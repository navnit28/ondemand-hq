import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { PLATFORM_COLORS, TIER_STYLES } from './adapter.js';
import * as d3f from 'd3-force-3d';

/**
 * CorrelationGraph — react-force-graph-2d canvas, Obsidian-futuristic on white.
 * V2 (2026-07-19) — navigation & clarity upgrade:
 * - CLUTTER FIX: d3 collide force sized to node radius + label clearance, so
 *   badges/labels never stack; label de-clutter pass hides captions that would
 *   overlap at the current zoom (screen-space grid dedupe).
 * - NAV (item 3): hold-Space = pan (drag disabled), double-click node = center,
 *   Shift+drag = rubber-band multi-select, scroll = zoom, ALT+scroll = timeline
 *   scrub (delegated up), CTRL+click = lock/unlock node (fx/fy pin + 🔒 ring).
 * - TIER GRAMMAR (item 18): Verified solid category color; Likely dashed violet;
 *   Possible dotted slate; Predicted long-dash fuchsia (adapter supplies dash).
 * - HEAT MODE (item 12): edge width = interaction count, glow = importance
 *   (weight), pulse = breaking evidence (weightClass 'breaking' on any backing
 *   evidence).
 * - hover-focus dims non-neighbors to ~15% (nodes AND edges), cursor pointer.
 * - zoomToFit(400, 60) exactly once per data load; zoom state preserved across
 *   expand-modal open/close via getZoomState/setZoomState (item 1 support).
 */
