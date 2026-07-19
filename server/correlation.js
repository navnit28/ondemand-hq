// correlation.js — CORRELATION ENGINE (added 2026-07-19, round 1).
// Evidence-gated relationship graphs per country: five 200-proven plugins
// (Perplexity default, X Search, Reddit official, Instagram download, Instagram
// user-info) → normalized evidence records → model-extracted edges (HARD RULE:
// no edge without ≥1 backing evidence record, no general-knowledge edges) →
// deterministic weight/recency/dedupe/contradiction computation → versioned run
// JSON on disk (ALL versions kept for the UI date scrubber) with a real diff vs
// the previous run → Connected Dots narrative (streamed, sentence-traceable to
// evidence ids).
//
// Model policy (config, not hardcoded — see env.js):
//   plugins/evidence-gathering  → CE_PLUGIN_ENDPOINT_ID (gpt-5.6-sol; Claude
//                                 endpoints reject plugin attachment — live 400s
//                                 logged 2026-07-19, PLUGIN_TESTS.md)
//   analysis/extraction/narrative → CE_ANALYSIS_ENDPOINT_ID + reasoningEffort
//                                 (prod default claude-fable-5 medium; build/test
//                                 claude-sonnet-5 via env override)
//   Quick Query                 → GLM 4.7 Cerebras BYOI endpoint only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOdSession, syncQuery, streamQuery } from './ondemand.js';
import {
  CE_PLUGIN_ENDPOINT_ID, CE_ANALYSIS_ENDPOINT_ID, CE_ANALYSIS_REASONING_EFFORT,
  GLM_ENDPOINT_ID, QUICK_QUERY_MAX_TOKENS,
} from './env.js';
import * as log from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(__dirname, 'data', 'correlation');
const SEED_ROOT = path.join(__dirname, 'data', 'correlation-seed');
const MEDIA_ROOT = path.join(__dirname, 'data', 'correlation-media');
for (const d of [DATA_ROOT, MEDIA_ROOT]) fs.mkdirSync(d, { recursive: true });

export const PLUGINS = {
  perplexity: 'plugin-1722260873',
  xsearch: 'plugin-1751872652',
  reddit: 'plugin-1748003575',
  igDownload: 'plugin-1762980461',
  igUserInfo: 'plugin-1716164040',
};

export const RELATIONSHIP_TYPES = ['Investment', 'Trade', 'Aid-Humanitarian', 'Diplomatic',
  'Infrastructure', 'Energy', 'Technology', 'Security', 'Media-narrative'];

// ================= CORRELATION ENGINE V2 (2026-07-19) =================
// Deep-search windows (item 14): research window selector. Default = 730d
// (Last 2 Years) with higher weighting on the last 30 days via the context
// weighting engine below.
export const SEARCH_WINDOWS = [
  { key: '24h', days: 1, label: 'Last 24 hours' },
  { key: 'week', days: 7, label: 'Last week' },
  { key: 'month', days: 30, label: 'Last month' },
  { key: '6mo', days: 180, label: 'Last 6 months' },
  { key: '1y', days: 365, label: 'Last year' },
  { key: '2y', days: 730, label: 'Last 2 years' },
  { key: 'all', days: 0, label: 'Entire history' },
];
export const DEFAULT_WINDOW_DAYS = 730;

// Context weighting engine (item 15) — deterministic, applied server-side to
// every evidence record. Base class by age: historical 0.2 / recent 0.6 /
// breaking 1.0. Multipliers: ×2 direct UAE relevance, ×2 government source,
// ×3 official statement, ×2 multi-source corroboration. Normalized 0..1
// (cap 3.0) and blended into edge weights (60% legacy deterministic weight,
// 40% avg context weight of backing evidence).
export const WEIGHTING = {
  base: { historical: 0.2, recent: 0.6, breaking: 1.0 },
  recentDays: 30, breakingHours: 48,
  multipliers: { uaeRelevance: 2, governmentSource: 2, officialStatement: 3, multiSource: 2 },
  cap: 3.0, blend: { legacy: 0.6, context: 0.4 },
};
const GOV_SOURCE_RE = /\b(wam|wamnews|mofa|mofauae|ministry|government|embassy|consulate|presiden|sheikh|state house|gov\.|\.gov|official gazette|prime minister|cabinet|parliament|senate|un\b|unicef|who\b|adfd)\b/i;
const OFFICIAL_STMT_RE = /\b(announced|statement|decree|signed (an?|the) (agreement|mou|deal)|joint (statement|communiqu)|official visit|state visit|memorandum of understanding|press release)\b/i;

function uaeRelevant(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('uae') || t.includes('emirat') || UAE_REGISTRY.some(r =>
    t.includes(r.label.toLowerCase()) || (r.aliases || []).some(a => t.includes(a)));
}

/** Compute contextWeight for each evidence record; annotate factors for the UI. */
export function applyContextWeighting(evidence, nowTs) {
  const seenSources = new Map(); // fuzzy corroboration: same first-6-words claim stem
  for (const ev of evidence) {
    const stem = String(ev.claim || '').toLowerCase().split(/\s+/).slice(0, 6).join(' ');
    const set = seenSources.get(stem) || new Set();
    set.add(`${ev.platform}:${ev.source}`);
    seenSources.set(stem, set);
  }
  for (const ev of evidence) {
    const t = Date.parse(ev.publish_date || '');
    const ageH = Number.isFinite(t) ? (nowTs - t) / 3600000 : Infinity;
    let cls = 'historical';
    if (ageH <= WEIGHTING.breakingHours) cls = 'breaking';
    else if (ageH <= WEIGHTING.recentDays * 24) cls = 'recent';
    let w = WEIGHTING.base[cls];
    const factors = [cls];
    if (uaeRelevant(`${ev.claim} ${ev.snippet}`)) { w *= WEIGHTING.multipliers.uaeRelevance; factors.push('uae-relevance×2'); }
    if (GOV_SOURCE_RE.test(`${ev.source} ${ev.url || ''}`)) { w *= WEIGHTING.multipliers.governmentSource; factors.push('gov-source×2'); }
    if (OFFICIAL_STMT_RE.test(`${ev.claim} ${ev.snippet}`)) { w *= WEIGHTING.multipliers.officialStatement; factors.push('official-stmt×3'); }
    const stem = String(ev.claim || '').toLowerCase().split(/\s+/).slice(0, 6).join(' ');
    if ((seenSources.get(stem)?.size || 1) >= 2) { w *= WEIGHTING.multipliers.multiSource; factors.push('multi-source×2'); }
    ev.weightClass = cls;
    ev.weightFactors = factors;
    ev.contextWeight = +Math.min(WEIGHTING.cap, w).toFixed(3);
    ev.contextWeightNorm = +(Math.min(WEIGHTING.cap, w) / WEIGHTING.cap).toFixed(3);
  }
  return evidence;
}

