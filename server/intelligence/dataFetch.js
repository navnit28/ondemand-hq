// dataFetch.js — ADAPTIVE-RETRY DATA-FETCH LAYER (smart-run rewrite, 2026-07-21;
// v3 Cerebras removal 2026-07-21). ONE smart run per correlation request.
// CEREBRAS-FREE (2026-07-21 v3): Cerebras is restricted platform-wide to quick
// summaries/queries and is fully removed from this correlation backend.
// PRIMARY PATH: fable-5 with a strict quality gate: the run must yield
// >= MIN_DATA_POINTS clean, deduped, validated data points. If the primary
// pass fails or comes back short, its artifacts are KEPT (never discarded)
// and a DELTA PROMPT pass excludes every already-captured claim — only the
// missing remainder is fetched. Both passes are then MERGED
// (validated + deduped across passes) so the latest correlation is always
// present in the final dataset, and the merged set must satisfy the 100+
// gate. As an absolute last-resort guarantee (so the pipeline NEVER blocks
// the user), any residual shortfall is backfilled from the real, on-disk
// evidence corpus — never simulated data. The full pass/merge audit trail
// (primaryCount, deltaAdded, mergedCount, per-attempt log) is recorded on the
// run stats for UI display.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOdSession, syncQuery } from '../ondemand.js';
import * as log from '../log.js';
import { SOURCE_TYPES } from './sources.js';
import {
  FABLE_FALLBACK_ENDPOINT_ID, FABLE_FALLBACK_REASONING_EFFORT,
  CE_MIN_DATA_POINTS,
} from '../env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIN_DATA_POINTS = CE_MIN_DATA_POINTS;      // strict floor — ≥100, clamped in env.js
export const TARGET_DATA_POINTS = 120;                  // even target per run
export const MAX_FETCH_ATTEMPTS = 4;                    // reject+retry budget PER ENDPOINT (ladder rung)

export const EXTRACTION_SYSTEM = 'You are the ODA Correlation Engine extractor. Respond with ONE valid JSON array only — no prose, no markdown fences. Ground every record in the provided material; null when unknown; never invent URLs, dates, or facts.';

/** Validate + normalize one candidate data point. Returns a clean record or null. */
export function validateDataPoint(p) {
  if (!p || typeof p !== 'object') return null;
  const claim = String(p.claim ?? '').trim().slice(0, 400);
  if (claim.length < 15) return null;

  const source_type = SOURCE_TYPES.includes(p.source_type) ? p.source_type : 'perplexity_research';
  const source = String(p.source ?? '').slice(0, 120).trim() || 'unknown';
  const url = typeof p.url === 'string' && p.url.startsWith('http') ? p.url : null;
  const pdCandidate = typeof p.publish_date === 'string' ? p.publish_date.slice(0, 10) : '';
  const publish_date = /^\d{4}-\d{2}-\d{2}$/.test(pdCandidate) ? pdCandidate : null;
  const snippet = String(p.snippet ?? '').slice(0, 400);
  const entities = Array.isArray(p.entities)
    ? p.entities.map(e => String(e).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean)
    : [];
  const confRaw = Number(p.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5;

  return { claim, source_type, source, url, publish_date, snippet, entities, confidence };
}

/**
 * Validate + dedupe an entire candidate batch.
 * Dedupe key: normalized claim (lowercase, alphanumeric only, first 120 chars).
 * `points` (the valid, deduped, normalized records) is carried alongside the
 * documented {ok,count,reasons} shape — callers need the actual records to
 * assemble the accepted batch, not just the pass/fail verdict.
 */
export function validateBatch(points) {
  const reasons = [];
  if (!Array.isArray(points)) return { ok: false, count: 0, reasons: ['not_an_array'], points: [] };
  const seen = new Set();
  const valid = [];
  for (const raw of points) {
    const v = validateDataPoint(raw);
    if (!v) { reasons.push('invalid_record'); continue; }
    const key = v.claim.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
    if (!key || seen.has(key)) { reasons.push('duplicate_claim'); continue; }
    seen.add(key);
    valid.push(v);
  }
  const count = valid.length;
  return { ok: count >= MIN_DATA_POINTS, count, reasons, points: valid };
}

/** No odd batches: if length is odd, drop the single lowest-confidence record. */
export function enforceEvenBatch(points) {
  const arr = Array.isArray(points) ? points.slice() : [];
  if (arr.length % 2 === 0) return arr;
  let minIdx = 0;
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i].confidence ?? 0) < (arr[minIdx].confidence ?? 0)) minIdx = i;
  }
  arr.splice(minIdx, 1);
  return arr;
}

