import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { PLATFORM_COLORS, EDGE_CLASS_STYLE } from '../adapter.js';
import { nodeLatLon, project, GEO_CATEGORY, GEO_CATEGORY_STYLE, LAND_BLOBS } from './geo.js';

/**
 * GraphCanvasV2 — Correlation Engine V2 canvas.
 * Adds on top of V1: minimap (F2), nav controls (F3: Space=pan, dbl-click center,
 * Shift+drag multi-select, ALT+scroll timeline scrub, CTRL+click lock), cluster
 * pills (F4 rendering), rich-media nodes (F7), Heat Mode (F11: interactions→width,
 * importance→glow, breaking-news pulse), Geographic Overlay (F12: Meridian Loom
 * world map + categorized animated connections).
 * Preserves the QA gate: white ODA canvas, 15% hover dim, weight→size,
 * width→strength, color→type, halos, labels on hover/zoom only.
 */
export default function GraphCanvasV2({
  graph, run, width, height, showLabels, physics,
  heatMode, geoMode, breakingIds,
  onHoverNode, onHoverLink, onClickNode, onClickLink, onDblClickNode,
  onAltScroll, onSelectNodes, searchNodeId, pulseKeys, fgApiRef, isFullscreen,
}) {
  const fgRef = useRef();
  const wrapRef = useRef();
  const miniRef = useRef();
  const [hover, setHover] = useState(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selection, setSelection] = useState(new Set()); // F3 multi-select
  const [selRect, setSelRect] = useState(null);
  const lockedRef = useRef(new Set());                    // F3 CTRL+click lock
  const imgCache = useRef(new Map());
  const pulseT = useRef(0);
  const zoomState = useRef({ k: 1, x: 0, y: 0 });

  // expose imperative API upward (fullscreen zoom memory F1, minimap jump F2)
  useEffect(() => {
    if (fgApiRef) fgApiRef.current = {
      fg: () => fgRef.current,
      getZoom: () => zoomState.current,
      setZoom: (k, ms = 0) => fgRef.current?.zoom(k, ms),
      centerAt: (x, y, ms = 0) => fgRef.current?.centerAt(x, y, ms),
      zoomToFit: (ms = 600) => fgRef.current?.zoomToFit(ms, 42),
    };
  }, [fgApiRef]);

  // media preload (F7 — images, logos, maps, charts, doc thumbs)
  useEffect(() => {
    for (const n of graph.nodes) {
      for (const m of (n.media || []).slice(0, 2)) {
        if (m.url && !imgCache.current.has(m.url)) {
          const img = new Image();
          img.src = m.url;
          imgCache.current.set(m.url, img);
        }
      }
    }
  }, [graph.nodes]);

  // ---- F3 keyboard: Space=pan / ESC clears selection ----
  useEffect(() => {
    const down = (e) => {
      if (e.code === 'Space' && !/input|textarea/i.test(e.target.tagName)) { setSpaceHeld(true); e.preventDefault(); }
      if (e.key === 'Escape') { setSelection(new Set()); onSelectNodes?.([]); }
    };
    const up = (e) => { if (e.code === 'Space') setSpaceHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [onSelectNodes]);

  // ---- F3 ALT+scroll = timeline scrub (blocks canvas zoom) ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (e.altKey) { e.preventDefault(); e.stopPropagation(); onAltScroll?.(e.deltaY > 0 ? 1 : -1); }
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [onAltScroll]);

  // ---- F3 double-click = center on nearest node ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onDbl = (e) => {
      if (!fgRef.current) return;
      const r = el.getBoundingClientRect();
      const g = fgRef.current.screen2GraphCoords(e.clientX - r.left, e.clientY - r.top);
      let best = null, bd = Infinity;
      for (const n of graph.nodes) {
        if (!Number.isFinite(n.x)) continue;
        const d = Math.hypot(n.x - g.x, n.y - g.y);
        if (d < bd) { bd = d; best = n; }
      }
      if (best && bd < 40) {
        fgRef.current.centerAt(best.x, best.y, 550);
        fgRef.current.zoom(Math.max(zoomState.current.k, 2.6), 550);
        onDblClickNode?.(best);
      }
    };
    el.addEventListener('dblclick', onDbl);
    return () => el.removeEventListener('dblclick', onDbl);
  }, [graph.nodes, onDblClickNode]);

  // ---- F3 Shift+drag rubber-band multi-select ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let start = null;
    const dn = (e) => { if (e.shiftKey && e.button === 0) { const r = el.getBoundingClientRect(); start = { x: e.clientX - r.left, y: e.clientY - r.top }; setSelRect({ ...start, w: 0, h: 0 }); e.stopPropagation(); } };
    const mv = (e) => { if (!start) return; const r = el.getBoundingClientRect(); const cx = e.clientX - r.left, cy = e.clientY - r.top; setSelRect({ x: Math.min(start.x, cx), y: Math.min(start.y, cy), w: Math.abs(cx - start.x), h: Math.abs(cy - start.y) }); };
    const upH = () => {
      if (!start) return;
      setSelRect(rect => {
        if (rect && rect.w > 6 && rect.h > 6 && fgRef.current) {
          const picked = new Set();
          for (const n of graph.nodes) {
            const p = fgRef.current.graph2ScreenCoords(n.x, n.y);
            if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) picked.add(n.id);
          }
          setSelection(picked);
          onSelectNodes?.([...picked]);
        }
        return null;
      });
      start = null;
    };
    el.addEventListener('mousedown', dn, true);
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', upH);
    return () => { el.removeEventListener('mousedown', dn, true); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', upH); };
  }, [graph.nodes, onSelectNodes]);

  // neighbor index (hover dim @15% — QA gate)
  const neighbors = useMemo(() => {
    const map = new Map();
    for (const l of graph.links) {
      const s = l.source.id ?? l.source, t = l.target.id ?? l.target;
      (map.get(s) || map.set(s, new Set()).get(s)).add(t);
      (map.get(t) || map.set(t, new Set()).get(t)).add(s);
    }
    return map;
  }, [graph.links]);

  // zoomToFit on data change (skip in fullscreen restore — parent drives zoom)
  useEffect(() => {
    if (isFullscreen === 'restoring') return;
    let tries = 0;
    const timer = setInterval(() => {
      const fg = fgRef.current;
      if (!fg) return;
      try {
        const bbox = fg.getGraphBbox?.();
        if (bbox && bbox.x && bbox.x[1] > bbox.x[0]) { fg.zoomToFit(700, 42); clearInterval(timer); }
      } catch { /* laying out */ }
      if (++tries > 40) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [graph, geoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!searchNodeId || !fgRef.current) return;
    const n = graph.nodes.find(x => x.id === searchNodeId);
    if (n && Number.isFinite(n.x)) { fgRef.current.centerAt(n.x, n.y, 700); fgRef.current.zoom(3.2, 700); }
  }, [searchNodeId, graph.nodes]);

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

  // ---- F12 geo pinning: when geoMode, fix nodes at projected world coords ----
  const GEO_W = 1000, GEO_H = 520;
  useEffect(() => {
    if (!run) return;
    for (const n of graph.nodes) {
      if (geoMode) {
        const [px, py] = project(nodeLatLon(n, run.countryIso || run.country), GEO_W, GEO_H);
        n.fx = px - GEO_W / 2; n.fy = py - GEO_H / 2;
      } else if (!lockedRef.current.has(n.id)) {
        n.fx = undefined; n.fy = undefined;
      }
    }
    fgRef.current?.d3ReheatSimulation?.();
  }, [geoMode, graph.nodes, run]);

  const isDimNode = useCallback((n) => {
    if (n.dim) return true;
    if (selection.size && !selection.has(n.id)) return true;
    if (!hover) return false;
    if (hover.kind === 'node') return hover.id !== n.id && !(neighbors.get(hover.id)?.has(n.id));
    if (hover.kind === 'link') {
      const l = hover.link;
      const s = l.source.id ?? l.source, t = l.target.id ?? l.target;
      return n.id !== s && n.id !== t;
    }
    return false;
  }, [hover, neighbors, selection]);

  // ---------- painters ----------
  const nodeCanvasObject = useCallback((n, ctx, globalScale) => {
    const dim = isDimNode(n);
    ctx.save();
    ctx.globalAlpha = dim ? 0.15 : 1;

    // F4 — cluster pill rendering
    if (n.kind === 'pill') {
      const label = `${n.label} (${n.memberCount}) ▼`;
      ctx.font = `600 ${Math.max(10, 12 / Math.sqrt(globalScale))}px Montserrat, sans-serif`;
      const tw = ctx.measureText(label).width;
      const w = tw + 22, h = 22 / Math.min(1.6, Math.max(0.7, globalScale * 0.9));
      ctx.beginPath();
      ctx.roundRect(n.x - w / 2, n.y - h / 2, w, h, h / 2);
      ctx.fillStyle = n.tint || '#eef2ff';
      ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = n.tintStroke || '#c7d2fe'; ctx.stroke();
      if (hover?.kind === 'node' && hover.id === n.id) { ctx.lineWidth = 2.2; ctx.strokeStyle = '#6d4aff'; ctx.stroke(); }
      ctx.fillStyle = '#1f2937';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, n.x, n.y + 0.5);
      n.__pillW = w; n.__pillH = h;
      ctx.restore();
      return;
    }

    const r = n.size / 2;
    // halo (key entities — QA gate)
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 3.5, 0, 2 * Math.PI);
    ctx.fillStyle = n.tint || '#eef2ff';
    ctx.fill();
    // F11 breaking-news pulse ring
    if (heatMode && breakingIds?.has(n.id)) {
      const ph = (performance.now() % 1400) / 1400;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 4 + ph * 10, 0, 2 * Math.PI);
      ctx.strokeStyle = `rgba(220,38,38,${0.55 * (1 - ph)})`;
      ctx.lineWidth = 2; ctx.stroke();
    }
    // body
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = n.kind === 'country' ? '#111827' : '#ffffff';
    ctx.fill();
    if (n.kind !== 'country') { ctx.lineWidth = 1.4; ctx.strokeStyle = n.tintStroke || '#c7d2fe'; ctx.stroke(); }
    if (hover?.kind === 'node' && hover.id === n.id) { ctx.lineWidth = 2; ctx.strokeStyle = '#6d4aff'; ctx.stroke(); }
    // F3 — locked-position padlock tick
    if (lockedRef.current.has(n.id)) {
      ctx.beginPath();
      ctx.arc(n.x - r * 0.85, n.y - r * 0.85, 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#111827'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 6px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🔒'.length ? 'L' : 'L', n.x - r * 0.85, n.y - r * 0.85 + 0.5);
    }
    // F7 — rich media chip (image/logo/map/chart/doc/tweet/satellite)
    const m0 = n.media?.[0];
    const img = m0?.url ? imgCache.current.get(m0.url) : null;
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath(); ctx.arc(n.x, n.y - r - 7, 7, 0, 2 * Math.PI); ctx.clip();
      ctx.drawImage(img, n.x - 7, n.y - r - 14, 14, 14);
      ctx.restore();
      ctx.beginPath(); ctx.arc(n.x, n.y - r - 7, 7, 0, 2 * Math.PI);
      ctx.strokeStyle = m0.mediaKind === 'satellite' ? '#0e9f6e' : '#d62976';
      ctx.lineWidth = 1; ctx.stroke();
    } else if (m0?.mediaKind) {
      const glyph = { video: '▶', doc: '📄', pdf: '📄', tweet: '𝕏', map: '📍', chart: '📊', gov: '🏛', satellite: '🛰' }[m0.mediaKind];
      if (glyph) {
        ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#374151';
        ctx.fillText(glyph, n.x, n.y - r - 7);
      }
    }
    // initials
    const label = n.kind === 'country' ? n.label.slice(0, 2).toUpperCase()
      : n.label.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    ctx.fillStyle = n.kind === 'country' ? '#ffffff' : '#1f2937';
    ctx.font = `600 ${Math.max(4, r * 0.72)}px Montserrat, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, n.x, n.y);
    // labels on hover/zoom only (QA gate): country + top-5 by weight always at zoom>1.05
    const isTop = n.__top5;
    if (showLabels && (n.kind === 'country' || (hover?.kind === 'node' && hover.id === n.id) || (globalScale > 1.05 && isTop) || globalScale > 2)) {
      ctx.font = `500 ${11 / globalScale}px Montserrat, sans-serif`;
      ctx.fillStyle = dim ? 'rgba(55,65,81,0.35)' : '#374151';
      ctx.textBaseline = 'top';
      ctx.fillText(n.label, n.x, n.y + r + 3);
    }
    if (n.evidenceCount > 0 && !dim) {
      ctx.beginPath();
      ctx.arc(n.x + r * 0.8, n.y - r * 0.8, 5.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#6d4aff'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 7px Montserrat, sans-serif';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(String(n.evidenceCount > 9 ? '9+' : n.evidenceCount), n.x + r * 0.8, n.y - r * 0.8 + 0.5);
    }
    // selection ring (F3)
    if (selection.has(n.id)) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 6, 0, 2 * Math.PI);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#6d4aff'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }, [hover, isDimNode, showLabels, heatMode, breakingIds, selection]);

  const linkCanvasObject = useCallback((l, ctx) => {
    const s = typeof l.source === 'object' ? l.source : null;
    const t = typeof l.target === 'object' ? l.target : null;
    if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(t.x)) return;
    const hovered = hover?.kind === 'link' && hover.id === l.id;
    const dimmed = hover && !hovered && hover.kind === 'link';
    const isPulse = pulseT.current && pulseKeys?.includes(l.id);
    const geoStyle = geoMode ? GEO_CATEGORY_STYLE[GEO_CATEGORY[l.type] || 'trade'] : null;
    // CE-V2 stage-5 edge classification: Verified solid / Likely long-dash /
    // Possible short-dash / Predicted dotted (+ alpha taper by certainty)
    const clsStyle = l.edgeClass ? EDGE_CLASS_STYLE[l.edgeClass] : null;
    ctx.save();
    ctx.globalAlpha = (dimmed ? 0.12 : 1) * (l.opacity ?? 1) * (clsStyle?.alphaMul ?? 1);
    ctx.strokeStyle = geoStyle ? geoStyle.color : l.color;
    // F11 heat: interaction count → width; importance → glow
    const baseW = heatMode ? (l.heatWidth ?? l.width) : l.width;
    ctx.lineWidth = hovered ? baseW + 1.6 : baseW;
    if (heatMode) { ctx.shadowColor = l.color; ctx.shadowBlur = l.heatGlow ?? 6; }
    if (isPulse) { ctx.shadowColor = l.color; ctx.shadowBlur = 14; }
    if (geoStyle?.dash?.length) ctx.setLineDash(geoStyle.dash);
    else if (clsStyle?.dash?.length) ctx.setLineDash(clsStyle.dash);
    ctx.beginPath();
    if (geoMode) {
      // great-circle-ish arc on the map
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2 - Math.hypot(t.x - s.x, t.y - s.y) * 0.18;
      ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(mx, my, t.x, t.y);
    } else if (l.curvature) {
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const dx = t.x - s.x, dy = t.y - s.y;
      const nx = -dy, ny = dx, len = Math.hypot(nx, ny) || 1;
      ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(mx + (nx / len) * l.curvature * 60, my + (ny / len) * l.curvature * 60, t.x, t.y);
    } else { ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    if (!geoMode && l.direction !== 'both') {
      const from = l.direction === 'b->a' ? t : s;
      const to = l.direction === 'b->a' ? s : t;
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      const ax = to.x - Math.cos(ang) * ((to.size || 8) / 2 + 3), ay = to.y - Math.sin(ang) * ((to.size || 8) / 2 + 3);
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 6 * Math.cos(ang - 0.45), ay - 6 * Math.sin(ang - 0.45));
      ctx.lineTo(ax - 6 * Math.cos(ang + 0.45), ay - 6 * Math.sin(ang + 0.45));
      ctx.fill();
    }
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    if (!geoMode) (l.platforms || []).slice(0, 4).forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(mx + (i - ((l.platforms.length - 1) / 2)) * 9, my - 6, 4, 0, 2 * Math.PI);
      ctx.fillStyle = PLATFORM_COLORS[p] || '#9ca3af';
      ctx.fill();
    });
    if (l.contradiction) { ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('⚠', mx, my + 10); }
    // CE-V2 class accent tick at midpoint (Verified/Likely/Possible/Predicted)
    if (clsStyle && !geoMode) {
      ctx.beginPath();
      ctx.arc(mx, my + 6, 2.6, 0, 2 * Math.PI);
      ctx.fillStyle = clsStyle.accent;
      ctx.fill();
    }
    ctx.restore();
  }, [hover, pulseKeys, heatMode, geoMode]);

  // ---- F12 background: Meridian Loom stylized world map ----
  const onRenderFramePre = useCallback((ctx, globalScale) => {
    if (!geoMode) return;
    ctx.save();
    ctx.translate(-GEO_W / 2, -GEO_H / 2);
    ctx.globalAlpha = 0.55;
    // graticule
    ctx.strokeStyle = '#eef1f6'; ctx.lineWidth = 0.6 / globalScale;
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x] = project([0, lon], GEO_W, GEO_H);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, GEO_H); ctx.stroke();
    }
    for (let lat = -60; lat <= 80; lat += 20) {
      const [, y] = project([lat, 0], GEO_W, GEO_H);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(GEO_W, y); ctx.stroke();
    }
    // landmass blobs
    ctx.fillStyle = '#f3f5f9'; ctx.strokeStyle = '#e2e7ef'; ctx.lineWidth = 1 / globalScale;
    for (const blob of LAND_BLOBS) {
      ctx.beginPath();
      blob.forEach(([la, lo], i) => {
        const [x, y] = project([la, lo], GEO_W, GEO_H);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }, [geoMode]);

  // ---- F2 minimap ----
  useEffect(() => {
    const cv = miniRef.current;
    const fg = fgRef.current;
    if (!cv || !fg) return;
    let raf;
    const MW = 168, MH = 108;
    const draw = () => {
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, MW, MH);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(0, 0, MW, MH);
      const xs = graph.nodes.map(n => n.x).filter(Number.isFinite);
      const ys = graph.nodes.map(n => n.y).filter(Number.isFinite);
      if (xs.length > 1) {
        const minX = Math.min(...xs) - 30, maxX = Math.max(...xs) + 30;
        const minY = Math.min(...ys) - 30, maxY = Math.max(...ys) + 30;
        const sc = Math.min(MW / (maxX - minX), MH / (maxY - minY));
        const ox = (MW - (maxX - minX) * sc) / 2, oy = (MH - (maxY - minY) * sc) / 2;
        cv.__map = { minX, minY, sc, ox, oy };
        // edges
        ctx.strokeStyle = 'rgba(160,170,190,0.5)'; ctx.lineWidth = 0.5;
        for (const l of graph.links) {
          const s = typeof l.source === 'object' ? l.source : null, t = typeof l.target === 'object' ? l.target : null;
          if (!s || !t || !Number.isFinite(s.x)) continue;
          ctx.beginPath();
          ctx.moveTo(ox + (s.x - minX) * sc, oy + (s.y - minY) * sc);
          ctx.lineTo(ox + (t.x - minX) * sc, oy + (t.y - minY) * sc);
          ctx.stroke();
        }
        for (const n of graph.nodes) {
          if (!Number.isFinite(n.x)) continue;
          ctx.beginPath();
          ctx.arc(ox + (n.x - minX) * sc, oy + (n.y - minY) * sc, n.kind === 'country' ? 3 : Math.max(1, n.size * sc * 0.4), 0, 2 * Math.PI);
          ctx.fillStyle = n.kind === 'country' ? '#111827' : (n.tintStroke || '#94a3b8');
          ctx.fill();
        }
        // viewport rectangle
        try {
          const tl = fg.screen2GraphCoords(0, 0);
          const br = fg.screen2GraphCoords(width, height);
          ctx.strokeStyle = '#6d4aff'; ctx.lineWidth = 1.2;
          ctx.strokeRect(ox + (tl.x - minX) * sc, oy + (tl.y - minY) * sc, (br.x - tl.x) * sc, (br.y - tl.y) * sc);
        } catch { /* not ready */ }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [graph, width, height]);

  const miniJump = (e) => {
    const cv = miniRef.current;
    const m = cv?.__map;
    if (!m || !fgRef.current) return;
    const r = cv.getBoundingClientRect();
    const gx = (e.clientX - r.left - m.ox) / m.sc + m.minX;
    const gy = (e.clientY - r.top - m.oy) / m.sc + m.minY;
    fgRef.current.centerAt(gx, gy, 420);
  };
  const miniWheel = (e) => {
    e.preventDefault();
    const z = zoomState.current.k * (e.deltaY < 0 ? 1.25 : 0.8);
    fgRef.current?.zoom(Math.max(0.05, Math.min(12, z)), 200);
  };

  return (
    <div ref={wrapRef} className={`ce-canvas ce-canvas--v2${spaceHeld ? ' ce-canvas--pan' : ''}`}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graph}
        width={width} height={height}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color;
          if (n.kind === 'pill') {
            const w = n.__pillW || 80, h = n.__pillH || 22;
            ctx.fillRect(n.x - w / 2, n.y - h / 2, w, h);
          } else {
            ctx.beginPath(); ctx.arc(n.x, n.y, n.size / 2 + 4, 0, 2 * Math.PI); ctx.fill();
          }
        }}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={() => 'replace'}
        linkDirectionalParticles={(l) => (heatMode ? Math.min(6, (l.interactions || 1)) : l.particles)}
        linkDirectionalParticleSpeed={(l) => l.particleSpeed}
        linkDirectionalParticleWidth={heatMode ? 2.4 : 1.8}
        linkDirectionalParticleColor={(l) => l.color}
        onRenderFramePre={onRenderFramePre}
        onZoom={(z) => { zoomState.current = z; }}
        onNodeHover={(n) => { setHover(n ? { kind: 'node', id: n.id } : null); onHoverNode?.(n); }}
        onLinkHover={(l) => { setHover(l ? { kind: 'link', id: l.id, link: l } : null); onHoverLink?.(l); }}
        onNodeClick={(n, evt) => {
          if (evt?.ctrlKey && n) {           // F3 CTRL+click = lock/unlock position
            if (lockedRef.current.has(n.id)) { lockedRef.current.delete(n.id); n.fx = undefined; n.fy = undefined; }
            else { lockedRef.current.add(n.id); n.fx = n.x; n.fy = n.y; }
            return;
          }
          onClickNode?.(n, evt);
        }}
        onNodeRightClick={(n) => onDblClickNode?.(n)}
        onLinkClick={(l, evt) => onClickLink?.(l, evt)}
        onBackgroundClick={() => { onClickNode?.(null); onClickLink?.(null); setSelection(new Set()); onSelectNodes?.([]); }}
        onNodeDragEnd={(n) => { if (lockedRef.current.has(n.id)) { n.fx = n.x; n.fy = n.y; } }}
        enableNodeDrag={!spaceHeld}
        enablePanInteraction
        cooldownTime={physics && !geoMode ? 4000 : 0}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.32}
        backgroundColor="#ffffff"
      />
      {selRect && <div className="ce-selrect" style={{ left: selRect.x, top: selRect.y, width: selRect.w, height: selRect.h }} />}
      {/* F2 minimap */}
      <div className="ce-minimap" onClick={miniJump} onWheel={miniWheel} title="Mini map — click to jump, scroll to zoom">
        <canvas ref={miniRef} width={168} height={108} />
      </div>
      {/* F3 hint strip */}
      <div className="ce-navhints">Space pan · 2×click center · Shift+drag select · Ctrl+click lock · Alt+scroll timeline</div>
    </div>
  );
}
