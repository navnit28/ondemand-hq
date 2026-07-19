import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { PLATFORM_COLORS, VERIFICATION_STYLES } from './adapter.js';

/**
 * CorrelationGraph V2 (2026-07-19) — clean white ODA design language.
 * QA gate: ODA watermark ≤4% opacity; labels only on hover/zoom (country + top-5
 * by weight always); node size = weight; edge width = strength; edge color/style =
 * verification tier (Verified #159a7a solid / Likely #1dac89 solid / Possible dashed /
 * Predicted dotted) with on-canvas legend; Obsidian hover-focus dim to ~15%;
 * particle flow + glow on high-weight edges; halos on key entities.
 * V2 interactions: Space=pan (native drag), double-click node = center,
 * Shift+Drag = multi-select, Scroll = zoom, ALT+Scroll = timeline scrub,
 * CTRL+Click = lock node; bottom-right minimap w/ viewport rect, click-to-jump,
 * wheel zoom; heat mode (width=interactions, glow=importance, pulse=breaking).
 */
export default function CorrelationGraph({ graph, width, height, showLabels, physics,
  onHoverLink, onHoverNode, onClickLink, onClickNode, onDblClickNode, onLockNode,
  onAltScroll, onMultiSelect, searchNodeId, pulseKeys, heatMode, focusNodeId,
  onViewChange, externalCenter }) {
  const fgRef = useRef();
  const wrapRef = useRef();
  const miniRef = useRef();
  const [hover, setHover] = useState(null); // {kind:'node'|'link', id, link?}
  const imgCache = useRef(new Map());
  const pulseT = useRef(0);
  const fitDone = useRef(false);
  const spaceDown = useRef(false);
  const marquee = useRef(null);            // {x0,y0,x1,y1} screen coords
  const [marqueeBox, setMarqueeBox] = useState(null);
  const viewRef = useRef({ cx: 0, cy: 0, k: 1 });
  const breathT = useRef(0);

  // expose fg instance for QA drivers
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('debug') === '1') {
        window.__ceFg = { fg: fgRef.current, graph, wrap: wrapRef.current };
      }
    } catch { /* noop */ }
  }, [graph]);

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

  // zoomToFit once per data load
  useEffect(() => {
    fitDone.current = false;
    let tries = 0;
    const timer = setInterval(() => {
      const fg = fgRef.current;
      if (!fg || fitDone.current) { clearInterval(timer); return; }
      try {
        const bbox = fg.getGraphBbox?.();
        if (bbox && bbox.x && bbox.x[1] > bbox.x[0]) {
          fg.zoomToFit(400, 70);
          fitDone.current = true;
          clearInterval(timer);
        }
      } catch { /* not laid out yet */ }
      if (++tries > 40) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [graph]);

  // search / external center → zoom to node
  useEffect(() => {
    const id = searchNodeId || externalCenter;
    if (!id || !fgRef.current) return;
    const n = graph.nodes.find(x => x.id === id);
    if (n && Number.isFinite(n.x) && Number.isFinite(n.y)) {
      fgRef.current.centerAt(n.x, n.y, 700);
      fgRef.current.zoom(3.2, 700);
    }
  }, [searchNodeId, externalCenter, graph.nodes]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3ReheatSimulation?.();
    if (!physics) fg.cooldownTicks?.(0);
  }, [physics]);

  useEffect(() => {
    if (!pulseKeys?.length) return;
    pulseT.current = performance.now();
    const t = setTimeout(() => { pulseT.current = 0; }, 3000);
    return () => clearTimeout(t);
  }, [pulseKeys]);

  // (3) Space=pan cursor hint, Shift+Drag marquee multi-select, ALT+Scroll scrub
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const kd = (e) => { if (e.code === 'Space') { spaceDown.current = true; el.style.cursor = 'grab'; } };
    const ku = (e) => { if (e.code === 'Space') { spaceDown.current = false; el.style.cursor = ''; } };
    const wheel = (e) => {
      if (e.altKey) { e.preventDefault(); e.stopPropagation(); onAltScroll?.(Math.sign(e.deltaY)); }
    };
    const md = (e) => {
      if (!e.shiftKey) return;
      const r = el.getBoundingClientRect();
      marquee.current = { x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top };
      setMarqueeBox({ ...marquee.current });
      e.preventDefault(); e.stopPropagation();
    };
    const mm = (e) => {
      if (!marquee.current) return;
      const r = el.getBoundingClientRect();
      marquee.current.x1 = e.clientX - r.left; marquee.current.y1 = e.clientY - r.top;
      setMarqueeBox({ ...marquee.current });
    };
    const mu = () => {
      if (!marquee.current) return;
      const m = marquee.current; marquee.current = null; setMarqueeBox(null);
      const fg = fgRef.current;
      if (!fg) return;
      const [xa, xb] = [Math.min(m.x0, m.x1), Math.max(m.x0, m.x1)];
      const [ya, yb] = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)];
      if (xb - xa < 6 && yb - ya < 6) return;
      const hits = graph.nodes.filter(n => {
        if (!Number.isFinite(n.x)) return false;
        const p = fg.graph2ScreenCoords(n.x, n.y);
        return p.x >= xa && p.x <= xb && p.y >= ya && p.y <= yb;
      });
      onMultiSelect?.(hits);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    el.addEventListener('wheel', wheel, { passive: false, capture: true });
    el.addEventListener('mousedown', md, true);
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      el.removeEventListener('wheel', wheel, true);
      el.removeEventListener('mousedown', md, true);
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
    };
  }, [graph.nodes, onAltScroll, onMultiSelect]);

  // (3) double-click node = center (native dblclick on the wrap; nearest-node hit test)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const dbl = (e) => {
      const fg = fgRef.current;
      if (!fg) return;
      const r = el.getBoundingClientRect();
      const g = fg.screen2GraphCoords(e.clientX - r.left, e.clientY - r.top);
      let best = null, bd = Infinity;
      for (const n of graph.nodes) {
        const d = Math.hypot((n.x ?? 1e9) - g.x, (n.y ?? 1e9) - g.y);
        if (d < bd) { bd = d; best = n; }
      }
      if (best && bd < Math.max(best.size, 12)) {
        fg.centerAt(best.x, best.y, 600);
        fg.zoom(Math.max(fg.zoom(), 2.6), 600);
        onDblClickNode?.(best);
      }
    };
    el.addEventListener('dblclick', dbl);
    return () => el.removeEventListener('dblclick', dbl);
  }, [graph.nodes, onDblClickNode]);

  // breathing tick for breaking-news pulse + minimap redraw
  useEffect(() => {
    let raf;
    const tick = () => { breathT.current = performance.now(); drawMinimap(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const linkEnds = (l) => [typeof l.source === 'object' ? l.source : null, typeof l.target === 'object' ? l.target : null];
  const idOf = (v) => (typeof v === 'object' ? v.id : v);

  const isDimNode = useCallback((n) => {
    if (n.dim) return true;
    const focus = hover || (focusNodeId ? { kind: 'node', id: focusNodeId } : null);
    if (!focus) return false;
    if (focus.kind === 'node') {
      if (focus.id === n.id) return false;
      return !(neighbors.get(focus.id)?.has(n.id));
    }
    if (focus.kind === 'link') {
      const l = focus.link;
      return n.id !== idOf(l.source) && n.id !== idOf(l.target);
    }
    return false;
  }, [hover, focusNodeId, neighbors]);

  const isDimLink = useCallback((l) => {
    const focus = hover || (focusNodeId ? { kind: 'node', id: focusNodeId } : null);
    if (!focus) return false;
    if (focus.kind === 'link') return focus.id !== l.id;
    if (focus.kind === 'node') return idOf(l.source) !== focus.id && idOf(l.target) !== focus.id;
    return false;
  }, [hover, focusNodeId]);

  const nodeCanvasObject = useCallback((n, ctx, globalScale) => {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return; // pre-layout tick guard
    const dim = isDimNode(n);
    const alpha = dim ? 0.15 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    const r = n.size / 2;

    // halo on key entities (QA gate)
    if (n.keyEntity && !dim) {
      const g = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, r + 12);
      g.addColorStop(0, 'rgba(21,154,122,0.28)');
      g.addColorStop(1, 'rgba(21,154,122,0)');
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 12, 0, 2 * Math.PI);
      ctx.fillStyle = g; ctx.fill();
    }

    // community tint ring
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 3.2, 0, 2 * Math.PI);
    ctx.fillStyle = n.tint || '#eef2ff';
    ctx.fill();

    const mediaUrl = n.media?.[0]?.url;
    const img = mediaUrl ? imgCache.current.get(mediaUrl) : null;
    const imgReady = img && img.complete && img.naturalWidth > 0;

    // body
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = n.kind === 'country' ? '#111827'
      : n.kind === 'community' ? '#159a7a'
      : n.kind === 'country-side' ? '#374151' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = n.kind === 'country' ? 0 : 1.4;
    ctx.strokeStyle = n.tintStroke || '#c7d2fe';
    if (n.kind !== 'country') ctx.stroke();
    if (hover?.kind === 'node' && hover.id === n.id) {
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#159a7a'; ctx.stroke();
    }
    // CTRL+Click lock indicator
    if (n.locked && !dim) {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 6.5, 0, 2 * Math.PI);
      ctx.setLineDash([2, 3]); ctx.strokeStyle = '#159a7a'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.setLineDash([]);
    }

    // (7) rich media badge: REAL stored evidence media thumbnail only
    if (imgReady) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(n.x, n.y - r - 7, 7, 0, 2 * Math.PI);
      ctx.clip();
      ctx.drawImage(img, n.x - 7, n.y - r - 14, 14, 14);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(n.x, n.y - r - 7, 7, 0, 2 * Math.PI);
      ctx.strokeStyle = '#159a7a'; ctx.lineWidth = 1; ctx.stroke();
    }

    // initials inside disc
    const label = (n.kind === 'country' || n.kind === 'country-side')
      ? n.label.slice(0, 2).toUpperCase()
      : n.kind === 'community' ? String(n.memberCount)
      : n.label.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    ctx.fillStyle = (n.kind === 'country' || n.kind === 'country-side' || n.kind === 'community') ? '#ffffff' : '#1f2937';
    ctx.font = `600 ${Math.max(4, r * 0.72)}px Montserrat, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, n.x, n.y);

    // QA-gate label policy: labels only when (a) node is alwaysLabel (country/top-5),
    // (b) hovered/focused, or (c) zoomed in past 2.2×; global showLabels toggle respected.
    const zoomedIn = globalScale >= 2.2;
    const hovered = hover?.kind === 'node' && hover.id === n.id;
    if (showLabels && !dim && (n.alwaysLabel || hovered || zoomedIn)) {
      const fs = Math.max(3.2, 11 / globalScale);
      ctx.font = `600 ${fs}px Montserrat, sans-serif`;
      const tw = ctx.measureText(n.label).width;
      const ly = n.y + r + 4.5;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(n.x - tw / 2 - 2, ly - 1, tw + 4, fs + 2.5);
      ctx.fillStyle = '#1f2937';
      ctx.textBaseline = 'top';
      ctx.fillText(n.label, n.x, ly);
    }
    if (n.evidenceCount > 0 && !dim) {
      ctx.beginPath();
      ctx.arc(n.x + r * 0.8, n.y - r * 0.8, 5.2, 0, 2 * Math.PI);
      ctx.fillStyle = '#159a7a'; ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 7px Montserrat, sans-serif';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(String(n.evidenceCount > 9 ? '9+' : n.evidenceCount), n.x + r * 0.8, n.y - r * 0.8 + 0.5);
    }
    ctx.restore();
  }, [hover, isDimNode, showLabels]);

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
    if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(t.x)) return; // pre-layout guard
    const hovered = hover?.kind === 'link' && hover.id === l.id;
    const dim = isDimLink(l);
    const isPulse = pulseT.current && pulseKeys?.includes(l.id);
    const c = curveControl(s, t, l.curvature);
    ctx.save();

    // (15) tier stroke: color + dash from verification tier; (12) heat glow;
    // breaking-news breathing pulse in heat mode
    ctx.globalAlpha = (dim ? 0.12 : 1) * (l.opacity ?? 1);
    ctx.strokeStyle = l.color;
    let w = hovered ? l.width + 1.6 : l.width;
    if (heatMode && l.breaking) {
      const b = 0.5 + 0.5 * Math.sin(breathT.current / 260);
      w += b * 1.6;
      ctx.shadowColor = '#dc2626'; ctx.shadowBlur = 8 + b * 10;
    } else if (l.glow && !dim) {
      ctx.shadowColor = l.color; ctx.shadowBlur = l.glow;
    } else if (!heatMode && l.weight >= 0.5 && !dim) {
      ctx.shadowColor = l.color; ctx.shadowBlur = 6; // subtle glow on high-weight edges (QA)
    }
    ctx.lineWidth = w;
    if (l.dash?.length) ctx.setLineDash(l.dash);
    if (isPulse) { ctx.shadowColor = l.color; ctx.shadowBlur = 14; }
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    if (l.curvature) ctx.quadraticCurveTo(c.cx, c.cy, t.x, t.y);
    else ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    if (!l.isContext) {
      const arrowSize = Math.max(8, l.width * 2.6);
      const uTip = 0.93;
      const tip = curvePoint(s, t, c, uTip);
      const before = curvePoint(s, t, c, uTip - 0.04);
      const ang = Math.atan2(tip.y - before.y, tip.x - before.x);
      drawArrowhead(ctx, tip, ang, l.color, arrowSize);
      if (l.direction === 'both') {
        const tip2 = curvePoint(s, t, c, 0.07);
        const after2 = curvePoint(s, t, c, 0.11);
        drawArrowhead(ctx, tip2, Math.atan2(tip2.y - after2.y, tip2.x - after2.x), l.color, arrowSize);
      }

      // edge caption ONLY on hover or deep zoom (QA gate: no label clutter)
      if (hovered || globalScale >= 2.6) {
        const mid = curvePoint(s, t, c, 0.5);
        const tag = l.verification ? `${l.verification} ${(l.confidence ?? 0).toFixed(2)}` : `${l.type}`;
        const caption = `${l.type} · ${tag} · ${l.evidenceIds?.length || 0}ev`;
        const fs = Math.max(4, 11 / globalScale);
        ctx.font = `700 ${fs}px Montserrat, sans-serif`;
        const tw = ctx.measureText(caption).width;
        ctx.globalAlpha = dim ? 0.12 : 0.95;
        ctx.fillStyle = 'rgba(255,255,255,0.94)';
        const padX = 3, padY = 1.5;
        ctx.fillRect(mid.x - tw / 2 - padX, mid.y - fs / 2 - padY, tw + padX * 2, fs + padY * 2);
        ctx.strokeStyle = l.color; ctx.lineWidth = 0.6;
        ctx.strokeRect(mid.x - tw / 2 - padX, mid.y - fs / 2 - padY, tw + padX * 2, fs + padY * 2);
        ctx.fillStyle = l.color;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(caption, mid.x, mid.y);
        if (l.contradiction) {
          ctx.font = '11px sans-serif';
          ctx.fillStyle = '#b45309';
          ctx.fillText('⚠', mid.x, mid.y + fs + 10);
        }
        ctx.globalAlpha = dim ? 0.12 : 1;
        (l.platforms || []).slice(0, 4).forEach((p, i) => {
          ctx.beginPath();
          ctx.arc(mid.x + (i - ((Math.min(l.platforms.length, 4) - 1) / 2)) * 9, mid.y + fs + 5, 3.2, 0, 2 * Math.PI);
          ctx.fillStyle = PLATFORM_COLORS[p] || '#9ca3af';
          ctx.fill();
        });
      }
    }
    ctx.restore();
  }, [hover, isDimLink, pulseKeys, heatMode]);

  const linkPointerAreaPaint = useCallback((l, color, ctx) => {
    const [s, t] = linkEnds(l);
    if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(t.x)) return;
    const c = curveControl(s, t, l.curvature);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(l.width + 8, 10);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    if (l.curvature) ctx.quadraticCurveTo(c.cx, c.cy, t.x, t.y);
    else ctx.lineTo(t.x, t.y);
    ctx.stroke();
  }, []);

  // ---------- (2) minimap ----------
  const graphBounds = () => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of graph.nodes) {
      if (!Number.isFinite(n.x)) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    if (!Number.isFinite(minX)) return null;
    const pad = 30;
    return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
  };

  const drawMinimap = () => {
    const cv = miniRef.current;
    const fg = fgRef.current;
    if (!cv || !fg) return;
    const b = graphBounds();
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(0, 0, W, H);
    if (!b) return;
    const sx = W / (b.maxX - b.minX), sy = H / (b.maxY - b.minY);
    const sc = Math.min(sx, sy);
    const ox = (W - (b.maxX - b.minX) * sc) / 2, oy = (H - (b.maxY - b.minY) * sc) / 2;
    const mx = (x) => ox + (x - b.minX) * sc, my = (y) => oy + (y - b.minY) * sc;
    // edges
    ctx.lineWidth = 0.7;
    for (const l of graph.links) {
      const [s, t] = linkEnds(l);
      if (!s || !t || !Number.isFinite(s.x)) continue;
      ctx.strokeStyle = l.isContext ? 'rgba(203,213,225,0.5)' : (l.color + '99');
      ctx.beginPath(); ctx.moveTo(mx(s.x), my(s.y)); ctx.lineTo(mx(t.x), my(t.y)); ctx.stroke();
    }
    // nodes
    for (const n of graph.nodes) {
      if (!Number.isFinite(n.x)) continue;
      ctx.beginPath();
      ctx.arc(mx(n.x), my(n.y), Math.max(1.4, n.size / 8), 0, 2 * Math.PI);
      ctx.fillStyle = n.kind === 'country' ? '#111827' : '#159a7a';
      ctx.fill();
    }
    // viewport rect: invert screen corners into graph coords
    try {
      const tl = fg.screen2GraphCoords(0, 0);
      const br = fg.screen2GraphCoords(width, height);
      ctx.strokeStyle = '#159a7a'; ctx.lineWidth = 1.4;
      ctx.strokeRect(mx(tl.x), my(tl.y), (br.x - tl.x) * sc, (br.y - tl.y) * sc);
    } catch { /* pre-layout */ }
    cv.__map = { b, sc, ox, oy };
  };

  const miniToGraph = (e) => {
    const cv = miniRef.current;
    const m = cv?.__map;
    if (!m) return null;
    const r = cv.getBoundingClientRect();
    const px = (e.clientX - r.left) * (cv.width / r.width);
    const py = (e.clientY - r.top) * (cv.height / r.height);
    return { x: m.b.minX + (px - m.ox) / m.sc, y: m.b.minY + (py - m.oy) / m.sc };
  };

  const setCursor = (on) => {
    const cv = wrapRef.current?.querySelector('canvas');
    if (cv) cv.style.cursor = on ? 'pointer' : (spaceDown.current ? 'grab' : 'default');
  };

  return (
    <div ref={wrapRef} className="ce-canvas">
      {/* QA gate: ODA watermark ≤4% opacity */}
      <div className="ce-watermark" aria-hidden>ODA</div>
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
        linkDirectionalParticleWidth={3.4}
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
        onNodeClick={(n, evt) => {
          if (evt?.ctrlKey && n) {                          // (3) CTRL+Click = lock
            n.fx = n.x; n.fy = n.y;
            onLockNode?.(n);
            return;
          }
          onClickNode?.(n, evt);
        }}
        onNodeDragEnd={(n) => { if (n.locked) { n.fx = n.x; n.fy = n.y; } }}
        onLinkClick={(l, evt) => { if (!l?.isContext) onClickLink?.(l, evt); }}
        onBackgroundClick={() => { onClickNode?.(null); onClickLink?.(null); }}
        enableNodeDrag
        cooldownTime={physics ? 4000 : 0}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.32}
        backgroundColor="#ffffff"
      />
      {/* shift-drag marquee */}
      {marqueeBox && (
        <div className="ce-marquee" style={{
          left: Math.min(marqueeBox.x0, marqueeBox.x1), top: Math.min(marqueeBox.y0, marqueeBox.y1),
          width: Math.abs(marqueeBox.x1 - marqueeBox.x0), height: Math.abs(marqueeBox.y1 - marqueeBox.y0),
        }} />
      )}
      {/* (15) on-canvas verification legend */}
      <div className="ce-legend" aria-label="Edge verification legend">
        {Object.entries(VERIFICATION_STYLES).map(([tier, s]) => (
          <span key={tier} className="ce-legend__row">
            <svg width="26" height="6"><line x1="1" y1="3" x2="25" y2="3" stroke={s.color} strokeWidth="2.4"
              strokeDasharray={s.dash.join(',') || 'none'} /></svg>
            {tier}
          </span>
        ))}
      </div>
      {/* (2) minimap */}
      <canvas ref={miniRef} className="ce-minimap" width={190} height={132}
        aria-label="Graph minimap"
        onClick={(e) => {
          const g = miniToGraph(e);
          if (g) fgRef.current?.centerAt(g.x, g.y, 450);      // click-to-jump
        }}
        onWheel={(e) => {                                     // wheel zoom on minimap
          e.preventDefault();
          const fg = fgRef.current;
          if (!fg) return;
          fg.zoom(fg.zoom() * (e.deltaY < 0 ? 1.25 : 0.8), 220);
        }}
      />
      <div className="ce-navhint" aria-hidden>Space pan · dbl-click center · Shift+drag select · Ctrl+click lock · Alt+scroll timeline</div>
    </div>
  );
}