function loadMainCorpusRecords() {
  try {
    const p = path.join(__dirname, '..', 'data', 'evidence-corpus-v2.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    log.error('datafetch.corpus_load_failed', { file: 'evidence-corpus-v2.json', error: String(e?.message || e).slice(0, 160) });
    return [];
  }
}

function loadSeedRecords(iso) {
  const out = [];
  try {
    const seedDir = path.join(__dirname, '..', 'data', 'correlation-seed', String(iso || '').toUpperCase());
    const files = fs.readdirSync(seedDir).filter(f => /^run-.*\.json$/i.test(f));
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(seedDir, f), 'utf8'));
        if (Array.isArray(parsed?.evidence)) out.push(...parsed.evidence);
      } catch { /* skip unreadable seed run file */ }
    }
  } catch { /* no correlation-seed dir for this iso — fine, corpus alone still covers the floor */ }
  return out;
}

function renderCorpusLine(r) {
  const source = r?.source || r?.platform || 'unknown';
  const date = r?.publish_date || 'undated';
  const url = r?.url || 'no-url';
  const claim = String(r?.claim || '').slice(0, 300);
  const snippet = String(r?.snippet || '').slice(0, 200);
  const tags = Array.isArray(r?.tags) ? r.tags.join(',') : (Array.isArray(r?.entities) ? r.entities.join(',') : '');
  return `- [${source}|${date}|${url}] ${claim} — ${snippet} (${tags})`;
}

/**
 * Real raw material for the extraction prompt — NEVER simulated. Loads the
 * 509-record evidence-corpus-v2.json plus any correlation-seed/<ISO>/run-*.json
 * evidence (if present for this country), renders every record as a bullet
 * line, and chunks into "=== CORPUS SECTION n ===" blocks of ~50 records each.
 */
export function buildExtractionMaterial({ iso, countryName } = {}) {
  void countryName; // material is the raw real corpus; country context is injected via the prompt, not the material
  const records = [...loadMainCorpusRecords(), ...loadSeedRecords(iso)];
  const lines = records.map(renderCorpusLine);
  const CHUNK = 50;
  const sections = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    sections.push(`=== CORPUS SECTION ${sections.length + 1} ===\n${lines.slice(i, i + CHUNK).join('\n')}`);
  }
  const material = sections.join('\n\n');
  // UNCAPPED PRELOAD (2026-07-21 v3): preload as much country data material as
  // possible — the previous 60k cap is lifted to the model-context ceiling.
  const CAP = 400000;
  return material.length > CAP ? material.slice(0, CAP) : material;
}

/** Build the extraction prompt — hard requirements on minimum + target record counts. */
export function buildExtractionPrompt({ countryName, phrase, material, min, target }) {
  return `Extract an EVIDENCE/DATA-POINT ARRAY documenting UAE relations with ${countryName} over ${phrase}, grounded strictly in the material below.
Each record schema: {"id":"E1"(sequential),"claim":string,"source_type":one of ${JSON.stringify(SOURCE_TYPES)},"source":string,"url":string(verbatim from material or null),"publish_date":"YYYY-MM-DD"|null,"snippet":string(<=40 words),"entities":[lowercase entity slugs],"confidence":number 0-1}
HARD REQUIREMENTS: Return AT LEAST ${min} records and aim for ${target}. Responses with fewer than ${min} records are rejected and retried. Maximise data-point density: decompose every compound fact into multiple granular records (one per statistic, per entity-pair, per event, per date). ONLY claims present in the material.
MATERIAL:
${material}`;
}

/** Robust JSON extraction — fence+shrink parser (same pattern as deepPipeline.js's extractJson). */
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

/** Split combined material into N roughly-equal slices at "=== ... ===" section boundaries. */
function sliceMaterialIntoParts(material, parts) {
  const raw = String(material || '');
  const chunks = raw.split(/\n(?=== )/).map(s => s.trim()).filter(Boolean);
  const buckets = Array.from({ length: parts }, () => []);
  if (chunks.length) {
    chunks.forEach((c, i) => buckets[i % parts].push(c));
  } else {
    const chunkLen = Math.max(1, Math.ceil(raw.length / parts));
    for (let i = 0; i < parts; i++) buckets[i].push(raw.slice(i * chunkLen, (i + 1) * chunkLen));
  }
  return buckets.map(arr => arr.join('\n\n') || raw.slice(0, 4000));
}

const claimKey = (v) => String(v?.claim || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);

