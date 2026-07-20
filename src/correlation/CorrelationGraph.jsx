import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { PLATFORM_COLORS } from './adapter.js';
import { attachGestures } from './gestures.js';

/**
 * CorrelationGraph — react-force-graph-2d canvas, Obsidian-futuristic on white.
 * - nodeCanvasObject custom draw: large country node, UAE entities w/ initials,
 *   IG-backed nodes draw downloaded proof thumbnails (cached Image objects)
 * - directional particles speed-scaled to recency; weight→width; recency→opacity
 * - hover lights node+neighbors, dims rest ~15%; new-edge pulse from daily diff
 * - search→zoom-to-node; zoomToFit on load (getGraphBbox polling — onEngineStop
 *   is unreliable under changing data); drag physics; 60fps (particle counts bounded)
 */
export default function CorrelationGraph({ graph, width, height, showLabels, physics,
  onHoverLink, onHoverNode, onClickLink, onClickNode, onBadgeClick, searchNodeId, pulseKeys }) {
  const fgRef = useRef();
  const wrapRef = useRef();
  const [hover, setHover] = useState(null); // {kind:'node'|'link', id}
  const imgCache = useRef(new Map());       // url -> HTMLImageElement
  const pulseT = useRef(0);
  const widthRef = useRef(width); widthRef.current = width;
  const heightRef = useRef(height); heightRef.current = height;

  // QA hook: expose fg instance + live graph + wrap el for test drivers.
  // Unconditional (the SPA's history.pushState can strip the ?debug=1 query
  // before this mounts); read-only handle, no behavioural effect.
  useEffect(() => {
    try { window.__ceFg = { fg: fgRef.current, graph, wrap: wrapRef.current }; } catch { /* noop */ }
  }, [graph]);

  // Gesture UX package (2026-07-19): pinch-zoom / swipe-pan / double-tap-center
  useEffect(() => {
    const el = wrapRef.current;
    const fg = fgRef.current;
    if (!el || !fg) return undefined;
    return attachGestures(el, {
      getZoom: () => fg.zoom(),
      zoom: (k, ms) => fg.zoom(k, ms),
      centerAt: (x, y, ms) => fg.centerAt(x, y, ms),
      getCenter: () => {
        try { return fg.screen2GraphCoords(widthRef.current / 2, heightRef.current / 2); }
        catch { return null; }
      },
      screen2GraphCoords: (x, y) => { try { return fg.screen2GraphCoords(x, y); } catch { return null; } },
      findNearest: (gx, gy, maxD) => {
        let best = null, bd = maxD;
        for (const n of graph.nodes) {
          if (!Number.isFinite(n.x)) continue;
          const d = Math.hypot(n.x - gx, n.y - gy);
          if (d < bd) { bd = d; best = n; }
        }
        return best;
      },
    });
  }, [graph.nodes]);

  // pre-load IG proof thumbnails referenced by nodes
  useEffect(() => {
    for (const n of graph.nodes) {
      for (const m of (n.media || []).slice(0, 1)) {
        if (!imgCache.current.has(m.url)) {
          const img = new Image();
          img.src = m.url;
          imgCache.current.set(m.url, img);
        }
      }
    }
  }, [graph.nodes]);

  // neighbor index for hover dim
  const neighbors = useMemo(() => {
    const map = new Map();
    for (const l of graph.links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      (map.get(s) || map.set(s, new Set()).get(s)).add(t);
      (map.get(t) || map.set(t, new Set()).get(t)).add(s);
    }
    return map;
  }, [graph.links]);

  // zoomToFit on load/data change — getGraphBbox polling pattern
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      const fg = fgRef.current;
      if (!fg) return;
      try {
        const bbox = fg.getGraphBbox?.();
        if (bbox && bbox.x && bbox.x[1] > bbox.x[0]) { fg.zoomToFit(700, 42); clearInterval(timer); }
      } catch { /* not laid out yet */ }
      if (++tries > 40) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
    // width/height in deps (2026-07-20): re-fit after expand→fullscreen AND on
    // restore to normal size — same bbox-polling pattern (onEngineStop unreliable).
  }, [graph, width, height]);

  // search → zoom to node
  useEffect(() => {
    if (!searchNodeId || !fgRef.current) return;
    const n = graph.nodes.find(x => x.id === searchNodeId);
    if (n && Number.isFinite(n.x) && Number.isFinite(n.y)) {
      fgRef.current.centerAt(n.x, n.y, 700);
      fgRef.current.zoom(3.2, 700);
    }
  }, [searchNodeId, graph.nodes]);

  // physics toggle
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3ReheatSimulation?.();
    if (!physics) fg.cooldownTicks?.(0);
  }, [physics]);

  // new-edge pulse ticker (diff) — bounded to 3s
  useEffect(() => {
    if (!pulseKeys?.length) return;
    pulseT.current = performance.now();
    const t = setTimeout(() => { pulseT.current = 0; }, 3000);
    return () => clearTimeout(t);
  }, [pulseKeys]);

  const isDimNode = useCallback((n) => {
    if (n.dim) return true;
    if (!hover) return false;
    if (hover.kind === 'node') {
      if (hover.id === n.id) return false;
      return !(neighbors.get(hover.id)?.has(n.id));
    }
    if (hover.kind === 'link') {
      const l = hover.link;
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return n.id !== s && n.id !== t;
    }
    return false;
  }, [hover, neighbors]);

  const nodeCanvasObject = useCallback((n, ctx, globalScale) => {
    const dim = isDimNode(n);
    const alpha = dim ? 0.15 : 1;
    const r = n.size / 2;

    // LOD VIRTUALIZATION (2026-07-19): when a node renders below ~3.5 screen px,
    // draw a single cheap tinted disc and skip halo/initials/badge/media entirely —
    // keeps 60fps with hundreds-scale graphs and removes sub-pixel clutter.
    if (r * globalScale < 3.5 && n.kind !== 'country' && !(hover?.kind === 'node' && hover.id === n.id)) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.85;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(r, 2 / globalScale), 0, 2 * Math.PI);
      ctx.fillStyle = n.tintStroke || '#a7d9cb';
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    // community tint halo (legend-mapped: halo hue = Louvain community)
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 3.5, 0, 2 * Math.PI);
    ctx.fillStyle = n.tint || '#eef2ff';
    ctx.fill();

    // IG proof thumbnail (first media) clipped in a circle above the node body
    const mediaUrl = n.media?.[0]?.url;
    const img = mediaUrl ? imgCache.current.get(mediaUrl) : null;
    const imgReady = img && img.complete && img.naturalWidth > 0;

    // body
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = n.kind === 'country' ? '#111827' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = n.kind === 'country' ? 0 : 1.4;
    ctx.strokeStyle = n.tintStroke || '#a7d9cb';
    if (n.kind !== 'country') ctx.stroke();
    if (hover?.kind === 'node' && hover.id === n.id) {
      ctx.lineWidth = 2; ctx.strokeStyle = '#159a7a'; ctx.stroke();
    }

    if (imgReady) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(n.x, n.y - r - 7, 7, 0, 2 * Math.PI);
      ctx.clip();
      ctx.drawImage(img, n.x - 7, n.y - r - 14, 14, 14);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(n.x, n.y - r - 7, 7, 0, 2 * Math.PI);
      ctx.strokeStyle = '#0f766e'; ctx.lineWidth = 1; ctx.stroke();
    }

    // initials
    const label = n.kind === 'country' ? n.label.slice(0, 2).toUpperCase()
      : n.label.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    ctx.fillStyle = n.kind === 'country' ? '#ffffff' : '#1f2937';
    ctx.font = `600 ${Math.max(4, r * 0.72)}px Montserrat, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, n.x, n.y);

    // text label — VIEWPORT-FIT (2026-07-19 Gemini UX fix): labels near the frame
    // edge are re-anchored inward so they never clip (e.g. 'Relief Beneficiaries').
    if (showLabels && (globalScale > 1.05 || n.kind === 'country' || (hover?.kind === 'node' && hover.id === n.id))) {
      const fpx = 11 / globalScale;
      ctx.font = `500 ${fpx}px Montserrat, sans-serif`;
      ctx.fillStyle = dim ? 'rgba(55,65,81,0.35)' : '#374151';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(n.label).width;
      // canvas viewport bounds in graph coords
      let align = 'center', lx = n.x;
      const fg = fgRef.current;
      if (fg?.screen2GraphCoords) {
        try {
          const tl = fg.screen2GraphCoords(0, 0);
          const br = fg.screen2GraphCoords(widthRef.current, heightRef.current);
          const pad = 4 / globalScale;
          if (n.x + tw / 2 > br.x - pad) { align = 'right'; lx = Math.min(n.x + r, br.x - pad); }
          else if (n.x - tw / 2 < tl.x + pad) { align = 'left'; lx = Math.max(n.x - r, tl.x + pad); }
        } catch { /* not ready */ }
      }
      ctx.textAlign = align;
      ctx.fillText(n.label, lx, n.y + r + 3);
      ctx.textAlign = 'center';
    }
    // UX overhaul 2026-07-19: EVIDENCE-BACKED badge — badgeCount = distinct evidence
    // records on this node's incident edges (adapter computes it strictly from the
    // run; NEVER a corpus/aggregate number). ODA-neutral styling (white pill, dark
    // text, brand ring) replaces the purple blob. Collision-aware: candidate anchor
    // angles are tried until the pill overlaps no other node disc; the chosen rect
    // is registered on n.__badgeRect for click hit-testing (badge → evidence
    // breakdown panel). Zero-evidence nodes get NO badge — no invented numbers.
    const badgeN = n.badgeCount ?? 0;
    n.__badgeRect = null;
    // LOD (2026-07-20, 200-point density): badges render only when legible —
    // zoomed in (globalScale ≥ 1.15), or node hovered, or a high-signal node
    // (country / top-weight via alwaysLabel / pagerank). Prevents pill soup.
    const badgeVisible = badgeN > 0 && !dim &&
      (globalScale >= 1.15 || (hover?.kind === 'node' && hover.id === n.id) ||
       n.kind === 'country' || n.alwaysLabel || (n.pagerank ?? 0) > 0.06);
    if (badgeVisible) {
      const txt = String(badgeN);
      ctx.font = '700 7.5px Montserrat, sans-serif';
      const tw2 = ctx.measureText(txt).width;
      const bw = Math.max(13, tw2 + 9), bh = 12;
      // candidate anchors: NE, NW, SE, SW, E — pick first that avoids other nodes
      const cand = [[0.85, -0.85], [-0.85 - bw / r, -0.85], [0.85, 0.55], [-0.85 - bw / r, 0.55], [1.15, -0.2]];
      let bx = n.x + r * 0.85, by = n.y - r * 0.85 - bh / 2;
      for (const [fx, fy] of cand) {
        const tx = n.x + r * fx, ty = n.y + r * fy - bh / 2;
        const cx2 = tx + bw / 2, cy2 = ty + bh / 2;
        const hit = (graph.nodes || []).some(o => o !== n && Number.isFinite(o.x) &&
          Math.hypot(o.x - cx2, o.y - cy2) < o.size / 2 + bh / 2 + 1);
        if (!hit) { bx = tx; by = ty; break; }
      }
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, bh / 2);
      else ctx.rect(bx, by, bw, bh);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = '#159a7a'; ctx.stroke();
      ctx.fillStyle = '#0f766e';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + bw / 2, by + bh / 2 + 0.5);
      n.__badgeRect = { x: bx, y: by, w: bw, h: bh };
    }
    ctx.restore();
  }, [hover, isDimNode, showLabels, graph.nodes]);

  const linkCanvasObject = useCallback((l, ctx) => {
    const s = typeof l.source === 'object' ? l.source : null;
    const t = typeof l.target === 'object' ? l.target : null;
    if (!s || !t) return;
    const hovered = hover?.kind === 'link' && hover.id === l.id;
    const dim = hover && !hovered && hover.kind === 'link';
    const isPulse = pulseT.current && pulseKeys?.includes(l.id);
    ctx.save();
    ctx.globalAlpha = (dim ? 0.12 : 1) * l.opacity;
    ctx.strokeStyle = l.color;
    ctx.lineWidth = hovered ? l.width + 1.6 : l.width;
    if (isPulse) { ctx.shadowColor = l.color; ctx.shadowBlur = 14; }
    ctx.beginPath();
    if (l.curvature) {
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const dx = t.x - s.x, dy = t.y - s.y;
      const nx = -dy, ny = dx;
      const len = Math.hypot(nx, ny) || 1;
      const cx = mx + (nx / len) * l.curvature * 60, cy = my + (ny / len) * l.curvature * 60;
      ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(cx, cy, t.x, t.y);
    } else { ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); }
    ctx.stroke();
    // direction arrow
    if (l.direction !== 'both') {
      const from = l.direction === 'b->a' ? t : s;
      const to = l.direction === 'b->a' ? s : t;
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      const ax = to.x - Math.cos(ang) * (to.size / 2 + 3), ay = to.y - Math.sin(ang) * (to.size / 2 + 3);
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 6 * Math.cos(ang - 0.45), ay - 6 * Math.sin(ang - 0.45));
      ctx.lineTo(ax - 6 * Math.cos(ang + 0.45), ay - 6 * Math.sin(ang + 0.45));
      ctx.fill();
    }
    // platform glyph badges along the link midpoint
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    (l.platforms || []).slice(0, 4).forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(mx + (i - ((l.platforms.length - 1) / 2)) * 9, my - 6, 4, 0, 2 * Math.PI);
      ctx.fillStyle = PLATFORM_COLORS[p] || '#9ca3af';
      ctx.fill();
    });
    // contradiction marker: drawn triangle-alert (icon audit — no emoji glyphs on canvas)
    if (l.contradiction) {
      const ty = my + 10;
      ctx.beginPath();
      ctx.moveTo(mx, ty - 4); ctx.lineTo(mx + 4.5, ty + 3.5); ctx.lineTo(mx - 4.5, ty + 3.5);
      ctx.closePath();
      ctx.fillStyle = '#f59e0b'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.fillStyle = '#78350f'; ctx.font = '700 5px Montserrat, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('!', mx, ty + 1.2);
    }
    ctx.restore();
  }, [hover, pulseKeys]);

  return (
    <div ref={wrapRef} className="ce-canvas">
      <ForceGraph2D
        ref={fgRef}
        graphData={graph}
        width={width} height={height}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.size / 2 + 4, 0, 2 * Math.PI);
          ctx.fill();
          // badge is part of the node's pointer area (click routed via onNodeClick)
          if (n.__badgeRect) {
            const b = n.__badgeRect;
            ctx.fillRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
          }
        }}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={() => 'replace'}
        linkDirectionalParticles={(l) => l.particles}
        linkDirectionalParticleSpeed={(l) => l.particleSpeed}
        linkDirectionalParticleWidth={1.8}
        linkDirectionalParticleColor={(l) => l.color}
        onNodeHover={(n) => { setHover(n ? { kind: 'node', id: n.id } : null); onHoverNode?.(n); }}
        onLinkHover={(l) => { setHover(l ? { kind: 'link', id: l.id, link: l } : null); onHoverLink?.(l); }}
        onNodeClick={(n, evt) => {
          // badge hit-test: if click landed inside the badge pill → evidence breakdown
          try {
            const fg = fgRef.current;
            if (n?.__badgeRect && fg && evt) {
              const rct = wrapRef.current.getBoundingClientRect();
              const g = fg.screen2GraphCoords(evt.clientX - rct.left, evt.clientY - rct.top);
              const b = n.__badgeRect;
              if (g.x >= b.x - 2 && g.x <= b.x + b.w + 2 && g.y >= b.y - 2 && g.y <= b.y + b.h + 2) {
                onBadgeClick?.(n);
                return;
              }
            }
          } catch { /* fall through to normal node click */ }
          onClickNode?.(n);
        }}
        onLinkClick={(l) => onClickLink?.(l)}
        onBackgroundClick={() => { onClickNode?.(null); onClickLink?.(null); }}
        enableNodeDrag
        cooldownTime={physics ? 4000 : 0}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.32}
        backgroundColor="#ffffff"
      />
    </div>
  );
}
