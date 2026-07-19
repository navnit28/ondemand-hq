// V2Panels.jsx — Correlation Engine V2 UX (2026-07-19):
// EntityInspector (5), RelationshipInspector (6), HoverPreviewCard (8),
// LightboxV2 (9), ArticleSummary (10), TimelineReplay (11), ClusterChips (4),
// StoryMode (14), MediaGallery (7). All data comes from the REAL stored run —
// missing media/fields render explicit evidence-gap states, never placeholders.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { X, ExternalLink, Zap, ChevronLeft, ChevronRight, Maximize2, Play, Lock } from 'lucide-react';
import { summarizeEvidence, streamStory } from './api.js';
import { evPlatform, VERIFICATION_STYLES } from './adapter.js';

const spring = { type: 'spring', stiffness: 360, damping: 30 };
const FLAGS = { KE: '🇰🇪', EG: '🇪🇬', JO: '🇯🇴', PK: '🇵🇰', MA: '🇲🇦', ID: '🇮🇩', BD: '🇧🇩', SD: '🇸🇩', SO: '🇸🇴', ET: '🇪🇹', LB: '🇱🇧', SY: '🇸🇾', YE: '🇾🇪', UG: '🇺🇬', TZ: '🇹🇿', RW: '🇷🇼', AE: '🇦🇪' };

export const nodeEvidence = (run, node) => run.evidence.filter(ev =>
  (ev.entities || []).includes(node.id) || (ev.claim || '').toLowerCase().includes((node.label || '~').toLowerCase()));

const GapNote = ({ what }) => (
  <div className="ce2-gap" role="note">Evidence gap — no {what} in the stored run for this item. The 24h workflow fills this on scheduled runs.</div>
);

/** (10) streamed structured article summary block. */
export function ArticleSummary({ iso, runId, ev }) {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle'); // idle|streaming|done|error
  const ctrlRef = useRef(null);
  const start = () => {
    setState('streaming'); setText('');
    ctrlRef.current = summarizeEvidence({
      iso, runId, evidenceId: ev.id,
      onToken: (_t, full) => setText(full),
      onDone: (full) => { setText(full); setState('done'); },
      onError: (e) => { setText(`Summary unavailable: ${e}`); setState('error'); },
    });
  };
  useEffect(() => () => ctrlRef.current?.abort(), []);
  return (
    <div className="ce2-summary">
      {state === 'idle' && (
        <button className="ce-btn ce-btn--ghost" onClick={start}>Σ Summarize (50w · 100w · key points · entities · risk · UAE relevance)</button>
      )}
      {state !== 'idle' && (
        <div className="ce2-summary__body" dir="auto">
          {text || 'Streaming from gpt-5.6-sol-medium…'}
          {state === 'streaming' && <span className="qq-caret">▍</span>}
        </div>
      )}
    </div>
  );
}