/**
 * Build the "already captured" exclusion block for a DELTA rerun. The fallback
 * prompt must NOT refetch claims the primary pass already delivered — only the
 * missing remainder. Claims are truncated to keep the exclusion list compact.
 */
export function buildDeltaExclusion(captured) {
  const lines = (captured || []).map((p, i) => `${i + 1}. ${String(p.claim || '').slice(0, 140)}`);
  if (!lines.length) return '';
  return `\nALREADY CAPTURED (DELTA MODE — DO NOT REPEAT ANY OF THESE ${lines.length} CLAIMS; return ONLY NEW records not semantically covered below):\n${lines.join('\n')}\n`;
}

/** Merge passes: earlier-pass points win on duplicate claim keys; order preserved. */
export function mergePasses(...passes) {
  const seen = new Set();
  const out = [];
  for (const pass of passes) {
    for (const p of pass || []) {
      const key = claimKey(p);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * THE adaptive smart run. ONE run, quality-gated:
 *   PASS 1 (primary):  fable-5-medium, single extraction (the ONLY population model).
 *   PASS 1b:           if short, ONE chunked retry on the SAME rung (still the same run).
 *   PASS 2 (fallback): optional second rung in delta mode — none by default in the
 *                      2026-07-21 v3 policy (a FABLE background delta job tops up instead).
 *   MERGE:             all passes merged + deduped; gate re-evaluated on the merge.
 *   BACKFILL:          last-resort corpus top-up (real data only) so the pipeline
 *                      never blocks. Throws only if even backfill cannot reach the floor.
 */
export async function hardForceDataPoints({
  iso, countryName, phrase, material, sessionTag,
  // INCREMENTAL RUNS (2026-07-21 v3): priorCaptured = evidence records already
  // persisted by earlier runs for this country. When present, every pass runs
  // in DELTA mode (exclusion prompt) so the engine fetches ONLY new/missing
  // data instead of re-fetching everything; prior records are merged into the
  // final dataset unchanged.
  priorCaptured = null,
  // 2026-07-21 v3 policy (CEREBRAS-FREE): fable-5 is the ONLY population model,
  // synchronous AND background. A short fable pass KEEPS its artifacts,
  // corpus-backfills to clear the floor now, and the caller schedules a FABLE
  // BACKGROUND delta job (backgroundDeltaFetch) that merges in real model
  // points and auto-refreshes the UI. Cerebras never appears in this ladder.
  endpointLadder = [
    { endpointId: FABLE_FALLBACK_ENDPOINT_ID, effort: FABLE_FALLBACK_REASONING_EFFORT, label: 'fable-5-medium' },
  ],
  onAttempt = () => {},
} = {}) {
  const attempts = [];
  const passLog = [];
  let globalAttemptN = 0;
  const recordAttempt = (rec) => {
    globalAttemptN += 1;
    const full = { attempt: globalAttemptN, ...rec };
    attempts.push(full);
    log.info('datafetch.attempt', full);
    onAttempt?.(full);
    return full;
  };

  // captured = artifacts KEPT across passes (never discarded on a short pass).
  // Incremental mode: prior-run records seed the captured set so passes below
  // exclude them (delta prompts) and only the missing remainder is fetched.
  const prior = Array.isArray(priorCaptured) ? priorCaptured.map(validateDataPoint).filter(Boolean) : [];
  let captured = mergePasses(prior.map(p => ({ ...p, origin: p.origin || 'prior-run' })));
  const incremental = captured.length > 0;
  let primaryCount = 0;
  let deltaAdded = 0;
  let fallbackUsed = false;
  let endpointUsed = endpointLadder[0]?.endpointId ?? null;

  const finalize = (points, corpusBackfilled = 0) => {
    const even = enforceEvenBatch(points);
    const dataPoints = even.map((p, i) => ({ ...p, id: `E${i + 1}`, origin: p.origin || 'model' }));
    return {
      dataPoints, attempts, endpointUsed, fallbackUsed, corpusBackfilled,
      primaryCount, deltaAdded, mergedCount: dataPoints.length, passes: passLog,
    };
  };

  const runSingle = async (rung, { deltaOf = null, tagSuffix, target }) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const need = Math.max(2, MIN_DATA_POINTS - (deltaOf ? deltaOf.length : 0));
    try {
      const sid = await createOdSession(`${sessionTag}-${tagSuffix}`, []);
      const prompt = buildExtractionPrompt({ countryName, phrase, material, min: need, target })
        + (deltaOf ? buildDeltaExclusion(deltaOf) : '');
      const raw = await syncQuery({ odSessionId: sid, query: prompt, systemPrompt: EXTRACTION_SYSTEM, endpointId: rung.endpointId, reasoningEffort: rung.effort });
      const parsed = extractJson(raw);
      const batch = validateBatch(Array.isArray(parsed) ? parsed : []);
      const latencyMs = Date.now() - t0;
      recordAttempt({ endpointId: rung.endpointId, effort: rung.effort, mode: deltaOf ? 'delta-single' : 'single', requested: target, returnedRaw: Array.isArray(parsed) ? parsed.length : 0, validCount: batch.count, accepted: batch.count >= need, rejectedReason: batch.count >= need ? null : `below_needed:${batch.count}<${need}`, latencyMs, startedAt, error: null });
      return batch.points;
    } catch (e) {
      const latencyMs = Date.now() - t0;
      recordAttempt({ endpointId: rung.endpointId, effort: rung.effort, mode: deltaOf ? 'delta-single' : 'single', requested: target, returnedRaw: 0, validCount: 0, accepted: false, rejectedReason: null, latencyMs, startedAt, error: String(e?.message || e).slice(0, 300) });
      return [];
    }
  };

  const runChunked = async (rung, { deltaOf = null, tagSuffix }) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const CHUNKS = 4, CHUNK_MIN = 26, CHUNK_TARGET = 34;
    try {
      const slices = sliceMaterialIntoParts(material, CHUNKS);
      const excl = deltaOf ? buildDeltaExclusion(deltaOf) : '';
      const runChunk = async (k, mat, suffix = '') => {
        const sid = await createOdSession(`${sessionTag}-${tagSuffix}c${k}${suffix}`, []);
        const prompt = buildExtractionPrompt({ countryName, phrase, material: mat, min: CHUNK_MIN, target: CHUNK_TARGET }) + excl;
        const rawText = await syncQuery({ odSessionId: sid, query: prompt, systemPrompt: EXTRACTION_SYSTEM, endpointId: rung.endpointId, reasoningEffort: rung.effort });
        const parsed = extractJson(rawText);
        return Array.isArray(parsed) ? parsed : [];
      };
      const results = await Promise.allSettled(slices.map((mat, k) => runChunk(k, mat)));
      const chunkArrays = results.map(r => (r.status === 'fulfilled' ? r.value : []));
      const shortIdx = chunkArrays.map((arr, k) => (validateBatch(arr).count < CHUNK_MIN ? k : -1)).filter(k => k >= 0);
      if (shortIdx.length) {
        const retryResults = await Promise.allSettled(shortIdx.map(k => runChunk(k, slices[k], '-retry')));
        shortIdx.forEach((k, j) => { if (retryResults[j].status === 'fulfilled') chunkArrays[k] = retryResults[j].value; });
      }
      const merged = [].concat(...chunkArrays);
      const batch = validateBatch(merged);
      const latencyMs = Date.now() - t0;
      recordAttempt({ endpointId: rung.endpointId, effort: rung.effort, mode: deltaOf ? 'delta-chunked' : 'chunked', requested: CHUNKS * CHUNK_TARGET, returnedRaw: merged.length, validCount: batch.count, accepted: batch.ok, rejectedReason: batch.ok ? null : `below_minimum:${batch.count}<${MIN_DATA_POINTS}`, latencyMs, startedAt, error: null });
      return batch.points;
    } catch (e) {
      const latencyMs = Date.now() - t0;
      recordAttempt({ endpointId: rung.endpointId, effort: rung.effort, mode: deltaOf ? 'delta-chunked' : 'chunked', requested: 4 * 34, returnedRaw: 0, validCount: 0, accepted: false, rejectedReason: null, latencyMs, startedAt, error: String(e?.message || e).slice(0, 300) });
      return [];
    }
  };

  const primary = endpointLadder[0];
  const fallback = endpointLadder[1] || null;

  if (incremental) {
    passLog.push({ pass: 'prior-run', label: 'incremental-seed', endpointId: null, count: captured.length, gate: captured.length >= MIN_DATA_POINTS ? 'pass' : 'short' });
  }
  // ---- PASS 1: PRIMARY (fable-5) — single extraction; DELTA mode when incremental ----
  captured = mergePasses(captured, await runSingle(primary, { deltaOf: incremental ? captured : null, tagSuffix: 'p1', target: TARGET_DATA_POINTS }));
  // ---- PASS 1b: one chunked retry on the SAME rung if short (same run) ----
  if (captured.length < MIN_DATA_POINTS) {
    captured = mergePasses(captured, await runChunked(primary, { deltaOf: incremental ? captured : null, tagSuffix: 'p1b' }));
  }
  primaryCount = captured.length;
  passLog.push({ pass: 'primary', label: primary.label, endpointId: primary.endpointId, count: primaryCount, gate: primaryCount >= MIN_DATA_POINTS ? 'pass' : 'short' });

  if (captured.length >= MIN_DATA_POINTS) {
    endpointUsed = primary.endpointId;
    return finalize(captured, 0);
  }

  // ---- PASS 2: FALLBACK (fable-5-medium) in DELTA mode — keep pass-1 artifacts ----
  if (fallback) {
    fallbackUsed = true;
    endpointUsed = fallback.endpointId;
    log.error('datafetch.primary_short', { sessionTag, primaryCount, needed: MIN_DATA_POINTS, fallingBackTo: fallback.label });
    const beforeDelta = captured.length;
    const deltaPts = await runSingle(fallback, { deltaOf: captured, tagSuffix: 'p2', target: Math.max(TARGET_DATA_POINTS - captured.length, MIN_DATA_POINTS - captured.length + 20) });
    captured = mergePasses(captured, deltaPts);
    if (captured.length < MIN_DATA_POINTS) {
      captured = mergePasses(captured, await runChunked(fallback, { deltaOf: captured, tagSuffix: 'p2b' }));
    }
    deltaAdded = captured.length - beforeDelta;
    passLog.push({ pass: 'fallback-delta', label: fallback.label, endpointId: fallback.endpointId, count: deltaAdded, gate: captured.length >= MIN_DATA_POINTS ? 'pass' : 'short' });
    if (captured.length >= MIN_DATA_POINTS) {
      return finalize(captured, 0);
    }
  }

  // ---- LAST-RESORT GUARANTEE: backfill the shortfall from the real corpus ----
  const haveKeys = new Set(captured.map(claimKey));
  const validatedCorpus = loadMainCorpusRecords()
    .map(validateDataPoint)
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);

  const backfilled = [];
  for (const rec of validatedCorpus) {
    if (captured.length + backfilled.length >= TARGET_DATA_POINTS) break;
    const key = claimKey(rec);
    if (haveKeys.has(key)) continue;
    haveKeys.add(key);
    backfilled.push({ ...rec, origin: 'corpus-backfill' });
  }
  const combined = captured.concat(backfilled);
  if (combined.length < MIN_DATA_POINTS) {
    throw new Error(`hardForceDataPoints: corpus backfill insufficient (${combined.length} < ${MIN_DATA_POINTS})`);
  }
  passLog.push({ pass: 'corpus-backfill', label: 'corpus', endpointId: null, count: backfilled.length, gate: 'pass' });
  log.error('datafetch.corpus_backfill', { n: backfilled.length, total: combined.length });
  return finalize(combined, backfilled.length);
}


