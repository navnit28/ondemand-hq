// worldCommands.js — STRICT typed allowlisted command schema for voice-controlled
// world actions (2026-07-20). Arbitrary model text can NEVER execute UI actions:
// only a validated command object that passes this schema is dispatched.

const ISO2 = /^[A-Za-z]{2}$/;

// Countries known to the world (BASELINE registry — keep in sync with server/intel.js COUNTRIES)
export const KNOWN_ISOS = new Set([
  'EG', 'JO', 'PK', 'KE', 'ET', 'BD', 'ID', 'MA', 'RW', 'SD', 'SO', 'SY', 'TZ', 'UG', 'YE', 'LB',
]);

export const KNOWN_LAYERS = new Set(['intel', 'correlations', 'x', 'opps', 'risks', 'agreements', 'timeline']);

const isIso = (v) => typeof v === 'string' && ISO2.test(v) && KNOWN_ISOS.has(v.toUpperCase());
const isIsoList = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every(isIso);
const isLayer = (v) => typeof v === 'string' && KNOWN_LAYERS.has(v.toLowerCase());
const isStep = (v) => Number.isFinite(v) && Math.abs(v) <= 24 && v !== 0;

/** command name -> { validate(args) -> true|string(error), normalize(args) } */
export const COMMAND_SCHEMA = Object.freeze({
  rotateTo:          { validate: a => isIso(a?.iso) || 'rotateTo requires iso (known ISO2)', normalize: a => ({ iso: a.iso.toUpperCase() }) },
  showCountry:       { validate: a => isIso(a?.iso) || 'showCountry requires iso (known ISO2)', normalize: a => ({ iso: a.iso.toUpperCase() }) },
  openLayer:         { validate: a => isLayer(a?.layer) || 'openLayer requires layer in ' + [...KNOWN_LAYERS].join('|'), normalize: a => ({ layer: a.layer.toLowerCase() }) },
  compare:           { validate: a => (isIsoList(a?.isos) && a.isos.length >= 2) || 'compare requires isos: 2-8 known ISO2 codes', normalize: a => ({ isos: a.isos.map(i => i.toUpperCase()) }) },
  zoomIn:            { validate: () => true, normalize: () => ({}) },
  zoomOut:           { validate: () => true, normalize: () => ({}) },
  resetView:         { validate: () => true, normalize: () => ({}) },
  showRoutes:        { validate: a => a == null || a?.iso == null || isIso(a.iso) || 'showRoutes iso must be a known ISO2', normalize: a => (a?.iso ? { iso: a.iso.toUpperCase() } : {}) },
  highlightCountries:{ validate: a => isIsoList(a?.isos) || 'highlightCountries requires isos: 1-8 known ISO2 codes', normalize: a => ({ isos: a.isos.map(i => i.toUpperCase()) }) },
  timelineShift:     { validate: a => isStep(a?.step) || 'timelineShift requires non-zero numeric step |step|<=24', normalize: a => ({ step: Math.trunc(a.step) }) },
  openSources:       { validate: () => true, normalize: () => ({}) },
  closePanel:        { validate: () => true, normalize: () => ({}) },
});

export const ALLOWED_COMMANDS = Object.freeze(Object.keys(COMMAND_SCHEMA));

/**
 * Validate ONE raw command object ({command|cmd|name, args|params}).
 * Returns {ok:true, command, args} or {ok:false, error} — NEVER throws.
 * Malformed, unknown, oversized, or prototype-polluting input is safely rejected.
 */
export function validateCommand(raw) {
  try {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'command must be an object' };
    const name = raw.command ?? raw.cmd ?? raw.name;
    if (typeof name !== 'string') return { ok: false, error: 'missing command name' };
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') return { ok: false, error: 'illegal command name' };
    const spec = COMMAND_SCHEMA[name];
    if (!spec) return { ok: false, error: `unknown command "${String(name).slice(0, 40)}"` };
    const args = raw.args ?? raw.params ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'args must be an object' };
    if (JSON.stringify(args).length > 600) return { ok: false, error: 'args too large' };
    const v = spec.validate(args);
    if (v !== true) return { ok: false, error: v };
    return { ok: true, command: name, args: spec.normalize(args) };
  } catch (e) {
    return { ok: false, error: 'validation failure: ' + (e?.message || 'unknown') };
  }
}

/** Validate a batch (model may emit several). Caps at 4 actions per turn;
 *  every invalid entry is reported, never executed. */
export function validateCommands(list) {
  if (!Array.isArray(list)) return { accepted: [], rejected: [{ raw: list, error: 'commands must be an array' }] };
  const accepted = [], rejected = [];
  for (const raw of list.slice(0, 12)) {
    const r = validateCommand(raw);
    if (r.ok && accepted.length < 4) accepted.push({ command: r.command, args: r.args });
    else if (r.ok) rejected.push({ raw, error: 'per-turn action cap (4) reached' });
    else rejected.push({ raw, error: r.error });
  }
  return { accepted, rejected };
}
