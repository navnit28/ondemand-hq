// deepPipeline.js — DEEP RESEARCH/INTELLIGENCE PIPELINE (rewrite, 2026-07-19).
// Replaces the round-1 gather→normalize→edges flow with the full 7-part pipeline:
//   (a) DEEP SEARCH MODE research windows        → ./windows.js
//   (b) CONTEXT WEIGHTING on every fact/edge     → ./weighting.js
//   (c) 16-class maximum-evidence retrieval + HARD-FORCE 100+ min data-fetch → ./sources.js, ./dataFetch.js
//   (d) 10-specialist Perplexity orchestration   → ./specialists.js
//   (e) AI CORRELATION LAYER (inferred edges)    → ./correlationLayer.js
//   (f) PREDICTION MODE                          → ./prediction.js
//   (g) UAE STRATEGIC IMPACT ENGINE              → ./impact.js
// Output: ONE unified evidence-gated graph. Edges admitted ONLY with attached evidence;
// unevidenced inferences clearly tagged (inference:true, verification:"Predicted"/"Possible").
// EMPTY-UPSTREAM RESILIENCE: every stage accepts an empty-but-valid evidence set (the
// 2026-07-19 live fetches returned 0 articles / timeouts) and still emits a valid,
// versioned, diffable run snapshot; the scheduled workflow populates data on later runs.
// Model policy (2026-07-20 GLM switch): ALL model calls = GLM 4.7 Cerebras BYOI + validated reasoningEffort,
// streamed where the platform supports it (streamQuery), sync JSON extraction otherwise.

import { KIMI_K3_ENDPOINT_ID, KIMI_K3_REASONING_EFFORT, validEffort } from '../env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOdSession, syncQuery, streamQuery } from '../ondemand.js';
import * as log from '../log.js';
import { resolveWindow, windowPhrase, inWindow, RESEARCH_WINDOWS, DEFAULT_WINDOW } from './windows.js';
import { weighFact, edgeWeightFromEvidence, markCorroborations } from './weighting.js';
import { buildRetrievalPlan, SOURCE_TYPES } from './sources.js';
import { hardForceDataPoints, buildExtractionMaterial, MIN_DATA_POINTS } from './dataFetch.js';
import { buildSpecialistPrompts, SPECIALISTS, SPECIALIST_SYSTEM } from './specialists.js';
import { assignVerification, buildInferencePrompt, deterministicInference, VERIFICATION_TIERS } from './correlationLayer.js';
import { buildPredictionPrompt, normalisePredictions, PREDICTION_CATEGORIES } from './prediction.js';
import { buildImpactPrompt, normaliseImpactScores, structuralImpactScores } from './impact.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));

// GLM 4.7 BYOI everywhere (decomposed form — suffixed id returns HTTP 400; Phase-1 verified).
// ONLY the ACTIVE BYOI id — predefined-glm-4.7/-flash are inactive registry entries.
export const DEEP_ENDPOINT_ID = process.env.DEEP_ENDPOINT_ID || KIMI_K3_ENDPOINT_ID; // Kimi K3 — THE correlating model (2026-07-21; GLM removed from correlation)
export const DEEP_REASONING_EFFORT = validEffort(process.env.DEEP_REASONING_EFFORT, KIMI_K3_REASONING_EFFORT); // MEDIUM — validated low|medium|max, decomposed form only (suffixed ids = HTTP 400)

// Edge styling contract persisted for the frontend (brand tokens).
export const EDGE_STYLE = {
  Verified:  { color: '#159a7a', line: 'solid',  pulse: false },
  Likely:    { color: '#1dac89', line: 'solid',  pulse: false },
  Possible:  { color: '#1dac89', line: 'dashed', pulse: false },
  Predicted: { color: '#8aa8a0', line: 'dotted', pulse: true },
};

const extractJson = (text) => {
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
};

