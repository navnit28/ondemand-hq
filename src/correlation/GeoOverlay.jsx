// GeoOverlay.jsx — (13) Geographic Overlay (2026-07-19 V2): equirectangular world
// map drawn with d3-geo-free canvas primitives (no tile service — offline-safe),
// nodes placed at country/UAE anchors, animated connection arcs typed as
// flight/shipping/trade/military/diplomacy/investment/aid.
import React, { useEffect, useRef } from 'react';
import { ARC_COLORS } from './adapter.js';

// Coarse country anchor coords (lon, lat) — UAE + the 16 monitored countries.
const ANCHORS = {
  AE: [54.0, 24.0], KE: [37.9, 0.0], EG: [30.8, 26.8], JO: [36.2, 31.2], PK: [69.3, 30.4],
  MA: [-7.1, 31.8], ID: [113.9, -0.8], BD: [90.4, 23.7], SD: [30.2, 12.9], SO: [46.2, 5.2],
  ET: [39.6, 9.1], LB: [35.9, 33.9], SY: [38.5, 35.0], YE: [48.0, 15.6], UG: [32.3, 1.4],
  TZ: [34.9, -6.4], RW: [29.9, -2.0],
};
// Very coarse continent outlines (lon,lat polylines) for context — schematic, not GIS.
const OUTLINES = [
  // Africa
  [[-17, 15], [-5, 35], [10, 37], [32, 31], [43, 11], [51, 10], [40, -16], [35, -34], [18, -34], [12, -18], [8, 4], [-17, 15]],
  // Arabia + Middle East
  [[34, 28], [36, 36], [48, 39], [60, 25], [59, 22], [56, 24], [51, 24], [48, 28], [44, 12], [34, 28]],
  // South & SE Asia
  [[60, 25], [67, 24], [72, 20], [77, 8], [80, 15], [88, 22], [92, 20], [98, 8], [104, 1], [114, -8], [120, -9], [117, 5], [100, 14], [92, 27], [75, 35], [60, 25]],
  // Europe (partial)
  [[-10, 36], [0, 44], [15, 45], [30, 46], [40, 45], [30, 60], [10, 58], [-10, 50], [-10, 36]],
];

