import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, GitMerge, Database, Zap } from 'lucide-react';

/**
 * RunOpsPanel — Palantir-style engine-run operations strip (2026-07-21 overhaul).
 * Surfaces the adaptive smart-run audit trail from run.stats.dataFetch:
 *   • PRIMARY pass (fable-5) — count + gate verdict
 *   • FALLBACK Δ pass (fable-5-medium, delta prompt) — records added
 *   • MERGE — final deduped dataset size vs the ≥100 quality gate
 *   • BACKFILL — corpus top-up count (last resort), if any
 * plus a collapsible monospace attempt log (endpoint, mode, valid, latency).
 * Renders nothing for legacy runs without dataFetch stats.
 */
const EP_LABELS = [
  [/kimi/i, 'KIMI-K3·MED'],
  [/byoi|cerebras|glm/i, 'QUICK·ONLY'],  // Cerebras never appears in CE runs (2026-07-21 v3) — legacy runs only
  [/fable/i, 'FABLE-5·MED'],
  [/sonnet/i, 'SONNET-5'],
];
const epLabel = (id) => {
  for (const [re, label] of EP_LABELS) if (re.test(String(id || ''))) return label;
  return String(id || 'unknown').slice(0, 22).toUpperCase();
};

function Led({ state }) {
  // state: 'pass' | 'short' | 'skip' | 'live'
  return <i className={`rop-led rop-led--${state}`} aria-hidden />;
}

export default function RunOpsPanel({ run }) {
  const [logOpen, setLogOpen] = useState(false);
  const df = run?.stats?.dataFetch;
  if (!df) return null;

  const min = df.minRequired ?? 100;
  const finalCount = run?.stats?.evidenceCount ?? df.mergedCount ?? 0;
  const gatePass = finalCount >= min;
  const passes = Array.isArray(df.passes) ? df.passes : [];
  const primary = passes.find(p => p.pass === 'primary');
  const fallback = passes.find(p => p.pass === 'fallback-delta');
  const backfill = passes.find(p => p.pass === 'corpus-backfill');
  const attempts = Array.isArray(df.attempts) ? df.attempts : [];

  return (
    <div className="rop" data-testid="ce-runops" role="group" aria-label="Engine run operations">
      <div className="rop-row">
        <span className="rop-title"><Cpu size={11} aria-hidden /> RUN OPS</span>

        <span className={`rop-stage${primary ? '' : ' rop-stage--na'}`} title="Primary pass — fable-5 smart run (Cerebras-free backend)">
          <Led state={primary ? (primary.gate === 'pass' ? 'pass' : 'short') : 'skip'} />
          <b>PRIMARY</b>
          <code>{epLabel(primary?.endpointId ?? df.endpointUsed)}</code>
          <code className="rop-n">{df.primaryCount ?? primary?.count ?? '—'}</code>
        </span>

        <span className="rop-arrow" aria-hidden>→</span>

        <span className={`rop-stage${df.fallbackUsed ? '' : ' rop-stage--na'}`} title="Fallback pass — fable-5-medium, delta prompt (already-captured claims excluded)">
          <Led state={df.fallbackUsed ? (fallback?.gate === 'pass' ? 'pass' : 'short') : 'skip'} />
          <b>FALLBACK·Δ</b>
          {df.fallbackUsed
            ? <><code>{epLabel(fallback?.endpointId)}</code><code className="rop-n">+{df.deltaAdded ?? fallback?.count ?? 0}</code></>
            : <code className="rop-muted">not needed</code>}
        </span>

        <span className="rop-arrow" aria-hidden>→</span>

        <span className="rop-stage" title="Merged dataset — passes deduped by claim; latest correlation always present">
          <Led state={gatePass ? 'pass' : 'short'} />
          <GitMerge size={11} aria-hidden />
          <b>MERGE</b>
          <code className="rop-n">{finalCount}</code>
          <span className={`rop-gate${gatePass ? '' : ' rop-gate--fail'}`}>{gatePass ? `≥${min} PASS` : `<${min} FAIL`}</span>
        </span>

        {(df.corpusBackfilled ?? 0) > 0 && (
          <>
            <span className="rop-arrow" aria-hidden>→</span>
            <span className="rop-stage" title="Last-resort corpus backfill (real on-disk evidence, never simulated)">
              <Led state="short" />
              <Database size={11} aria-hidden />
              <b>BACKFILL</b>
              <code className="rop-n">+{df.corpusBackfilled ?? backfill?.count ?? 0}</code>
            </span>
          </>
        )}

        {df.backgroundBackfill && (
          <>
            <span className="rop-arrow" aria-hidden>→</span>
            <span className="rop-stage" title="Server-side Fable background delta backfill — merges automatically, UI refreshes itself">
              <Led state={df.backgroundBackfill.status === 'done' ? 'pass' : (df.backgroundBackfill.status === 'running' ? 'live' : 'short')} />
              <b>BG·FABLE·Δ</b>
              <code className="rop-n">{df.backgroundBackfill.status === 'done' ? `+${df.backgroundBackfill.added ?? 0}` : df.backgroundBackfill.status}</code>
            </span>
          </>
        )}

        <button className="rop-logbtn" onClick={() => setLogOpen(o => !o)} aria-expanded={logOpen}>
          {logOpen ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
          {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
        </button>
      </div>

      {logOpen && attempts.length > 0 && (
        <table className="rop-log" aria-label="Data-fetch attempt log">
          <thead>
            <tr><th>#</th><th>endpoint</th><th>mode</th><th>valid</th><th>verdict</th><th>latency</th></tr>
          </thead>
          <tbody>
            {attempts.map(a => (
              <tr key={a.attempt} className={a.accepted ? 'rop-log--ok' : 'rop-log--rej'}>
                <td>{a.attempt}</td>
                <td>{epLabel(a.endpointId)}</td>
                <td>{a.mode}</td>
                <td>{a.validCount}</td>
                <td>{a.error ? `ERR ${String(a.error).slice(0, 48)}` : (a.accepted ? 'ACCEPTED' : (a.rejectedReason || 'rejected'))}</td>
                <td>{typeof a.latencyMs === 'number' ? `${(a.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * LiveRunStrip — status indicator while the engine is running (job active).
 * Shows stage progression with a live LED; datafetch attempts stream in via
 * the job's stage log where available.
 */
export function LiveRunStrip({ job, countryName }) {
  if (!job) return null;
  return (
    <div className="rop rop--live" role="status" data-testid="ce-live-strip">
      <div className="rop-row">
        <span className="rop-title"><Zap size={11} aria-hidden /> ENGINE RUN</span>
        <span className="rop-stage"><Led state="live" /><b>{countryName?.toUpperCase()}</b></span>
        <span className="rop-arrow" aria-hidden>·</span>
        <span className="rop-stage"><code>stage: {job.stage || 'starting'}</code></span>
        {job.startedAt && <span className="rop-stage"><code className="rop-muted">t0 {new Date(job.startedAt).toISOString().slice(11, 19)}Z</code></span>}
        <span className="rop-stage"><code className="rop-muted">fable-primary · fable-Δ-bg · cerebras-free backend</code></span>
      </div>
    </div>
  );
}