/** Small concurrency limiter for the parallel research fan-out. */
function pLimit(n) {
  const q = []; let active = 0;
  const next = () => {
    if (!q.length || active >= n) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

// Research workflow V2 (items 16+17) — optimized for INTELLIGENCE DENSITY, not
// speed: ~10 Perplexity specialist sub-prompts fanned out in parallel (bounded
// concurrency), each steering the researcher across official websites,
// government releases, press releases, academic papers, think-tank reports,
// media, financial reports, corporate filings, investor presentations,
// government PDFs, whitepapers, conference presentations, official speeches,
// public datasets and satellite-imagery reporting where relevant. The
// orchestration layer (normalize stage) merges all streams into ONE unified
// evidence pool feeding one intelligence graph.
const SOURCE_DIRECTIVE = `Prioritize primary and high-density sources in this order: official government websites and releases (uaeembassy/mofa/wam.ae, national ministries), press releases, corporate filings and investor presentations, government PDFs and whitepapers, academic papers and think-tank reports (e.g. ECSSR, Chatham House, Brookings), conference presentations and official speeches, financial reports, reputable media, public datasets, and satellite-imagery-based reporting where relevant. For EVERY item return: ISO date, entities involved, one-line description, and the exact source URL.`;

export function buildResearchPrompts(countryName, windowDays) {
  const now = new Date();
  const from = windowDays > 0 ? new Date(now.getTime() - windowDays * 86400000) : null;
  const range = from ? `between ${from.toISOString().slice(0, 10)} and ${now.toISOString().slice(0, 10)}` : 'across the entire recorded history of the relationship';
  const CN = countryName;
  return {
    developments: `Comprehensive summary of ALL significant developments between the United Arab Emirates and ${CN} ${range}: agreements, investments, aid, visits, disputes, infrastructure, energy, technology, defence. ${SOURCE_DIRECTIVE}`,
    organisations: `Every organisation, company, sovereign fund, agency or NGO active in the UAE–${CN} relationship ${range}: role, ownership/parent, sector, and what it did. Include UAE entities (ODA, MOFA, ADQ, Mubadala, G42, Core42, ADNOC, AD Ports, Presight, ADFD, Masdar, Etihad, DP World, EDGE) and ${CN}-side counterparts. ${SOURCE_DIRECTIVE}`,
    funding: `All funding, investment and financing announcements between UAE entities and ${CN} ${range}: amounts, currencies, instruments (equity/loan/grant/PPP), stage (announced/signed/disbursed), recipients. ${SOURCE_DIRECTIVE}`,
    officials: `Government officials driving the UAE–${CN} relationship ${range}: names, exact titles, meetings, state visits, and direct quotes from official statements. ${SOURCE_DIRECTIVE}`,
    strategic: `Strategic implications for the UAE of its relationship with ${CN} ${range}, across trade, diplomacy, investment, technology, food security, energy, defence, climate, education, healthcare, humanitarian aid, the UAE National AI Strategy, economic diversification and foreign policy. Cite concrete evidence per implication. ${SOURCE_DIRECTIVE}`,
    predictions12mo: `Grounded expectations for the next 12 months in UAE–${CN} relations based ONLY on announced plans, signed frameworks, budget lines and official statements ${range} — no speculation without a cited basis. ${SOURCE_DIRECTIVE}`,
    contradictions: `Contradictory or disputed reporting about UAE–${CN} relations ${range}: conflicting numbers, denied claims, retracted stories, single-source assertions. Quote both sides with URLs. ${SOURCE_DIRECTIVE}`,
    missing: `Relationships in the UAE–${CN} network that likely exist but are under-reported ${range}: shared investors or directors, trade dependencies, technology transfer, shared infrastructure, funding chains, policy alignment. For each, state the OBSERVABLE SIGNALS (with URLs) that suggest it — do not assert unverified facts. ${SOURCE_DIRECTIVE}`,
    analogues: `Historical analogues: earlier UAE partnerships that resemble the current UAE–${CN} trajectory (e.g. ports, energy, food-security or AI partnerships with other countries) ${range} and how they evolved. ${SOURCE_DIRECTIVE}`,
    confidenceAudit: `Source-confidence audit for UAE–${CN} claims ${range}: which widely-reported claims are single-source, which are corroborated by 2+ independent outlets, which come only from social media. List each claim with its corroboration level and URLs. ${SOURCE_DIRECTIVE}`,
  };
}
// ================= end V2 constants =================

// ---------- UAE node registry (extensible — country-side nodes surface per run) ----------
export const UAE_REGISTRY = [
  { id: 'uae', label: 'UAE', fullName: 'United Arab Emirates', kind: 'country' },
  { id: 'oda', label: 'ODA', fullName: 'Office of Development Affairs', kind: 'entity', aliases: ['office of development affairs'] },
  { id: 'mofa', label: 'MOFA', fullName: 'Ministry of Foreign Affairs', kind: 'entity', aliases: ['ministry of foreign affairs', 'mofaic', 'uae foreign ministry'] },
  { id: 'adq', label: 'ADQ', fullName: 'ADQ (Abu Dhabi sovereign holding)', kind: 'entity', aliases: ['adq'] },
  { id: 'mubadala', label: 'Mubadala', fullName: 'Mubadala Investment Company', kind: 'entity', aliases: ['mubadala'] },
  { id: 'g42', label: 'G42', fullName: 'G42 (Group 42)', kind: 'entity', aliases: ['g42', 'group 42'] },
  { id: 'core42', label: 'Core42', fullName: 'Core42 (G42 cloud/AI)', kind: 'entity', aliases: ['core42'] },
  { id: 'adnoc', label: 'ADNOC', fullName: 'Abu Dhabi National Oil Company', kind: 'entity', aliases: ['adnoc', 'adnoc distribution', 'adnoc gas'] },
  { id: 'adports', label: 'AD Ports', fullName: 'AD Ports Group', kind: 'entity', aliases: ['ad ports', 'ad ports group', 'abu dhabi ports'] },
  { id: 'presight', label: 'Presight', fullName: 'Presight AI (G42)', kind: 'entity', aliases: ['presight'] },
  { id: 'adfd', label: 'ADFD', fullName: 'Abu Dhabi Fund for Development', kind: 'entity', aliases: ['adfd', 'abu dhabi fund'] },
  { id: 'masdar', label: 'Masdar', fullName: 'Masdar (clean energy)', kind: 'entity', aliases: ['masdar'] },
  { id: 'etihad', label: 'Etihad', fullName: 'Etihad Airways', kind: 'entity', aliases: ['etihad', 'etihad airways'] },
  { id: 'dpworld', label: 'DP World', fullName: 'DP World', kind: 'entity', aliases: ['dp world'] },
  { id: 'edge', label: 'EDGE', fullName: 'EDGE Group (defence)', kind: 'entity', aliases: ['edge group', 'edge'] },
];
// Official Instagram channels only (state media / ministries / entities).
const OFFICIAL_IG = [
  { handle: 'wamnews', role: 'Emirates News Agency (state media)' },
  { handle: 'mofauae', role: 'UAE Ministry of Foreign Affairs' },
];

const countryDir = (iso) => path.join(DATA_ROOT, iso);
const seedDir = (iso) => path.join(SEED_ROOT, iso);
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1)); };

// ---------- run store (ALL versions kept; seed hydration for fresh deploys) ----------
function hydrateRuns(iso) {
  const live = countryDir(iso);
  if (fs.existsSync(live) && fs.readdirSync(live).some(f => f.startsWith('run-'))) return;
  const seed = seedDir(iso);
  if (!fs.existsSync(seed)) return;
  for (const f of fs.readdirSync(seed)) {
    if (!f.endsWith('.json')) continue;
    const dst = path.join(live, f);
    fs.mkdirSync(live, { recursive: true });
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(seed, f), dst);
  }
  // hydrate seed media too (images referenced by seed runs)
  const sm = path.join(SEED_ROOT, 'media', iso);
  const lm = path.join(MEDIA_ROOT, iso);
  if (fs.existsSync(sm)) {
    fs.mkdirSync(lm, { recursive: true });
    for (const f of fs.readdirSync(sm)) {
      const dst = path.join(lm, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(sm, f), dst);
    }
  }
  log.info('correlation.seed_hydrated', { iso });
}