/**
 * backgroundDeltaFetch — BACKGROUND backfill pass (2026-07-21; v3 Cerebras-free).
 * Runs FABLE in DELTA mode against the already-captured records (exclusion
 * prompt), returning ONLY new validated model points. Called server-side by
 * the background backfill job when a population pass came back short of the
 * floor; the caller merges (mergePasses), dedupes, re-persists the run, and
 * the UI auto-refreshes via the existing status poll. NO Cerebras here —
 * Cerebras is restricted to quick summaries/queries only.
 */
export async function backgroundDeltaFetch({ iso, countryName, phrase, material, captured, sessionTag }) {
  void iso;
  const t0 = Date.now();
  const need = Math.max(4, MIN_DATA_POINTS - (captured?.length || 0) + 10);
  const sid = await createOdSession(`${sessionTag}-bgc`, []);
  const prompt = buildExtractionPrompt({ countryName, phrase, material, min: need, target: need + 20 })
    + buildDeltaExclusion(captured || []);
  const raw = await syncQuery({ odSessionId: sid, query: prompt, systemPrompt: EXTRACTION_SYSTEM, endpointId: FABLE_FALLBACK_ENDPOINT_ID, reasoningEffort: FABLE_FALLBACK_REASONING_EFFORT });
  const parsed = (function () { try { return extractJson(raw); } catch { return null; } })();
  const batch = validateBatch(Array.isArray(parsed) ? parsed : []);
  const capturedKeys = new Set((captured || []).map(claimKey));
  const fresh = batch.points.filter(p => !capturedKeys.has(claimKey(p))).map(p => ({ ...p, origin: 'fable-bg-backfill' }));
  log.info('datafetch.bg_delta', { sessionTag, engine: 'fable-5', returned: batch.count, fresh: fresh.length, latencyMs: Date.now() - t0 });
  return fresh;
}
