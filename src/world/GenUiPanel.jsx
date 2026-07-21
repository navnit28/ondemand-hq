// GenUiPanel.jsx — SAFE generated-UI renderer (2026-07-20). Every card type maps
// 1:1 to an allowlisted component below; props arrive ONLY through
// uiSchema.validateUiBlock (already validated + URL-sanitised upstream).
// ALL content renders as React text nodes — no dangerouslySetInnerHTML anywhere.
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Pin, PinOff, ChevronDown, ChevronUp, X, ExternalLink, AlertTriangle } from 'lucide-react';
import Flag from '../intel/Flag.jsx';
import { safeUrl } from './uiSchema.js';
import { bidiAttrs, isolateMixed } from './bidi.js';
import { vt } from './voiceI18n.js';

const spring = { type: 'spring', stiffness: 360, damping: 30 };

function Provenance({ p, lang }) {
  if (!p) return null;
  return <span className={`wv-prov wv-prov--${p}`} title={vt(lang, 'provenance')[p] || p}>{vt(lang, 'provenance')[p] || p}</span>;
}

function Sources({ sources, lang }) {
  if (!sources?.length) return null;
  return (
    <div className="wv-sources">
      {sources.slice(0, 8).map((s, i) => (
        <span key={i} className="wv-source">
          {safeUrl(s.url)
            ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title} <ExternalLink size={9} aria-hidden /></a>
            : <span>{s.title}</span>}
          <Provenance p={s.provenance} lang={lang} />
        </span>
      ))}
    </div>
  );
}

const Txt = ({ children, lang }) => <span {...bidiAttrs(String(children ?? ''), 'auto')}>{isolateMixed(String(children ?? ''))}</span>;

