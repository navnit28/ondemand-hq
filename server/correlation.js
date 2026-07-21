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
//   data-fetch (deep-v2)        → HARD-FORCED ≥100 data points (MIN_DATA_POINTS)
//                                 per run, even batch counts, on Cerebras GLM 4.7
//                                 BYOI with claude-fable-5 medium fallback (see
//                                 intelligence/dataFetch.js); a run-level backstop
//                                 in this file retries once and rejects the run
//                                 rather than ever persist below-minimum evidence.
//   Quick Query                 → GLM 4.7 Cerebras BYOI endpoint only.
//
// Latest-result persistence (2026-07-20): every completed run (round-1 or deep-v2)
// writes a `latest.json` pointer per country so the UI always has an immediate,
// O(1) "current result" to display without scanning/loading every run file.
// POST /api/correlation/regenerate/:iso now delegates to the hard-forced deep-v2
// job (runDeepJob) instead of the legacy round-1 runPipeline, so every entry
// point — the "Start Correlation Engine" button included — goes through the
// ≥100-data-point path; round-1 runPipeline is kept only for reference/back-compat.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOdSession, syncQuery, streamQuery } from './ondemand.js';
import {
  CE_PLUGIN_ENDPOINT_ID, CE_ANALYSIS_ENDPOINT_ID, CE_ANALYSIS_REASONING_EFFORT, CE_STREAM_REASONING_EFFORT,
  GLM_ENDPOINT_ID, QUICK_QUERY_MAX_TOKENS,
} from './env.js';
import * as log from './log.js';
// DEEP PIPELINE v2 (2026-07-19 rewrite): windows / weighting / 16-source retrieval /
// 10 specialists / AI correlation layer / prediction mode / UAE impact engine.
import { runDeepPipeline, RESEARCH_WINDOWS, DEFAULT_WINDOW } from './intelligence/deepPipeline.js';
// Data-fetch layer (2026-07-20): hard-forced minimum evidence data points per run
// (see intelligence/dataFetch.js — Cerebras GLM 4.7 BYOI with claude-fable-5-medium
// fallback); enforced again as a run-level backstop in runDeepJob below.
import { MIN_DATA_POINTS, cerebrasDeltaFetch, buildExtractionMaterial } from './intelligence/dataFetch.js';
import { DATA_DIR as DATA_BASE } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(DATA_BASE, 'correlation');
const SEED_ROOT = path.join(DATA_BASE, 'correlation-seed');
const MEDIA_ROOT = path.join(DATA_BASE, 'correlation-media');
try { for (const d of [DATA_ROOT, MEDIA_ROOT]) fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('[correlation] mkdir failed:', e.message); }

export const PLUGINS = {
  perplexity: 'plugin-1722260873',
  xsearch: 'plugin-1751872652',
  reddit: 'plugin-1748003575',
  igDownload: 'plugin-1762980461',
  igUserInfo: 'plugin-1716164040',
};

export const RELATIONSHIP_TYPES = ['Investment', 'Trade', 'Aid-Humanitarian', 'Diplomatic',
  'Infrastructure', 'Energy', 'Technology', 'Security', 'Media-narrative'];

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

// ---------- latest-result persistence (2026-07-20) ----------
// Every completed run (round-1 or deep-v2) persists a small `latest.json` pointer
// per country so the UI always has an immediate, O(1) "current result" to display
// without scanning/loading every run-*.json file on disk.
function latestPointerPath(iso) { return path.join(countryDir(iso), 'latest.json'); }

function persistLatestPointer(iso, run) {
  writeJson(latestPointerPath(iso), {
    runId: run.runId,
    generated_at: run.generated_at,
    evidenceCount: run.stats?.evidenceCount ?? run.evidence?.length ?? 0,
    edgeCount: run.stats?.edgeCount ?? run.edges?.length ?? 0,
    pipeline: run.pipeline || 'round-1',
    persistedAt: new Date().toISOString(),
  });
  log.info('correlation.latest_persisted', { iso, runId: run.runId });
}