/** Streamed model call on GLM 4.7 BYOI + validated effort; falls back to sync on stream failure. */
async function modelCall({ session, prompt, systemPrompt, pluginIds = [], onToken }) {
  try {
    let acc = '';
    const answer = await streamQuery({
      odSessionId: session, query: prompt, pluginIds,
      endpointId: DEEP_ENDPOINT_ID, reasoningEffort: DEEP_REASONING_EFFORT,
      systemPrompt,
      onRaw: () => {},
      onEvent: (type, payload) => { if (type === 'answer') { acc += payload; onToken?.(payload); } },
    });
    return answer || acc;
  } catch (e) {
    log.error('deep.stream_fallback_sync', { error: String(e.message).slice(0, 160) });
    return syncQuery({
      odSessionId: session, query: prompt, pluginIds,
      endpointId: DEEP_ENDPOINT_ID, reasoningEffort: DEEP_REASONING_EFFORT, systemPrompt,
    });
  }
}

/**
 * Run the full deep pipeline. options:
 *   iso, countryName          — target country
 *   window                    — research window id ('24h'|'1w'|'1m'|'6m'|'1y'|'2y'|'all'); default '2y'
 *   plugins                   — {perplexity, xsearch, ...} plugin-id map (from correlation.js PLUGINS)
 *   registry                  — UAE node registry
 *   relationshipTypes         — canonical edge types
 *   offline                   — true → skip all network calls; run deterministic stages only
 *   seedEvidence              — pre-supplied evidence records (e.g. from a workflow payload or test);
 *                               MAY BE EMPTY — the pipeline is empty-upstream resilient by design.
 *   seedStatedEdges           — pre-supplied stated edges (workflow digest ingestion); still pass
 *                               the evidence gate: dropped unless their evidence ids resolve.
 * Returns the unified run object (caller persists it as a versioned snapshot).
 */
