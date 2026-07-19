// V2Surfaces.jsx — Correlation Engine V2 UI surfaces (2026-07-19).
// MiniMap, EntityInspector, RelationshipInspector, HoverPreview, LightboxV2,
// TimelineReplay, GeoOverlay, StoryMode, PredictionPanel, ClusterChips,
// DeepSearchSelect. ALL data comes from the real run payload — zero mock data;
// fields without evidence render an honest "—".
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  X, Zap, ExternalLink, BadgeCheck, ChevronLeft, ChevronRight, Maximize2,
  Play, Pause, MapPin, BookOpen, Lock, Radio,
} from 'lucide-react';
import { REL_TYPE_COLORS, TIER_STYLES, IMPACT_COLORS, PLATFORM_COLORS, entityTimeline, relationshipChain } from './adapter.js';

const spring = { type: 'spring', stiffness: 360, damping: 30 };

/* ================= item 2 — MiniMap ================= */
export function MiniMap({ fgRef, graph, width = 172, height = 112 }) {
  const cvRef = useRef();
  useEffect(() => {
    let alive = true;
    const draw = () => {
      if (!alive) return;
      const fg = fgRef.current; const cv = cvRef.current;
      if (!fg || !cv) { requestAnimationFrame(draw); return; }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(0, 0, width, height);
      const nodes = graph.nodes.filter(n => Number.isFinite(n.x));
      if (!nodes.length) { setTimeout(draw, 400); return; }
      const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
      const minX = Math.min(...xs) - 30, maxX = Math.max(...xs) + 30;
      const minY = Math.min(...ys) - 30, maxY = Math.max(...ys) + 30;
      const sx = width / (maxX - minX), sy = height / (maxY - minY);
      const s = Math.min(sx, sy);
      const ox = (width - (maxX - minX) * s) / 2, oy = (height - (maxY - minY) * s) / 2;
      const px = (x) => ox + (x - minX) * s, py = (y) => oy + (y - minY) * s;
      // edges faint
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 0.6;
      for (const l of graph.links) {
        const a = typeof l.source === 'object' ? l.source : null, b = typeof l.target === 'object' ? l.target : null;
        if (!a || !b) continue;
        ctx.beginPath(); ctx.moveTo(px(a.x), py(a.y)); ctx.lineTo(px(b.x), py(b.y)); ctx.stroke();
      }
      for (const n of nodes) {
        ctx.beginPath(); ctx.arc(px(n.x), py(n.y), n.kind === 'country' ? 3 : 1.8, 0, 7);
        ctx.fillStyle = n.kind === 'country' ? '#111827' : (n.tintStroke || '#a5b4fc'); ctx.fill();
      }
      // viewport rectangle (screen corners → graph coords)
      try {
        const tl = fg.screen2GraphCoords(0, 0), br = fg.screen2GraphCoords(fg.width || 800, fg.height || 500);
        ctx.strokeStyle = '#6d4aff'; ctx.lineWidth = 1.2;
        ctx.strokeRect(px(tl.x), py(tl.y), (br.x - tl.x) * s, (br.y - tl.y) * s);
      } catch { /* not ready */ }
      cv.__proj = { minX, minY, s, ox, oy };
      setTimeout(draw, 450);
    };
    draw();
    return () => { alive = false; };
  }, [fgRef, graph, width, height]);

  const jump = (e) => {
    const cv = cvRef.current; const fg = fgRef.current;
    if (!cv?.__proj || !fg) return;
    const r = cv.getBoundingClientRect();
    const { minX, minY, s, ox, oy } = cv.__proj;
    const gx = (e.clientX - r.left - ox) / s + minX;
    const gy = (e.clientY - r.top - oy) / s + minY;
    fg.centerAt(gx, gy, 400);
  };
  const wheel = (e) => {
    e.preventDefault(); e.stopPropagation();
    const fg = fgRef.current; if (!fg) return;
    const k = fg.zoom();
    fg.zoom(Math.max(0.2, Math.min(12, k * (e.deltaY < 0 ? 1.25 : 0.8))), 200);
  };
  return (
    <canvas ref={cvRef} className="ce-minimap" width={width} height={height}
      onClick={jump} onWheel={wheel} aria-label="Graph mini-map — click to jump, scroll to zoom" />
  );
}