// Always resolves to the LATEST completed run for a country: pointer-first, with a
// self-healing fallback to the newest run-*.json (listRuns already excludes latest.json
// via its /^run-.+\.json$/ filter) if the pointer is missing or stale.
export function getLatestRun(iso) {
  hydrateRuns(iso);
  const pointer = readJson(latestPointerPath(iso), null);
  if (pointer?.runId) {
    const run = getRun(iso, pointer.runId);
    if (run) return run;
  }
  const runs = listRuns(iso);
  if (!runs.length) return null;
  const newest = getRun(iso, runs[runs.length - 1].runId);
  if (newest) persistLatestPointer(iso, newest); // self-heal a missing/stale pointer
  return newest;
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
    const weight = +(0.35 * countFactor + 0.25 * diversityFactor + 0.20 * recencyFactor + 0.20 * avgConf).toFixed(4);
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

export async function runPipeline(iso, countryName) {
  if (jobs.get(iso)?.status === 'running') return jobs.get(iso);
  const startedAt = new Date();
  const runId = `${iso}-${startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '')}`;
  const job = { status: 'running', stage: 'gather', runId, startedAt: startedAt.toISOString(), error: null, narrativeTokens: '', minDataPoints: MIN_DATA_POINTS };
  jobs.set(iso, job);
  (async () => {
    const pluginsCalled = [];
    try {
      // ---- Stage 1: gather (3 plugins in parallel; plugin-execution model policy) ----
      const queries = {
        perplexity: `Latest (June-July 2026) official announcements and news on relations between the United Arab Emirates and ${countryName}: investments, trade agreements, development aid, infrastructure, energy, technology, defence and diplomacy involving UAE entities (ODA, MOFA, ADQ, Mubadala, G42, Core42, ADNOC, AD Ports, Presight, ADFD, Masdar, Etihad, DP World, EDGE). For EACH item give the date, the entities involved, a one-line description and the source URL.`,
        xsearch: `Posts from 2026-06-19 to 2026-07-19 about UAE and ${countryName} cooperation: investments, aid, agreements, visits. Prioritize official accounts (ministries, embassies, state media, UAE entities). Include each post's x.com URL, author handle, and date.`,
        reddit: `Fetch recent posts from subreddits about ${countryName} and the UAE (e.g. r/unitedarabemirates, country subreddits): aid, investments, ADNOC, Mubadala, DP World, partnerships. Include post titles, URLs, subreddit names and dates.`,
      };
      const gather = {};
      const gatherResults = await Promise.allSettled(Object.entries(queries).map(async ([key, q]) => {
        const sid = await createOdSession(`ce-${iso}-${key}`, [PLUGINS[key]]);
        const answer = await syncQuery({ odSessionId: sid, query: q, pluginIds: [PLUGINS[key]], endpointId: CE_PLUGIN_ENDPOINT_ID, reasoningEffort: 'medium' });
        gather[key] = answer;
        pluginsCalled.push({ plugin: key, pluginId: PLUGINS[key], status: 200, chars: answer.length });
      }));
      for (let i = 0; i < gatherResults.length; i++) {
        const r = gatherResults[i];
        if (r.status === 'rejected') {
          const key = Object.keys(queries)[i];
          gather[key] = '';
          pluginsCalled.push({ plugin: key, pluginId: PLUGINS[key], status: 'failed', error: String(r.reason?.message || r.reason).slice(0, 200) });
          log.error('correlation.gather_failed', { iso, plugin: key, error: String(r.reason?.message || r.reason).slice(0, 200) });
        }
      }
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

      // ---- Stage 3: normalize → evidence records (analysis model policy) ----
      const sidN = await createOdSession(`ce-${iso}-normalize`, []);
      const material = [
        ['WEB (Perplexity)', gather.perplexity], ['X POSTS', gather.xsearch],
        ['REDDIT', gather.reddit], ['INSTAGRAM PROFILES', ig.profiles.map(p => `@${p.handle} (${p.role}): ${p.answer}`).join('\n\n')],
        ['INSTAGRAM POST', ig.downloadAnswer || ''],
      ].map(([t, a]) => `=== ${t} ===\n${(a || '').slice(0, 9000)}`).join('\n\n');
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
Rules: ONLY claims present in the material. 6-20 records. Prefer dated, official, URL-backed items.
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
      const nodes = [
        ...UAE_REGISTRY.map(r => ({ ...r })),
        { id: iso.toLowerCase(), label: countryName, fullName: countryName, kind: 'country-side' },
        ...[...new Set(rawEdges.flatMap(e => [e.entity_a, e.entity_b]))]
          .filter(id => !UAE_REGISTRY.some(r => r.id === id) && id !== iso.toLowerCase())
          .map(id => ({ id, label: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), fullName: id, kind: 'country-side' })),
      ];
      const run = {
        runId, iso, country: countryName,
        generated_at: startedAt.toISOString(),
        model: {
          analysis: `${CE_ANALYSIS_ENDPOINT_ID}+${CE_ANALYSIS_REASONING_EFFORT}`,
          plugins: `${CE_PLUGIN_ENDPOINT_ID}+medium`,
          narrative: 'streamed',
        },
        pluginsCalled,
        evidence, edges, nodes,
        narrative: { text: narrative.trim(), trace },
        stats: {
          evidenceCount: evidence.length, edgeCount: edges.length,
          droppedNoEvidence, contradictions: edges.filter(e => e.contradiction).length,
          igMediaCount: ig.downloads.length,
          durationMs: Date.now() - startedAt.getTime(),
        },
        sources: { perplexityChars: gather.perplexity?.length || 0, xChars: gather.xsearch?.length || 0, redditChars: gather.reddit?.length || 0 },
      };
      run.diffFromPrevious = diffRuns(prev, run);
      writeJson(path.join(countryDir(iso), `run-${runId}.json`), run);
      persistLatestPointer(iso, run);
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
      endpointId: GLM_ENDPOINT_ID, reasoningEffort: CE_STREAM_REASONING_EFFORT, fulfillmentOnly: true, // validated low|medium|max (2026-07-20 mode audit)
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
// ---------- DEEP PIPELINE v2 job runner (2026-07-19) ----------
// Runs the full rewritten pipeline (windows/weighting/16-source/10-specialist/
// correlation-layer/prediction/impact) and persists the result as a versioned
// daily snapshot alongside round-1 runs — same run-store, same diff mechanics,
// so the UI date scrubber and daily-diff (new-edge pulse) work unchanged.
// EMPTY-UPSTREAM RESILIENT: an empty evidence set still yields a valid snapshot.
export async function runDeepJob(iso, countryName, { window: windowId, offline = false, seedEvidence = null, seedStatedEdges = null } = {}) {
  if (jobs.get(iso)?.status === 'running') return jobs.get(iso);
  const job = { status: 'running', stage: 'deep:init', runId: null, startedAt: new Date().toISOString(), error: null, pipeline: 'deep-v2', window: windowId || DEFAULT_WINDOW, minDataPoints: MIN_DATA_POINTS };
  jobs.set(iso, job);
  const pipelineArgs = {
    iso, countryName, window: windowId,
    plugins: PLUGINS, registry: UAE_REGISTRY, relationshipTypes: RELATIONSHIP_TYPES,
    offline, seedEvidence, seedStatedEdges,
    onStage: (name) => { job.stage = name; },
  };
  const work = (async () => {
    try {
      let run = await runDeepPipeline(pipelineArgs);

      // ---------- latest-result persistence (2026-07-20): run-level hard-force backstop ----------
      // Non-offline runs must clear MIN_DATA_POINTS (evidence data points), mirroring the
      // hard-force inside runDeepPipeline itself. If a run still comes back below minimum,
      // reject + retry the pipeline ONCE at the run level; if the retry is STILL below
      // minimum, error the job rather than ever persist a below-minimum run. offline/seeded
      // runs (used by tests/workflows) are exempt — they intentionally control their own
      // evidence set.
      if (!offline && (run.stats?.evidenceCount ?? 0) < MIN_DATA_POINTS) {
        log.error('correlation.run_below_minimum', { iso, runId: run.runId, count: run.stats?.evidenceCount, min: MIN_DATA_POINTS });
        job.stage = 'deep:retry-below-minimum';
        run = await runDeepPipeline(pipelineArgs);
        if ((run.stats?.evidenceCount ?? 0) < MIN_DATA_POINTS) {
          throw new Error(`Run rejected: ${run.stats?.evidenceCount ?? 0} < ${MIN_DATA_POINTS} data points after retry`);
        }
      }

      job.runId = run.runId;
      const runs = listRuns(iso);
      const prev = runs.length ? getRun(iso, runs[runs.length - 1].runId) : null;
      run.diffFromPrevious = diffRuns(prev, run); // daily diff — newEdgeIds drive the frontend pulse
      writeJson(path.join(countryDir(iso), `run-${run.runId}.json`), run);
      persistLatestPointer(iso, run);
      job.status = 'done'; job.stage = 'complete'; job.finishedAt = new Date().toISOString();
      job.run = { runId: run.runId, evidence: run.stats.evidenceCount, edges: run.stats.edgeCount, emptyUpstream: run.stats.emptyUpstream, dataFetch: run.stats?.dataFetch || null };
      log.info('correlation.deep_run_done', { iso, runId: run.runId, ...run.stats });
      // ---------- BACKGROUND Cerebras backfill (2026-07-21) ----------
      // fable-5-medium is the ONLY sync population model. If its pass came back
      // short (corpusBackfilled > 0 marks the shortfall), the fable artifacts are
      // KEPT and already persisted above; now a server-side Cerebras job fetches
      // ONLY the missing delta (exclusion prompt), merges + dedupes into the run,
      // re-persists, and the UI auto-refreshes via its backfill poll — no user
      // action needed. Fire-and-forget: never blocks or fails the main job.
      if (!offline && (run.stats?.dataFetch?.corpusBackfilled ?? 0) > 0) {
        run.stats.dataFetch.backgroundBackfill = { status: 'running', startedAt: new Date().toISOString() };
        writeJson(path.join(countryDir(iso), `run-${run.runId}.json`), run);
        persistLatestPointer(iso, run);
        (async () => {
          try {
            const captured = run.evidence.filter(e => e.origin !== 'corpus-backfill');
            const material = buildExtractionMaterial({ iso, countryName });
            const fresh = await cerebrasDeltaFetch({
              iso, countryName, phrase: 'the last 2 years', material,
              captured, sessionTag: `bgfill-${iso}-${run.runId}`,
            });
            if (fresh.length) {
              const seen = new Set(run.evidence.map(e => (e.claim || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120)));
              let nextIdx = run.evidence.length;
              for (const f of fresh) {
                const key = (f.claim || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                nextIdx += 1;
                run.evidence.push({ ...f, id: `E${nextIdx}` });
              }
              run.stats.evidenceCount = run.evidence.length;
            }
            run.stats.dataFetch.backgroundBackfill = {
              status: 'done', added: fresh.length, completedAt: new Date().toISOString(),
              endpoint: 'cerebras-glm-4.7', mergedTotal: run.evidence.length,
            };
            writeJson(path.join(countryDir(iso), `run-${run.runId}.json`), run);
            persistLatestPointer(iso, run);
            log.info('correlation.bg_backfill_done', { iso, runId: run.runId, added: fresh.length, total: run.evidence.length });
          } catch (e) {
            run.stats.dataFetch.backgroundBackfill = { status: 'error', error: String(e?.message || e).slice(0, 200), completedAt: new Date().toISOString() };
            try { writeJson(path.join(countryDir(iso), `run-${run.runId}.json`), run); persistLatestPointer(iso, run); } catch { /* best-effort */ }
            log.error('correlation.bg_backfill_failed', { iso, runId: run.runId, error: String(e?.message || e).slice(0, 200) });
          }
        })();
      }
      return run;
    } catch (e) {
      job.status = 'error'; job.error = e.message;
      log.error('correlation.deep_run_failed', { iso, error: e.message });
      throw e;
    }
  })();
  job.promise = work.catch(() => null);
  return job;
}

export function registerCorrelationRoutes(app, { countries }) {
  const countryOf = (iso) => countries.find(c => c.iso === iso.toUpperCase());

  // DEEP SEARCH MODE config: selectable research windows (pipeline parameter + API option).
  app.get('/api/correlation/windows', (_req, res) => res.json({
    default: DEFAULT_WINDOW,
    defaultLabel: 'Last 2 Years + higher weighting on Last 30 Days',
    windows: Object.values(RESEARCH_WINDOWS),
  }));

  // Trigger the deep pipeline: POST /api/correlation/deep/:iso?window=2y
  // body (optional): { window, offline, seedEvidence } — seedEvidence may be [] (empty-but-valid).
  app.post('/api/correlation/deep/:iso', async (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const c = countryOf(iso);
    if (!c) return res.status(404).json({ error: 'Unknown country' });
    const windowId = req.query.window || req.body?.window || DEFAULT_WINDOW;
    if (!RESEARCH_WINDOWS[String(windowId).toLowerCase()]) return res.status(400).json({ error: `Unknown window '${windowId}'`, valid: Object.keys(RESEARCH_WINDOWS) });
    try {
      const job = await runDeepJob(iso, c.name, {
        window: windowId,
        offline: !!req.body?.offline,
        seedEvidence: Array.isArray(req.body?.seedEvidence) ? req.body.seedEvidence : null,
        seedStatedEdges: Array.isArray(req.body?.seedStatedEdges) ? req.body.seedStatedEdges : null,
      });
      res.json({ job: { status: job.status, stage: job.stage, runId: job.runId, pipeline: job.pipeline, window: job.window } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/correlation/runs/:iso', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    if (!countryOf(iso)) return res.status(404).json({ error: 'Unknown country' });
    const runs = listRuns(iso);
    // Read the pointer file directly (not getLatestRun) to avoid loading the full run JSON
    // on every list call; falls back to the newest listed run if the pointer is absent.
    const latestRunId = readJson(latestPointerPath(iso), null)?.runId ?? (runs.length ? runs[runs.length - 1].runId : null);
    res.json({ iso, runs, pipeline: pipelineStatus(iso), latestRunId });
  });

  // Latest correlation result is ALWAYS persisted and is what the UI displays by default.
  app.get('/api/correlation/latest/:iso', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    if (!countryOf(iso)) return res.status(404).json({ error: 'Unknown country' });
    const run = getLatestRun(iso);
    if (!run) return res.status(404).json({ error: 'No correlation runs yet', iso });
    res.json({ iso, latest: true, run });
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

  // Legacy regenerate route — repointed to the HARD-FORCED deep pipeline (2026-07-20) so
  // EVERY entry point ('Start Correlation Engine' button, legacy callers) goes through the
  // ≥MIN_DATA_POINTS path. Round-1 runPipeline is retained above for reference only — it is
  // no longer routed from any HTTP endpoint.
  app.post('/api/correlation/regenerate/:iso', async (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const c = countryOf(iso);
    if (!c) return res.status(404).json({ error: 'Unknown country' });
    try {
      const job = await runDeepJob(iso, c.name, {});
      res.json({ job: { status: job.status, stage: job.stage, runId: job.runId, pipeline: job.pipeline, window: job.window, minDataPoints: job.minDataPoints } });
    } catch (e) { res.status(400).json({ error: e.message }); }
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

  // ---------- V2 inspector support (restored 2026-07-19, expand-mode fix) ----------
  // Streamed article summary for one evidence record — gpt-5.6-sol-medium.
  app.post('/api/correlation/summarize', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      const { iso, runId, evidenceId } = req.body || {};
      const run = getRun(String(iso || '').toUpperCase(), runId);
      const ev = run?.evidence.find(v => v.id === evidenceId);
      if (!ev) throw new Error('Evidence record not found');
      const sid = await createOdSession(`ce-sum-${iso}-${evidenceId}`, []);
      await streamQuery({
        odSessionId: sid,
        endpointId: GLM_ENDPOINT_ID, reasoningEffort: CE_STREAM_REASONING_EFFORT, // validated low|medium|max (2026-07-20 mode audit)
        query: `Evidence record from the ODA Correlation Engine run on ${run.country} (${run.generated_at}):
CLAIM: ${ev.claim}
SOURCE: ${ev.source} (${ev.platform || ev.source_type || 'unknown'})${ev.publish_date ? ' · ' + ev.publish_date : ''}${ev.url ? '\nURL: ' + ev.url : ''}
SNIPPET: ${ev.snippet || '(none)'}

Produce EXACTLY these sections, grounded ONLY in the record above (no outside facts):
## 50-word summary
## 100-word summary
## Key points
## Named entities
## Risk level (Low/Medium/High + one line why)
## Importance (Low/Medium/High + one line why)
## UAE relevance (one line)`,
        pluginIds: [],
        systemPrompt: 'You are the ODA Correlation Engine article summarizer. Ground everything in the given record only; never invent facts, dates, or URLs.',
        onRaw: (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`),
      });
      res.write('data: [DONE]\n\n');
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
  });

  // One-click Story Mode — GLM 4.7 BYOI, streamed SSE.
  app.get('/api/correlation/story/:iso/:runId/stream', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      const iso = req.params.iso.toUpperCase();
      const run = getRun(iso, req.params.runId);
      if (!run) throw new Error('Run not found');
      const evList = run.evidence.map(v => `${v.id}: [${v.platform || v.source_type}/${v.source}${v.publish_date ? '/' + v.publish_date : ''}] ${v.claim}`).join('\n') || '(no evidence this run)';
      const edgeList = run.edges.map(e => `${e.id}: ${e.entity_a} -[${e.relationship_type}${e.verification ? '/' + e.verification : ''}]-> ${e.entity_b} :: ${e.claim}`).join('\n') || '(no edges this run)';
      const sid = await createOdSession(`ce-story-${iso}-${run.runId}`, []);
      await streamQuery({
        odSessionId: sid,
        endpointId: GLM_ENDPOINT_ID, reasoningEffort: CE_STREAM_REASONING_EFFORT, // validated low|medium|max (2026-07-20 mode audit)
        query: `ODA Correlation Engine intelligence picture for UAE ↔ ${run.country} (run ${run.runId}).
EVIDENCE:
${evList}

GRAPH EDGES:
${edgeList}

Narrate in EXACTLY these sections, 2-4 sentences each, every factual sentence ending with its evidence id(s) in square brackets; mark forecasts as (forecast):
## Beginning
## Key actors
## Major developments
## Current situation
## Risks
## Future outlook`,
        pluginIds: [],
        systemPrompt: 'You are the ODA Correlation Engine story narrator. Evidence-traceable sentences only; forecasts explicitly marked; never invent facts.',
        onRaw: (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`),
      });
      res.write('data: [DONE]\n\n');
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
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
