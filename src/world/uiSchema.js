// uiSchema.js — validated JSON component schema for SAFE generated UI
// (2026-07-20). The model streams {ui:[...]} blocks; ONLY components that pass
// this validator render, each mapped to an allowlisted React component.
// No dangerouslySetInnerHTML anywhere — every field renders as TEXT.

const MAX_STR = 400;
const MAX_ITEMS = 12;

const str = (v, max = MAX_STR) => typeof v === 'string' && v.length > 0 && v.length <= max;
const optStr = (v, max = MAX_STR) => v == null || str(v, max);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const optNum = (v) => v == null || num(v);
const iso2 = (v) => typeof v === 'string' && /^[A-Za-z]{2}$/.test(v);
const optIso = (v) => v == null || iso2(v);
const arr = (v, fn, max = MAX_ITEMS) => Array.isArray(v) && v.length <= max && v.every(fn);
const optArr = (v, fn, max = MAX_ITEMS) => v == null || arr(v, fn, max);

/** Only http(s) URLs pass; anything else (javascript:, data:, blob:) is rejected. */
export function safeUrl(v) {
  if (typeof v !== 'string' || v.length > 600) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}
const optUrl = (v) => v == null || safeUrl(v);

// Evidence/source provenance tag — distinguishes fact/evidence/inference/uncertainty
const PROVENANCE = new Set(['verified', 'evidence', 'inference', 'uncertain']);
const prov = (v) => v == null || PROVENANCE.has(v);

const sourceItem = (s) => s != null && typeof s === 'object' && str(s.title, 200) && optUrl(s.url) && optStr(s.date, 40) && prov(s.provenance);
const metricItem = (m) => m != null && typeof m === 'object' && str(m.label, 120) && (str(String(m.value), 80)) && optStr(m.unit, 24) && optStr(m.trend, 24) && prov(m.provenance);
const rowItem = (r) => Array.isArray(r) && r.length <= 8 && r.every(c => str(String(c), 160));
const timePoint = (p) => p != null && typeof p === 'object' && str(p.date, 40) && str(p.label, 200) && prov(p.provenance);
const riskCell = (r) => r != null && typeof r === 'object' && str(r.title, 160) && ['low','medium','high','critical'].includes(String(r.severity).toLowerCase()) && optStr(r.likelihood, 24);
const chartPoint = (p) => p != null && typeof p === 'object' && str(String(p.x), 60) && num(p.y);
const actionItem = (a) => a != null && typeof a === 'object' && str(a.text, 240) && optStr(a.owner, 80);

/** component type -> validator(props) -> true|string(error) */
export const UI_COMPONENTS = Object.freeze({
  countrySummary: (p) => (iso2(p?.iso) && str(p.title, 160) && optStr(p.summary, 1200) && optArr(p.metrics, metricItem, 8) && optArr(p.sources, sourceItem, 8)) || 'countrySummary: iso+title required; summary<=1200; metrics<=8; sources<=8',
  comparisonTable: (p) => (str(p?.title, 160) && arr(p.columns, c => str(c, 80), 8) && arr(p.rows, rowItem, MAX_ITEMS)) || 'comparisonTable: title, columns[<=8], rows[<=12][<=8] required',
  metricCard: (p) => (metricItem(p) ? true : 'metricCard: label+value required'),
  timeline: (p) => (str(p?.title, 160) && arr(p.points, timePoint, MAX_ITEMS)) || 'timeline: title + points[{date,label}] required',
  riskMatrix: (p) => (str(p?.title, 160) && arr(p.risks, riskCell, MAX_ITEMS)) || 'riskMatrix: title + risks[{title,severity}] required',
  routeSummary: (p) => (str(p?.title, 160) && optIso(p.from) && optIso(p.to) && optStr(p.mode, 40) && optStr(p.summary, 800)) || 'routeSummary: title required; from/to ISO2',
  sourceList: (p) => (arr(p?.sources, sourceItem, MAX_ITEMS) ? true : 'sourceList: sources[{title,url?,provenance?}] required'),
  evidenceCard: (p) => (str(p?.claim, 400) && prov(p.provenance) && optArr(p.sources, sourceItem, 6) && optStr(p.snippet, 600)) || 'evidenceCard: claim required',
  scenarioCard: (p) => (str(p?.title, 160) && str(p.narrative, 1000) && optStr(p.probability, 40)) || 'scenarioCard: title+narrative required',
  recommendationCard: (p) => (str(p?.title, 160) && arr(p.actions, actionItem, 8)) || 'recommendationCard: title + actions[{text}] required',
  chart: (p) => (str(p?.title, 160) && ['bar','line'].includes(p.kind) && arr(p.points, chartPoint, 24)) || 'chart: title, kind bar|line, points[{x,y}] required',
  alert: (p) => (str(p?.text, 400) && ['info','warn','critical'].includes(String(p.level || 'info'))) || 'alert: text required; level info|warn|critical',
  actionList: (p) => (arr(p?.actions, actionItem, MAX_ITEMS) ? true : 'actionList: actions[{text}] required'),
  sourcePanel: (p) => (str(p?.title, 160) && arr(p.sources, sourceItem, MAX_ITEMS)) || 'sourcePanel: title + sources required',
});

export const ALLOWED_UI_TYPES = Object.freeze(Object.keys(UI_COMPONENTS));

/**
 * Validate one streamed UI block. Returns {ok, type, props, anchor} | {ok:false, error}.
 * anchor: optional ISO2 country the card is spatially attached to.
 */
export function validateUiBlock(raw) {
  try {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ui block must be an object' };
    const type = raw.type ?? raw.component;
    if (typeof type !== 'string' || !(type in UI_COMPONENTS)) return { ok: false, error: `unknown ui type "${String(type).slice(0, 40)}"` };
    const props = raw.props ?? raw.data ?? {};
    if (typeof props !== 'object' || Array.isArray(props)) return { ok: false, error: 'props must be an object' };
    if (JSON.stringify(props).length > 8000) return { ok: false, error: 'props too large' };
    const v = UI_COMPONENTS[type](props);
    if (v !== true) return { ok: false, error: v };
    const anchor = iso2(raw.anchor) ? raw.anchor.toUpperCase() : null;
    return { ok: true, type, props, anchor };
  } catch (e) {
    return { ok: false, error: 'ui validation failure: ' + (e?.message || 'unknown') };
  }
}
