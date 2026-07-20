// src/voice/GeneratedUI.jsx — approved React components for validated UI blocks.
// No dangerouslySetInnerHTML anywhere; all text rendered as React text nodes.
// rAF-batched insertion happens in VoiceMode (this file is pure presentational).
import React from 'react';
import { ExternalLink, TrendingUp, TrendingDown, Minus, AlertTriangle, Info, Pin, X } from 'lucide-react';

const Trend = ({ t }) => t === 'up' ? <TrendingUp size={11} aria-hidden /> : t === 'down' ? <TrendingDown size={11} aria-hidden /> : t === 'flat' ? <Minus size={11} aria-hidden /> : null;

const Sources = ({ sources }) => !sources?.length ? null : (
  <div className="vgen-sources">
    {sources.slice(0, 6).map((s, i) => (
      <span key={i} className="vgen-src">
        {s.id ? <b>{s.id}</b> : null} {s.source}{s.date ? ` · ${s.date}` : ''}
        {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" aria-label={`Open source ${s.source}`}><ExternalLink size={9} aria-hidden /></a> : null}
      </span>
    ))}
  </div>
);

const C = {
  CountrySummaryCard: ({ p }) => (<div><h6>{p.title}</h6><p>{p.summary}</p>
    {p.metrics?.length ? <div className="vgen-metrics">{p.metrics.map((m, i) => <span key={i}>{m.label}: <b>{m.value}</b> <Trend t={m.trend} /></span>)}</div> : null}
    <Sources sources={p.sources} /></div>),
  ComparisonTable: ({ p }) => (<div>{p.title ? <h6>{p.title}</h6> : null}
    <table className="vgen-table"><thead><tr>{p.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>{p.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
    <Sources sources={p.sources} /></div>),
  MetricCard: ({ p }) => (<div className="vgen-metric"><span>{p.label}</span><b>{p.value}{p.unit ? ` ${p.unit}` : ''}</b> <Trend t={p.trend} /><Sources sources={p.sources} /></div>),
  Timeline: ({ p }) => (<div>{p.title ? <h6>{p.title}</h6> : null}
    <ul className="vgen-timeline">{p.events.map((e, i) => <li key={i}><b>{e.date}</b> {e.label}{e.detail ? <span> — {e.detail}</span> : null}</li>)}</ul>
    <Sources sources={p.sources} /></div>),
  RiskMatrix: ({ p }) => (<div>{p.title ? <h6>{p.title}</h6> : null}
    <ul className="vgen-risks">{p.risks.map((r, i) => <li key={i} data-sev={r.impact}><b>{r.label}</b> <span>likelihood {r.likelihood} · impact {r.impact}</span></li>)}</ul>
    <Sources sources={p.sources} /></div>),
  RouteSummary: ({ p }) => (<div><h6>{p.from} → {p.to}{p.mode ? ` (${p.mode})` : ''}</h6><p>{p.summary}</p><Sources sources={p.sources} /></div>),
  SourceList: ({ p }) => (<div>{p.title ? <h6>{p.title}</h6> : null}<Sources sources={p.sources} /></div>),
  EvidenceCard: ({ p }) => (<div className="vgen-evidence">
    {p.verification ? <span className={`vgen-tier vgen-tier--${p.verification.toLowerCase()}`}>{p.verification}</span> : null}
    <p>{p.claim}</p><Sources sources={[{ id: p.id, source: p.source, date: p.date, url: p.url }]} /></div>),
  ScenarioCard: ({ p }) => (<div><h6>{p.title}{p.kind ? <em className="vgen-kind"> · {p.kind}</em> : null}</h6><p>{p.narrative}</p>
    {typeof p.probability === 'number' ? <span className="vgen-prob">p={p.probability.toFixed(2)}</span> : null}<Sources sources={p.sources} /></div>),
  RecommendationCard: ({ p }) => (<div><h6>{p.title}<em className="vgen-kind"> · recommendation</em></h6><p>{p.recommendation}</p>
    {p.rationale ? <p className="vgen-rationale">{p.rationale}</p> : null}<Sources sources={p.sources} /></div>),
  SmallChart: ({ p }) => (<div>{p.title ? <h6>{p.title}</h6> : null}
    <div className="vgen-chart" role="img" aria-label={p.title || 'chart'}>
      {p.y.map((v, i) => { const max = Math.max(...p.y, 1); return (
        <span key={i} className="vgen-bar" title={`${p.x[i] ?? i}: ${v}`}
          style={{ height: `${Math.max(4, (v / max) * 42)}px` }} />); })}
    </div><Sources sources={p.sources} /></div>),
  Alert: ({ p }) => (<div className={`vgen-alert vgen-alert--${p.severity}`}>
    {p.severity === 'info' ? <Info size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />} {p.text}<Sources sources={p.sources} /></div>),
  KeyFinding: ({ p }) => (<div className="vgen-finding">{p.basis ? <span className={`vgen-basis vgen-basis--${p.basis}`}>{p.basis}</span> : null}<p>{p.finding}</p><Sources sources={p.sources} /></div>),
  ActionList: ({ p }) => (<div>{p.title ? <h6>{p.title}</h6> : null}
    <ol className="vgen-actions">{p.actions.map((a, i) => <li key={i}><b>{a.label}</b>{a.detail ? <span> — {a.detail}</span> : null}</li>)}</ol></div>),
};

/** One generated card: pinnable/dismissible; renders only approved validated blocks. */
export default function GeneratedCard({ block, onPin, onDismiss, pinned }) {
  const Cmp = C[block.component];
  if (!Cmp) return null; // unknown → skip (already filtered by uiSchema, double-guard)
  return (
    <div className={`vgen-card${pinned ? ' pinned' : ''}`} data-component={block.component} data-anchor={block.anchor || ''}>
      <div className="vgen-card__bar">
        <span className="vgen-card__type">{block.component}</span>
        <button onClick={onPin} aria-label={pinned ? 'Unpin card' : 'Pin card'} title={pinned ? 'Unpin' : 'Pin'}><Pin size={10} aria-hidden /></button>
        <button onClick={onDismiss} aria-label="Dismiss card"><X size={10} aria-hidden /></button>
      </div>
      <Cmp p={block.props} />
    </div>
  );
}
