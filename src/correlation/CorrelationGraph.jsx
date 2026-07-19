import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { PLATFORM_COLORS } from './adapter.js';

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
  onHoverLink, onHoverNode, onClickLink, onClickNode, searchNodeId, pulseKeys }) {
  const fgRef = useRef();
  const wrapRef = useRef();
  const [hover, setHover] = useState(null); // {kind:'node'|'link', id}
  const imgCache = useRef(new Map());       // url -> HTMLImageElement
  const pulseT = useRef(0);

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
    ctx.fillStyle = n.kind === 'country' ? '#111827' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = n.kind === 'country' ? 0 : 1.4;
    ctx.strokeStyle = n.tintStroke || '#c7d2fe';
    if (n.kind !== 'country') ctx.stroke();
    if (hover?.kind === 'node' && hover.id === n.id) {
      ctx.lineWidth = 2; ctx.strokeStyle = '#6d4aff'; ctx.stroke();
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

    // initials
    const label = n.kind === 'country' ? n.label.slice(0, 2).toUpperCase()
      : n.label.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    ctx.fillStyle = n.kind === 'country' ? '#ffffff' : '#1f2937';
    ctx.font = `600 ${Math.max(4, r * 0.72)}px Montserrat, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, n.x, n.y);

    // text label
    if (showLabels && (globalScale > 1.05 || n.kind === 'country' || (hover?.kind === 'node' && hover.id === n.id))) {
      ctx.font = `500 ${11 / globalScale}px Montserrat, sans-serif`;
      ctx.fillStyle = dim ? 'rgba(55,65,81,0.35)' : '#374151';
      ctx.textBaseline = 'top';
      ctx.fillText(n.label, n.x, n.y + r + 3);
    }
    // evidence-count badge
    if (n.evidenceCount > 0 && !dim) {
      ctx.beginPath();
      ctx.arc(n.x + r * 0.8, n.y - r * 0.8, 5.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#6d4aff'; ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 7px Montserrat, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n.evidenceCount > 9 ? '9+' : n.evidenceCount), n.x + r * 0.8, n.y - r * 0.8 + 0.5);
    }
    ctx.restore();
  }, [hover, isDimNode, showLabels]);

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
    // ⚠ contradiction marker
    if (l.contradiction) {
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠', mx, my + 10);
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
        }}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={() => 'replace'}
        linkDirectionalParticles={(l) => l.particles}
        linkDirectionalParticleSpeed={(l) => l.particleSpeed}
        linkDirectionalParticleWidth={1.8}
        linkDirectionalParticleColor={(l) => l.color}
        onNodeHover={(n) => { setHover(n ? { kind: 'node', id: n.id } : null); onHoverNode?.(n); }}
        onLinkHover={(l) => { setHover(l ? { kind: 'link', id: l.id, link: l } : null); onHoverLink?.(l); }}
        onNodeClick={(n) => onClickNode?.(n)}
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
