import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { X, Zap, ExternalLink, BadgeCheck, MapPin, TrendingUp, TrendingDown, Minus } from 'lucide-react';

const spring = { type: 'spring', stiffness: 360, damping: 30 };

/* ---------- shared derivations (evidence → analyst signals) ---------- */
export function entityDossier(run, node) {
  const links = (run.edges || []).filter(e => e.entity_a === node.id || e.entity_b === node.id);
  const evIds = new Set(links.flatMap(l => l.evidence_record_ids || []));
  const evidence = (run.evidence || []).filter(ev =>
    evIds.has(ev.id) || (ev.claim || '').toLowerCase().includes((node.label || '~').toLowerCase()));
  const media = evidence.flatMap(ev => (ev.media || []).map(m => ({ ...m, evidence: ev })));
  const dates = evidence.map(e => e.publish_date).filter(Boolean).sort();
  const sent = evidence.reduce((a, e) => a + ({ support: 1, oppose: -1 }[e.stance] ?? 0), 0);
  const sentiment = evidence.length ? sent / evidence.length : 0;
  const conf = evidence.length ? evidence.reduce((a, e) => a + (e.confidence ?? 0.5), 0) / evidence.length : 0;
  const weights = links.map(l => l.weight ?? 0);
  const recents = links.map(l => l.recency ?? 0.5);
  const meanW = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
  const meanR = recents.length ? recents.reduce((a, b) => a + b, 0) / recents.length : 0.5;
  const trajectory = meanR > 0.62 ? 'rising' : meanR < 0.38 ? 'cooling' : 'stable';
  const geos = [...new Set(evidence.map(e => e.geo || e.country).filter(Boolean))];
  return { links, evidence, media, dates, sentiment, conf, meanW, trajectory, geos };
}