export function listRuns(iso) {
  hydrateRuns(iso);
  const dir = countryDir(iso);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^run-.+\.json$/.test(f)).sort()
    .map(f => {
      const r = readJson(path.join(dir, f), null);
      if (!r) return null;
      return {
        runId: r.runId, generated_at: r.generated_at, model: r.model,
        pluginsCalled: r.pluginsCalled, evidenceCount: r.evidence?.length ?? 0,
        edgeCount: r.edges?.length ?? 0, contradictions: (r.edges || []).filter(e => e.contradiction).length,
        diffFromPrevious: r.diffFromPrevious || null,
      };
    }).filter(Boolean);
}

export function getRun(iso, runId) {
  hydrateRuns(iso);
  const safe = String(runId).replace(/[^A-Za-z0-9-]/g, '');
  return readJson(path.join(countryDir(iso), `run-${safe}.json`), null);
}

// ---------- markdown media/url extraction (real payload shape, mirrors intel.js) ----------
function extractUrls(md) {
  const images = [...(md || '').matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)].map(m => ({ alt: m[1], url: m[2] }));
  const links = [...(md || '').matchAll(/(?<!\!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map(m => ({ title: m[1], url: m[2] })).filter(l => !images.some(i => i.url === l.url));
  const xPosts = [...(md || '').matchAll(/https?:\/\/x\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/g)].map(m => ({ author: m[1], statusId: m[2], url: m[0] }));
  const igShortcodes = [...(md || '').matchAll(/shortcode[:\s`]*([A-Za-z0-9_-]{8,})/gi)].map(m => m[1]);
  const blobMedia = [...(md || '').matchAll(/https?:\/\/airev\w*\.blob\.core\.windows\.net\/[^)\s"']+/g)].map(m => m[0]);
  return { images, links, xPosts, igShortcodes, blobMedia };
}

function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const c of [fence?.[1], text]) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    for (let end = c.length; end > start; end--) {
      try { return JSON.parse(c.slice(start, end)); } catch { /* shrink */ }
    }
  }
  return null;
}

async function analysisJson(sessionId, prompt, systemPrompt) {
  const answer = await syncQuery({
    odSessionId: sessionId, query: prompt,
    endpointId: CE_ANALYSIS_ENDPOINT_ID, reasoningEffort: CE_ANALYSIS_REASONING_EFFORT,
    systemPrompt: systemPrompt || 'You are the ODA Correlation Engine extractor. Respond with ONE valid JSON value only — no prose, no markdown fences. Ground every field in the provided material; use null when unknown; never invent URLs, dates, or facts.',
  });
  return { parsed: extractJson(answer), raw: answer };
}

// ---------- deterministic graph computation (weight / recency / dedupe / contradiction) ----------
const DAY = 86400000;
function computeEdges(rawEdges, evidenceById, nowTs) {
  // HARD RULE: no edge without ≥1 valid backing evidence record.
  const valid = [];
  let droppedNoEvidence = 0;
  for (const e of rawEdges || []) {
    const ids = (e.evidence_record_ids || []).filter(id => evidenceById.has(id));
    if (!ids.length) { droppedNoEvidence++; continue; }
    valid.push({ ...e, evidence_record_ids: [...new Set(ids)] });
  }
  // Dedupe: merge same unordered pair + relationship type, stacking evidence.
  const merged = new Map();
  for (const e of valid) {
    const pair = [e.entity_a, e.entity_b].sort().join('~');
    const key = `${pair}|${e.relationship_type}`;
    if (!merged.has(key)) { merged.set(key, { ...e }); continue; }
    const m = merged.get(key);
    m.evidence_record_ids = [...new Set([...m.evidence_record_ids, ...e.evidence_record_ids])];
    if ((e.confidence ?? 0) > (m.confidence ?? 0)) { m.claim = e.claim; m.direction = e.direction; m.confidence = e.confidence; m.stance = e.stance; }
    else if (e.stance && e.stance !== m.stance) m.altStance = e.stance; // keep for contradiction check
  }
  const edges = [...merged.values()].map((e, i) => {
    const evs = e.evidence_record_ids.map(id => evidenceById.get(id)).filter(Boolean);
    const platforms = new Set(evs.map(v => v.platform));
    const ages = evs.map(v => {
      const t = Date.parse(v.publish_date || '');
      return Number.isFinite(t) ? Math.max(0, (nowTs - t) / DAY) : 30; // unknown date → neutral 30d
    });
    const avgAge = ages.reduce((a, b) => a + b, 0) / (ages.length || 1);
    const recencyFactor = Math.exp(-avgAge / 14); // 14-day half-life-ish decay
    const avgConf = evs.reduce((a, v) => a + (v.confidence ?? 0.5), 0) / (evs.length || 1);
    const countFactor = Math.min(1, evs.length / 5);
    const diversityFactor = Math.min(1, platforms.size / 4);
    // weight = f(evidence count, source diversity, recency decay, avg confidence)
    const legacyWeight = 0.35 * countFactor + 0.25 * diversityFactor + 0.20 * recencyFactor + 0.20 * avgConf;
    // V2 item 15: blend in the context weighting engine (avg normalized context
    // weight of backing evidence): 60% legacy deterministic + 40% context.
    const avgCtx = evs.reduce((a, v) => a + (v.contextWeightNorm ?? 0.33), 0) / (evs.length || 1);
    const weight = +(WEIGHTING.blend.legacy * legacyWeight + WEIGHTING.blend.context * avgCtx).toFixed(4);
    return {
      id: `ED${i + 1}`,
      entity_a: e.entity_a, entity_b: e.entity_b,
      relationship_type: e.relationship_type,
      direction: e.direction || 'a->b',
      claim: e.claim,
      evidence_record_ids: e.evidence_record_ids,
      confidence: +(e.confidence ?? avgConf).toFixed(3),
      stance: e.stance || 'neutral',
      weight,
      recency: +recencyFactor.toFixed(4),       // → opacity client-side
      evidencePlatforms: [...platforms],
      contradiction: false,                      // set below
      tier: 'Verified',                          // V2 item 18: evidence-gated = Verified tier
      interactions: evs.length,                  // V2 item 12: heat mode — interaction count
    };
  });
  // Contradiction ⚠: same unordered pair + type carrying both cooperation and tension stances.
  const byPairType = new Map();
  for (const e of edges) {
    const key = `${[e.entity_a, e.entity_b].sort().join('~')}|${e.relationship_type}|${e.stance}`;
    byPairType.set(key, e);
  }
  const seen = new Map();
  for (const e of edges) {
    const base = [e.entity_a, e.entity_b].sort().join('~') + '|' + e.relationship_type;
    const stances = seen.get(base) || new Set();
    stances.add(e.stance);
    seen.set(base, stances);
  }
  for (const e of edges) {
    const stances = seen.get([e.entity_a, e.entity_b].sort().join('~') + '|' + e.relationship_type);
    if (stances?.has('cooperation') && stances?.has('tension')) e.contradiction = true;
  }
  return { edges, droppedNoEvidence };
}

function diffRuns(prev, curr) {
  if (!prev) return { addedEdges: [], removedEdges: [], addedEvidence: [], weightChanges: [], newEdgeIds: [] };
  const key = (e) => `${[e.entity_a, e.entity_b].sort().join('~')}|${e.relationship_type}`;
  const prevMap = new Map((prev.edges || []).map(e => [key(e), e]));
  const currMap = new Map((curr.edges || []).map(e => [key(e), e]));
  const addedEdges = [...currMap.keys()].filter(k => !prevMap.has(k));
  const removedEdges = [...prevMap.keys()].filter(k => !currMap.has(k));
  const weightChanges = [...currMap.keys()].filter(k => prevMap.has(k))
    .map(k => ({ key: k, from: prevMap.get(k).weight, to: currMap.get(k).weight }))
    .filter(c => Math.abs(c.to - c.from) >= 0.02);
  const prevEv = new Set((prev.evidence || []).map(v => v.url).filter(Boolean));
  const addedEvidence = (curr.evidence || []).filter(v => v.url && !prevEv.has(v.url)).map(v => v.id);
  const newEdgeIds = addedEdges.map(k => currMap.get(k).id);
  return { addedEdges, removedEdges, addedEvidence, weightChanges, newEdgeIds };
}

// ---------- pipeline jobs ----------
const jobs = new Map(); // iso -> job
export function pipelineStatus(iso) { return jobs.get(iso) || { status: 'idle' }; }

export async function runPipeline(iso, countryName, opts = {}) {
  if (jobs.get(iso)?.status === 'running') return jobs.get(iso);
  const windowDays = Number.isFinite(+opts.windowDays) ? +opts.windowDays : DEFAULT_WINDOW_DAYS;
  const geo = opts.geo || null; // {lat,lng} of the counterpart country
  const startedAt = new Date();
  const runId = `${iso}-${startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '')}`;
  const job = { status: 'running', stage: 'gather', runId, startedAt: startedAt.toISOString(), error: null, narrativeTokens: '', windowDays };
  jobs.set(iso, job);
  (async () => {
    const pluginsCalled = [];
    try {
      // ---- Stage 1 (V2, items 16+17): intelligence-density research fan-out ----
      // ~10 Perplexity specialist sub-prompts (bounded 3-way concurrency) + X + Reddit.
      const now = new Date();
      const fromDate = windowDays > 0 ? new Date(now.getTime() - windowDays * 86400000).toISOString().slice(0, 10) : null;
      const subPrompts = buildResearchPrompts(countryName, windowDays);
      const gather = {}; // perplexity:<facet> streams + xsearch + reddit
      const limit = pLimit(3);
      const perplexityJobs = Object.entries(subPrompts).map(([facet, q]) => limit(async () => {
        const sid = await createOdSession(`ce-${iso}-ppx-${facet}`, [PLUGINS.perplexity]);
        const answer = await syncQuery({ odSessionId: sid, query: q, pluginIds: [PLUGINS.perplexity], endpointId: CE_PLUGIN_ENDPOINT_ID, reasoningEffort: 'medium' });
        gather[`perplexity:${facet}`] = answer;
        pluginsCalled.push({ plugin: `perplexity:${facet}`, pluginId: PLUGINS.perplexity, status: 200, chars: answer.length });
        job.stage = `gather ${Object.keys(gather).length}/${Object.keys(subPrompts).length + 2}`;
      }).catch(e => {
        gather[`perplexity:${facet}`] = '';
        pluginsCalled.push({ plugin: `perplexity:${facet}`, pluginId: PLUGINS.perplexity, status: 'failed', error: String(e?.message || e).slice(0, 200) });
        log.error('correlation.gather_failed', { iso, plugin: `perplexity:${facet}`, error: String(e?.message || e).slice(0, 200) });
      }));
      const social = {
        xsearch: `Posts ${fromDate ? `from ${fromDate} to ${now.toISOString().slice(0, 10)}` : 'from any time'} about UAE and ${countryName} cooperation: investments, aid, agreements, visits, disputes. Prioritize official accounts (ministries, embassies, state media, UAE entities). Include each post's x.com URL, author handle, and date.`,
        reddit: `Fetch recent posts from subreddits about ${countryName} and the UAE (e.g. r/unitedarabemirates, country subreddits): aid, investments, ADNOC, Mubadala, DP World, partnerships, controversies. Include post titles, URLs, subreddit names and dates.`,
      };
      const socialJobs = Object.entries(social).map(([key, q]) => limit(async () => {
        const sid = await createOdSession(`ce-${iso}-${key}`, [PLUGINS[key]]);
        const answer = await syncQuery({ odSessionId: sid, query: q, pluginIds: [PLUGINS[key]], endpointId: CE_PLUGIN_ENDPOINT_ID, reasoningEffort: 'medium' });
        gather[key] = answer;
        pluginsCalled.push({ plugin: key, pluginId: PLUGINS[key], status: 200, chars: answer.length });
      }).catch(e => {
        gather[key] = '';
        pluginsCalled.push({ plugin: key, pluginId: PLUGINS[key], status: 'failed', error: String(e?.message || e).slice(0, 200) });
        log.error('correlation.gather_failed', { iso, plugin: key, error: String(e?.message || e).slice(0, 200) });
      }));
      await Promise.allSettled([...perplexityJobs, ...socialJobs]);
      job.stage = 'instagram';

      // ---- Stage 2: Instagram (official channels only; verify officialness; download proofs to disk) ----
      const ig = { profiles: [], downloads: [] };
      await Promise.allSettled(OFFICIAL_IG.map(async ({ handle, role }) => {
        const sid = await createOdSession(`ce-${iso}-iginfo-${handle}`, [PLUGINS.igUserInfo]);
        const answer = await syncQuery({
          odSessionId: sid, pluginIds: [PLUGINS.igUserInfo], endpointId: CE_PLUGIN_ENDPOINT_ID, reasoningEffort: 'low',
          query: `Fetch Instagram user info for "${handle}": follower count, isVerified, isBusinessAccount, bio, full name.`,
        });
        ig.profiles.push({ handle, role, answer });
        pluginsCalled.push({ plugin: 'igUserInfo', pluginId: PLUGINS.igUserInfo, status: 200, chars: answer.length, handle });
      }));
      // Download latest WAM post images as visual proofs (bounded: one post).
      try {
        const sid = await createOdSession(`ce-${iso}-igdl`, [PLUGINS.igDownload]);
        const dlAnswer = await syncQuery({
          odSessionId: sid, pluginIds: [PLUGINS.igDownload], endpointId: CE_PLUGIN_ENDPOINT_ID, reasoningEffort: 'low',
          query: `Get the most recent post of the official Instagram account wamnews${countryName ? ` (prefer one mentioning ${countryName} or UAE partnerships if visible)` : ''} and download its images. Return the post shortcode, caption, and the downloaded media URLs.`,
        });
        pluginsCalled.push({ plugin: 'igDownload', pluginId: PLUGINS.igDownload, status: 200, chars: dlAnswer.length });
        const media = extractUrls(dlAnswer);
        const dir = path.join(MEDIA_ROOT, iso);
        fs.mkdirSync(dir, { recursive: true });
        let n = 0;
        for (const url of media.blobMedia.slice(0, 4)) {
          try {
            const r = await fetch(url);
            if (!r.ok) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 5000) continue; // not a real image
            n++;
            const fname = `${runId}-ig${n}.jpg`;
            fs.writeFileSync(path.join(dir, fname), buf);
            ig.downloads.push({
              kind: 'image', url: `/api/correlation/media/${iso}/${fname}`,
              originUrl: url, bytes: buf.length, sourceHandle: 'wamnews',
              shortcode: media.igShortcodes[0] || null,
            });
          } catch (e) { log.error('correlation.ig_media_fetch_failed', { iso, error: e.message }); }
        }
        ig.downloadAnswer = dlAnswer;
      } catch (e) {
        pluginsCalled.push({ plugin: 'igDownload', pluginId: PLUGINS.igDownload, status: 'failed', error: e.message.slice(0, 200) });
        log.error('correlation.ig_download_failed', { iso, error: e.message });
      }
      job.stage = 'normalize';

      // ---- Stage 3 (V2 orchestration layer): merge ALL research streams into ONE
      // unified evidence pool (per-facet sections, each truncated; the merged
      // material feeds a single extractor so the graph is one unified artifact) ----
      const sidN = await createOdSession(`ce-${iso}-normalize`, []);
      const facetSections = Object.entries(gather)
        .filter(([k]) => k.startsWith('perplexity:'))
        .map(([k, a]) => [`WEB RESEARCH — ${k.split(':')[1].toUpperCase()}`, a]);
      const material = [
        ...facetSections,
        ['X POSTS', gather.xsearch],
        ['REDDIT', gather.reddit],
        ['INSTAGRAM PROFILES', ig.profiles.map(p => `@${p.handle} (${p.role}): ${p.answer}`).join('\n\n')],
        ['INSTAGRAM POST', ig.downloadAnswer || ''],
      ].map(([t, a]) => `=== ${t} ===\n${(a || '').slice(0, 5000)}`).join('\n\n');
      const { parsed: evParsed, raw: evRaw } = await analysisJson(sidN, `
You are given raw multi-platform research material about UAE ↔ ${countryName} relations.
${material}

Extract an EVIDENCE ARRAY — ONE valid JSON array only. Each record:
{"id": "E1" (sequential), "claim": string (one sentence, factual),
 "platform": "perplexity"|"x"|"reddit"|"instagram",
 "source": string (publication name, X handle, subreddit, or IG handle),
 "url": string (a URL that VERBATIM appears in the material; null only if truly absent),
 "publish_date": string (ISO date YYYY-MM-DD if stated/derivable, else null),
 "snippet": string (≤40 words quoted/paraphrased from the material),
 "confidence": number 0-1}
Rules: ONLY claims present in the material. 10-40 records (this is a deep multi-facet research pass — extract densely). Prefer dated, official, URL-backed items.
Include UAE-entity mentions (ODA, MOFA, ADQ, Mubadala, G42, Core42, ADNOC, AD Ports, Presight, ADFD, Masdar, Etihad, DP World, EDGE) whenever present.
If the INSTAGRAM section has a downloaded post, add one record with platform "instagram" for it.`);
      let evidence = Array.isArray(evParsed) ? evParsed : (evParsed?.evidence || []);
      evidence = evidence.map((v, i) => ({
        id: v.id || `E${i + 1}`, claim: String(v.claim || '').slice(0, 400),
        platform: ['perplexity', 'x', 'reddit', 'instagram'].includes(v.platform) ? v.platform : 'perplexity',
        source: String(v.source || 'unknown').slice(0, 120),
        url: typeof v.url === 'string' && v.url.startsWith('http') ? v.url : null,
        publish_date: /^\d{4}-\d{2}-\d{2}/.test(v.publish_date || '') ? v.publish_date.slice(0, 10) : null,
        snippet: String(v.snippet || '').slice(0, 400),
        media: [],
        confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0.5)),
      })).filter(v => v.claim.length > 8);
      // attach IG visual proofs to the instagram evidence record (or create it)
      if (ig.downloads.length) {
        const igRec = evidence.find(v => v.platform === 'instagram');
        if (igRec) igRec.media = ig.downloads;
        else if (evidence.length) evidence[0].media = ig.downloads; // keep proofs reachable
      }
      // V2 item 15: context weighting engine — deterministic annotation pass
      applyContextWeighting(evidence, startedAt.getTime());
      job.stage = 'edges';

      // ---- Stage 4: edge extraction (HARD RULE enforced server-side after) ----
      const sidE = await createOdSession(`ce-${iso}-edges`, []);
      const registryList = UAE_REGISTRY.map(r => `${r.id} (${r.fullName})`).join('; ');
      const evList = evidence.map(v => `${v.id}: [${v.platform}/${v.source}${v.publish_date ? '/' + v.publish_date : ''}] ${v.claim}`).join('\n');
      const { parsed: edParsed, raw: edRaw } = await analysisJson(sidE, `
UAE entity registry: ${registryList}.
Country node id: "${iso.toLowerCase()}" (${countryName}). Country-side organisations may be given their own short lowercase ids.

Evidence records:
${evList}

Extract RELATIONSHIP EDGES — ONE valid JSON array only. Each edge:
{"entity_a": string (registry id or country-side id),
 "entity_b": string,
 "relationship_type": one of ${JSON.stringify(RELATIONSHIP_TYPES)},
 "direction": "a->b"|"b->a"|"both" (who acts on whom),
 "claim": string (one line describing the relationship),
 "evidence_record_ids": [strings — ONLY ids from the evidence list above that directly support this edge],
 "confidence": number 0-1,
 "stance": "cooperation"|"tension"|"neutral"}
HARD RULES: never create an edge without at least one supporting evidence id; never use
general knowledge — if a relationship is not in the evidence, it does not exist.
3-15 edges. At least one edge should connect a UAE entity to ${countryName} where evidence supports it.`);
      const evidenceById = new Map(evidence.map(v => [v.id, v]));
      const knownIds = new Set([...UAE_REGISTRY.map(r => r.id), iso.toLowerCase()]);
      const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const rawEdges = (Array.isArray(edParsed) ? edParsed : (edParsed?.edges || [])).map(e => ({
        ...e,
        entity_a: knownIds.has(slug(e.entity_a)) ? slug(e.entity_a) : (UAE_REGISTRY.find(r => (r.aliases || []).includes(String(e.entity_a).toLowerCase()))?.id || slug(e.entity_a)),
        entity_b: knownIds.has(slug(e.entity_b)) ? slug(e.entity_b) : (UAE_REGISTRY.find(r => (r.aliases || []).includes(String(e.entity_b).toLowerCase()))?.id || slug(e.entity_b)),
        relationship_type: RELATIONSHIP_TYPES.includes(e.relationship_type) ? e.relationship_type : 'Diplomatic',
      })).filter(e => e.entity_a && e.entity_b && e.entity_a !== e.entity_b);
      const { edges, droppedNoEvidence } = computeEdges(rawEdges, evidenceById, startedAt.getTime());
      job.stage = 'correlate';

      // ---- Stage 4b (V2 item 18): AI correlation layer — second-stage reasoning
      // pass surfacing relationships never explicitly stated. Tiered OUTPUT:
      // Likely / Possible / Predicted (Verified is reserved for evidence-gated
      // edges from Stage 4). Every inferred edge must cite the OBSERVABLE
      // evidence ids that ground the inference + carry probability, supporting
      // and counter evidence (item 19). Inferred edges are stored SEPARATELY
      // (inferredEdges) so the evidence-gated core graph stays pure.
      let inferredEdges = [];
      try {
        const sidI = await createOdSession(`ce-${iso}-infer`, []);
        const verifiedList = edges.map(e => `${e.id}: ${e.entity_a} -[${e.relationship_type}/${e.direction}]-> ${e.entity_b} :: ${e.claim}`).join('\n');
        const { parsed: infParsed } = await analysisJson(sidI, `
UAE entity registry: ${registryList}.
Country: ${countryName} (node id "${iso.toLowerCase()}").

EVIDENCE RECORDS:
${evList}

VERIFIED (evidence-gated) EDGES already extracted:
${verifiedList}

Second-stage CORRELATION REASONING: infer relationships that are NOT explicitly stated
but are structurally suggested by the evidence — shared investors/directors/advisors,
trade dependency, technology transfer, shared infrastructure, funding chains, policy
alignment, common counterparties, sequential announcements.

Return ONE JSON array. Each inferred edge:
{"entity_a": string (registry id or lowercase slug),
 "entity_b": string,
 "relationship_type": one of ${JSON.stringify(RELATIONSHIP_TYPES)},
 "direction": "a->b"|"b->a"|"both",
 "claim": string (the inferred relationship, phrased as an inference),
 "tier": "Likely"|"Possible"|"Predicted",
 "probability": number 0-1 (calibrated: Likely 0.6-0.85, Possible 0.35-0.6, Predicted = forward-looking),
 "basis_evidence_ids": [ids from the evidence list whose OBSERVABLE facts ground this inference — REQUIRED, ≥1],
 "supporting": string (one line: the observable signals supporting it),
 "counter": string (one line: the strongest reason it might be wrong; null if none found),
 "reasoning": string (≤30 words: why this inference follows from the basis evidence)}
HARD RULES: never output an inference with empty basis_evidence_ids; never repeat a
verified edge; 0-8 inferences; mark forward-looking ones tier "Predicted".`);
        inferredEdges = (Array.isArray(infParsed) ? infParsed : (infParsed?.edges || []))
          .map((e, i) => ({
            id: `IE${i + 1}`,
            entity_a: knownIds.has(slug(e.entity_a)) ? slug(e.entity_a) : (UAE_REGISTRY.find(r => (r.aliases || []).includes(String(e.entity_a).toLowerCase()))?.id || slug(e.entity_a)),
            entity_b: knownIds.has(slug(e.entity_b)) ? slug(e.entity_b) : (UAE_REGISTRY.find(r => (r.aliases || []).includes(String(e.entity_b).toLowerCase()))?.id || slug(e.entity_b)),
            relationship_type: RELATIONSHIP_TYPES.includes(e.relationship_type) ? e.relationship_type : 'Diplomatic',
            direction: ['a->b', 'b->a', 'both'].includes(e.direction) ? e.direction : 'a->b',
            claim: String(e.claim || '').slice(0, 300),
            tier: ['Likely', 'Possible', 'Predicted'].includes(e.tier) ? e.tier : 'Possible',
            probability: Math.max(0, Math.min(1, Number(e.probability) || 0.4)),
            basis_evidence_ids: (e.basis_evidence_ids || []).filter(id => evidenceById.has(id)),
            supporting: String(e.supporting || '').slice(0, 300),
            counter: e.counter ? String(e.counter).slice(0, 300) : null,
            reasoning: String(e.reasoning || '').slice(0, 240),
            stance: 'neutral',
            weight: +(0.25 + (Number(e.probability) || 0.4) * 0.5).toFixed(3),
            interactions: (e.basis_evidence_ids || []).length,
          }))
          // HARD RULE (evidence-gated inference): drop any inference without valid basis evidence
          .filter(e => e.basis_evidence_ids.length && e.entity_a && e.entity_b && e.entity_a !== e.entity_b);
      } catch (e) { log.error('correlation.infer_failed', { iso, error: e.message }); }
      job.stage = 'intel';

      // ---- Stage 4c (V2 items 10+20): per-article intelligence + UAE Strategic
      // Impact Engine — one batched analysis call for summaries/key-points/NER/
      // risk (per evidence record) + per-entity impact scores with explicit
      // reasoning across the 14 strategic dimensions. ----
      let articleIntel = {}; let impactScores = {};
      try {
        const sidA = await createOdSession(`ce-${iso}-intel`, []);
        const nodeIds = [...new Set([...UAE_REGISTRY.map(r => r.id), iso.toLowerCase(), ...rawEdges.flatMap(e => [e.entity_a, e.entity_b]), ...inferredEdges.flatMap(e => [e.entity_a, e.entity_b])])];
        const { parsed: aiParsed } = await analysisJson(sidA, `
EVIDENCE RECORDS about UAE ↔ ${countryName}:
${evidence.map(v => `${v.id} [${v.platform}/${v.source}${v.publish_date ? '/' + v.publish_date : ''}]: ${v.claim} — ${v.snippet}`).join('\n')}

ENTITY IDS in the graph: ${nodeIds.join(', ')}

Return ONE JSON object with EXACTLY two keys:
"articles": { "<evidence id>": {
   "summary50": string (≤50 words), "summary100": string (≤100 words, only when the material supports more detail; else null),
   "keyPoints": [2-4 short strings], "entities": [named entities mentioned],
   "riskLevel": "Low"|"Medium"|"High", "importance": number 1-10,
   "uaeRelation": string (one line: how this item relates to the UAE) } }  — one entry per evidence id;
"impact": { "<entity id>": {
   "score": "Very High"|"High"|"Medium"|"Low"|"None",
   "reasoning": string (≤40 words, explicit, grounded in the evidence),
   "dimensions": [subset of ["trade","diplomacy","investment","technology","food security","energy","defence","climate","education","healthcare","humanitarian","National AI Strategy","economic diversification","foreign policy"] that apply] } } — one entry per entity id that appears in the evidence; omit entities with zero evidence presence (they default to "None").
Ground EVERYTHING in the evidence records; no outside knowledge.`);
        if (aiParsed && typeof aiParsed === 'object') {
          articleIntel = aiParsed.articles || {};
          impactScores = aiParsed.impact || {};
        }
      } catch (e) { log.error('correlation.intel_failed', { iso, error: e.message }); }
      job.stage = 'narrative';

      // ---- Stage 5: Connected Dots narrative (STREAMED, sentence-traceable) ----
      const sidNar = await createOdSession(`ce-${iso}-narrative`, []);
      let narrative = '';
      try {
        narrative = await streamQuery({
          odSessionId: sidNar,
          endpointId: CE_ANALYSIS_ENDPOINT_ID,
          reasoningEffort: CE_ANALYSIS_REASONING_EFFORT,
          query: `You are writing the "Connected Dots" briefing for the ODA Correlation Engine run on ${countryName}.
Evidence:
${evList}

Edges:
${edges.map(e => `${e.id}: ${e.entity_a} -[${e.relationship_type}/${e.direction}]-> ${e.entity_b} :: ${e.claim} (evidence: ${e.evidence_record_ids.join(', ')})`).join('\n')}

Write 4-6 sentences telling the story of how these dots connect. EVERY sentence MUST end with
the evidence id(s) it relies on, in square brackets, e.g. "... announced last week. [E3][E7]".
No headings, no bullets — flowing prose only. Never state anything not in the evidence.`,
          pluginIds: [],
          systemPrompt: 'You are the ODA Correlation Engine narrator. Flowing prose only, every sentence traceable to evidence ids in square brackets.',
          onRaw: () => {},
          onEvent: (type, payload) => { if (type === 'answer') job.narrativeTokens += payload; },
        });
      } catch (e) {
        log.error('correlation.narrative_failed', { iso, error: e.message });
        narrative = job.narrativeTokens || '';
      }
      // streamQuery uses ENDPOINT_ID default — override not supported; use sync fallback on CE model if empty
      if (!narrative) {
        narrative = await syncQuery({
          odSessionId: sidNar,
          query: 'Write the Connected Dots narrative as instructed previously.',
        });
      }
      // sentence traceability check: keep only sentences carrying ≥1 [E#] tag (or tag-free tail)
      const sentences = narrative.match(/[^.!?]+[.!?]+/g) || [narrative];
      const trace = sentences.map(s => ({ sentence: s.trim(), evidenceIds: [...s.matchAll(/\[E\d+\]/g)].map(m => m[0].slice(1, -1)) }))
        .filter(t => t.sentence.length > 3);
      job.stage = 'persist';

      // ---- Stage 6: persist versioned run + diff ----
      const runs = listRuns(iso);
      const prev = runs.length ? getRun(iso, runs[runs.length - 1].runId) : null;
      const allEdgeNodeIds = [...new Set([...rawEdges, ...inferredEdges].flatMap(e => [e.entity_a, e.entity_b]))];
      const UAE_GEO = { lat: 24.3, lng: 54.4 }; // Abu Dhabi anchor for the geographic overlay
      const nodes = [
        ...UAE_REGISTRY.map(r => ({ ...r, geo: UAE_GEO })),
        { id: iso.toLowerCase(), label: countryName, fullName: countryName, kind: 'country-side', geo: geo || null },
        ...allEdgeNodeIds
          .filter(id => !UAE_REGISTRY.some(r => r.id === id) && id !== iso.toLowerCase())
          .map(id => ({ id, label: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), fullName: id, kind: 'country-side', geo: geo || null })),
      ].map(n => ({ ...n, impact: impactScores[n.id] || null }));
      const run = {
        runId, iso, country: countryName,
        generated_at: startedAt.toISOString(),
        schema: 2,                                   // V2 run schema marker
        windowDays,                                  // item 14: research window used
        weighting: WEIGHTING,                        // item 15: engine parameters (auditable)
        model: {
          analysis: `${CE_ANALYSIS_ENDPOINT_ID}+${CE_ANALYSIS_REASONING_EFFORT}`,
          plugins: `${CE_PLUGIN_ENDPOINT_ID}+medium`,
          narrative: 'streamed',
        },
        pluginsCalled,
        evidence, edges, nodes,
        inferredEdges,                               // item 18: tiered inference layer
        articleIntel,                                // item 10: per-article summaries/NER/risk
        impactScores,                                // item 20: UAE Strategic Impact Engine
        narrative: { text: narrative.trim(), trace },
        stats: {
          evidenceCount: evidence.length, edgeCount: edges.length,
          inferredCount: inferredEdges.length,
          droppedNoEvidence, contradictions: edges.filter(e => e.contradiction).length,
          igMediaCount: ig.downloads.length,
          durationMs: Date.now() - startedAt.getTime(),
        },
        sources: Object.fromEntries(Object.entries(gather).map(([k, v]) => [k, (v || '').length])),
      };
      run.diffFromPrevious = diffRuns(prev, run);
      writeJson(path.join(countryDir(iso), `run-${runId}.json`), run);
      job.status = 'done'; job.stage = 'complete'; job.finishedAt = new Date().toISOString();
      job.run = { runId, evidence: run.stats.evidenceCount, edges: run.stats.edgeCount };
      log.info('correlation.run_done', { iso, runId, evidence: run.stats.evidenceCount, edges: run.stats.edgeCount, ms: run.stats.durationMs });
    } catch (e) {
      job.status = 'error'; job.error = e.message;
      log.error('correlation.run_failed', { iso, error: e.message });
    }
  })();
  return job;
}

