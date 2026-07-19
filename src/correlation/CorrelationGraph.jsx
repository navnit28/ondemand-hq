import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { PLATFORM_COLORS } from './adapter.js';

/**
 * CorrelationGraph — react-force-graph-2d canvas, Obsidian-futuristic on white.
 * VISUAL-CLARITY OVERHAUL (2026-07-19):
 * - every relationship renders as its OWN crisp category-colored curved edge
 *   (curvature fan from the adapter — parallel edges never merge)
 * - on-edge captions via linkCanvasObjectMode 'after' pattern (drawn in the
 *   same painter, placed at the true quadratic-curve midpoint): category name
 *   + weight + evidence count, white-pill background for readability
 * - directional particles flow in the REAL data direction (adapter orients
 *   source→target to match), speed ∝ weight; 'both' edges get no particles
 *   but double arrowheads
 * - hover focus: non-neighbor nodes AND edges dim to ~15% (node hover too,
 *   not just edge hover)
 * - all entity nodes render individually (no count-badge clusters) with
 *   full-name labels; context tethers are faint dashed lines
 * - zoomToFit(400, 60) guarded to run exactly ONCE per data load
 * - cursor: pointer over nodes/edges for click affordance
 */
export default function CorrelationGraph({ graph, width, height, showLabels, physics,
  onHoverLink, onHoverNode, onClickLink, onClickNode, searchNodeId, pulseKeys }) {
  const fgRef = useRef();
  const wrapRef = useRef();
  const [hover, setHover] = useState(null); // {kind:'node'|'link', id, link?}
  const imgCache = useRef(new Map());       // url -> HTMLImageElement
  const pulseT = useRef(0);
  const fitDone = useRef(false);            // zoomToFit-once guard

  // ?debug=1 test hook: expose the fg instance + live graph for QA drivers
  // (same pattern as the existing DebugDrawer; no-op in normal use)
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('debug') === '1') {
        window.__ceFg = { fg: fgRef.current, graph, wrap: wrapRef.current };
      }
    } catch { /* noop */ }
  }, [graph]);

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

  // zoomToFit(400, 60) exactly ONCE after the initial engine settles.
  // getGraphBbox polling (onEngineStop alone is unreliable under changing data)
  // + fitDone guard so later ticks/hover re-renders never re-zoom.
  useEffect(() => {
    fitDone.current = false;
    let tries = 0;
    const timer = setInterval(() => {
      const fg = fgRef.current;
      if (!fg || fitDone.current) { clearInterval(timer); return; }
      try {
        const bbox = fg.getGraphBbox?.();
        if (bbox && bbox.x && bbox.x[1] > bbox.x[0]) {
          fg.zoomToFit(400, 60);
          fitDone.current = true;
          clearInterval(timer);
        }
      } catch { /* not laid out yet */ }
      if (++tries > 40) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [graph]);

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

  const linkEnds = (l) => {
    const s = typeof l.source === 'object' ? l.source : null;
    const t = typeof l.target === 'object' ? l.target : null;
    return [s, t];
  };
  const idOf = (v) => (typeof v === 'object' ? v.id : v);

  // ----- hover-focus predicates: node hover AND edge hover both dim the rest -----
  const isDimNode = useCallback((n) => {
    if (n.dim) return true;
    if (!hover) return false;
    if (hover.kind === 'node') {
      if (hover.id === n.id) return false;
      return !(neighbors.get(hover.id)?.has(n.id));
    }
    if (hover.kind === 'link') {
      const l = hover.link;
      return n.id !== idOf(l.source) && n.id !== idOf(l.target);
    }
    return false;
  }, [hover, neighbors]);

  const isDimLink = useCallback((l) => {
    if (!hover) return false;
    if (hover.kind === 'link') return hover.id !== l.id;
    if (hover.kind === 'node') return idOf(l.source) !== hover.id && idOf(l.target) !== hover.id;
    return false;
  }, [hover]);

  const nodeCanvasObject = useCallback((n, ctx, globalScale) => {
    const dim = isDimNode(n);
    const alpha = dim ? 0.15 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    const r = n.size / 2;

    // community tint halo
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
    ctx.fillStyle = n.kind === 'country' ? '#111827'
      : n.kind === 'country-side' ? '#374151' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = n.kind === 'country' ? 0 : 1.4;
    ctx.strokeStyle = n.tintStroke || '#c7d2fe';
    if (n.kind !== 'country') ctx.stroke();
    if (hover?.kind === 'node' && hover.id === n.id) {
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#6d4aff'; ctx.stroke();
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
      ctx.strokeStyle = '#d62976'; ctx.lineWidth = 1; ctx.stroke();
    }

    // initials inside the disc
    const label = (n.kind === 'country' || n.kind === 'country-side')
      ? n.label.slice(0, 2).toUpperCase()
      : n.label.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    ctx.fillStyle = (n.kind === 'country' || n.kind === 'country-side') ? '#ffffff' : '#1f2937';
    ctx.font = `600 ${Math.max(4, r * 0.72)}px Montserrat, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, n.x, n.y);

    // ALWAYS-readable text label under every node (cluster expansion means
    // each entity is individually identifiable) — white pill for contrast.
    if (showLabels) {
      const fs = Math.max(3.2, 11 / globalScale);
      ctx.font = `600 ${fs}px Montserrat, sans-serif`;
      const tw = ctx.measureText(n.label).width;
      const ly = n.y + r + 4.5;
      ctx.fillStyle = dim ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.88)';
      ctx.fillRect(n.x - tw / 2 - 2, ly - 1, tw + 4, fs + 2.5);
      ctx.fillStyle = dim ? 'rgba(55,65,81,0.3)' : '#1f2937';
      ctx.textBaseline = 'top';
      ctx.fillText(n.label, n.x, ly);
    }
    // evidence-count badge
    if (n.evidenceCount > 0 && !dim) {
      ctx.beginPath();
      ctx.arc(n.x + r * 0.8, n.y - r * 0.8, 5.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#6d4aff'; ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 7px Montserrat, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(String(n.evidenceCount > 9 ? '9+' : n.evidenceCount), n.x + r * 0.8, n.y - r * 0.8 + 0.5);
    }
    ctx.restore();
  }, [hover, isDimNode, showLabels]);

  // quadratic-curve helpers so captions/arrows sit ON the drawn curve
  const curveControl = (s, t, curvature) => {
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    if (!curvature) return { cx: mx, cy: my };
    const dx = t.x - s.x, dy = t.y - s.y;
    const nx = -dy, ny = dx;
    const len = Math.hypot(nx, ny) || 1;
    return { cx: mx + (nx / len) * curvature * 60, cy: my + (ny / len) * curvature * 60 };
  };
  const curvePoint = (s, t, c, u) => ({
    x: (1 - u) * (1 - u) * s.x + 2 * (1 - u) * u * c.cx + u * u * t.x,
    y: (1 - u) * (1 - u) * s.y + 2 * (1 - u) * u * c.cy + u * u * t.y,
  });

  const drawArrowhead = (ctx, tip, angle, color, size = 7) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - size * Math.cos(angle - 0.42), tip.y - size * Math.sin(angle - 0.42));
    ctx.lineTo(tip.x - size * Math.cos(angle + 0.42), tip.y - size * Math.sin(angle + 0.42));
    ctx.fill();
  };

  const linkCanvasObject = useCallback((l, ctx, globalScale) => {
    const [s, t] = linkEnds(l);
    if (!s || !t) return;
    const hovered = hover?.kind === 'link' && hover.id === l.id;
    const dim = isDimLink(l);
    const isPulse = pulseT.current && pulseKeys?.includes(l.id);
    const c = curveControl(s, t, l.curvature);
    ctx.save();

    // ---- stroke: crisp solid category color; context tethers dashed+faint ----
    ctx.globalAlpha = (dim ? 0.12 : 1) * (l.opacity ?? 1);
    ctx.strokeStyle = l.color;
    ctx.lineWidth = hovered ? l.width + 1.6 : l.width;
    if (l.isContext) ctx.setLineDash([3, 4]);
    if (isPulse) { ctx.shadowColor = l.color; ctx.shadowBlur = 14; }
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    if (l.curvature) ctx.quadraticCurveTo(c.cx, c.cy, t.x, t.y);
    else ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    if (!l.isContext) {
      // ---- arrowheads on the CURVE: source→target = true flow direction ----
      // Large tip arrow + mid-curve chevrons so direction reads at ANY zoom.
      const arrowSize = Math.max(9, l.width * 3.2);
      const uTip = 0.93;
      const tip = curvePoint(s, t, c, uTip);
      const before = curvePoint(s, t, c, uTip - 0.04);
      const ang = Math.atan2(tip.y - before.y, tip.x - before.x);
      drawArrowhead(ctx, tip, ang, l.color, arrowSize);
      if (l.direction === 'both') {
        const tip2 = curvePoint(s, t, c, 0.07);
        const after2 = curvePoint(s, t, c, 0.11);
        const ang2 = Math.atan2(tip2.y - after2.y, tip2.x - after2.x);
        drawArrowhead(ctx, tip2, ang2, l.color, arrowSize);
      } else {
        // direction chevrons at 1/4 and 3/4 of the curve (skip caption zone)
        for (const u of [0.28, 0.72]) {
          const p = curvePoint(s, t, c, u);
          const q = curvePoint(s, t, c, u - 0.04);
          const a2 = Math.atan2(p.y - q.y, p.x - q.x);
          drawArrowhead(ctx, p, a2, l.color, arrowSize * 0.72);
        }
      }

      // ---- on-edge caption ('after'-mode pattern): category · weight · evidence ----
      // Screen-constant ~11px font: fs in graph units = 11 / globalScale.
      const mid = curvePoint(s, t, c, 0.5);
      const caption = `${l.type} · w${(l.weight ?? 0).toFixed(2)} · ${l.evidenceIds?.length || 0}ev`;
      const fs = Math.max(4, 11 / globalScale);
      ctx.font = `700 ${fs}px Montserrat, sans-serif`;
      const tw = ctx.measureText(caption).width;
      ctx.globalAlpha = dim ? 0.12 : 0.95;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      const padX = 3, padY = 1.5;
      ctx.fillRect(mid.x - tw / 2 - padX, mid.y - fs / 2 - padY, tw + padX * 2, fs + padY * 2);
      ctx.strokeStyle = l.color; ctx.lineWidth = 0.6;
      ctx.strokeRect(mid.x - tw / 2 - padX, mid.y - fs / 2 - padY, tw + padX * 2, fs + padY * 2);
      ctx.fillStyle = l.color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(caption, mid.x, mid.y);

      // platform glyph badges just under the caption
      ctx.globalAlpha = dim ? 0.12 : 1;
      (l.platforms || []).slice(0, 4).forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(mid.x + (i - ((Math.min(l.platforms.length, 4) - 1) / 2)) * 9, mid.y + fs + 5, 3.4, 0, 2 * Math.PI);
        ctx.fillStyle = PLATFORM_COLORS[p] || '#9ca3af';
        ctx.fill();
      });
      // ⚠ contradiction marker
      if (l.contradiction) {
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#b45309';
        ctx.fillText('⚠', mid.x, mid.y + fs + 14);
      }
    }
    ctx.restore();
  }, [hover, isDimLink, pulseKeys]);

  // wide invisible hit-band along the curve so edges are easy to hover/click
  const linkPointerAreaPaint = useCallback((l, color, ctx) => {
    const [s, t] = linkEnds(l);
    if (!s || !t) return;
    const c = curveControl(s, t, l.curvature);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(l.width + 8, 10);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    if (l.curvature) ctx.quadraticCurveTo(c.cx, c.cy, t.x, t.y);
    else ctx.lineTo(t.x, t.y);
    ctx.stroke();
  }, []);

  const setCursor = (on) => {
    const cv = wrapRef.current?.querySelector('canvas');
    if (cv) cv.style.cursor = on ? 'pointer' : 'default';
  };

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
        }}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={() => 'replace'}
        linkPointerAreaPaint={linkPointerAreaPaint}
        linkDirectionalParticles={(l) => l.particles}
        linkDirectionalParticleSpeed={(l) => l.particleSpeed}
        linkDirectionalParticleWidth={3.6}
        linkDirectionalParticleColor={(l) => l.color}
        onNodeHover={(n) => {
          setCursor(Boolean(n));
          setHover(n ? { kind: 'node', id: n.id } : null);
          onHoverNode?.(n);
        }}
        onLinkHover={(l) => {
          if (l?.isContext) { setCursor(false); setHover(null); onHoverLink?.(null); return; }
          setCursor(Boolean(l));
          setHover(l ? { kind: 'link', id: l.id, link: l } : null);
          onHoverLink?.(l);
        }}
        onNodeClick={(n, evt) => onClickNode?.(n, evt)}
        onLinkClick={(l, evt) => { if (!l?.isContext) onClickLink?.(l, evt); }}
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
