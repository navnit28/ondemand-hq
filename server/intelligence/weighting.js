// weighting.js — CONTEXT WEIGHTING model (added 2026-07-19, deep-pipeline rewrite).
// Applied to EVERY fact/evidence record and propagated onto every edge.
//   Base weights (temporal class): Historical 0.2 · Recent 0.6 · Breaking 1.0
//   Multipliers: Direct UAE relevance ×2 · Government source ×2 · Official statement ×3 ·
//                Repeated across multiple sources ×2
// finalWeight = base × Π(multipliers) × windowBoost, persisted on each fact and edge.

const DAY = 86400000;

export const BASE_WEIGHTS = { historical: 0.2, recent: 0.6, breaking: 1.0 };
export const MULTIPLIERS = {
  uaeRelevance: 2, governmentSource: 2, officialStatement: 3, multiSource: 2,
};

const GOV_DOMAIN_RE = /\.gov(\.[a-z]{2})?\b|\.gov\.ae|wam\.ae|mofa\.gov|u\.ae\b|un\.org|worldbank\.org|imf\.org|state\.gov|europa\.eu|parliament\.|whitehouse\.gov/i;
const GOV_SOURCE_RE = /ministry|government|embassy|wam|emirates news agency|state media|presiden|royal court|cabinet|federal|authority|commission|agency/i;
const OFFICIAL_RE = /official statement|officially (announced|stated|confirmed)|press release|communiqu|joint statement|decree|memorandum of understanding|mou signed|speech (by|of)|(minister|president|sheikh|ambassador|secretary)[^.]{0,60}(said|announced|stated|declared|confirmed)/i;
const UAE_RE = /\buae\b|united arab emirates|abu dhabi|dubai|emirati|adq|mubadala|g42|core42|adnoc|ad ports|presight|adfd|masdar|etihad|dp world|edge group|mofa/i;

/** Temporal class from publish date: Breaking ≤72h, Recent ≤30d (or the window's boost band), else Historical. */
export function temporalClass(publishDate, nowTs = Date.now(), win = null) {
  const t = Date.parse(publishDate || '');
  if (!Number.isFinite(t)) return 'historical'; // undated → conservative
  const ageDays = Math.max(0, (nowTs - t) / DAY);
  if (ageDays <= 3) return 'breaking';
  const recentBand = win?.boostRecentDays || 30;
  if (ageDays <= recentBand) return 'recent';
  return 'historical';
}

/**
 * Compute the full weight record for one fact/evidence record.
 * fact: { claim, snippet, source, url, publish_date, source_type, corroborations }
 * Returns { temporalClass, baseWeight, multipliers: {name: value}, windowBoost, finalWeight }.
 */
export function weighFact(fact, { nowTs = Date.now(), win = null } = {}) {
  const tc = temporalClass(fact.publish_date, nowTs, win);
  const base = BASE_WEIGHTS[tc];
  const text = `${fact.claim || ''} ${fact.snippet || ''} ${fact.source || ''}`;
  const mults = {};
  if (UAE_RE.test(text)) mults.uaeRelevance = MULTIPLIERS.uaeRelevance;
  if (GOV_DOMAIN_RE.test(fact.url || '') || GOV_SOURCE_RE.test(fact.source || '') ||
      ['government_release', 'government_pdf', 'official_website', 'official_speech', 'corporate_filing'].includes(fact.source_type))
    mults.governmentSource = MULTIPLIERS.governmentSource;
  if (OFFICIAL_RE.test(text) || ['official_speech', 'press_release', 'government_release'].includes(fact.source_type))
    mults.officialStatement = MULTIPLIERS.officialStatement;
  if ((fact.corroborations ?? 1) >= 2) mults.multiSource = MULTIPLIERS.multiSource;

  // Window boost: default profile gives extra weighting to facts inside the boost band (e.g. last 30d of a 2y window).
  let windowBoost = 1;
  if (win?.boostRecentDays && win.boostFactor > 1) {
    const t = Date.parse(fact.publish_date || '');
    if (Number.isFinite(t) && (nowTs - t) / DAY <= win.boostRecentDays) windowBoost = win.boostFactor;
  }

  const product = Object.values(mults).reduce((a, b) => a * b, 1);
  const finalWeight = +(base * product * windowBoost).toFixed(4);
  return { temporalClass: tc, baseWeight: base, multipliers: mults, windowBoost, finalWeight };
}

/** Edge weight = evidence-weight aggregation, normalised 0..1 for rendering (raw kept alongside). */
export function edgeWeightFromEvidence(evidenceRecords) {
  if (!evidenceRecords.length) return { rawWeight: 0, weight: 0 };
  const raw = evidenceRecords.reduce((a, v) => a + (v.weighting?.finalWeight ?? 0), 0) / evidenceRecords.length;
  // Max theoretical fact weight = 1.0 × 2 × 2 × 3 × 2 × 1.5 = 36 → log-normalise for display.
  const weight = +Math.min(1, Math.log1p(raw) / Math.log1p(36)).toFixed(4);
  return { rawWeight: +raw.toFixed(4), weight };
}

/** Mark corroborations: same claim fingerprint appearing under ≥2 distinct sources. */
export function markCorroborations(evidence) {
  const fp = (v) => (v.claim || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3).sort().slice(0, 8).join('|');
  const groups = new Map();
  for (const v of evidence) {
    const k = fp(v);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(v.source || v.url || Math.random());
  }
  for (const v of evidence) v.corroborations = groups.get(fp(v))?.size || 1;
  return evidence;
}
