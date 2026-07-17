import React, { useEffect, useState } from 'react';

/**
 * STEP 2 — Real tool-activity UI.
 * While a tool runs: shimmer placeholder → transitions into a compact activity
 * card with tool name, purpose, status, elapsed time, completion state, result
 * summary. Two modes:
 *   Standard — clean human progress
 *   Debug    — exact plugin ids, timings, model, request ids, event details
 * Secrets/system prompts never appear (backend redacts; debug carries ids only).
 */
function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function LiveElapsed({ startedAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const ms = Math.max(0, now - new Date(startedAt).getTime());
  return <span className="tool__elapsed">{fmtMs(ms)}</span>;
}

export function ToolActivityCard({ act, debugMode }) {
  const running = act.status === 'running';
  return (
    <div className={`tool${running ? ' running' : act.status === 'failed' ? ' failed' : ' done'}`}>
      {running && <span className="tool__shimmer" aria-hidden="true" />}
      <div className="tool__row">
        <span className={`tool__dot ${act.status}`} aria-hidden="true" />
        <span className="tool__name">{act.tool}</span>
        <span className="tool__purpose">{act.purpose}</span>
        <span style={{ flex: 1 }} />
        {running
          ? <LiveElapsed startedAt={act.startedAt} />
          : <span className="tool__elapsed">{fmtMs(act.elapsedMs)}</span>}
        <span className={`tool__state ${act.status}`}>
          {running ? 'working' : act.status === 'failed' ? 'failed' : 'done'}
        </span>
      </div>
      {!running && act.summary && <div className="tool__summary">{act.summary}</div>}
      {debugMode && act.debug && (
        <div className="tool__debug">
          {Object.entries(act.debug).map(([k, v]) => (
            v != null && <span key={k} className="tool__kv"><b>{k}</b> {typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Task phase card — artifact pipeline (Queued→…→Complete/Failed/Retrying). */
const TASK_PHASES = ['Queued', 'Planning', 'Generating', 'Rendering', 'Validating', 'Complete'];
export function TaskPhaseCard({ task, debugMode }) {
  const idx = TASK_PHASES.indexOf(task.phase);
  const failed = task.phase === 'Failed';
  const retrying = task.phase === 'Retrying';
  return (
    <div className={`taskcard${failed ? ' failed' : ''}`}>
      <div className="taskcard__head">
        <span className="taskcard__fmt">{(task.format || '').toUpperCase()}</span>
        <span className="taskcard__tool">{task.tool}</span>
        <span style={{ flex: 1 }} />
        <span className={`taskcard__phase${failed ? ' failed' : ''}${retrying ? ' retry' : ''}`}>{task.phase}</span>
      </div>
      <div className="taskcard__bar" role="progressbar" aria-valuemin={0} aria-valuemax={TASK_PHASES.length - 1}
        aria-valuenow={idx >= 0 ? idx : 0} aria-label={`Artifact ${task.phase}`}>
        {TASK_PHASES.map((p, i) => (
          <span key={p} className={`taskcard__seg${idx >= i && !failed ? ' on' : ''}${retrying && i === idx ? ' retry' : ''}`} title={p} />
        ))}
      </div>
      {failed && <div className="taskcard__err">{task.userMessage || 'Generation failed.'}{task.errorCode ? ` [${task.errorCode}]` : ''}</div>}
      {debugMode && (
        <div className="tool__debug">
          <span className="tool__kv"><b>taskId</b> {task.taskId}</span>
          {task.detail && <span className="tool__kv"><b>detail</b> {task.detail}</span>}
          {task.url && <span className="tool__kv"><b>url</b> {task.url}</span>}
          {task.artifactId && <span className="tool__kv"><b>artifactId</b> {task.artifactId}</span>}
        </div>
      )}
    </div>
  );
}