/** (9) LightboxV2: zoom, fullscreen, carousel, caption, attribution, AI summary, related entities. */
export function LightboxV2({ data, run, iso, onClose }) {
  const [idx, setIdx] = useState(data.index || 0);
  const [zoom, setZoom] = useState(1);
  const figRef = useRef(null);
  const items = data.items || [data];
  const cur = items[Math.max(0, Math.min(idx, items.length - 1))];
  const ev = cur.evidence;
  const related = ev ? (ev.entities || []).slice(0, 8) : [];
  useEffect(() => {
    const kd = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIdx(i => Math.min(items.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIdx(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, [items.length, onClose]);
  return (
    <motion.div className="ce-lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.figure ref={figRef} initial={{ scale: 0.94 }} animate={{ scale: 1 }} transition={spring} onClick={(e) => e.stopPropagation()}>
        <div className="ce2-lb__stage">
          <img src={cur.media.url} alt={cur.media.caption || 'evidence media'}
            style={{ transform: `scale(${zoom})` }}
            onWheel={(e) => { e.preventDefault(); setZoom(z => Math.max(0.5, Math.min(5, z * (e.deltaY < 0 ? 1.15 : 0.87)))); }} />
          {items.length > 1 && (
            <>
              <button className="ce2-lb__nav ce2-lb__nav--l" disabled={idx === 0} onClick={() => setIdx(i => i - 1)} aria-label="Previous image"><ChevronLeft size={18} /></button>
              <button className="ce2-lb__nav ce2-lb__nav--r" disabled={idx === items.length - 1} onClick={() => setIdx(i => i + 1)} aria-label="Next image"><ChevronRight size={18} /></button>
            </>
          )}
        </div>
        <figcaption>
          <div className="ce2-lb__row">
            <b>{cur.media.caption || ev?.claim || 'Evidence media'}</b>
            <span className="ce2-lb__tools">
              <button onClick={() => setZoom(z => Math.min(5, z * 1.3))} aria-label="Zoom in">＋</button>
              <button onClick={() => setZoom(z => Math.max(0.5, z / 1.3))} aria-label="Zoom out">－</button>
              <button onClick={() => figRef.current?.requestFullscreen?.()} aria-label="Fullscreen"><Maximize2 size={12} /></button>
              <span>{idx + 1}/{items.length}</span>
            </span>
          </div>
          <div className="ce2-lb__attr">
            Source: {ev?.source || cur.media.sourceHandle || 'unknown'}
            {ev?.publish_date && ` · ${ev.publish_date}`}
            {ev?.url && <a href={ev.url} target="_blank" rel="noopener noreferrer"> original <ExternalLink size={10} /></a>}
          </div>
          {related.length > 0 && (
            <div className="ce2-lb__rel">Related entities: {related.join(', ')}</div>
          )}
          {ev ? <ArticleSummary iso={iso} runId={run.runId} ev={ev} /> : <GapNote what="linked evidence record" />}
        </figcaption>
      </motion.figure>
    </motion.div>
  );
}

/** (8) hover preview card on nodes. */
export function HoverPreviewCard({ node, run, iso, pos }) {
  if (!node || node.kind === 'community') return null;
  const evs = nodeEvidence(run, node);
  const latest = evs.slice().sort((a, b) => (b.publish_date || '').localeCompare(a.publish_date || ''))[0];
  const media = node.media?.[0];
  const flag = node.kind === 'country' ? (FLAGS[iso] || '') : FLAGS.AE;
  return (
    <div className="ce2-hovercard" style={{ left: pos.x, top: pos.y }}>
      <div className="ce2-hovercard__head">
        {media
          ? <img src={media.url} alt="" className="ce2-hovercard__img" />
          : <div className="ce2-hovercard__img ce2-hovercard__img--gap">{node.label.slice(0, 2).toUpperCase()}</div>}
        <div>
          <b>{flag} {node.fullName || node.label}</b>
          <div className="ce2-hovercard__meta">
            importance {(node.weightSum ?? 0).toFixed(2)} · {node.degree ?? 0} links
            {node.impact && ` · UAE impact: ${node.impact}`}
          </div>
        </div>
      </div>
      <div className="ce2-hovercard__sum">
        {latest ? latest.claim : 'No stored evidence mentions this entity in the current run (evidence gap).'}
      </div>
      <div className="ce2-hovercard__foot">
        {latest?.publish_date ? `last updated ${latest.publish_date}` : 'no dated evidence'}
        {latest?.source && ` · ${latest.source}`}
      </div>
    </div>
  );
}

const IMPACT_ORDER = ['trade', 'diplomacy', 'investment', 'technology', 'food_security', 'energy', 'defence', 'climate', 'education', 'healthcare', 'humanitarian_impact', 'national_ai_strategy', 'economic_diversification', 'foreign_policy'];

/** (5) Entity Inspector — analyst notebook panel. */
export function EntityInspector({ node, run, iso, onClose, onQuickQuery, onLightbox }) {
  const evs = useMemo(() => nodeEvidence(run, node).sort((a, b) => (a.publish_date || '').localeCompare(b.publish_date || '')), [run, node]);
  const rels = run.edges.filter(e => e.entity_a === node.id || e.entity_b === node.id);
  const media = evs.flatMap(ev => (ev.media || []).map(m => ({ media: m, evidence: ev })));
  const impact = (run.impact || []).find(s => s.entity_id === node.id);
  const preds = run.predictions ? Object.entries(run.predictions).flatMap(([cat, arr]) =>
    (arr || []).filter(p => (p.prediction || '').toLowerCase().includes(node.label.toLowerCase())).map(p => ({ ...p, cat }))) : [];
  const coop = rels.filter(e => e.stance === 'cooperation').length;
  const tens = rels.filter(e => e.stance === 'tension').length;
  const sentiment = tens > coop ? 'tension-leaning' : coop > 0 ? 'cooperation-leaning' : 'neutral';
  const geo = node.kind === 'country' || node.kind === 'country-side' ? `${run.country} theatre` : 'UAE / Gulf';
  return (
    <motion.aside className="ce2-inspector" initial={{ x: 380 }} animate={{ x: 0 }} exit={{ x: 380 }} transition={spring} aria-label="Entity inspector">
      <div className="ce2-inspector__head">
        <div>
          <b>{node.fullName || node.label}</b>
          <div className="ce2-inspector__sub">{node.kind} · community {node.community} {node.locked && <Lock size={10} />}</div>
        </div>
        <button onClick={onClose} aria-label="Close inspector"><X size={14} /></button>
      </div>
      <div className="ce2-inspector__scroll">
        <section><h5>Role</h5>
          <p>{node.kind === 'country' ? `Bilateral partner country in the UAE ↔ ${run.country} intelligence picture.`
            : node.kind === 'country-side' ? `${run.country}-side organisation engaged with UAE entities.`
            : `UAE state-linked entity in the ODA registry.`}</p>
        </section>
        <section><h5>Importance</h5>
          <p>weight {(node.weightSum ?? 0).toFixed(3)} · PageRank {(node.pagerank ?? 0).toFixed(4)} · degree {node.degree ?? 0}
            {node.keyEntity && ' · ★ key entity'}</p>
        </section>
        <section><h5>Timeline</h5>
          {evs.filter(e => e.publish_date).length
            ? <ul className="ce2-tl">{evs.filter(e => e.publish_date).map(e => (
                <li key={e.id}><span>{e.publish_date}</span> {e.claim}</li>))}</ul>
            : <GapNote what="dated events" />}
        </section>
        <section><h5>Relationships ({rels.length})</h5>
          {rels.length ? rels.map(e => (
            <div key={e.id} className="ce2-rel">
              <span className="ce2-tier" style={{ '--tc': VERIFICATION_STYLES[e.verification || 'Likely']?.color }}>{e.verification || e.relationship_type}</span>
              {e.entity_a === node.id ? `→ ${e.entity_b}` : `← ${e.entity_a}`} · {e.relationship_type} · conf {(e.confidence ?? 0).toFixed(2)}
            </div>
          )) : <GapNote what="direct relationships" />}
        </section>
        <section><h5>Recent activity</h5>
          {evs.length ? <p>{evs[evs.length - 1].claim}</p> : <GapNote what="recent activity" />}
        </section>
        <section><h5>Summary</h5>
          {impact ? <p>{impact.overall_reasoning}</p> : <GapNote what="impact summary" />}
        </section>
        <section><h5>Media ({media.length})</h5>
          {media.length ? (
            <div className="ce2-mediagrid">{media.map((m, i) => (
              <button key={i} className="ce-thumb" onClick={() => onLightbox({ items: media, index: i, media: m.media, evidence: m.evidence })}>
                <img src={m.media.url} alt="" loading="lazy" />
              </button>))}</div>
          ) : <GapNote what="stored media" />}
        </section>
        <section><h5>Sources</h5>
          {evs.length ? evs.map(e => (
            <div key={e.id} className="ce2-src">
              <span className={`ce-ev__plat ce-ev__plat--${evPlatform(e)}`}>{evPlatform(e)}</span> {e.source}
              {e.url && <a href={e.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={10} /></a>}
              {e.weighting && <span className="ce2-w">w={e.weighting.finalWeight}</span>}
            </div>
          )) : <GapNote what="sources" />}
        </section>
        <section><h5>Confidence</h5>
          <p>{rels.length ? `mean edge confidence ${(rels.reduce((a, e) => a + (e.confidence || 0), 0) / rels.length).toFixed(2)}` : 'no edges to score'}
            {evs.length ? ` · mean evidence confidence ${(evs.reduce((a, e) => a + (e.confidence || 0), 0) / evs.length).toFixed(2)}` : ''}</p>
        </section>
        <section><h5>Geographic relevance</h5><p>{geo}</p></section>
        <section><h5>Sentiment</h5><p>{sentiment} ({coop} cooperation / {tens} tension edges)</p></section>
        <section><h5>Predicted trajectory</h5>
          {preds.length ? preds.map((p, i) => (
            <p key={i} className={p.grounded ? '' : 'ce2-spec'}>
              [{p.cat}] {p.prediction} — p={p.probability}{p.grounded ? '' : ' (speculation)'}
            </p>
          )) : impact ? (
            <div className="ce2-impactgrid">
              {IMPACT_ORDER.filter(d => impact.dimensions?.[d] && impact.dimensions[d].level !== 'None').slice(0, 6).map(d => (
                <div key={d}><b>{d.replace(/_/g, ' ')}</b>: {impact.dimensions[d].level} — {impact.dimensions[d].reasoning}</div>
              ))}
              {IMPACT_ORDER.every(d => !impact.dimensions?.[d] || impact.dimensions[d].level === 'None') &&
                <GapNote what="non-None impact dimensions (structural prior run)" />}
            </div>
          ) : <GapNote what="predictions" />}
        </section>
      </div>
      <div className="ce2-inspector__foot">
        <button className="ce-pop__qq" onClick={onQuickQuery}><Zap size={11} /> Quick Query</button>
      </div>
    </motion.aside>
  );
}

/** (6) Relationship Inspector card on edge click. */
export function RelationshipInspector({ link, run, iso, onClose, onQuickQuery, onLightbox }) {
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  const evs = (link.evidenceIds || []).map(id => evById.get(id)).filter(Boolean);
  const media = evs.flatMap(ev => (ev.media || []).map(m => ({ media: m, evidence: ev })));
  const a = link.rawA || (typeof link.source === 'object' ? link.source.id : link.source);
  const b = link.rawB || (typeof link.target === 'object' ? link.target.id : link.target);
  const countryNode = run.nodes.find(n => n.kind === 'country');
  // connection chain: UAE → entity_a → relationship → entity_b → country context
  const chain = ['UAE', a, `${link.type}`, b, countryNode ? countryNode.label : run.country].filter((v, i, arr) => arr.indexOf(v) === i);
  const vs = VERIFICATION_STYLES[link.verification || 'Likely'] || {};
  return (
    <motion.aside className="ce2-inspector ce2-inspector--edge" initial={{ x: 380 }} animate={{ x: 0 }} exit={{ x: 380 }} transition={spring} aria-label="Relationship inspector">
      <div className="ce2-inspector__head">
        <div>
          <b style={{ color: vs.color }}>{link.verification || link.type}{link.inference ? ' (inferred)' : ''} · conf {(link.confidence ?? 0).toFixed(2)}</b>
          <div className="ce2-inspector__sub">{link.type} · weight {(link.weight ?? 0).toFixed(2)}{link.contradiction ? ' · ⚠ contradiction' : ''}</div>
        </div>
        <button onClick={onClose} aria-label="Close inspector"><X size={14} /></button>
      </div>
      <div className="ce2-inspector__scroll">
        <section><h5>Connection chain</h5>
          <div className="ce2-chain">{chain.map((c, i) => (
            <React.Fragment key={i}>{i > 0 && <span className="ce2-chain__arrow">→</span>}<span className="ce2-chain__hop">{c}</span></React.Fragment>
          ))}</div>
        </section>
        <section><h5>Why this relationship exists</h5>
          <p>{link.claim || 'No claim stored.'}</p>
          {link.inference && <p className="ce2-spec">This edge was inferred by the AI correlation layer{evs.length ? ' from the motivating evidence below' : ' without direct evidence'} — it is {link.verification}, not a verified fact.</p>}
        </section>
        <section><h5>Evidence &amp; articles ({evs.length})</h5>
          {evs.length ? evs.map(ev => (
            <div key={ev.id} className="ce-ev">
              <div className="ce-ev__head">
                <span className={`ce-ev__plat ce-ev__plat--${evPlatform(ev)}`}>{evPlatform(ev)}</span>
                <span className="ce-ev__src">{ev.source}</span>
                {ev.publish_date && <span className="ce-ev__date">{ev.publish_date}</span>}
                {ev.weighting && <span className="ce2-w">w={ev.weighting.finalWeight}</span>}
              </div>
              <p>{ev.claim}</p>
              {ev.url && <a className="ce-pop__link" href={ev.url} target="_blank" rel="noopener noreferrer">source <ExternalLink size={10} /></a>}
              <ArticleSummary iso={iso} runId={run.runId} ev={ev} />
            </div>
          )) : <GapNote what="direct evidence (unevidenced inference)" />}
        </section>
        <section><h5>Images</h5>
          {media.length ? (
            <div className="ce2-mediagrid">{media.map((m, i) => (
              <button key={i} className="ce-thumb" onClick={() => onLightbox({ items: media, index: i, media: m.media, evidence: m.evidence })}>
                <img src={m.media.url} alt="" loading="lazy" />
              </button>))}</div>
          ) : <GapNote what="images" />}
        </section>
        <section><h5>Timeline</h5>
          {evs.filter(e => e.publish_date).length
            ? <ul className="ce2-tl">{evs.filter(e => e.publish_date).sort((x, y) => x.publish_date.localeCompare(y.publish_date)).map(e => (
                <li key={e.id}><span>{e.publish_date}</span> {e.claim}</li>))}</ul>
            : <GapNote what="dated evidence" />}
        </section>
      </div>
      <div className="ce2-inspector__foot">
        <button className="ce-pop__qq" onClick={onQuickQuery}><Zap size={11} /> Quick Query</button>
      </div>
    </motion.aside>
  );
}

/** (4) Louvain community chips with collapse/expand. */
export function ClusterChips({ communities, collapsed, onToggle }) {
  if (!communities.length) return null;
  return (
    <div className="ce2-clusters" role="group" aria-label="Community clusters">
      {communities.map(c => (
        <motion.button key={c.id} layout className={`ce2-cluster${collapsed.has(c.id) ? ' ce2-cluster--closed' : ''}`}
          onClick={() => onToggle(c.id)} transition={spring}>
          {c.label} ({c.count} entities) {collapsed.has(c.id) ? '▸' : '▾'}
        </motion.button>
      ))}
    </div>
  );
}

/** (11) interactive intelligence timeline with drag-through replay. */
export function TimelineReplay({ dates, cutoff, onScrub, run }) {
  if (!dates.length) return <GapNote what="dated evidence for timeline replay" />;
  const idx = cutoff ? dates.indexOf(cutoff) : dates.length - 1;
  const evCount = (d) => run.evidence.filter(e => e.publish_date === d).length;
  return (
    <div className="ce2-timeline" aria-label="Intelligence timeline replay">
      <div className="ce2-timeline__ticks">
        {dates.map((d, i) => (
          <button key={d} className={`ce2-tick${i <= (idx < 0 ? dates.length - 1 : idx) ? ' on' : ''}`}
            style={{ '--h': `${6 + evCount(d) * 8}px` }}
            title={`${d} · ${evCount(d)} evidence`} onClick={() => onScrub(d)} />
        ))}
      </div>
      <input type="range" min={0} max={dates.length - 1} value={idx < 0 ? dates.length - 1 : idx}
        onChange={(e) => onScrub(dates[Number(e.target.value)])} aria-label="Timeline scrub" />
      <div className="ce2-timeline__row">
        <span>{dates[0]}</span>
        <b>{cutoff || 'full picture'} — edges appear/strengthen as evidence lands</b>
        <span>{dates[dates.length - 1]}</span>
        {cutoff && <button className="ce-btn ce-btn--ghost" onClick={() => onScrub(null)}>reset</button>}
      </div>
    </div>
  );
}

/** (14) one-click Story Mode (streamed gpt-5.6-sol-medium). */
export function StoryMode({ iso, run, onClose, onQuickQuery }) {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(true);
  useEffect(() => {
    let live = true;
    streamStory(iso, run.runId, {
      onToken: (_t, full) => { if (live) setText(full); },
    }).then((full) => { if (live) { setText(full || 'Story unavailable.'); setStreaming(false); } });
    return () => { live = false; };
  }, [iso, run.runId]);
  return (
    <motion.div className="ce2-story" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
      <div className="ce2-story__head">
        <b><Play size={12} /> Story Mode — UAE ↔ {run.country}</b>
        <span>
          <button className="ce-pop__qq" onClick={() => onQuickQuery(text)}><Zap size={11} /> Quick Query</button>
          <button onClick={onClose} aria-label="Close story"><X size={14} /></button>
        </span>
      </div>
      <div className="ce2-story__body" dir="auto">
        {text || 'Narrating from evidence (gpt-5.6-sol-medium, streamed)…'}
        {streaming && <span className="qq-caret">▍</span>}
      </div>
    </motion.div>
  );
}
