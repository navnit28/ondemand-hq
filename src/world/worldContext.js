// worldContext.js — TYPED MINIMAL world-state context payload (2026-07-20).
// A deliberate schema — not blind app state. buildWorldContext() whitelists,
// validates, and clamps every field before it is sent to the voice workflow.

import { KNOWN_ISOS } from './worldCommands.js';

const ISO2 = /^[A-Za-z]{2}$/;

export const WORLD_CONTEXT_VERSION = 1;

/**
 * @param {object} s partial world state gathered by the UI layer
 * @returns typed minimal payload (all fields optional except version)
 * Schema:
 *   version           1
 *   selectedCountry   ISO2 | null      — selected country on the globe
 *   activeLayer       string | null    — open CountryPage tab (intel|correlations|x|opps|risks|agreements|timeline)
 *   timelinePosition  string | null    — ISO date or run id shown by a scrubber
 *   selectedMarker    ISO2 | null      — marker under focus (hover/selection)
 *   filters           {types?: string[], minWeight?: number, window?: string}
 *   camera            {focusIso?: ISO2|null, zoom?: number, userRotated?: boolean}
 *   activeRoutes      [{from: ISO2, to: ISO2}] (max 6)
 *   lang              'en'|'ar'|'auto'
 */
export function buildWorldContext(s = {}) {
  const iso = (v) => {
    if (typeof v !== 'string' || !ISO2.test(v)) return null;
    const up = v.toUpperCase();
    return KNOWN_ISOS.has(up) ? up : null;   // routes/markers must reference known countries
  };
  const ctx = { version: WORLD_CONTEXT_VERSION };

  const sel = iso(s.selectedCountry);
  if (sel) ctx.selectedCountry = sel;

  if (typeof s.activeLayer === 'string' && /^[a-z]{1,16}$/.test(s.activeLayer)) ctx.activeLayer = s.activeLayer;

  if (typeof s.timelinePosition === 'string' && s.timelinePosition.length <= 40) ctx.timelinePosition = s.timelinePosition;

  const mk = iso(s.selectedMarker);
  if (mk) ctx.selectedMarker = mk;

  if (s.filters && typeof s.filters === 'object') {
    const f = {};
    if (Array.isArray(s.filters.types)) f.types = s.filters.types.filter(t => typeof t === 'string' && t.length <= 24).slice(0, 12);
    if (Number.isFinite(s.filters.minWeight)) f.minWeight = Math.max(0, Math.min(1, s.filters.minWeight));
    if (typeof s.filters.window === 'string' && s.filters.window.length <= 24) f.window = s.filters.window;
    if (Object.keys(f).length) ctx.filters = f;
  }

  if (s.camera && typeof s.camera === 'object') {
    const c = {};
    const fi = iso(s.camera.focusIso);
    if (fi) c.focusIso = fi;
    if (Number.isFinite(s.camera.zoom)) c.zoom = Math.round(Math.max(0.1, Math.min(5, s.camera.zoom)) * 100) / 100;
    if (typeof s.camera.userRotated === 'boolean') c.userRotated = s.camera.userRotated;
    if (Object.keys(c).length) ctx.camera = c;
  }

  if (Array.isArray(s.activeRoutes)) {
    const routes = s.activeRoutes
      .map(r => ({ from: iso(r?.from), to: iso(r?.to) }))
      .filter(r => r.from && r.to)
      .slice(0, 6);
    if (routes.length) ctx.activeRoutes = routes;
  }

  ctx.lang = s.lang === 'ar' || s.lang === 'en' ? s.lang : 'auto';
  return ctx;
}

/** Capture full restorable UI snapshot (superset of the wire context — LOCAL only). */
export function captureWorldSnapshot(get) {
  // `get` is a function collection supplied by the UI layer; everything optional.
  try {
    return {
      selectedCountry: get.selectedCountry?.() ?? null,
      activeLayer: get.activeLayer?.() ?? null,
      timelinePosition: get.timelinePosition?.() ?? null,
      filters: get.filters?.() ?? null,
      camera: get.camera?.() ?? null,
      scrollY: get.scrollY?.() ?? 0,
      focusSelector: get.focusSelector?.() ?? null,
    };
  } catch { return null; }
}

/** Restore a snapshot via the UI layer's setters. Never throws. */
export function restoreWorldSnapshot(snap, set) {
  if (!snap) return false;
  try {
    if (snap.selectedCountry != null) set.selectedCountry?.(snap.selectedCountry);
    if (snap.activeLayer != null) set.activeLayer?.(snap.activeLayer);
    if (snap.timelinePosition != null) set.timelinePosition?.(snap.timelinePosition);
    if (snap.filters != null) set.filters?.(snap.filters);
    if (snap.camera != null) set.camera?.(snap.camera);
    if (typeof snap.scrollY === 'number') set.scrollY?.(snap.scrollY);
    if (snap.focusSelector) set.focus?.(snap.focusSelector);
    return true;
  } catch { return false; }
}
