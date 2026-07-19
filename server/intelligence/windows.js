// windows.js — DEEP SEARCH MODE research windows (added 2026-07-19, deep-pipeline rewrite).
// Selectable research windows exposed as a pipeline parameter and API/config option.
// Default: 'Last 2 Years + higher weighting on Last 30 Days' (id: "2y", boostRecentDays 30).

export const RESEARCH_WINDOWS = {
  '24h': { id: '24h', label: 'Last 24 hours',  days: 1,    boostRecentDays: null, boostFactor: 1 },
  '1w':  { id: '1w',  label: 'Last 1 week',    days: 7,    boostRecentDays: null, boostFactor: 1 },
  '1m':  { id: '1m',  label: 'Last 1 month',   days: 30,   boostRecentDays: null, boostFactor: 1 },
  '6m':  { id: '6m',  label: 'Last 6 months',  days: 182,  boostRecentDays: 30,   boostFactor: 1.25 },
  '1y':  { id: '1y',  label: 'Last 1 year',    days: 365,  boostRecentDays: 30,   boostFactor: 1.25 },
  // DEFAULT — Last 2 Years with higher weighting applied to facts from the Last 30 Days.
  '2y':  { id: '2y',  label: 'Last 2 years (30-day boost)', days: 730, boostRecentDays: 30, boostFactor: 1.5 },
  'all': { id: 'all', label: 'Entire history', days: null, boostRecentDays: 30,   boostFactor: 1.5 },
};

export const DEFAULT_WINDOW = '2y';

export function resolveWindow(id) {
  return RESEARCH_WINDOWS[String(id || '').toLowerCase()] || RESEARCH_WINDOWS[DEFAULT_WINDOW];
}

/** Human phrase for prompt injection, e.g. "the last 2 years (2024-07-19 → 2026-07-19)". */
export function windowPhrase(win, nowTs = Date.now()) {
  const end = new Date(nowTs).toISOString().slice(0, 10);
  if (!win.days) return `the entire available history up to ${end}`;
  const start = new Date(nowTs - win.days * 86400000).toISOString().slice(0, 10);
  return `${win.label.toLowerCase()} (${start} → ${end})`;
}

/** True if an ISO publish date falls inside the window (unknown dates are kept — gated later by weighting). */
export function inWindow(publishDate, win, nowTs = Date.now()) {
  if (!win.days) return true;
  const t = Date.parse(publishDate || '');
  if (!Number.isFinite(t)) return true; // keep undated; weighting treats it as historical
  return (nowTs - t) <= win.days * 86400000;
}
