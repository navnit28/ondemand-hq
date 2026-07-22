// oda-recorrelate.mjs — ODA BILATERAL RE-CORRELATION JOB (2026-07-22).
//
// Re-runs the CORRECTED correlation (buildOdaCorrelationPrompt on Fable 5 MAX +
// grounding injection + ensureCrossClusterEdges backstop) over every seeded
// country, producing a NEW versioned seed run per country — the previous run
// files are PRESERVED untouched (additive, no destructive overwrite; the UI date
// scrubber keeps all versions).
//
// Designed to run as PARALLEL SUB-AGENT PROCESSES: launch N processes with
// --only ISO,ISO,... splits (each process is one sub-agent working its share).
//
// Usage: ONDEMAND_API_KEY=... node scripts/oda-recorrelate.mjs [--concurrency N] [--only ISO,ISO]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOdSession, syncQuery } from '../server/ondemand.js';
import { CE_ANALYSIS_ENDPOINT_ID, CE_ANALYSIS_REASONING_EFFORT } from '../server/env.js';
import { UAE_REGISTRY, RELATIONSHIP_TYPES } from '../server/correlation.js';
import { COUNTRIES } from '../server/intel.js';
import { edgeWeightFromEvidence } from '../server/intelligence/weighting.js';
import { assignVerification } from '../server/intelligence/correlationLayer.js';
import { EDGE_STYLE } from '../server/intelligence/deepPipeline.js';
import {
  buildOdaCorrelationPrompt, injectGroundingEvidence, ensureCrossClusterEdges,
  ODA_CATEGORY_IDS, ODA_EDGE_CATEGORIES,
} from '../server/intelligence/odaCorrelation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_ROOT = path.join(__dirname, '..', 'server', 'data', 'correlation-seed');

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CONCURRENCY = Math.max(1, parseInt(argVal('--concurrency', '2'), 10) || 2);
const ONLY = (argVal('--only', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const WORKER = argVal('--worker', 'w0');

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

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const CAT_TYPE = Object.fromEntries(ODA_EDGE_CATEGORIES.map(c => [c.id, c.relationship_type]));

function newestRunFile(iso) {
  const d = path.join(SEED_ROOT, iso);
  const files = fs.readdirSync(d).filter(f => /^run-.*\.json$/i.test(f)).sort();
  return files.length ? path.join(d, files[files.length - 1]) : null;
}

async function recorrelate(c) {
  const t0 = Date.now();
  const prevFile = newestRunFile(c.iso);
  if (!prevFile) return { iso: c.iso, error: 'no seed run to build on' };
  const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));

  // ---- PRESERVE + ADD: start from the previous run's evidence, inject grounding ----
  const inj = injectGroundingEvidence(c.iso, prev.evidence.map(e => ({ ...e })));
  const evidence = inj.evidence;
  const evidenceById = new Map(evidence.map(v => [v.id, v]));
  const evList = evidence.map(v => `${v.id}: [${v.source_type}/${v.source}${v.publish_date ? '/' + v.publish_date : ''}] ${v.claim}`).join('\n').slice(0, 100000);

  // ---- Fable 5 MAX pass with the corrected ODA correlation prompt ----
  const sid = await createOdSession(`oda-recorr-${c.iso}-${WORKER}`, []);
  const raw = await syncQuery({
    odSessionId: sid,
    endpointId: CE_ANALYSIS_ENDPOINT_ID, reasoningEffort: CE_ANALYSIS_REASONING_EFFORT, // Fable 5 MAX
    systemPrompt: 'ODA bilateral correlation engine. ONE valid JSON array only. Every edge cites evidence ids from the material or carries gap:true — never invent a number, name, official, or connection. Cross-cluster UAE↔country edges are MANDATORY.',
    query: buildOdaCorrelationPrompt({ countryName: c.name, iso: c.iso, registry: UAE_REGISTRY, relationshipTypes: RELATIONSHIP_TYPES, evList }),
  });
  const parsed = extractJson(raw);
  const modelEdges = Array.isArray(parsed) ? parsed : [];

  // ---- Gate: evidence-or-gap (mirror of deepPipeline gate) ----
  const gated = modelEdges.map(e => {
    const ids = [...new Set((e.evidence_record_ids || []).filter(id => evidenceById.has(id)))];
    if (!ids.length && !e.gap) return null;
    const rt = RELATIONSHIP_TYPES.includes(e.relationship_type)
      ? e.relationship_type
      : (CAT_TYPE[e.oda_category] || 'Diplomatic');
    return {
      ...e, entity_a: slug(e.entity_a), entity_b: slug(e.entity_b),
      relationship_type: rt, evidence_record_ids: ids,
      inference: !!e.inference || !!e.gap, gap: !!e.gap,
      oda_category: ODA_CATEGORY_IDS.includes(e.oda_category) ? e.oda_category : null,
      confidence: e.gap ? Math.min(0.2, e.confidence ?? 0.1) : e.confidence,
    };
  }).filter(e => e && e.entity_a && e.entity_b && e.entity_a !== e.entity_b);

  // ---- Merge with previous edges (dedupe by pair+type; new ODA edges win) ----
  const seen = new Set(gated.map(e => `${[e.entity_a, e.entity_b].sort().join('~')}|${e.relationship_type}`));
  const kept = (prev.edges || []).filter(e => !seen.has(`${[e.entity_a, e.entity_b].sort().join('~')}|${e.relationship_type}`));
  let edges = [...gated, ...kept];

  // ---- Deterministic backstop: cross-cluster guarantee ----
  const backstop = ensureCrossClusterEdges({ iso: c.iso, countryName: c.name, edges, evidence, registry: UAE_REGISTRY });
  edges = backstop.edges;

  // ---- Recompute weights/verification/styles; renumber ----
  edges = edges.map((e, i) => {
    const evs = (e.evidence_record_ids || []).map(id => evidenceById.get(id)).filter(Boolean);
    const { rawWeight, weight } = edgeWeightFromEvidence(evs);
    const confidence = +(Math.max(0, Math.min(1, e.confidence ?? 0.5))).toFixed(3);
    const verification = e.gap ? 'Predicted' : (e.verification || assignVerification({ ...e, confidence }, evs));
    return {
      ...e, id: `ED${i + 1}`, confidence, verification,
      style: EDGE_STYLE[verification] || EDGE_STYLE.Possible,
      weight: e.weight ?? weight, rawWeight: e.rawWeight ?? rawWeight,
      stance: e.stance || 'neutral',
      sourceTypes: e.sourceTypes || [...new Set(evs.map(v => v.source_type))],
      dimension: e.dimension || e.oda_category || null,
    };
  });

  // ---- Node completion ----
  const nodes = prev.nodes.map(n => ({ ...n }));
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const e of edges) for (const id of [e.entity_a, e.entity_b]) {
    if (!nodeIds.has(id)) {
      nodeIds.add(id);
      nodes.push({ id, label: id.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()), fullName: id, kind: 'country-side' });
    }
  }

  // ---- NEW versioned run (previous file untouched) ----
  const now = new Date();
  const runId = `${c.iso}-${now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '')}`;
  const ctry = c.iso.toLowerCase();
  const uaeIds = new Set(UAE_REGISTRY.map(r => r.id));
  const crossEdges = edges.filter(e => (e.entity_a === ctry && uaeIds.has(e.entity_b)) || (e.entity_b === ctry && uaeIds.has(e.entity_a)));
  const run = {
    ...prev,
    runId, generated_at: now.toISOString(),
    evidence, edges, nodes,
    model: { ...(prev.model || {}), selected: 'Fable 5 MAX', analysis: 'Fable 5 MAX', all: `${CE_ANALYSIS_ENDPOINT_ID}+${CE_ANALYSIS_REASONING_EFFORT}` },
    stats: {
      ...(prev.stats || {}),
      evidenceCount: evidence.length, edgeCount: edges.length,
      statedEdges: edges.filter(e => !e.inference).length,
      inferredEdges: edges.filter(e => e.inference).length,
      crossClusterEdges: crossEdges.length,
      gapEdges: edges.filter(e => e.gap).length,
      backstopAdded: backstop.added,
    },
    odaRecorrelation: {
      job: 'oda-recorrelate', worker: WORKER, at: now.toISOString(),
      model: 'Fable 5 MAX', modelEdges: gated.length, groundingInjected: inj.injected,
      basedOnRun: prev.runId,
    },
    diffFromPrevious: null, // recomputed by server diff route when listed
  };
  const outFile = path.join(SEED_ROOT, c.iso, `run-${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(run, null, 1));
  const byCat = {};
  for (const e of crossEdges) byCat[e.oda_category || 'untyped'] = (byCat[e.oda_category || 'untyped'] || 0) + 1;
  return { iso: c.iso, runId, total: edges.length, cross: crossEdges.length, gap: run.stats.gapEdges, modelEdges: gated.length, byCat, ms: Date.now() - t0 };
}

const targets = COUNTRIES.filter(c => !ONLY.length || ONLY.includes(c.iso));
console.log(`[recorr:${WORKER}] targets=${targets.map(c => c.iso).join(',')} concurrency=${CONCURRENCY}`);
const queue = [...targets];
const results = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const c = queue.shift();
    if (!c) return;
    try {
      const r = await recorrelate(c);
      results.push(r);
      if (r.error) console.error(`[recorr:${WORKER}] FAIL ${r.iso}: ${r.error}`);
      else console.log(`[recorr:${WORKER}] OK ${r.iso} run=${r.runId} total=${r.total} CROSS=${r.cross} gap=${r.gap} model=${r.modelEdges} cats=${JSON.stringify(r.byCat)} in ${(r.ms / 1000).toFixed(1)}s`);
    } catch (e) {
      results.push({ iso: c.iso, error: String(e?.message || e).slice(0, 180) });
      console.error(`[recorr:${WORKER}] FAIL ${c.iso}: ${String(e?.message || e).slice(0, 180)}`);
    }
  }
}));
const bad = results.filter(r => r.error);
console.log(`[recorr:${WORKER}] done: ${results.length - bad.length} ok, ${bad.length} failed${bad.length ? ' -> ' + bad.map(b => b.iso).join(',') : ''}`);
process.exit(bad.length ? 1 : 0);
