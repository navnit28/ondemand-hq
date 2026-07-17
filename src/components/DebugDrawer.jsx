import React, { useEffect, useRef, useState } from 'react';
import { streamDebugBus } from '../api.js';
import ErrorBoundary from './ErrorBoundary.jsx';

/**
 * Stream debug drawer — observability for the /api/chat SSE passthrough.
 * GATED: rendered ONLY when the page URL carries ?debug=1 (or #debug=1) —
 * invisible to regular users. The feed shows
 * exclusively the REAL event frames tapped from streamChat via streamDebugBus.
 * Shows the raw event feed (color-tagged: thinking/tool/answer/status/metrics),
 * TTFT, tokens/sec, per-type counters, and a UTC clock.
 */

export function isDebugMode() {
  if (typeof window === 'undefined') return false;
  try {
    const qs = new URLSearchParams(window.location.search);
    return qs.get('debug') === '1' || window.location.hash.includes('debug=1');
  } catch { return false; }
}

/* ---------- color tags (real passthrough event types) ---------- */
const TYPE_CLASS = {
  planning_thinking: 'dbg-t-thinking',
  step_thinking: 'dbg-t-thinking',
  planning_output: 'dbg-t-plan',
  step_output: 'dbg-t-tool',
  fulfillment: 'dbg-t-answer',
  statusLog: 'dbg-t-status',
  metricsLog: 'dbg-t-metrics',
  routing: 'dbg-t-status',
  plugin_status: 'dbg-t-status',
  status: 'dbg-t-status',
  error: 'dbg-t-error',
  drop: 'dbg-t-error',
  done: 'dbg-t-quiet',
  '[DONE]': 'dbg-t-quiet',
  heartbeat: 'dbg-t-quiet',
  keepalive: 'dbg-t-quiet',
  open: 'dbg-t-quiet',
  close: 'dbg-t-quiet',
};
const typeClass = (t) => TYPE_CLASS[t] || 'dbg-t-quiet';
const feedTime = (iso) => (iso ? `${String(iso).slice(11, 23)}` : '—');

function freshRun() {
  return { openAt: null, firstDeltaAt: null, answerChars: 0, ttft: null, tps: null };
}

function DebugDrawerInner() {
  const [openDrawer, setOpenDrawer] = useState(false);
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState('');

  const rowsRef = useRef([]);       // ring buffer, last 300 events
  const seqRef = useRef(0);
  const framesRef = useRef(0);
  const countsRef = useRef({});
  const runRef = useRef(freshRun());
  const feedRef = useRef(null);

  useEffect(() => {
    const off = streamDebugBus.on((e) => {
      const now = Date.now();
      const run = runRef.current;
      if (e.kind === 'lifecycle' && e.type === 'open') runRef.current = { ...freshRun(), openAt: now };
      if (e.kind === 'frame') {
        framesRef.current += 1;
        countsRef.current[e.type] = (countsRef.current[e.type] || 0) + 1;
        const isDelta = ['planning_thinking', 'step_thinking', 'fulfillment', 'step_output', 'planning_output'].includes(e.type);
        if (isDelta && run.openAt && run.ttft == null) run.ttft = now - run.openAt;
        if (e.type === 'fulfillment' && e.chars) {
          run.answerChars += e.chars;
          const elapsed = (now - (run.openAt || now)) / 1000;
          if (elapsed > 0) run.tps = (run.answerChars / 4) / elapsed;
        }
      }
      const rows = rowsRef.current;
      rows.push({ seq: seqRef.current++, kind: e.kind, type: e.type, chars: e.chars, clientTs: e.clientTs, message: e.message });
      if (rows.length > 300) rows.splice(0, rows.length - 300);
      setTick(t => t + 1);
    });
    return off;
  }, []);

  useEffect(() => {
    const fmt = () => { const iso = new Date().toISOString(); return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`; };
    setClock(fmt());
    const id = setInterval(() => setClock(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (openDrawer && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [tick, openDrawer]);

  const run = runRef.current;
  const ttftLabel = run.ttft != null ? `${Math.round(run.ttft)} ms` : '—';
  const tpsLabel = run.tps != null ? run.tps.toFixed(1) : '—';
  const counts = countsRef.current;

  return (
    <aside className={`debug-drawer${openDrawer ? ' open' : ''}`} data-testid="debug-drawer">
      <div className="debug-drawer__header" onClick={() => setOpenDrawer(o => !o)}>
        <span className="debug-drawer__dot on" />
        <span className="debug-drawer__title">Stream debug</span>
        <span className="debug-drawer__counters">
          {framesRef.current} frames · TTFT <b data-testid="debug-ttft">{ttftLabel}</b> · <b data-testid="debug-tps">{tpsLabel}</b> tok/s
        </span>
        <span className="debug-drawer__clock" data-testid="debug-clock">{clock}</span>
        <span className={`debug-drawer__chev${openDrawer ? ' up' : ''}`} aria-hidden>▾</span>
      </div>

      {openDrawer && (
        <div className="debug-drawer__body">
          <div className="debug-drawer__controls">
            <div className="debug-drawer__chips">
              {Object.entries(counts).map(([t, n]) => (
                <span key={t} className={`dbg-chip ${typeClass(t)}`}>{t}:{n}</span>
              ))}
            </div>
          </div>

          <div className="debug-drawer__feed" data-testid="debug-feed" ref={feedRef}>
            {rowsRef.current.length === 0 && <div className="dbg-row dbg-t-quiet">— no stream events yet; send a message —</div>}
            {rowsRef.current.map(r => (
              <div key={r.seq} className={`dbg-row ${typeClass(r.type)}`}>
                <span className="dbg-row__ts">{feedTime(r.clientTs)}</span>
                <span className="dbg-row__tag">{r.kind === 'lifecycle' ? `⟂ ${r.type}` : r.type}</span>
                <span className="dbg-row__chars">{r.kind === 'frame' ? `${r.chars}ch` : (r.message || '')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

export default function DebugDrawer() {
  if (!isDebugMode()) return null; // hidden for regular users — ?debug=1 only
  return (
    <ErrorBoundary name="debug-drawer">
      <DebugDrawerInner />
    </ErrorBoundary>
  );
}