/* ================= item 8 — Hover preview card ================= */
export function HoverPreview({ node, run, pos }) {
  if (!node || node.kind === 'cluster') return null;
  const tl = entityTimeline(run, node);
  const latest = tl[tl.length - 1];
  const img = node.media?.[0]?.url;
  const impact = run.impactScores?.[node.id];
  const flag = node.kind === 'country' ? 'ae' : (node.kind === 'country-side' && node.id.length === 2 ? node.id.toLowerCase() : null);
  return (
    <div className="ce-hoverprev" style={{ left: pos.x, top: pos.y }}>
      <div className="ce-hoverprev__head">
        {img ? <img src={img} alt="" /> : <span className="ce-hoverprev__avatar">{node.label.slice(0, 2).toUpperCase()}</span>}
        <div>
          <b>{node.fullName || node.label} {flag && <span className={`fi fi-${flag}`} style={{ fontSize: 11 }} />}</b>
          <div className="ce-hoverprev__meta">{node.kind} · importance {(node.pagerank * 100).toFixed(1)} · {node.evidenceCount} evidence</div>
        </div>
      </div>
      {impact && <div className="ce-hoverprev__impact" style={{ borderColor: IMPACT_COLORS[impact.score] }}>UAE impact: <b>{impact.score}</b></div>}
      <div className="ce-hoverprev__news">{latest ? `${latest.date || 'undated'} — ${latest.claim.slice(0, 110)}${latest.claim.length > 110 ? '…' : ''}` : 'No evidence records touch this entity in this run.'}</div>
      <div className="ce-hoverprev__foot">last updated {latest?.date || run.generated_at?.slice(0, 10)} · click for full inspector</div>
    </div>
  );
}