function SentimentBar({ v }) {
  const pct = Math.round(((v + 1) / 2) * 100);
  return (
    <div className="ins-sent" title={`sentiment ${v.toFixed(2)}`}>
      <div className="ins-sent__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function MiniTimeline({ dates }) {
  if (!dates.length) return <span className="ins-muted">no dated evidence</span>;
  const t0 = Date.parse(dates[0]), t1 = Date.parse(dates[dates.length - 1]) || t0 + 1;
  return (
    <div className="ins-tl">
      {dates.map((d, i) => (
        <span key={i} className="ins-tl__dot" title={d}
          style={{ left: `${t1 > t0 ? ((Date.parse(d) - t0) / (t1 - t0)) * 100 : 50}%` }} />
      ))}
      <span className="ins-tl__d0">{dates[0]}</span>
      <span className="ins-tl__d1">{dates[dates.length - 1]}</span>
    </div>
  );
}

/* ---------- F5 Entity Inspector — analyst notebook panel ---------- */
export function EntityInspector({ run, node, onClose, onLightbox, onQuickQuery }) {
  const d = useMemo(() => entityDossier(run, node), [run, node]);
  const TrajIcon = d.trajectory === 'rising' ? TrendingUp : d.trajectory === 'cooling' ? TrendingDown : Minus;
  return (
    <motion.aside className="ce-inspector" initial={{ x: 360 }} animate={{ x: 0 }} exit={{ x: 360 }} transition={spring}
      aria-label={`Entity inspector — ${node.label}`}>
      <div className="ins-head">
        <div>
          <div className="ins-kicker">ENTITY DOSSIER</div>
          <h3>{node.fullName || node.label}</h3>
          <div className="ins-sub">{node.kind} · community {node.community} · degree {node.degree}</div>
        </div>
        <button className="ins-x" onClick={onClose} aria-label="Close inspector"><X size={14} /></button>
      </div>
      <div className="ins-body">
        <div className="ins-row2">
          <div className="ins-stat"><b>{(node.pagerank ?? 0).toFixed(4)}</b><span>importance (PageRank)</span></div>
          <div className="ins-stat"><b>{Math.round(d.conf * 100)}%</b><span>mean confidence</span></div>
        </div>
        <div className="ins-sec"><h4>Role</h4>
          <p>{node.role || (node.kind === 'country' ? 'Focus country of this correlation run.' : `Connected via ${d.links.length} relationship${d.links.length === 1 ? '' : 's'} — ${[...new Set(d.links.map(l => l.relationship_type))].join(', ') || 'n/a'}.`)}</p>
        </div>
        <div className="ins-sec"><h4>Activity timeline</h4><MiniTimeline dates={d.dates} /></div>
        <div className="ins-sec"><h4>Relationships ({d.links.length})</h4>
          <ul className="ins-rels">
            {d.links.slice(0, 8).map(l => (
              <li key={l.id}>
                <span className="ins-rel__type">{l.relationship_type}</span>
                {l.entity_a === node.id ? l.entity_b : l.entity_a}
                <span className="ins-rel__w">w {(l.weight ?? 0).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="ins-sec"><h4>Recent activity</h4>
          {d.evidence.slice(0, 3).map(ev => (
            <div key={ev.id} className="ins-ev">
              <span className="ins-ev__src">{ev.source}{/wamnews|mofauae/i.test(ev.source || '') && <BadgeCheck size={10} className="ce-verified" />}</span>
              <span className="ins-ev__date">{ev.publish_date}</span>
              <p>{ev.claim}</p>
            </div>
          ))}
          {!d.evidence.length && <span className="ins-muted">no direct evidence records</span>}
        </div>
        <div className="ins-sec"><h4>Summary</h4>
          <p className="ins-summary">{d.evidence[0]?.snippet || d.evidence[0]?.claim || 'No narrative summary available for this entity in the current run.'}</p>
        </div>
        {d.media.length > 0 && (
          <div className="ins-sec"><h4>Media ({d.media.length})</h4>
            <div className="ins-media">
              {d.media.slice(0, 6).map((m, i) => (
                <button key={i} className="ce-thumb" onClick={() => onLightbox({ media: m, evidence: m.evidence, gallery: d.media, index: i })}>
                  <img src={m.url} alt={`media proof ${i + 1}`} loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="ins-sec"><h4>Sources</h4>
          <ul className="ins-srcs">
            {[...new Set(d.evidence.map(e => e.source).filter(Boolean))].slice(0, 6).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
        <div className="ins-row2">
          <div className="ins-stat"><b><MapPin size={11} /> {d.geos.length ? d.geos.join(', ') : run.country}</b><span>geographic relevance</span></div>
          <div className="ins-stat"><b><TrajIcon size={12} /> {d.trajectory}</b><span>predicted trajectory</span></div>
        </div>
        <div className="ins-sec"><h4>Sentiment</h4><SentimentBar v={d.sentiment} /></div>
      </div>
      <button className="ce-pop__qq ins-qq" onClick={onQuickQuery}><Zap size={11} /> Quick Query this entity</button>
    </motion.aside>
  );
}

/* ---------- F6 Relationship Inspector — connection-chain card ---------- */
export function RelationshipInspector({ run, link, onClose, onLightbox, onQuickQuery }) {
  const evById = new Map((run.evidence || []).map(e => [e.id, e]));
  const evs = (link.evidenceIds || []).map(id => evById.get(id)).filter(Boolean);
  const media = evs.flatMap(e => (e.media || []).map(m => ({ ...m, evidence: e })));
  const dates = evs.map(e => e.publish_date).filter(Boolean).sort();
  const sId = link.source.id ?? link.source, tId = link.target.id ?? link.target;
  // connection chain: source → (its strongest intermediates) → target
  const chain = useMemo(() => {
    const hops = [sId];
    const mids = (run.edges || [])
      .filter(e => (e.entity_a === sId || e.entity_b === sId) && e.id !== link.id)
      .map(e => e.entity_a === sId ? e.entity_b : e.entity_a)
      .filter(m => (run.edges || []).some(e2 => (e2.entity_a === m && e2.entity_b === tId) || (e2.entity_b === m && e2.entity_a === tId)))
      .slice(0, 2);
    hops.push(...mids, tId);
    return [...new Set(hops)];
  }, [run.edges, sId, tId, link.id]);
  return (
    <motion.div className="ce-relcard" initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} transition={spring}
      aria-label="Relationship inspector">
      <button className="ins-x" onClick={onClose} aria-label="Close relationship card"><X size={13} /></button>
      <div className="ins-kicker" style={{ color: link.color }}>
        {link.type}
        {link.edgeClass && <span className={`rel-class rel-class--${link.edgeClass.toLowerCase()}`}> {link.edgeClass}</span>}
        {link.contradiction ? ' · ⚠ CONTRADICTED' : ''}
      </div>
      {link.classReasoning && <div className="rel-clsreason">{link.classReasoning}</div>}
      <div className="rel-chain">
        {chain.map((h, i) => (
          <React.Fragment key={h}>
            <span className="rel-hop">{h}</span>
            {i < chain.length - 1 && <span className="rel-arrow">→</span>}
          </React.Fragment>
        ))}
      </div>
      <p className="rel-claim">{link.claim}</p>
      <div className="rel-why"><b>Why this relationship exists:</b> {evs[0]?.snippet || evs[0]?.claim || link.claim} <span className="ins-muted">({evs.length} evidence record{evs.length === 1 ? '' : 's'})</span></div>
      <div className="rel-meta">
        <span>weight {(link.weight ?? 0).toFixed(2)}</span>
        <span>confidence {link.confidence ?? '—'}</span>
        <span>direction {link.direction || 'both'}</span>
        {dates.length > 0 && <span>{dates[0]} → {dates[dates.length - 1]}</span>}
      </div>
      {dates.length > 0 && <MiniTimeline dates={dates} />}
      <div className="rel-evs">
        {evs.slice(0, 3).map(ev => (
          <div key={ev.id} className="ins-ev">
            <span className="ins-ev__src">{ev.source}</span>
            <span className="ins-ev__date">{ev.publish_date}</span>
            <p>{ev.claim}</p>
            {ev.url && <a href={ev.url} target="_blank" rel="noopener noreferrer">article <ExternalLink size={9} /></a>}
          </div>
        ))}
      </div>
      {media.length > 0 && (
        <div className="ins-media">
          {media.slice(0, 5).map((m, i) => (
            <button key={i} className="ce-thumb" onClick={() => onLightbox({ media: m, evidence: m.evidence, gallery: media, index: i })}>
              <img src={m.url} alt={`relationship proof ${i + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <button className="ce-pop__qq" onClick={onQuickQuery}><Zap size={11} /> Quick Query</button>
    </motion.div>
  );
}

/* ---------- F8 Hover Preview — floating entity card ---------- */
export function HoverPreview({ run, node, pos }) {
  const d = useMemo(() => entityDossier(run, node), [run, node]);
  const img = d.media[0];
  const flag = node.kind === 'country' ? (run.countryIso || '').toLowerCase() : null;
  return (
    <div className="ce-hoverprev" style={{ left: pos.x, top: pos.y }}>
      <div className="hp-head">
        {img ? <img className="hp-avatar" src={img.url} alt="" /> : <span className="hp-avatar hp-avatar--txt">{(node.label || '?').slice(0, 2).toUpperCase()}</span>}
        <div>
          <b>{node.fullName || node.label}
            {flag && <span className={`fi fi-${flag} hp-flag`} aria-label={run.country} />}
          </b>
          <div className="hp-sub">importance {(node.pagerank ?? 0).toFixed(3)} · {d.links.length} links</div>
        </div>
      </div>
      <p className="hp-summary">{d.evidence[0]?.claim || 'No recent evidence in this run.'}</p>
      {d.evidence[0]?.publish_date && <div className="hp-updated">last updated {d.evidence[0].publish_date}</div>}
      {d.evidence[1] && <div className="hp-news">↳ {d.evidence[1].claim?.slice(0, 90)}…</div>}
    </div>
  );
}

/* ---------- F9 Lightbox V2 — zoom, fullscreen, carousel, AI summary ---------- */
export function LightboxV2({ data, run, onClose, onQuickQuery }) {
  const gallery = data.gallery?.length ? data.gallery : [{ ...data.media, evidence: data.evidence }];
  const [idx, setIdx] = useState(Math.max(0, data.index ?? 0));
  const [zoom, setZoom] = useState(1);
  const [fs, setFs] = useState(false);
  const cur = gallery[idx] || gallery[0];
  const ev = cur.evidence || data.evidence;
  const related = useMemo(() => {
    if (!ev) return [];
    return (run.edges || []).filter(e => (e.evidence_record_ids || []).includes(ev.id))
      .flatMap(e => [e.entity_a, e.entity_b]);
  }, [run.edges, ev]);
  const aiSummary = ev ? `${ev.platform} evidence from ${ev.source}${ev.publish_date ? ` (${ev.publish_date})` : ''}: ${ev.snippet || ev.claim}` : 'No linked evidence record.';
  return (
    <motion.div className={`ce-lightbox ce-lightbox--v2${fs ? ' ce-lightbox--fs' : ''}`}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.figure initial={{ scale: 0.94 }} animate={{ scale: 1 }} transition={spring} onClick={(e) => e.stopPropagation()}>
        <div className="lb-toolbar">
          <button onClick={() => setZoom(z => Math.min(4, z * 1.4))} aria-label="Zoom in">＋</button>
          <button onClick={() => setZoom(z => Math.max(1, z / 1.4))} aria-label="Zoom out">－</button>
          <button onClick={() => setFs(f => !f)} aria-label="Toggle fullscreen">{fs ? '⤡' : '⤢'}</button>
          <span className="lb-count">{idx + 1}/{gallery.length}</span>
          <button onClick={onClose} aria-label="Close lightbox"><X size={14} /></button>
        </div>
        <div className="lb-stage">
          {gallery.length > 1 && <button className="lb-nav lb-nav--l" onClick={() => setIdx(i => (i - 1 + gallery.length) % gallery.length)} aria-label="Previous image">‹</button>}
          <div className="lb-imgwrap">
            <img src={cur.url} alt={`proof media ${idx + 1}`} style={{ transform: `scale(${zoom})` }} />
          </div>
          {gallery.length > 1 && <button className="lb-nav lb-nav--r" onClick={() => setIdx(i => (i + 1) % gallery.length)} aria-label="Next image">›</button>}
        </div>
        <figcaption>
          <div className="lb-cap">
            <span className="ce-lb__handle">@{cur.sourceHandle || ev?.source || 'unknown'} <BadgeCheck size={12} className="ce-verified" /></span>
            {ev?.url && <a href={ev.url} target="_blank" rel="noopener noreferrer">source <ExternalLink size={11} /></a>}
            {cur.originUrl && <a href={cur.originUrl} target="_blank" rel="noopener noreferrer">original <ExternalLink size={11} /></a>}
          </div>
          <p className="lb-ai"><b>AI summary</b> — {aiSummary}</p>
          {related.length > 0 && (
            <div className="lb-related">related: {[...new Set(related)].slice(0, 5).map((r, i) => <span key={i} className="lb-rel">{r}</span>)}</div>
          )}
          {onQuickQuery && <button className="ce-pop__qq" onClick={() => onQuickQuery(ev)}><Zap size={11} /> Quick Query</button>}
        </figcaption>
      </motion.figure>
    </motion.div>
  );
}