// ---------- Connected Dots live SSE stream (replays stored trace instantly as meta,
// then streams a FRESH narrative from the analysis model, grounded in the run) ----------
export async function streamNarrative(iso, runId, res) {
  const run = getRun(iso, runId);
  if (!run) throw new Error(`No run ${runId} for ${iso}`);
  const evList = run.evidence.map(v => `${v.id}: [${v.platform}/${v.source}${v.publish_date ? '/' + v.publish_date : ''}] ${v.claim}`).join('\n');
  const sid = await createOdSession(`ce-${iso}-narrative-live`, []);
  await streamQuery({
    odSessionId: sid,
    endpointId: CE_ANALYSIS_ENDPOINT_ID,
    reasoningEffort: CE_ANALYSIS_REASONING_EFFORT,
    query: `Evidence for the ODA Correlation Engine run on ${run.country} (${run.generated_at}):
${evList}

Edges:
${run.edges.map(e => `${e.id}: ${e.entity_a} -[${e.relationship_type}/${e.direction}]-> ${e.entity_b} :: ${e.claim} (evidence: ${e.evidence_record_ids.join(', ')})`).join('\n')}

Write the 4-6 sentence "Connected Dots" briefing. EVERY sentence MUST end with the evidence
id(s) it relies on in square brackets, e.g. [E3][E7]. Flowing prose only; nothing beyond the evidence.`,
    pluginIds: [],
    systemPrompt: 'You are the ODA Correlation Engine narrator. Flowing prose only, every sentence traceable to evidence ids in square brackets.',
    onRaw: (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`),
  });
}

// ---------- Quick Query (GLM 4.7 Cerebras ONLY; hard ~150-token stop; latency stamp) ----------
// Session pooling: a fresh session costs ~2.3s — reused it drops to the GLM answer's
// own ~1.3s (200-proven 2026-07-19). Recreated once automatically on any session error.
let qqSessionId = null;
export async function quickQuery({ context, question }, res) {
  const t0 = Date.now();
  if (!qqSessionId) {
    qqSessionId = await createOdSession('ce-quickquery', []);
    log.info('quickquery.session_created', {});
  }
  const sid = qqSessionId;
  const systemPrompt = 'You are the ODA Quick Query analyst. Answer in 1-3 crisp sentences, grounded ONLY in the JSON artifact provided. No preamble, no caveats, no markdown.';
  const q = `ARTIFACT JSON:\n${JSON.stringify(context || {}).slice(0, 3500)}\n\nQUESTION: ${question}`;
  // Hard token stop: no documented max-tokens param (live docs 2026-07-19) →
  // client-side: accumulate fulfillment deltas, abort at ~150 tokens (≈600 chars),
  // truncate at the last sentence boundary.
  const HARD_CHARS = QUICK_QUERY_MAX_TOKENS * 4;
  const controller = new AbortController();
  let answer = '';
  let stoppedEarly = false;
  let ttftMs = null; // time-to-first-answer-token (real stream signal)
  try {
    await streamQuery({
      odSessionId: sid, query: q, pluginIds: [], systemPrompt,
      endpointId: GLM_ENDPOINT_ID, reasoningEffort: 'low', fulfillmentOnly: true,
      signal: controller.signal,
      onRaw: (event, data) => {
        if (event === 'message' || event === 'thinking') res.write(`event: ${event}\ndata: ${data}\n\n`);
      },
      onEvent: (type, payload) => {
        if (type !== 'answer') return;
        if (ttftMs === null) ttftMs = Date.now() - t0;
        answer += payload;
        if (answer.length >= HARD_CHARS && !stoppedEarly) { stoppedEarly = true; controller.abort(); }
      },
    });
  } catch (e) {
    if (!stoppedEarly && !e.partialAnswer) { qqSessionId = null; throw e; } // recreate session next call
    answer = answer || e.partialAnswer || answer;
  }
  // sentence-boundary truncation
  if (stoppedEarly) {
    const m = answer.match(/^[\s\S]*[.!?](?=\s|$)/);
    if (m && m[0].length > 40) answer = m[0];
  }
  const latencyMs = Date.now() - t0;
  return { answer: answer.trim(), latencyMs, ttftMs, approxTokens: Math.ceil(answer.length / 4), stoppedEarly, model: GLM_ENDPOINT_ID };
}

// ---------- routes ----------
export function registerCorrelationRoutes(app, { countries }) {
  const countryOf = (iso) => countries.find(c => c.iso === iso.toUpperCase());

  app.get('/api/correlation/runs/:iso', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    if (!countryOf(iso)) return res.status(404).json({ error: 'Unknown country' });
    res.json({ iso, runs: listRuns(iso), pipeline: pipelineStatus(iso) });
  });

  app.get('/api/correlation/run/:iso/:runId', (req, res) => {
    const run = getRun(req.params.iso.toUpperCase(), req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  app.get('/api/correlation/run/:iso/:runId/download', (req, res) => {
    const run = getRun(req.params.iso.toUpperCase(), req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="correlation-${run.iso}-${run.runId}.json"`);
    res.send(JSON.stringify(run, null, 1));
  });

  app.get('/api/correlation/diff/:iso', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const runs = listRuns(iso);
    if (runs.length < 2) return res.status(404).json({ error: 'Need ≥2 runs to diff' });
    const a = getRun(iso, req.query.a || runs[runs.length - 2].runId);
    const b = getRun(iso, req.query.b || runs[runs.length - 1].runId);
    if (!a || !b) return res.status(404).json({ error: 'Run not found' });
    res.json({ a: a.runId, b: b.runId, diff: diffRuns(a, b) });
  });

  app.post('/api/correlation/regenerate/:iso', async (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const c = countryOf(iso);
    if (!c) return res.status(404).json({ error: 'Unknown country' });
    // V2 item 14: optional research window (?windowDays=730 or body {windowDays});
    // country geo passed through for the geographic overlay.
    const windowDays = +(req.query.windowDays ?? req.body?.windowDays ?? DEFAULT_WINDOW_DAYS);
    try { res.json({ job: await runPipeline(iso, c.name, { windowDays, geo: { lat: c.lat, lng: c.lng } }) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // V2 config surface: windows + weighting engine parameters (single source of truth for the UI)
  app.get('/api/correlation/config', (_req, res) => res.json({
    schema: 2, windows: SEARCH_WINDOWS, defaultWindowDays: DEFAULT_WINDOW_DAYS,
    weighting: WEIGHTING, relationshipTypes: RELATIONSHIP_TYPES,
    tiers: ['Verified', 'Likely', 'Possible', 'Predicted'],
  }));

  // V2 item 21: Story Mode — 'Explain this graph' executive briefing, streamed
  // (SSE passthrough from the analysis model, grounded ONLY in the run payload).
  app.get('/api/correlation/story/:iso/:runId/stream', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      const run = getRun(req.params.iso.toUpperCase(), req.params.runId);
      if (!run) throw new Error('Run not found');
      const evList = run.evidence.map(v => `${v.id}: [${v.platform}/${v.source}${v.publish_date ? '/' + v.publish_date : ''}] ${v.claim}`).join('\n');
      const edgeList = run.edges.map(e => `${e.id} (Verified): ${e.entity_a} -[${e.relationship_type}/${e.direction}]-> ${e.entity_b} :: ${e.claim}`).join('\n');
      const infList = (run.inferredEdges || []).map(e => `${e.id} (${e.tier}, p=${e.probability}): ${e.entity_a} -[${e.relationship_type}]-> ${e.entity_b} :: ${e.claim}`).join('\n');
      const impacts = Object.entries(run.impactScores || {}).map(([id, s]) => `${id}: ${s.score} — ${s.reasoning}`).join('\n');
      const sid = await createOdSession(`ce-${req.params.iso}-story`, []);
      await streamQuery({
        odSessionId: sid,
        endpointId: CE_ANALYSIS_ENDPOINT_ID,
        reasoningEffort: CE_ANALYSIS_REASONING_EFFORT,
        query: `You are briefing the ODA executive team. Explain this correlation graph for ${run.country} (run ${run.runId}, window ${run.windowDays || 'n/a'} days).

EVIDENCE:
${evList}

VERIFIED EDGES:
${edgeList}

INFERRED EDGES (tiered):
${infList || '(none)'}

UAE STRATEGIC IMPACT SCORES:
${impacts || '(none)'}

Write the executive briefing in EXACTLY these sections, using these markdown headings:
## The beginning
## Key actors
## Major developments
## Current situation
## Risks
## Future outlook
Each section 2-4 sentences. EVERY factual sentence must cite evidence ids in square brackets [E#].
In "Future outlook", clearly separate evidence-backed expectations (cite [E#]/[IE#]) from inferred
possibilities (name the tier: Likely/Possible/Predicted). Nothing beyond the provided material.`,
        pluginIds: [],
        systemPrompt: 'You are the ODA Story Mode narrator: executive-brief style, precise, evidence-cited, no fluff.',
        onRaw: (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`),
      });
      res.write('data: [DONE]\n\n');
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
  });

  app.get('/api/correlation/status/:iso', (req, res) => res.json(pipelineStatus(req.params.iso.toUpperCase())));

  // Connected Dots — real SSE stream from the analysis model, grounded in the run.
  app.get('/api/correlation/narrative/:iso/:runId/stream', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      await streamNarrative(req.params.iso.toUpperCase(), req.params.runId, res);
      res.write('data: [DONE]\n\n');
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
  });

  app.get('/api/correlation/media/:iso/:file', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const fname = path.basename(req.params.file);
    for (const p of [path.join(MEDIA_ROOT, iso, fname), path.join(SEED_ROOT, 'media', iso, fname)]) {
      if (fs.existsSync(p)) { res.setHeader('Cache-Control', 'public, max-age=86400'); return res.sendFile(p); }
    }
    res.status(404).json({ error: 'Media not found' });
  });

  // Quick Query — GLM 4.7 Cerebras only, SSE frames + final metrics with latency stamp.
  app.post('/api/quick-query', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      const out = await quickQuery({ context: req.body?.context, question: String(req.body?.question || '').slice(0, 500) }, res);
      res.write(`event: metrics\ndata: ${JSON.stringify(out)}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch (e) {
      log.error('quickquery.failed', { error: e.message });
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
  });
}