/* ================= item 5 — Entity Inspector ================= */
export function EntityInspector({ node, run, onClose, onQuickQuery, onLightbox }) {
  if (!node) return null;
  const tl = entityTimeline(run, node);
  const rels = (run.edges || []).filter(e => e.entity_a === node.id || e.entity_b === node.id);
  const infRels = (run.inferredEdges || []).filter(e => e.entity_a === node.id || e.entity_b === node.id);
  const impact = run.impactScores?.[node.id];
  const media = [...new Map((node.media || []).map(m => [m.url, m])).values()];
  const stances = rels.reduce((a, e) => { a[e.stance || 'neutral'] = (a[e.stance || 'neutral'] || 0) + 1; return a; }, {});
  const avgConf = rels.length ? (rels.reduce((a, e) => a + (e.confidence || 0), 0) / rels.length) : null;
  const predicted = infRels.filter(e => e.tier === 'Predicted');
  const importance = Math.round((node.pagerank || 0) * 1000) / 10;
  const geo = node.geo;
  return (
    <motion.aside className="ce-inspector" initial={{ x: 380 }} animate={{ x: 0 }} exit={{ x: 380 }} transition={spring} aria-label={`Entity inspector: ${node.label}`}>
      <div className="ce-insp__head">
        <div>
          <b>{node.fullName || node.label}</b>
          <div className="ce-insp__sub">{node.kind === 'country' ? 'Country (UAE anchor)' : node.kind === 'country-side' ? 'Counterpart-side entity' : 'UAE entity'} · community {node.community}</div>
        </div>
        <button onClick={onClose} aria-label="Close inspector"><X size={14} /></button>
      </div>
      <div className="ce-insp__body">
        <div className="ce-insp__grid">
          <div className="ce-insp__stat"><span>Importance</span><b>{importance}</b><i>PageRank ×1000</i></div>
          <div className="ce-insp__stat"><span>Connections</span><b>{node.degree ?? rels.length}</b><i>{rels.length} verified · {infRels.length} inferred</i></div>
          <div className="ce-insp__stat"><span>Evidence</span><b>{node.evidenceCount}</b><i>records this run</i></div>
          <div className="ce-insp__stat"><span>Confidence</span><b>{avgConf === null ? '—' : `${Math.round(avgConf * 100)}%`}</b><i>avg edge confidence</i></div>
        </div>

        {impact ? (
          <section>
            <h4>UAE strategic impact</h4>
            <div className="ce-impactline"><span className="ce-impactchip" style={{ background: IMPACT_COLORS[impact.score], color: ['Low', 'None'].includes(impact.score) ? '#374151' : '#fff' }}>{impact.score}</span>
              <div className="ce-dims">{(impact.dimensions || []).map(d => <em key={d}>{d}</em>)}</div>
            </div>
            <p className="ce-insp__why">{impact.reasoning}</p>
          </section>
        ) : <section><h4>UAE strategic impact</h4><p className="ce-insp__why">— not scored in this run (no evidence presence).</p></section>}

        <section>
          <h4>Sentiment (edge stances)</h4>
          <div className="ce-stancebar">
            {['cooperation', 'neutral', 'tension'].map(s => stances[s] ? (
              <span key={s} className={`ce-stance ce-stance--${s}`} style={{ flex: stances[s] }}>{s} {stances[s]}</span>) : null)}
            {!rels.length && <span className="ce-insp__why">— no verified edges touch this entity.</span>}
          </div>
        </section>

        <section>
          <h4>Relationships</h4>
          {rels.map(e => (
            <div key={e.id} className="ce-insp__rel">
              <span className="ce-relchip" style={{ '--c': REL_TYPE_COLORS[e.relationship_type] }}>{e.relationship_type}</span>
              <span className="ce-insp__reltxt">{e.entity_a === node.id ? '→' : '←'} {e.entity_a === node.id ? e.entity_b : e.entity_a}: {e.claim.slice(0, 90)}{e.claim.length > 90 ? '…' : ''}</span>
            </div>
          ))}
          {infRels.map(e => (
            <div key={e.id} className="ce-insp__rel ce-insp__rel--inf">
              <span className="ce-relchip" style={{ '--c': TIER_STYLES[e.tier]?.color || '#94a3b8' }}>{e.tier}</span>
              <span className="ce-insp__reltxt">{e.claim.slice(0, 90)}{e.claim.length > 90 ? '…' : ''} <i>p={e.probability}</i></span>
            </div>
          ))}
          {!rels.length && !infRels.length && <p className="ce-insp__why">—</p>}
        </section>

        <section>
          <h4>Timeline &amp; recent activity</h4>
          {tl.length ? (
            <ol className="ce-insp__tl">
              {tl.slice(-6).map(ev => (
                <li key={ev.id}>
                  <span className="ce-insp__tld">{ev.date || 'undated'}</span>
                  <span className={`ce-wclass ce-wclass--${ev.weightClass || 'historical'}`}>{ev.weightClass || '·'}</span>
                  {ev.claim.slice(0, 100)}{ev.claim.length > 100 ? '…' : ''}
                  {ev.url && <a href={ev.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={9} /></a>}
                </li>
              ))}
            </ol>
          ) : <p className="ce-insp__why">— no dated activity in this run.</p>}
        </section>

        {media.length > 0 && (
          <section>
            <h4>Media</h4>
            <div className="ce-insp__gallery">
              {media.map((m, i) => (
                <button key={i} className="ce-thumb" onClick={() => onLightbox({ items: media, index: i, run })} aria-label="Open media gallery">
                  <img src={m.url} alt={`proof @${m.sourceHandle}`} loading="lazy" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section>
          <h4>Sources &amp; geographic relevance</h4>
          <div className="ce-insp__srcs">
            {[...new Set(tl.map(ev => `${ev.platform}:${ev.source}`))].slice(0, 6).map(s => {
              const [plat, ...rest] = s.split(':');
              return <span key={s} className="ce-srcchip"><i style={{ background: PLATFORM_COLORS[plat] || '#9ca3af' }} />{rest.join(':')}</span>;
            })}
            {!tl.length && <span className="ce-insp__why">—</span>}
          </div>
          <p className="ce-insp__why"><MapPin size={10} /> {geo ? `${geo.lat.toFixed(1)}, ${geo.lng.toFixed(1)}` : node.kind === 'country-side' ? run.country : 'United Arab Emirates'}</p>
        </section>

        <section>
          <h4>Predicted trajectory</h4>
          {predicted.length ? predicted.map(e => (
            <p key={e.id} className="ce-insp__why"><b>p={e.probability}</b> — {e.claim} <i>({e.reasoning})</i></p>
          )) : <p className="ce-insp__why">— no evidence-backed prediction touches this entity in this run.</p>}
        </section>
      </div>
      <button className="ce-pop__qq" onClick={onQuickQuery}><Zap size={11} /> Quick Query this entity</button>
    </motion.aside>
  );
}

/* ================= item 6 — Relationship Inspector ================= */
export function RelationshipInspector({ link, run, onClose, onQuickQuery, onLightbox }) {
  if (!link) return null;
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  const evs = (link.evidenceIds || []).map(id => evById.get(id)).filter(Boolean);
  const chain = relationshipChain(run, link);
  const media = evs.flatMap(e => e.media || []);
  const tier = link.tier || 'Verified';
  const ts = TIER_STYLES[tier];
  const dates = evs.map(e => e.publish_date).filter(Boolean).sort();
  return (
    <motion.aside className="ce-inspector" initial={{ x: 380 }} animate={{ x: 0 }} exit={{ x: 380 }} transition={spring} aria-label="Relationship inspector">
      <div className="ce-insp__head">
        <div>
          <b style={{ color: link.color || REL_TYPE_COLORS[link.type] }}>{link.type}{link.contradiction ? ' ⚠' : ''}</b>
          <span className="ce-tierchip" style={{ '--c': ts?.color || REL_TYPE_COLORS[link.type] }}>{tier}</span>
          <div className="ce-insp__sub">{link.direction === 'both' ? `${chain[0]} ⇄ ${chain[chain.length - 1]}` : `${chain[0]} → ${chain[chain.length - 1]}`} · weight {link.weight} · {tier === 'Verified' ? `confidence ${Math.round((link.confidence || 0) * 100)}%` : `probability ${Math.round((link.probability || 0) * 100)}%`}</div>
        </div>
        <button onClick={onClose} aria-label="Close inspector"><X size={14} /></button>
      </div>
      <div className="ce-insp__body">
        <section>
          <h4>Chain view</h4>
          <div className="ce-chain">
            {chain.map((c, i) => (
              <React.Fragment key={i}>
                <span className="ce-chain__node">{c}</span>
                {i < chain.length - 1 && <span className="ce-chain__arrow">→</span>}
              </React.Fragment>
            ))}
          </div>
        </section>
        <section>
          <h4>Why this relationship exists</h4>
          <p className="ce-insp__why">{link.claim}</p>
          {link.reasoning && <p className="ce-insp__why"><b>Inference reasoning:</b> {link.reasoning}</p>}
          {link.supporting && <p className="ce-insp__why ce-good"><b>Supporting:</b> {link.supporting}</p>}
          {link.counter && <p className="ce-insp__why ce-bad"><b>Counter-evidence:</b> {link.counter}</p>}
          {tier !== 'Verified' && !link.counter && <p className="ce-insp__why ce-bad"><b>Counter-evidence:</b> none surfaced.</p>}
        </section>
        <section>
          <h4>{tier === 'Verified' ? 'Evidence' : 'Basis evidence (observable signals)'} · {evs.length}</h4>
          {evs.map(ev => {
            const intel = run.articleIntel?.[ev.id];
            return (
              <div key={ev.id} className="ce-insp__ev">
                <div className="ce-insp__evhead">
                  <i style={{ background: PLATFORM_COLORS[ev.platform] || '#9ca3af' }} />
                  {ev.source}{/wamnews|mofauae/i.test(ev.source) && <BadgeCheck size={10} className="ce-verified" />}
                  <span>{ev.publish_date || 'undated'}</span>
                  {intel && <em className={`ce-risk ce-risk--${intel.riskLevel?.toLowerCase()}`}>{intel.riskLevel}</em>}
                </div>
                <p>{intel?.summary50 || ev.claim}</p>
                {intel?.keyPoints?.length > 0 && <ul className="ce-insp__kp">{intel.keyPoints.slice(0, 3).map((k, i) => <li key={i}>{k}</li>)}</ul>}
                {ev.url && <a href={ev.url} target="_blank" rel="noopener noreferrer">article <ExternalLink size={9} /></a>}
              </div>
            );
          })}
          {!evs.length && <p className="ce-insp__why">—</p>}
        </section>
        {media.length > 0 && (
          <section>
            <h4>Images</h4>
            <div className="ce-insp__gallery">
              {media.map((m, i) => (
                <button key={i} className="ce-thumb" onClick={() => onLightbox({ items: media, index: i, run })} aria-label="Open image">
                  <img src={m.url} alt="evidence media" loading="lazy" />
                </button>
              ))}
            </div>
          </section>
        )}
        <section>
          <h4>Timeline</h4>
          <p className="ce-insp__why">{dates.length ? `${dates[0]} → ${dates[dates.length - 1]} (${dates.length} dated of ${evs.length})` : 'All backing evidence is undated.'}</p>
        </section>
      </div>
      <button className="ce-pop__qq" onClick={onQuickQuery}><Zap size={11} /> Quick Query this relationship</button>
    </motion.aside>
  );
}

/* ================= item 9 — Lightbox V2 (carousel/zoom/fullscreen/AI summary) ================= */
export function LightboxV2({ data, onClose }) {
  const [idx, setIdx] = useState(data.index || 0);
  const [zoom, setZoom] = useState(false);
  const [max, setMax] = useState(false);
  const items = data.items || [];
  const m = items[idx];
  const run = data.run;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIdx(i => Math.min(items.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIdx(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, onClose]);
  if (!m) return null;
  // AI summary: the articleIntel of the evidence record carrying this media (real data only)
  const carrier = (run?.evidence || []).find(ev => (ev.media || []).some(x => x.url === m.url));
  const intel = carrier ? run.articleIntel?.[carrier.id] : null;
  const related = intel?.entities || [];
  return (
    <motion.div className={`ce-lightbox${max ? ' ce-lightbox--max' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.figure initial={{ scale: 0.95 }} animate={{ scale: 1 }} transition={spring} onClick={(e) => e.stopPropagation()}>
        <div className="ce-lb__stage">
          {items.length > 1 && <button className="ce-lb__nav" onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0} aria-label="Previous"><ChevronLeft size={18} /></button>}
          <img src={m.url} alt={`media proof ${idx + 1} of ${items.length}`}
            style={{ transform: zoom ? 'scale(1.8)' : 'none', cursor: zoom ? 'zoom-out' : 'zoom-in' }}
            onClick={() => setZoom(z => !z)} />
          {items.length > 1 && <button className="ce-lb__nav" onClick={() => setIdx(i => Math.min(items.length - 1, i + 1))} disabled={idx === items.length - 1} aria-label="Next"><ChevronRight size={18} /></button>}
        </div>
        <figcaption>
          <div className="ce-lb__row">
            <span className="ce-lb__handle">@{m.sourceHandle || carrier?.source || 'source'} <BadgeCheck size={12} className="ce-verified" /></span>
            <span className="ce-lb__count">{idx + 1}/{items.length}</span>
            <button className="ce-lb__tool" onClick={() => setMax(x => !x)} aria-label="Toggle fullscreen"><Maximize2 size={12} /></button>
          </div>
          {carrier && <p className="ce-lb__cap">{carrier.claim}</p>}
          {intel?.summary50 && <p className="ce-lb__ai"><b>AI summary:</b> {intel.summary50}</p>}
          {related.length > 0 && <p className="ce-lb__rel">Related: {related.slice(0, 6).join(' · ')}</p>}
          <div className="ce-lb__row">
            {carrier?.url && <a href={carrier.url} target="_blank" rel="noopener noreferrer">source <ExternalLink size={11} /></a>}
            {m.originUrl && <a href={m.originUrl} target="_blank" rel="noopener noreferrer">original <ExternalLink size={11} /></a>}
          </div>
        </figcaption>
      </motion.figure>
    </motion.div>
  );
}

/* ================= item 11 — Timeline replay ================= */
export function TimelineReplay({ run, cutoff, onCutoff }) {
  const [playing, setPlaying] = useState(false);
  const dates = useMemo(() => {
    const ds = [...new Set((run.evidence || []).map(e => e.publish_date).filter(Boolean))].sort();
    return ds;
  }, [run]);
  const idx = cutoff ? dates.indexOf(cutoff) : dates.length - 1;
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const cur = cutoff ? dates.indexOf(cutoff) : -1;
      if (cur >= dates.length - 1) { setPlaying(false); onCutoff(null); return; }
      onCutoff(dates[cur + 1]);
    }, 900);
    return () => clearInterval(t);
  }, [playing, cutoff, dates, onCutoff]);
  if (dates.length < 2) {
    return <div className="ce-replay ce-replay--empty">Timeline replay: this run has {dates.length} dated evidence record{dates.length === 1 ? '' : 's'} — need ≥2 distinct dates to scrub. Undated evidence stays visible.</div>;
  }
  return (
    <div className="ce-replay" aria-label="Intelligence timeline replay">
      <button className="ce-btn" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause replay' : 'Play replay'}>
        {playing ? <Pause size={12} /> : <Play size={12} />}
      </button>
      <span className="ce-replay__d0">{dates[0]}</span>
      <input type="range" min={0} max={dates.length - 1} value={idx < 0 ? dates.length - 1 : idx}
        onChange={(e) => { const i = +e.target.value; onCutoff(i >= dates.length - 1 ? null : dates[i]); }}
        aria-label="Drag through time — nodes and connections appear as evidence accumulates" />
      <span className="ce-replay__d1">{dates[dates.length - 1]}</span>
      <span className="ce-replay__cur">{cutoff ? `showing ≤ ${cutoff}` : 'full graph'} · ALT+scroll on canvas scrubs</span>
    </div>
  );
}

/* ================= item 13 — Geographic overlay ================= */
let LAND_CACHE = null;
function topoToFeatures(topo, objName) {
  const scale = topo.transform?.scale || [1, 1], translate = topo.transform?.translate || [0, 0];
  const arcs = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
  });
  const arcLine = (i) => (i >= 0 ? arcs[i] : arcs[~i].slice().reverse());
  const ring = (idxs) => { const pts = []; idxs.forEach((ai, k) => { const line = arcLine(ai); pts.push(...(k ? line.slice(1) : line)); }); return pts; };
  const coords = (g) => (g.type === 'Polygon' ? g.arcs.map(ring) : g.arcs.map(p => p.map(ring)));
  const obj = topo.objects[objName];
  return (obj.geometries || [obj]).map(g => ({ type: 'Feature', geometry: { type: g.type, coordinates: coords(g) } }));
}
export function GeoOverlay({ run, graph, width, height }) {
  const [land, setLand] = useState(LAND_CACHE);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (LAND_CACHE || failed) return;
    fetch('https://unpkg.com/world-atlas@2.0.2/land-110m.json')
      .then(r => r.json())
      .then(t => { LAND_CACHE = topoToFeatures(t, 'land'); setLand(LAND_CACHE); })
      .catch(() => setFailed(true));
  }, [failed]);

  const { d3path, project } = useMemo(() => {
    // d3-geo from the full d3 bundle
    // eslint-disable-next-line global-require
    const d3 = window.__d3geo;
    return d3 || {};
  }, []);
  // lazy import d3-geo pieces (bundled via vite from the d3 package)
  const [geoReady, setGeoReady] = useState(Boolean(window.__d3geo));
  useEffect(() => {
    if (window.__d3geo) return;
    import('d3-geo').then(m => {
      window.__d3geo = m;
      setGeoReady(true);
    }).catch(() => setFailed(true));
  }, []);

  if (!geoReady) return <div className="ce-geo ce-geo--loading">Loading map engine…</div>;
  const d3geo = window.__d3geo;
  const proj = d3geo.geoEquirectangular().fitSize([width, height - 26], { type: 'Sphere' });
  const pathGen = d3geo.geoPath(proj);
  const graticule = d3geo.geoGraticule10();

  // anchor coordinates: node.geo (V2 runs) with kind-based fallback
  const UAE = [54.4, 24.3];
  const nodesWithGeo = graph.nodes.filter(n => n.kind !== 'cluster').map(n => {
    const g = n.geo ? [n.geo.lng, n.geo.lat] : (n.kind === 'country-side' ? null : UAE);
    return g ? { ...n, lnglat: g } : null;
  }).filter(Boolean);
  // fan entities around their shared anchor so they don't stack
  const byAnchor = new Map();
  for (const n of nodesWithGeo) {
    const k = n.lnglat.join(',');
    (byAnchor.get(k) || byAnchor.set(k, []).get(k)).push(n);
  }
  const placed = new Map();
  for (const [, group] of byAnchor) {
    group.forEach((n, i) => {
      const [x, y] = proj(n.lnglat);
      const ang = (i / group.length) * Math.PI * 2;
      const r = group.length > 1 ? (n.kind === 'country' || n.kind === 'country-side' ? 0 : 16 + (i % 3) * 9) : 0;
      placed.set(n.id, [x + Math.cos(ang) * r, y + Math.sin(ang) * r]);
    });
  }
  const FLOW_KIND = {
    Investment: 'investment', Trade: 'trade', 'Aid-Humanitarian': 'aid', Diplomatic: 'diplomacy',
    Infrastructure: 'shipping', Energy: 'energy', Technology: 'technology', Security: 'military', 'Media-narrative': 'media',
  };
  const flows = graph.links.filter(l => !l.isContext && !l.inferred).map(l => {
    const a = placed.get(l.a), b = placed.get(l.b);
    if (!a || !b || (Math.abs(a[0] - b[0]) < 2 && Math.abs(a[1] - b[1]) < 2)) return null;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.18;
    return { id: l.id, d: `M${a[0]},${a[1]} Q${mx},${my} ${b[0]},${b[1]}`, color: REL_TYPE_COLORS[l.type], kind: FLOW_KIND[l.type], type: l.type };
  }).filter(Boolean);
  const kindsPresent = [...new Set(flows.map(f => `${f.type}|${f.kind}`))];

  return (
    <div className="ce-geo">
      <svg width={width} height={height - 26} role="img" aria-label="Geographic overlay: entities on a world map with animated flows">
        <rect width={width} height={height - 26} fill="#f8fafc" />
        <path d={pathGen(graticule)} fill="none" stroke="#eef2f7" strokeWidth="0.6" />
        {land && land.map((f, i) => <path key={i} d={pathGen(f)} fill="#eceff3" stroke="#d8dee7" strokeWidth="0.5" />)}
        {failed && !land && <text x={12} y={20} fontSize={10} fill="#9ca3af">coastline data unavailable offline — graticule projection shown</text>}
        {flows.map(f => (
          <g key={f.id}>
            <path d={f.d} fill="none" stroke={f.color} strokeWidth="1.6" opacity="0.85" className="ce-geo__flow" markerEnd="url(#ce-geo-arrow)" />
          </g>
        ))}
        <defs>
          <marker id="ce-geo-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#64748b" />
          </marker>
        </defs>
        {[...placed.entries()].map(([id, [x, y]]) => {
          const n = nodesWithGeo.find(v => v.id === id);
          return (
            <g key={id} transform={`translate(${x},${y})`}>
              <circle r={n.kind === 'country' || n.kind === 'country-side' ? 6 : 3.4}
                fill={n.kind === 'country' ? '#111827' : n.kind === 'country-side' ? '#374151' : '#fff'}
                stroke={n.tintStroke || '#a5b4fc'} strokeWidth="1.2" />
              <text y={n.kind === 'country' || n.kind === 'country-side' ? -9 : -6} textAnchor="middle" fontSize={n.kind === 'country' || n.kind === 'country-side' ? 9.5 : 7.5} fontWeight={n.kind === 'country' || n.kind === 'country-side' ? 700 : 500} fill="#374151">{n.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="ce-geo__legend">
        {kindsPresent.map(k => {
          const [type, kind] = k.split('|');
          return <span key={k}><i style={{ background: REL_TYPE_COLORS[type] }} />{kind}</span>;
        })}
        <span className="ce-geo__note">animated dashes = live flow direction</span>
      </div>
    </div>
  );
}

/* ================= item 19 — Prediction panel ================= */
export function PredictionPanel({ run, onQuickQuery, onClose }) {
  const preds = (run.inferredEdges || []).filter(e => e.tier === 'Predicted');
  const others = (run.inferredEdges || []).filter(e => e.tier !== 'Predicted');
  return (
    <motion.section className="ce-predict" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} aria-label="Prediction mode">
      <div className="ce-predict__head">
        <b><Radio size={13} /> Prediction Mode — evidence-backed forecasts only</b>
        <div>
          <button className="ce-btn" onClick={onQuickQuery}><Zap size={11} /> Quick Query predictions</button>
          <button className="ce-btn" onClick={onClose}><X size={12} /></button>
        </div>
      </div>
      <p className="ce-predict__rule">Hard separation: every forecast below carries basis evidence from this run. Pure speculation (zero observable signals) is dropped by the engine at extraction time — nothing speculative is shown as fact.</p>
      {preds.length === 0 && <p className="ce-insp__why">No evidence-backed forward-looking inferences in this run. {others.length > 0 ? `${others.length} present-state inference(s) exist (Likely/Possible) — toggle tiers in the legend to see them.` : ''}</p>}
      {preds.map(e => (
        <div key={e.id} className="ce-predict__card">
          <div className="ce-predict__prob">
            <div className="ce-predict__bar"><i style={{ width: `${Math.round(e.probability * 100)}%` }} /></div>
            <b>{Math.round(e.probability * 100)}%</b>
          </div>
          <div className="ce-predict__body">
            <b>{e.entity_a} → {e.entity_b} · {e.relationship_type}</b>
            <p>{e.claim}</p>
            <p className="ce-good"><b>Supporting:</b> {e.supporting || '—'} <em>(basis: {(e.basis_evidence_ids || []).join(', ')})</em></p>
            <p className="ce-bad"><b>Counter:</b> {e.counter || 'none surfaced'}</p>
            <p className="ce-insp__why"><b>Confidence reasoning:</b> {e.reasoning || '—'}</p>
          </div>
        </div>
      ))}
    </motion.section>
  );
}

/* ================= item 21 — Story Mode ================= */
export function StoryMode({ run, onClose, onQuickQuery, streamStory }) {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(true);
  useEffect(() => {
    let closed = false;
    streamStory(run.iso, run.runId, {
      onToken: (_t, full) => { if (!closed) setText(full); },
    }).then((final) => { if (!closed) { setText(final || ''); setStreaming(false); } });
    return () => { closed = true; };
  }, [run, streamStory]);
  const html = useMemo(() => text
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/\[(E\d+|IE\d+)\]/g, '<em class="ce-story__cite">[$1]</em>')
    .replace(/\n\n/g, '<br/><br/>'), [text]);
  return (
    <motion.div className="ce-storywrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.article className="ce-story" initial={{ y: 24 }} animate={{ y: 0 }} transition={spring} onClick={(e) => e.stopPropagation()} aria-label="Story mode executive briefing">
        <div className="ce-story__head">
          <b><BookOpen size={14} /> Story Mode — {run.country} executive briefing</b>
          <div>
            <button className="ce-btn" onClick={() => onQuickQuery(text)} disabled={streaming}><Zap size={11} /> Quick Query</button>
            <button className="ce-btn" onClick={onClose} aria-label="Close story"><X size={12} /></button>
          </div>
        </div>
        <div className="ce-story__body" dangerouslySetInnerHTML={{ __html: html || '<p>Streaming…</p>' }} />
        {streaming && <div className="ce-story__stream">streaming from {run.model?.analysis}… <span className="qq-caret">▍</span></div>}
      </motion.article>
    </motion.div>
  );
}

/* ================= item 4 — Cluster chips ================= */
export function ClusterChips({ clusters, collapsed, onToggle }) {
  if (!clusters?.length) return null;
  return (
    <div className="ce-clusters" role="group" aria-label="Louvain cluster collapse controls">
      {clusters.map(c => {
        const isC = collapsed.has(c.communityId);
        return (
          <motion.button key={c.communityId} layout className={`ce-clusterchip${isC ? ' on' : ''}`}
            style={{ '--c': c.color }} onClick={() => onToggle(c.communityId)}
            whileTap={{ scale: 0.96 }} transition={spring}
            aria-pressed={isC} aria-label={`${isC ? 'Expand' : 'Collapse'} cluster ${c.label}`}>
            {c.label} {isC ? '▶' : '▼'}
          </motion.button>
        );
      })}
      <span className="ce-clusters__hint">click to collapse/expand Louvain communities</span>
    </div>
  );
}

/* ================= item 14 — Deep Search window selector ================= */
export function DeepSearchSelect({ windows, value, onChange, disabled }) {
  return (
    <label className="ce-window" title="Deep Search research window (last 30 days always weighted higher)">
      <span>window</span>
      <select value={value} onChange={(e) => onChange(+e.target.value)} disabled={disabled} aria-label="Deep search research window">
        {(windows || []).map(w => <option key={w.key} value={w.days}>{w.label}</option>)}
      </select>
    </label>
  );
}

/* ================= tier legend (item 18 visual grammar) ================= */
export function TierLegend({ activeTiers, onToggle }) {
  return (
    <div className="ce-tierlegend" role="group" aria-label="Inference tier legend and filters">
      {Object.entries(TIER_STYLES).map(([tier, st]) => (
        <button key={tier} className={`ce-tierbtn${activeTiers.has(tier) ? ' on' : ''}`} onClick={() => onToggle(tier)} aria-pressed={activeTiers.has(tier)}>
          <svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke={st.color || '#374151'} strokeWidth="2.4" strokeDasharray={st.dash ? st.dash.join(',') : 'none'} /></svg>
          {st.label}
        </button>
      ))}
    </div>
  );
}