export default function GeoOverlay({ run, iso, links, width, height, onClickLink }) {
  const cvRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    // fit projection to region of interest: lon -20..125, lat -40..62
    const LON0 = -20, LON1 = 125, LAT0 = 62, LAT1 = -40;
    const px = (lon) => ((lon - LON0) / (LON1 - LON0)) * width;
    const py = (lat) => ((lat - LAT0) / (LAT1 - LAT0)) * height;

    const uae = ANCHORS.AE;
    const tgt = ANCHORS[iso] || [37, 0];
    // node geo positions: UAE entities near UAE, country-side near country, spread on a ring
    const pos = {};
    const uaeNodes = run.nodes.filter(n => n.kind !== 'country' && n.kind !== 'country-side');
    const sideNodes = run.nodes.filter(n => n.kind === 'country-side');
    uaeNodes.forEach((n, i) => {
      const a = (i / Math.max(1, uaeNodes.length)) * 2 * Math.PI;
      pos[n.id] = [uae[0] + Math.cos(a) * 4.5, uae[1] + Math.sin(a) * 3.4];
    });
    sideNodes.forEach((n, i) => {
      const a = (i / Math.max(1, sideNodes.length)) * 2 * Math.PI;
      pos[n.id] = [tgt[0] + Math.cos(a) * 4.5, tgt[1] + Math.sin(a) * 3.4];
    });
    const country = run.nodes.find(n => n.kind === 'country');
    if (country) pos[country.id] = tgt;

    const arcs = links.filter(l => !l.isContext).map(l => {
      const a = pos[l.rawA] || uae, b = pos[l.rawB] || tgt;
      return { ...l, ax: px(a[0]), ay: py(a[1]), bx: px(b[0]), by: py(b[1]), color: ARC_COLORS[l.arcType] || '#2563eb' };
    });
    cv.__arcs = arcs;

    const draw = (t) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#fbfdfc';
      ctx.fillRect(0, 0, width, height);
      // graticule
      ctx.strokeStyle = 'rgba(21,154,122,0.06)'; ctx.lineWidth = 1;
      for (let lon = -20; lon <= 125; lon += 15) { ctx.beginPath(); ctx.moveTo(px(lon), 0); ctx.lineTo(px(lon), height); ctx.stroke(); }
      for (let lat = -40; lat <= 60; lat += 15) { ctx.beginPath(); ctx.moveTo(0, py(lat)); ctx.lineTo(width, py(lat)); ctx.stroke(); }
      // coarse outlines
      ctx.strokeStyle = 'rgba(100,116,139,0.35)'; ctx.fillStyle = 'rgba(21,154,122,0.045)'; ctx.lineWidth = 1.1;
      for (const poly of OUTLINES) {
        ctx.beginPath();
        poly.forEach(([lon, lat], i) => (i ? ctx.lineTo(px(lon), py(lat)) : ctx.moveTo(px(lon), py(lat))));
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      // animated arcs
      for (const a of arcs) {
        const mx = (a.ax + a.bx) / 2, my = Math.min(a.ay, a.by) - Math.abs(a.bx - a.ax) * 0.22 - 26;
        ctx.strokeStyle = a.color; ctx.lineWidth = 1.2 + (a.weight || 0) * 2.6; ctx.globalAlpha = 0.8;
        if (a.dash?.length) ctx.setLineDash(a.dash);
        ctx.beginPath(); ctx.moveTo(a.ax, a.ay); ctx.quadraticCurveTo(mx, my, a.bx, a.by); ctx.stroke();
        ctx.setLineDash([]);
        // moving pulse dot
        const u = ((t / 1800) + (a.id.charCodeAt(2) || 0) * 0.13) % 1;
        const qx = (1 - u) * (1 - u) * a.ax + 2 * (1 - u) * u * mx + u * u * a.bx;
        const qy = (1 - u) * (1 - u) * a.ay + 2 * (1 - u) * u * my + u * u * a.by;
        ctx.beginPath(); ctx.arc(qx, qy, 3, 0, 2 * Math.PI);
        ctx.fillStyle = a.color; ctx.globalAlpha = 1; ctx.fill();
        // arc-type tag at apex
        ctx.font = '600 9px Montserrat, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = a.color; ctx.globalAlpha = 0.9;
        ctx.fillText(a.arcType, mx, my + 12);
        ctx.globalAlpha = 1;
      }
      // anchor nodes
      const drawAnchor = (p, label, big) => {
        ctx.beginPath(); ctx.arc(px(p[0]), py(p[1]), big ? 8 : 4.5, 0, 2 * Math.PI);
        ctx.fillStyle = big ? '#111827' : '#159a7a'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.font = `700 ${big ? 11 : 9}px Montserrat, sans-serif`;
        ctx.fillStyle = '#1f2937'; ctx.textAlign = 'center';
        ctx.fillText(label, px(p[0]), py(p[1]) - (big ? 12 : 8));
      };
      drawAnchor(uae, 'UAE', true);
      drawAnchor(tgt, run.country, true);
      for (const n of [...uaeNodes, ...sideNodes]) {
        const p = pos[n.id];
        if (p) drawAnchor(p, n.label.length > 12 ? n.label.slice(0, 11) + '…' : n.label, false);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [run, iso, links, width, height]);

  return (
    <div className="ce2-geo">
      <canvas ref={cvRef} width={width} height={height}
        onClick={(e) => {
          const cv = cvRef.current;
          const r = cv.getBoundingClientRect();
          const x = (e.clientX - r.left) * (cv.width / r.width);
          const y = (e.clientY - r.top) * (cv.height / r.height);
          let best = null, bd = 22;
          for (const a of cv.__arcs || []) {
            const mx = (a.ax + a.bx) / 2, my = Math.min(a.ay, a.by) - Math.abs(a.bx - a.ax) * 0.22 - 26;
            for (let u = 0; u <= 1; u += 0.05) {
              const qx = (1 - u) * (1 - u) * a.ax + 2 * (1 - u) * u * mx + u * u * a.bx;
              const qy = (1 - u) * (1 - u) * a.ay + 2 * (1 - u) * u * my + u * u * a.by;
              const d = Math.hypot(qx - x, qy - y);
              if (d < bd) { bd = d; best = a; }
            }
          }
          if (best) onClickLink?.(best, e);
        }} />
      <div className="ce2-geo__legend">
        {Object.entries(ARC_COLORS).map(([k, c]) => (
          <span key={k}><i style={{ background: c }} /> {k}</span>
        ))}
      </div>
    </div>
  );
}
