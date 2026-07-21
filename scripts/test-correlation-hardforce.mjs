#!/usr/bin/env node
// test-correlation-hardforce.mjs — verification harness for the HARD-FORCE
// data-fetch layer (2026-07-20). Runs the extraction N times (default 4,
// sequential) against ONE pinned endpoint (cerebras default | fable) and
// verifies every run returns ≥ MIN_DATA_POINTS clean, deduped, EVEN-count
// data points delivered BY THE MODEL (corpus backfill counts as a FAIL for
// verification purposes). Appends results to CORRELATION_TESTS.md.
//
// Usage: node scripts/test-correlation-hardforce.mjs [--endpoint cerebras|fable] [--runs 4] [--iso KE] [--country Kenya]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hardForceDataPoints, buildExtractionMaterial, MIN_DATA_POINTS, TARGET_DATA_POINTS,
} from '../server/intelligence/dataFetch.js';
import {
  CEREBRAS_ENDPOINT_ID, CE_DATAFETCH_REASONING_EFFORT,
  FABLE_FALLBACK_ENDPOINT_ID, FABLE_FALLBACK_REASONING_EFFORT,
  ONDEMAND_API_KEY,
} from '../server/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---- args ----
const args = process.argv.slice(2);
const argOf = (flag, fb) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };
const endpointArg = String(argOf('--endpoint', 'cerebras')).toLowerCase();
const RUNS = Math.max(1, parseInt(argOf('--runs', '4'), 10) || 4);
const ISO = argOf('--iso', 'KE');
const COUNTRY = argOf('--country', 'Kenya');

if (!ONDEMAND_API_KEY) {
  console.error('[harness] ONDEMAND_API_KEY / ON_DEMAND_API_KEY is not set — cannot run live verification.');
  process.exit(2);
}

const LADDERS = {
  cerebras: [{ endpointId: CEREBRAS_ENDPOINT_ID, effort: CE_DATAFETCH_REASONING_EFFORT, label: 'cerebras-glm-4.7' }],
  fable: [{ endpointId: FABLE_FALLBACK_ENDPOINT_ID, effort: FABLE_FALLBACK_REASONING_EFFORT, label: 'fable-5-medium' }],
};
const ladder = LADDERS[endpointArg];
if (!ladder) { console.error(`[harness] unknown --endpoint '${endpointArg}' (cerebras|fable)`); process.exit(2); }
const label = ladder[0].label;

const material = buildExtractionMaterial({ iso: ISO, countryName: COUNTRY });
console.log(`[harness] endpoint=${label} runs=${RUNS} iso=${ISO} country=${COUNTRY} material=${material.length} chars min=${MIN_DATA_POINTS} target=${TARGET_DATA_POINTS}`);

const runs = [];
for (let i = 1; i <= RUNS; i++) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let rec;
  try {
    const res = await hardForceDataPoints({
      iso: ISO, countryName: COUNTRY, phrase: 'the last 2 years',
      material, sessionTag: `ce-test-r${i}`, endpointLadder: ladder,
      onAttempt: (a) => console.log(`[harness] run ${i} attempt ${a.attempt} mode=${a.mode} valid=${a.validCount} accepted=${a.accepted}${a.rejectedReason ? ' reason=' + a.rejectedReason : ''}${a.error ? ' error=' + a.error : ''} latency=${a.latencyMs}ms`),
    });
    const latencyMs = Date.now() - t0;
    const count = res.dataPoints.length;
    const even = count % 2 === 0;
    const acceptedAttempt = res.attempts.find(a => a.accepted);
    const modelAccepted = acceptedAttempt ? acceptedAttempt.validCount
      : Math.max(0, ...res.attempts.map(a => a.validCount || 0));
    const pass = count >= MIN_DATA_POINTS && even && res.corpusBackfilled === 0;
    rec = {
      run: i, startedAt, endpoint: label, dataPoints: count, evenCheck: even,
      modelAcceptedCount: modelAccepted, attemptsUsed: res.attempts.length,
      corpusBackfilled: res.corpusBackfilled, latencyMs, pass,
    };
  } catch (e) {
    rec = {
      run: i, startedAt, endpoint: label, dataPoints: 0, evenCheck: false,
      modelAcceptedCount: 0, attemptsUsed: 0, corpusBackfilled: 0,
      latencyMs: Date.now() - t0, pass: false, error: String(e?.message || e).slice(0, 300),
    };
  }
  runs.push(rec);
  console.log(`[harness] RUN ${i}: ${rec.pass ? 'PASS' : 'FAIL'} — ${rec.dataPoints} data points (even=${rec.evenCheck}, model=${rec.modelAcceptedCount}, backfill=${rec.corpusBackfilled}) in ${rec.latencyMs}ms${rec.error ? ' error=' + rec.error : ''}`);
}

const allPassed = runs.every(r => r.pass);
console.log(JSON.stringify({ harness: 'correlation-hardforce', endpoint: label, runs, allPassed }));

// ---- human-readable table ----
console.log('\n| Run | Timestamp (UTC) | Endpoint | Attempts | Data points | Even | Model | Backfill | Latency (ms) | Result |');
for (const r of runs) {
  console.log(`| ${r.run} | ${r.startedAt} | ${r.endpoint} | ${r.attemptsUsed} | ${r.dataPoints} | ${r.evenCheck ? 'yes' : 'no'} | ${r.modelAcceptedCount} | ${r.corpusBackfilled} | ${r.latencyMs} | ${r.pass ? 'PASS' : 'FAIL'} |`);
}

// ---- append to CORRELATION_TESTS.md ----
const logPath = path.join(ROOT, 'CORRELATION_TESTS.md');
if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '# Correlation Engine Hard-Force Test Log\n');
const lines = [
  `\n## Test session ${new Date().toISOString()} — endpoint ${label}`,
  '',
  `Hard-force policy: strict minimum ${MIN_DATA_POINTS}+ data points per run · below-minimum responses rejected + retried · no odd/partial batches · target ${TARGET_DATA_POINTS}.`,
  '',
  '| Run | Timestamp (UTC) | Endpoint | Attempts | Data points | Even batch | Model-delivered | Corpus backfill | Latency (ms) | Result |',
  '|-----|-----------------|----------|----------|-------------|------------|-----------------|-----------------|--------------|--------|',
  ...runs.map(r => `| ${r.run} | ${r.startedAt} | ${r.endpoint} | ${r.attemptsUsed} | ${r.dataPoints} | ${r.evenCheck ? '✅ even' : '❌ odd'} | ${r.modelAcceptedCount} | ${r.corpusBackfilled} | ${r.latencyMs} | ${r.pass ? '✅ PASS' : '❌ FAIL'} |${r.error ? ` <!-- ${r.error} -->` : ''}`),
  '',
  allPassed
    ? `**Verdict: ALL ${RUNS} RUNS PASSED — ${label} consistently returned ${MIN_DATA_POINTS}+ clean data points per run.**`
    : `**Verdict: ${runs.filter(r => r.pass).length}/${RUNS} runs passed on ${label} — quality/quantity insufficient, fallback required.**`,
];
fs.appendFileSync(logPath, lines.join('\n') + '\n');
console.log(`[harness] results appended to ${logPath}`);
process.exit(allPassed ? 0 : 1);