export async function runDeepPipeline({
  iso, countryName, window: windowId = DEFAULT_WINDOW,
  plugins = {}, registry = [], relationshipTypes = [],
  offline = false, seedEvidence = null, seedStatedEdges = null, onStage = () => {},
}) {
  const nowTs = Date.now();
  const startedAt = new Date(nowTs);
  const win = resolveWindow(windowId);
  const phrase = windowPhrase(win, nowTs);
  const runId = `${iso}-${startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '')}`;
  const stageLog = [];
  const stage = (name, detail = {}) => { stageLog.push({ stage: name, at: new Date().toISOString(), ...detail }); onStage(name, detail); };

  // ---------- Stage A: retrieval (16 source classes) + Stage B: 10 specialists ----------
  stage('retrieval:start', { window: win.id, phrase, sourceClasses: SOURCE_TYPES.length });
  const rawMaterial = [];   // [{sourceType|specialist, text}]
  const specialistOutputs = {};
  if (!offline) {
    const plan = buildRetrievalPlan(countryName, phrase);
    const results = await Promise.allSettled(plan.map(async (p) => {
      const pluginId = plugins[p.plugin];
      const sid = await createOdSession(`deep-${iso}-${p.sourceType}`, pluginId ? [pluginId] : []);
      const text = await modelCall({ session: sid, prompt: p.query, pluginIds: pluginId ? [pluginId] : [] });
      return { sourceType: p.sourceType, text };
    }));
    for (const r of results) if (r.status === 'fulfilled' && r.value.text) rawMaterial.push(r.value);
    stage('retrieval:done', { fetched: rawMaterial.length, failed: results.filter(r => r.status === 'rejected').length });

    stage('specialists:start', { count: SPECIALISTS.length });
    const prompts = buildSpecialistPrompts(countryName, phrase);
    const specResults = await Promise.allSettled(SPECIALISTS.map(async (s) => {
      const sid = await createOdSession(`deep-${iso}-${s.id}`, plugins.perplexity ? [plugins.perplexity] : []);
      const text = await modelCall({
        session: sid, prompt: prompts[s.id], systemPrompt: SPECIALIST_SYSTEM,
        pluginIds: plugins.perplexity ? [plugins.perplexity] : [],
      });
      return { id: s.id, role: s.role, text };
    }));
    for (const r of specResults) if (r.status === 'fulfilled') specialistOutputs[r.value.id] = { role: r.value.role, chars: (r.value.text || '').length, text: r.value.text || '' };
    stage('specialists:done', { returned: Object.keys(specialistOutputs).length });
  } else {
    stage('retrieval:skipped', { reason: 'offline mode' });
  }

  // ---------- Stage C: normalize → typed evidence records (HARD-FORCE data-fetch layer, 2026-07-20) ----------
  // The old single "Up to 60 records, no minimum" extraction is REPLACED by the
  // hard-force data-fetch layer (./dataFetch.js): strict minimum 100+ validated
  // data points per run, below-minimum responses rejected and automatically
  // retried, no odd/partial batches, Cerebras GLM 4.7 first (ultimate speed)
  // with fable-5-medium automatic fallback.
  stage('normalize:start');
  let evidence = Array.isArray(seedEvidence) ? [...seedEvidence] : [];
  let fetchRes = null;
  if (!offline) {
    const liveMaterial = [
      ...rawMaterial.map(m => `=== SOURCE:${m.sourceType} ===\n${(m.text || '').slice(0, 6000)}`),
      ...Object.entries(specialistOutputs).map(([id, s]) => `=== SPECIALIST:${id}(${s.role}) ===\n${(s.text || '').slice(0, 6000)}`),
    ].join('\n\n').slice(0, 80000); // cap live material so combined prompt stays inside GLM's 65k ctx
    // Live plugin/specialist material ENRICHES the guaranteed real corpus base —
    // the extraction prompt always has enough real material to clear the floor.
    const combinedMaterial = [liveMaterial, buildExtractionMaterial({ iso, countryName })]
      .filter(Boolean).join('\n\n').slice(0, 140000);
    fetchRes = await hardForceDataPoints({
      iso, countryName, phrase, material: combinedMaterial,
      sessionTag: `deep-${iso}-datafetch`,
      onAttempt: (a) => stage('datafetch:attempt', { attempt: a.attempt, endpoint: a.endpointId, count: a.validCount, accepted: a.accepted }),
    });
    evidence = evidence.concat(fetchRes.dataPoints);
  }
  // Validate + weight EVERY fact (empty-safe).
  evidence = evidence.map((v, i) => ({
    id: v.id || `E${i + 1}`,
    claim: String(v.claim || '').slice(0, 400),
    source_type: SOURCE_TYPES.includes(v.source_type) ? v.source_type : 'perplexity_research',
    source: String(v.source || 'unknown').slice(0, 120),
    url: typeof v.url === 'string' && v.url.startsWith('http') ? v.url : null,
    publish_date: /^\d{4}-\d{2}-\d{2}/.test(v.publish_date || '') ? v.publish_date.slice(0, 10) : null,
    snippet: String(v.snippet || '').slice(0, 400),
    entities: Array.isArray(v.entities) ? v.entities.map(e => String(e).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).filter(Boolean) : [],
    media: v.media || [],
    origin: v.origin || 'model',
    confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0.5)),
  })).filter(v => v.claim.length > 8);
  if (offline || !fetchRes) {
    // legacy semantics for offline/seeded runs: strict window filter, original ids kept
    evidence = evidence.filter(v => inWindow(v.publish_date, win, nowTs));
  } else {
    // HARD FLOOR PRESERVATION: window filtering must never break the ≥MIN_DATA_POINTS
    // guarantee. In-window records are preferred; out-of-window records are retained
    // (highest confidence first) only when dropping them would fall below the floor.
    const inWin = evidence.filter(v => inWindow(v.publish_date, win, nowTs));
    if (inWin.length >= MIN_DATA_POINTS) {
      evidence = inWin;
    } else {
      const outWin = evidence.filter(v => !inWindow(v.publish_date, win, nowTs))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      evidence = inWin.concat(outWin.slice(0, Math.max(0, MIN_DATA_POINTS - inWin.length)));
    }
    // No odd batches: drop the single lowest-confidence record if the count is odd.
    if (evidence.length % 2 === 1) {
      let minIdx = 0;
      for (let i = 1; i < evidence.length; i++) if ((evidence[i].confidence ?? 0) < (evidence[minIdx].confidence ?? 0)) minIdx = i;
      evidence.splice(minIdx, 1);
    }
    // Re-id sequentially so downstream edge gating has unique, collision-free ids.
    evidence = evidence.map((v, i) => ({ ...v, id: `E${i + 1}` }));
  }
  markCorroborations(evidence);
  for (const v of evidence) v.weighting = weighFact(v, { nowTs, win });   // (b) persisted per-fact weight
  stage('normalize:done', {
    evidenceCount: evidence.length, emptyUpstream: evidence.length === 0,
    hardForce: fetchRes ? { endpointUsed: fetchRes.endpointUsed, fallbackUsed: fetchRes.fallbackUsed, attempts: fetchRes.attempts.length, corpusBackfilled: fetchRes.corpusBackfilled } : null,
  });

  // ---------- Stage D: stated-edge extraction (evidence-gated; empty-safe) ----------
  stage('edges:start');
  const evList = evidence.map(v => `${v.id}: [${v.source_type}/${v.source}${v.publish_date ? '/' + v.publish_date : ''} w=${v.weighting.finalWeight}] ${v.claim}`).join('\n');
  let statedRaw = Array.isArray(seedStatedEdges) ? [...seedStatedEdges] : [];
  if (!offline && evidence.length) {
    const sidE = await createOdSession(`deep-${iso}-edges`, []);
    const raw = await modelCall({
      session: sidE,
      systemPrompt: 'ODA Correlation Engine edge extractor. ONE valid JSON array only. Never create an edge without supporting evidence ids; never use general knowledge.',
      prompt: `UAE registry: ${registry.map(r => `${r.id} (${r.fullName})`).join('; ')}.
Country node id "${iso.toLowerCase()}" (${countryName}).
Evidence:\n${evList}
Extract RELATIONSHIP EDGES — JSON array of:
{"entity_a","entity_b","relationship_type":one of ${JSON.stringify(relationshipTypes)},
 "direction":"a->b"|"b->a"|"both","claim":string,
 "evidence_record_ids":[ids from above ONLY],"confidence":0-1,"stance":"cooperation"|"tension"|"neutral"}`,
    });
    const parsed = extractJson(raw);
    if (Array.isArray(parsed)) statedRaw = statedRaw.concat(parsed);
  }
  const evidenceById = new Map(evidence.map(v => [v.id, v]));
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const gate = (arr, isInference) => arr.map(e => {
    const ids = [...new Set((e.evidence_record_ids || e.basis_evidence_ids || []).filter(id => evidenceById.has(id)))];
    if (!ids.length && !isInference) return null;               // HARD GATE: stated edges need evidence
    return { ...e, entity_a: slug(e.entity_a), entity_b: slug(e.entity_b), evidence_record_ids: ids, inference: !!isInference || !!e.inference };
  }).filter(e => e && e.entity_a && e.entity_b && e.entity_a !== e.entity_b);
  const stated = gate(statedRaw, false);
  stage('edges:done', { stated: stated.length, droppedNoEvidence: statedRaw.length - stated.length });

  // ---------- Stage E: AI CORRELATION LAYER — inferred edges (empty-safe) ----------
  stage('correlation-layer:start');
  let inferredRaw = [];
  if (!offline && evidence.length) {
    const sidI = await createOdSession(`deep-${iso}-inference`, []);
    const raw = await modelCall({
      session: sidI, systemPrompt: SPECIALIST_SYSTEM,
      prompt: buildInferencePrompt(countryName, evList, stated.map(e => `${e.entity_a} -[${e.relationship_type}]-> ${e.entity_b}: ${e.claim}`).join('\n')),
    });
    const parsed = extractJson(raw);
    if (Array.isArray(parsed)) inferredRaw = parsed;
  }
  if (!inferredRaw.length) inferredRaw = deterministicInference(evidence, stated); // offline/empty fallback
  const inferred = gate(inferredRaw, true);
  stage('correlation-layer:done', { inferred: inferred.length });

  // ---------- Stage F: unify graph — weight, verify-tier, style (empty-safe) ----------
  const merged = new Map();
  for (const e of [...stated, ...inferred]) {
    const key = `${[e.entity_a, e.entity_b].sort().join('~')}|${e.relationship_type}`;
    if (!merged.has(key)) { merged.set(key, { ...e }); continue; }
    const m = merged.get(key);
    m.evidence_record_ids = [...new Set([...m.evidence_record_ids, ...e.evidence_record_ids])];
    if (!e.inference) m.inference = false;                       // stated beats inferred
    if ((e.confidence ?? 0) > (m.confidence ?? 0)) { m.claim = e.claim; m.confidence = e.confidence; m.stance = e.stance || m.stance; }
  }
  const edges = [...merged.values()].map((e, i) => {
    const evs = e.evidence_record_ids.map(id => evidenceById.get(id)).filter(Boolean);
    const { rawWeight, weight } = edgeWeightFromEvidence(evs);
    const confidence = +(Math.max(0, Math.min(1, e.confidence ?? (evs.length ? evs.reduce((a, v) => a + v.confidence, 0) / evs.length : 0.3)))).toFixed(3);
    const verification = assignVerification({ ...e, confidence }, evs);
    return {
      id: `ED${i + 1}`,
      entity_a: e.entity_a, entity_b: e.entity_b,
      relationship_type: e.relationship_type,
      dimension: e.dimension || null,
      direction: e.direction || 'a->b',
      claim: e.claim,
      evidence_record_ids: e.evidence_record_ids,
      inference: !!e.inference,
      confidence,
      verification,                       // Verified | Likely | Possible | Predicted
      style: EDGE_STYLE[verification],    // persisted so frontend styles tiers differently
      weight, rawWeight,                  // (b) context-weighted final edge weight
      stance: e.stance || 'neutral',
      sourceTypes: [...new Set(evs.map(v => v.source_type))],
    };
  });
  // Contradiction flag (cooperation+tension on same pair+type).
  const stanceSeen = new Map();
  for (const e of edges) {
    const k = [e.entity_a, e.entity_b].sort().join('~') + '|' + e.relationship_type;
    (stanceSeen.get(k) || stanceSeen.set(k, new Set()).get(k)).add(e.stance);
  }
  for (const e of edges) {
    const s = stanceSeen.get([e.entity_a, e.entity_b].sort().join('~') + '|' + e.relationship_type);
    e.contradiction = !!(s?.has('cooperation') && s?.has('tension'));
  }

  // Node set: registry + country + every edge/evidence entity.
  const nodeIds = new Set([...registry.map(r => r.id), iso.toLowerCase(),
    ...edges.flatMap(e => [e.entity_a, e.entity_b]), ...evidence.flatMap(v => v.entities)]);
  const nodes = [
    ...registry.map(r => ({ ...r })),
    { id: iso.toLowerCase(), label: countryName, fullName: countryName, kind: 'country' },
    ...[...nodeIds].filter(id => !registry.some(r => r.id === id) && id !== iso.toLowerCase())
      .map(id => ({ id, label: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), fullName: id, kind: 'country-side' })),
  ];

  // ---------- Stage G: PREDICTION MODE (empty-safe) ----------
  stage('prediction:start');
  let predictions = normalisePredictions(null); // all-empty categories baseline
  if (!offline && (evidence.length || edges.length)) {
    const sidP = await createOdSession(`deep-${iso}-predict`, []);
    const raw = await modelCall({
      session: sidP, systemPrompt: SPECIALIST_SYSTEM,
      prompt: buildPredictionPrompt(countryName, evList, edges.map(e => `${e.entity_a} -[${e.relationship_type}/${e.verification}]-> ${e.entity_b}`).join('\n'), phrase),
    });
    predictions = normalisePredictions(extractJson(raw));
  }
  stage('prediction:done', { categories: PREDICTION_CATEGORIES.length, items: Object.values(predictions).reduce((a, c) => a + c.length, 0) });

  // ---------- Stage H: UAE STRATEGIC IMPACT ENGINE (empty-safe) ----------
  stage('impact:start');
  let impact;
  if (!offline && evidence.length) {
    const sidS = await createOdSession(`deep-${iso}-impact`, []);
    const raw = await modelCall({
      session: sidS, systemPrompt: SPECIALIST_SYSTEM,
      prompt: buildImpactPrompt(countryName, nodes, evList, edges.map(e => `${e.id}: ${e.entity_a}→${e.entity_b} [${e.relationship_type}/${e.verification}] ${e.claim}`).join('\n')),
    });
    impact = normaliseImpactScores(extractJson(raw), nodes);
  } else {
    impact = structuralImpactScores(nodes);
  }
  stage('impact:done', { scored: impact.length });

  // ---------- Assemble unified run snapshot ----------
  const run = {
    runId, iso, country: countryName,
    generated_at: startedAt.toISOString(),
    pipeline: 'deep-v2',
    window: { id: win.id, label: win.label, days: win.days, boostRecentDays: win.boostRecentDays, boostFactor: win.boostFactor, phrase },
    model: {
      all: `${DEEP_ENDPOINT_ID}+${DEEP_REASONING_EFFORT}`, streaming: true,
      // hard-force data-fetch provenance (2026-07-20): which endpoint actually delivered the run
      dataFetch: fetchRes ? `${fetchRes.endpointUsed}+hardforce-min${MIN_DATA_POINTS}` : 'offline',
    },
    specialists: Object.fromEntries(Object.entries(specialistOutputs).map(([id, s]) => [id, { role: s.role, chars: s.chars }])),
    evidence, edges, nodes, predictions, impact,
    weighting_model: {
      base: { historical: 0.2, recent: 0.6, breaking: 1.0 },
      multipliers: { uaeRelevance: 2, governmentSource: 2, officialStatement: 3, multiSource: 2 },
      windowBoost: win.boostFactor,
    },
    stats: {
      evidenceCount: evidence.length,
      edgeCount: edges.length,
      statedEdges: edges.filter(e => !e.inference).length,
      inferredEdges: edges.filter(e => e.inference).length,
      byVerification: Object.fromEntries(VERIFICATION_TIERS.map(t => [t, edges.filter(e => e.verification === t).length])),
      contradictions: edges.filter(e => e.contradiction).length,
      predictionItems: Object.values(predictions).reduce((a, c) => a + c.length, 0),
      emptyUpstream: evidence.length === 0,
      // hard-force data-fetch audit trail (2026-07-20): full attempt log with
      // per-attempt endpoint, count, accept/reject reason and latency.
      dataFetch: fetchRes ? {
        minRequired: MIN_DATA_POINTS,
        attempts: fetchRes.attempts,
        endpointUsed: fetchRes.endpointUsed,
        fallbackUsed: fetchRes.fallbackUsed,
        corpusBackfilled: fetchRes.corpusBackfilled,
        // adaptive smart-run audit (2026-07-21): per-pass counts + gate verdicts
        primaryCount: fetchRes.primaryCount ?? null,
        deltaAdded: fetchRes.deltaAdded ?? null,
        mergedCount: fetchRes.mergedCount ?? null,
        passes: fetchRes.passes ?? [],
      } : null,
      durationMs: Date.now() - nowTs,
    },
    stageLog,
  };
  stage('complete', { edges: edges.length, evidence: evidence.length });
  return run;
}

export { RESEARCH_WINDOWS, DEFAULT_WINDOW, VERIFICATION_TIERS, PREDICTION_CATEGORIES };