/* ---------- allowlisted card components ---------- */
const CARDS = {
  countrySummary: ({ p, lang }) => (
    <div>
      <div className="wv-card__head"><Flag iso={p.iso} size="sm" title={p.iso} /> <b><Txt lang={lang}>{p.title}</Txt></b></div>
      {p.summary && <p className="wv-card__body"><Txt lang={lang}>{p.summary}</Txt></p>}
      {p.metrics?.length > 0 && (
        <div className="wv-metrics">
          {p.metrics.map((m, i) => (
            <div key={i} className="wv-metric">
              <b>{String(m.value)}{m.unit ? ` ${m.unit}` : ''}</b>
              <span><Txt lang={lang}>{m.label}</Txt></span>
              <Provenance p={m.provenance} lang={lang} />
            </div>
          ))}
        </div>
      )}
      <Sources sources={p.sources} lang={lang} />
    </div>
  ),
  comparisonTable: ({ p, lang }) => (
    <div>
      <div className="wv-card__head"><b><Txt lang={lang}>{p.title}</Txt></b></div>
      <table className="wv-table">
        <thead><tr>{p.columns.map((c, i) => <th key={i}><Txt lang={lang}>{c}</Txt></th>)}</tr></thead>
        <tbody>{p.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Txt lang={lang}>{String(c)}</Txt></td>)}</tr>)}</tbody>
      </table>
    </div>
  ),
  metricCard: ({ p, lang }) => (
    <div className="wv-metric wv-metric--solo">
      <b>{String(p.value)}{p.unit ? ` ${p.unit}` : ''}</b>
      <span><Txt lang={lang}>{p.label}</Txt></span>
      {p.trend && <em>{p.trend}</em>}
      <Provenance p={p.provenance} lang={lang} />
    </div>
  ),
  timeline: ({ p, lang }) => (
    <div>
      <div className="wv-card__head"><b><Txt lang={lang}>{p.title}</Txt></b></div>
      <ol className="wv-timeline">
        {p.points.map((pt, i) => (
          <li key={i}><span className="wv-timeline__date">{pt.date}</span> <Txt lang={lang}>{pt.label}</Txt> <Provenance p={pt.provenance} lang={lang} /></li>
        ))}
      </ol>
    </div>
  ),
  riskMatrix: ({ p, lang }) => (
    <div>
      <div className="wv-card__head"><b><Txt lang={lang}>{p.title}</Txt></b></div>
      <div className="wv-risks">
        {p.risks.map((r, i) => (
          <div key={i} className="wv-risk">
            <span className={`ig-impact ig-impact--${String(r.severity).toLowerCase()}`}>{r.severity}</span>
            <Txt lang={lang}>{r.title}</Txt>
            {r.likelihood && <em className="wv-risk__lk">{r.likelihood}</em>}
          </div>
        ))}
      </div>
    </div>
  ),
  routeSummary: ({ p, lang }) => (
    <div>
      <div className="wv-card__head">
        <b><Txt lang={lang}>{p.title}</Txt></b>
        {p.from && p.to && <span className="wv-route">{p.from} → {p.to}{p.mode ? ` · ${p.mode}` : ''}</span>}
      </div>
      {p.summary && <p className="wv-card__body"><Txt lang={lang}>{p.summary}</Txt></p>}
    </div>
  ),
  sourceList: ({ p, lang }) => <Sources sources={p.sources} lang={lang} />,
  evidenceCard: ({ p, lang }) => (
    <div>
      <p className="wv-card__body"><Txt lang={lang}>{p.claim}</Txt> <Provenance p={p.provenance} lang={lang} /></p>
      {p.snippet && <blockquote className="wv-quote"><Txt lang={lang}>{p.snippet}</Txt></blockquote>}
      <Sources sources={p.sources} lang={lang} />
    </div>
  ),
  scenarioCard: ({ p, lang }) => (
    <div>
      <div className="wv-card__head"><b><Txt lang={lang}>{p.title}</Txt></b>{p.probability && <em className="wv-prob">{p.probability}</em>}</div>
      <p className="wv-card__body"><Txt lang={lang}>{p.narrative}</Txt></p>
    </div>
  ),
  recommendationCard: ({ p, lang }) => (
    <div>
      <div className="wv-card__head"><b><Txt lang={lang}>{p.title}</Txt></b></div>
      <ul className="wv-actions">{p.actions.map((a, i) => <li key={i}><Txt lang={lang}>{a.text}</Txt>{a.owner && <em> — {a.owner}</em>}</li>)}</ul>
    </div>
  ),
  chart: ({ p, lang }) => {
    const max = Math.max(...p.points.map(pt => pt.y), 1);
    return (
      <div>
        <div className="wv-card__head"><b><Txt lang={lang}>{p.title}</Txt></b></div>
        <div className={`wv-chart wv-chart--${p.kind}`} role="img" aria-label={p.title}>
          {p.points.map((pt, i) => (
            <div key={i} className="wv-chart__col" title={`${pt.x}: ${pt.y}`}>
              <div className="wv-chart__bar" style={{ height: `${Math.max(4, (pt.y / max) * 56)}px` }} />
              <span className="wv-chart__x">{String(pt.x)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  },
  alert: ({ p, lang }) => (
    <div className={`wv-alert wv-alert--${p.level || 'info'}`}>
      <AlertTriangle size={12} aria-hidden /> <Txt lang={lang}>{p.text}</Txt>
    </div>
  ),
  actionList: ({ p, lang }) => (
    <ul className="wv-actions">{p.actions.map((a, i) => <li key={i}><Txt lang={lang}>{a.text}</Txt>{a.owner && <em> — {a.owner}</em>}</li>)}</ul>
  ),
  sourcePanel: ({ p, lang }) => (
    <details className="wv-srcpanel">
      <summary><Txt lang={lang}>{p.title}</Txt></summary>
      <Sources sources={p.sources} lang={lang} />
    </details>
  ),
};

/** One validated card: expandable / collapsible / pinnable / dismissible. */
export function GenUiCard({ block, lang, onDismiss, onPin, pinned }) {
  const [open, setOpen] = useState(true);
  const Cmp = CARDS[block.type];
  if (!Cmp) return null; // unreachable post-validation; defensive anyway
  return (
    <motion.div layout className={`wv-card${pinned ? ' wv-card--pinned' : ''}`}
      initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={spring}>
      <div className="wv-card__bar">
        {block.anchor && <span className="wv-card__anchor"><Flag iso={block.anchor} size="sm" title={block.anchor} /></span>}
        <span className="wv-card__type">{block.type}</span>
        <span style={{ flex: 1 }} />
        <button className="wv-iconbtn" onClick={() => onPin?.(block)} aria-label={pinned ? vt(lang, 'unpin') : vt(lang, 'pin')} title={pinned ? vt(lang, 'unpin') : vt(lang, 'pin')}>
          {pinned ? <PinOff size={11} aria-hidden /> : <Pin size={11} aria-hidden />}
        </button>
        <button className="wv-iconbtn" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={open ? vt(lang, 'collapse') : vt(lang, 'expand')}>
          {open ? <ChevronUp size={11} aria-hidden /> : <ChevronDown size={11} aria-hidden />}
        </button>
        <button className="wv-iconbtn" onClick={() => onDismiss?.(block)} aria-label={vt(lang, 'close')}>
          <X size={11} aria-hidden />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
            <div className="wv-card__inner"><Cmp p={block.props} lang={lang} /></div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