const CorrelationGraph = React.forwardRef(function CorrelationGraph({ graph, width, height, showLabels, physics,
  onHoverLink, onHoverNode, onClickLink, onClickNode, onNodeDouble, onAltScroll,
  onMultiSelect, searchNodeId, pulseKeys, heatMode, breakingIds, preserveZoom }, fwdRef) {
  const fgRef = useRef();
  const wrapRef = useRef();
  const [hover, setHover] = useState(null); // {kind:'node'|'link', id, link?}
  const imgCache = useRef(new Map());
  const pulseT = useRef(0);
  const fitDone = useRef(false);
  const spaceDown = useRef(false);
  const lockedIds = useRef(new Set());
  const lastClick = useRef({ id: null, t: 0 }); // manual dblclick detection
  const [selection, setSelection] = useState(null); // {x0,y0,x1,y1} screen coords
  const selecting = useRef(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const breathe = useRef(0); // heat-mode pulse phase

  // expose the fg instance upward (mini-map, expand modal zoom carry-over)
  useEffect(() => {
    if (fwdRef) fwdRef.current = {
      fg: () => fgRef.current,
      getZoomState: () => {
        const fg = fgRef.current;
        if (!fg) return null;
        try { return { k: fg.zoom(), cx: fg.centerAt().x, cy: fg.centerAt().y }; } catch { return null; }
      },
      setZoomState: (z) => {
        const fg = fgRef.current;
        if (!fg || !z) return;
        try { fg.centerAt(z.cx, z.cy, 0); fg.zoom(z.k, 0); fitDone.current = true; } catch { /* noop */ }
      },
    };
  }, [fwdRef]);

  // ?debug=1 test hook
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('debug') === '1') {
        window.__ceFg = { fg: fgRef.current, graph, wrap: wrapRef.current };
      }
    } catch { /* noop */ }
  }, [graph]);

  // pre-load IG proof thumbnails
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

  // CLUTTER FIX: collide force = node radius + label clearance
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('collide', d3f.forceCollide()
      .radius(n => (n.size / 2) + 14)
      .strength(0.9).iterations(2));
    fg.d3Force('charge')?.strength(-160);
    fg.d3Force('link')?.distance(l => 60 + (1 - (l.weight || 0.3)) * 60);
    fg.d3ReheatSimulation?.();
  }, [graph]);

  // neighbor index
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

  // zoomToFit(400,60) ONCE per data load — skipped when preserveZoom restores state
  useEffect(() => {
    if (preserveZoom) { fitDone.current = true; return; }
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
  }, [graph, preserveZoom]);

  // search → zoom
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

  // diff pulse
  useEffect(() => {
    if (!pulseKeys?.length) return;
    pulseT.current = performance.now();
    const t = setTimeout(() => { pulseT.current = 0; }, 3000);
    return () => clearTimeout(t);
  }, [pulseKeys]);

  // heat-mode breathing pulse re-render driver (bounded rAF only while on)
  useEffect(() => {
    if (!heatMode) return;
    let raf; let alive = true;
    const tick = () => { if (!alive) return; breathe.current = performance.now(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [heatMode]);

  // ---- item 3: keyboard/mouse navigation grammar ----
  useEffect(() => {
    const kd = (e) => {
      if (e.code === 'Space' && !e.repeat && wrapRef.current?.matches(':hover')) {
        spaceDown.current = true;
        const cv = wrapRef.current?.querySelector('canvas');
        if (cv) cv.style.cursor = 'grab';
        e.preventDefault();
      }
    };
    const ku = (e) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        const cv = wrapRef.current?.querySelector('canvas');
        if (cv) cv.style.cursor = 'default';
      }
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, []);

  // ALT+scroll = timeline scrub (capture-phase wheel on the wrapper)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.altKey) return;
      e.preventDefault(); e.stopPropagation();
      onAltScroll?.(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [onAltScroll]);

  // Shift+drag rubber-band multi-select
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const down = (e) => {
      if (!e.shiftKey || e.button !== 0) return;
      const r = el.getBoundingClientRect();
      selecting.current = { x0: e.clientX - r.left, y0: e.clientY - r.top };
      setSelection({ ...selecting.current, x1: selecting.current.x0, y1: selecting.current.y0 });
      e.preventDefault(); e.stopPropagation();
    };
    const move = (e) => {
      if (!selecting.current) return;
      const r = el.getBoundingClientRect();
      setSelection({ ...selecting.current, x1: e.clientX - r.left, y1: e.clientY - r.top });
    };
    const up = () => {
      if (!selecting.current) return;
      setSelection(sel => {
        if (sel && fgRef.current) {
          const { x0, y0, x1, y1 } = sel;
          const [minx, maxx] = [Math.min(x0, x1), Math.max(x0, x1)];
          const [miny, maxy] = [Math.min(y0, y1), Math.max(y0, y1)];
          const hit = new Set();
          for (const n of graph.nodes) {
            if (!Number.isFinite(n.x)) continue;
            const c = fgRef.current.graph2ScreenCoords(n.x, n.y);
            if (c.x >= minx && c.x <= maxx && c.y >= miny && c.y <= maxy) hit.add(n.id);
          }
          setSelectedIds(hit);
          onMultiSelect?.(graph.nodes.filter(n => hit.has(n.id)));
        }
        return null;
      });
      selecting.current = null;
    };
    el.addEventListener('mousedown', down, true);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      el.removeEventListener('mousedown', down, true);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [graph.nodes, onMultiSelect]);

  const idOf = (v) => (typeof v === 'object' ? v.id : v);

  const isDimNode = useCallback((n) => {
    if (n.dim) return true;
    if (selectedIds.size && !selectedIds.has(n.id)) return true;
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
  }, [hover, neighbors, selectedIds]);

  const isDimLink = useCallback((l) => {
    if (selectedIds.size && !(selectedIds.has(idOf(l.source)) && selectedIds.has(idOf(l.target)))) return true;
    if (!hover) return false;
    if (hover.kind === 'link') return hover.id !== l.id;
    if (hover.kind === 'node') return idOf(l.source) !== hover.id && idOf(l.target) !== hover.id;
    return false;
  }, [hover, selectedIds]);

  // screen-space label de-clutter: one label per 78×22px cell, priority = node size
  const labelGrid = useRef(new Map());
  const framePrep = useCallback((globalScale) => {
    labelGrid.current = new Map();
    return globalScale;
  }, []);

  const nodeCanvasObject = useCallback((n, ctx, globalScale) => {
    const dim = isDimNode(n);
    const alpha = dim ? 0.15 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    const r = n.size / 2;

    // cluster node (item 4): rounded-count disc with member ring
    if (n.kind === 'cluster') {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, 7);
      ctx.fillStyle = '#ede9fe'; ctx.fill();
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = n.clusterColor || '#8b5cf6';
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#4c1d95';
      ctx.font = `700 ${Math.max(5, r * 0.5)}px Montserrat, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n.memberIds?.length || ''), n.x, n.y);
      if (showLabels) {
        const fs = Math.max(3.4, 11 / globalScale);
        ctx.font = `600 ${fs}px Montserrat, sans-serif`;
        const tw = ctx.measureText(n.label).width;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(n.x - tw / 2 - 2, n.y + r + 4, tw + 4, fs + 2.5);
        ctx.fillStyle = '#4c1d95'; ctx.textBaseline = 'top';
        ctx.fillText(n.label, n.x, n.y + r + 5);
      }
      ctx.restore();
      return;
    }

    // halo
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 3.5, 0, 7);
    ctx.fillStyle = n.tint || '#eef2ff';
    ctx.fill();

    const mediaUrl = n.media?.[0]?.url;
    const img = mediaUrl ? imgCache.current.get(mediaUrl) : null;
    const imgReady = img && img.complete && img.naturalWidth > 0;

    // body
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 7);
    ctx.fillStyle = n.kind === 'country' ? '#111827'
      : n.kind === 'country-side' ? '#374151' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = n.kind === 'country' ? 0 : 1.4;
    ctx.strokeStyle = n.tintStroke || '#c7d2fe';
    if (n.kind !== 'country') ctx.stroke();
    if (hover?.kind === 'node' && hover.id === n.id) {
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#6d4aff'; ctx.stroke();
    }
    if (selectedIds.has(n.id)) {
      ctx.lineWidth = 2.2; ctx.strokeStyle = '#0ea5e9'; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    // CTRL+click lock ring
    if (lockedIds.current.has(n.id)) {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 6.5, 0, 7);
      ctx.lineWidth = 1.6; ctx.strokeStyle = '#f59e0b'; ctx.setLineDash([2, 2.6]); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `${Math.max(5, 8 / globalScale)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b45309';
      ctx.fillText('🔒', n.x + r + 8, n.y - r - 2);
    }

    if (imgReady) {
      ctx.save();
      ctx.beginPath(); ctx.arc(n.x, n.y - r - 7, 7, 0, 7); ctx.clip();
      ctx.drawImage(img, n.x - 7, n.y - r - 14, 14, 14);
      ctx.restore();
      ctx.beginPath(); ctx.arc(n.x, n.y - r - 7, 7, 0, 7);
      ctx.strokeStyle = '#d62976'; ctx.lineWidth = 1; ctx.stroke();
    }

    // initials
    const label = (n.kind === 'country' || n.kind === 'country-side')
      ? n.label.slice(0, 2).toUpperCase()
      : n.label.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    ctx.fillStyle = (n.kind === 'country' || n.kind === 'country-side') ? '#ffffff' : '#1f2937';
    ctx.font = `600 ${Math.max(4, r * 0.72)}px Montserrat, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, n.x, n.y);

    // label with screen-space de-clutter (VISUAL QA GATE: no overlapping text)
    if (showLabels) {
      const c = fgRef.current?.graph2ScreenCoords?.(n.x, n.y + r + 6);
      let show = true;
      if (c) {
        const cell = `${Math.round(c.x / 78)}:${Math.round(c.y / 22)}`;
        const prev = labelGrid.current.get(cell);
        if (prev && prev !== n.id && (graph.nodes.find(x => x.id === prev)?.size || 0) >= n.size) show = false;
        else labelGrid.current.set(cell, n.id);
      }
      if (show || n.kind !== 'entity' || (hover?.kind === 'node' && hover.id === n.id)) {
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
    }
    // evidence badge — OUTSIDE the label band (top-right), only when non-zero and not dimmed
    if (n.evidenceCount > 0 && !dim) {
      ctx.beginPath();
      ctx.arc(n.x + r + 4, n.y - r - 4, 5.2, 0, 7);
      ctx.fillStyle = '#6d4aff'; ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 6.5px Montserrat, sans-serif';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(String(n.evidenceCount > 9 ? '9+' : n.evidenceCount), n.x + r + 4, n.y - r - 3.6);
    }
    ctx.restore();
  }, [hover, isDimNode, showLabels, selectedIds, graph.nodes]);

  // curve helpers
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
    const s = typeof l.source === 'object' ? l.source : null;
    const t = typeof l.target === 'object' ? l.target : null;
    if (!s || !t) return;
    const hovered = hover?.kind === 'link' && hover.id === l.id;
    const dim = isDimLink(l);
    const isPulse = pulseT.current && pulseKeys?.includes(l.id);
    const isBreaking = heatMode && breakingIds?.has(l.id);
    const c = curveControl(s, t, l.curvature);
    ctx.save();

    // HEAT MODE: width = interactions, glow = importance, pulse = breaking
    let width = hovered ? l.width + 1.6 : l.width;
    if (heatMode && !l.isContext) {
      width = 0.8 + Math.min(8, (l.interactions || 1) * 1.15);
      ctx.shadowColor = l.color || '#a78bfa';
      ctx.shadowBlur = 4 + (l.weight || 0) * 22;
      if (isBreaking) {
        const ph = (Math.sin((breathe.current || 0) / 260) + 1) / 2;
        ctx.shadowBlur += ph * 18;
        width += ph * 1.6;
      }
    } else if (isPulse) { ctx.shadowColor = l.color; ctx.shadowBlur = 14; }

    ctx.globalAlpha = (dim ? 0.12 : 1) * (l.opacity ?? 1);
    ctx.strokeStyle = l.color;
    ctx.lineWidth = width;
    if (l.isContext) ctx.setLineDash([3, 4]);
    else if (l.dash) ctx.setLineDash(l.dash);           // V2 tier dash grammar
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    if (l.curvature) ctx.quadraticCurveTo(c.cx, c.cy, t.x, t.y);
    else ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    if (!l.isContext) {
      const arrowSize = Math.max(9, width * 3.2);
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
        for (const u of [0.28, 0.72]) {
          const p = curvePoint(s, t, c, u);
          const q = curvePoint(s, t, c, u - 0.04);
          const a2 = Math.atan2(p.y - q.y, p.x - q.x);
          drawArrowhead(ctx, p, a2, l.color, arrowSize * 0.72);
        }
      }

      // on-edge caption: category · weight · evidence (+tier when inferred, +🔥 heat)
      const mid = curvePoint(s, t, c, 0.5);
      const capBits = [`${l.type}`];
      if (l.tier && l.tier !== 'Verified') capBits.push(l.tier);
      capBits.push(`w${(l.weight ?? 0).toFixed(2)}`, `${l.evidenceIds?.length || 0}ev`);
      if (heatMode) capBits.push(`${l.interactions || 0}×`);
      const caption = capBits.join(' · ');
      const fs = Math.max(4, 11 / globalScale);
      ctx.font = `700 ${fs}px Montserrat, sans-serif`;
      const tw = ctx.measureText(caption).width;
      ctx.globalAlpha = dim ? 0.12 : 0.95;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      const padX = 3, padY = 1.5;
      ctx.fillRect(mid.x - tw / 2 - padX, mid.y - fs / 2 - padY, tw + padX * 2, fs + padY * 2);
      ctx.strokeStyle = l.color; ctx.lineWidth = 0.6;
      if (l.dash) ctx.setLineDash(l.dash);
      ctx.strokeRect(mid.x - tw / 2 - padX, mid.y - fs / 2 - padY, tw + padX * 2, fs + padY * 2);
      ctx.setLineDash([]);
      ctx.fillStyle = l.color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(caption, mid.x, mid.y);

      ctx.globalAlpha = dim ? 0.12 : 1;
      (l.platforms || []).slice(0, 4).forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(mid.x + (i - ((Math.min(l.platforms.length, 4) - 1) / 2)) * 9, mid.y + fs + 5, 3.4, 0, 7);
        ctx.fillStyle = PLATFORM_COLORS[p] || '#9ca3af';
        ctx.fill();
      });
      if (l.contradiction) {
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#b45309';
        ctx.fillText('⚠', mid.x, mid.y + fs + 14);
      }
    }
    ctx.restore();
  }, [hover, isDimLink, pulseKeys, heatMode, breakingIds]);

  const linkPointerAreaPaint = useCallback((l, color, ctx) => {
    const s = typeof l.source === 'object' ? l.source : null;
    const t = typeof l.target === 'object' ? l.target : null;
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
    if (cv && !spaceDown.current) cv.style.cursor = on ? 'pointer' : 'default';
  };

  return (
    <div ref={wrapRef} className="ce-canvas" style={{ position: 'relative' }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graph}
        width={width} height={height}
        onRenderFramePre={(ctx, globalScale) => framePrep(globalScale)}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.size / 2 + 4, 0, 7);
          ctx.fill();
        }}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={() => 'replace'}
        linkPointerAreaPaint={linkPointerAreaPaint}
        linkDirectionalParticles={(l) => (heatMode ? 0 : l.particles)}
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
        onNodeClick={(n, evt) => {
          if (evt?.ctrlKey && n) {           // CTRL+click = lock/unlock
            if (lockedIds.current.has(n.id)) {
              lockedIds.current.delete(n.id);
              n.fx = undefined; n.fy = undefined;
            } else {
              lockedIds.current.add(n.id);
              n.fx = n.x; n.fy = n.y;
            }
            fgRef.current?.d3ReheatSimulation?.();
            return;
          }
          // manual double-click detection (react-force-graph has no dblclick prop):
          // two clicks on the SAME node within 350ms = center+zoom on it
          const now = performance.now();
          const lc = lastClick.current;
          if (n && lc.id === n.id && now - lc.t < 350) {
            lastClick.current = { id: null, t: 0 };
            fgRef.current?.centerAt(n.x, n.y, 500);
            fgRef.current?.zoom(Math.max(2.2, fgRef.current.zoom()), 500);
            onNodeDouble?.(n);
            return;
          }
          lastClick.current = { id: n?.id || null, t: now };
          if (selectedIds.size) setSelectedIds(new Set());
          onClickNode?.(n, evt);
        }}
        onLinkClick={(l, evt) => { if (!l?.isContext) onClickLink?.(l, evt); }}
        onBackgroundClick={() => {
          if (selectedIds.size) { setSelectedIds(new Set()); onMultiSelect?.([]); }
          onClickNode?.(null); onClickLink?.(null);
        }}
        enableNodeDrag={!spaceDown.current}
        enablePanInteraction
        cooldownTime={physics ? 4000 : 0}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.32}
        backgroundColor="#ffffff"
      />
      {selection && (
        <div className="ce-rubber" style={{
          left: Math.min(selection.x0, selection.x1), top: Math.min(selection.y0, selection.y1),
          width: Math.abs(selection.x1 - selection.x0), height: Math.abs(selection.y1 - selection.y0),
        }} />
      )}
    </div>
  );
});

export default CorrelationGraph;
