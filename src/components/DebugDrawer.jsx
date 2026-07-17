import React, { useEffect, useRef, useState } from 'react';
import { streamDebugBus } from '../api.js';
import ErrorBoundary from './ErrorBoundary.jsx';

/**
 * Stream debug drawer — observability for the /api/chat SSE pipeline.
 * Subscribes to streamDebugBus (tapped inside api.js streamChat BEFORE onEvent)
 * so it never alters the app's stream semantics. Shows a live frame feed,
 * TTFT / tokens-per-second metrics for the current run, per-type counters,
 * and a UTC clock.
 */

/* ---------- shared enabled state (drawer header toggle + footer toggle) ---------- */
const enabledListeners = new Set();
export function setStreamDebugEnabled(v) {
  streamDebugBus.setEnabled(v);
  for (const fn of enabledListeners) fn(v);
}
export function useStreamDebugEnabled() {
  const [enabled, setLocal] = useState(streamDebugBus.enabled);
  useEffect(() => {
    const fn = (v) => setLocal(v);
    enabledListeners.add(fn);
    return () => enabledListeners.delete(fn);
  }, []);
  return [enabled, setStreamDebugEnabled];
}

/* ---------- helpers ---------- */
const TYPE_CLASS = {
  thinking: 'dbg-t-thinking',
  answer: 'dbg-t-answer',
  status: 'dbg-t-status',
  plugin_status: 'dbg-t-status',
  routing: 'dbg-t-status',
  metrics: 'dbg-t-metrics',
  error: 'dbg-t-error',
  drop: 'dbg-t-error',
  keepalive: 'dbg-t-quiet',
  open: 'dbg-t-quiet',
  close: 'dbg-t-quiet',
};
const typeClass = (t) => TYPE_CLASS[t] || 'dbg-t-quiet';
const feedTime = (iso) => (iso ? `${String(iso).slice(11, 23)}` : '—');

/* ---------- debug-UI gate: visible ONLY with ?debug=1 (or VITE_DEBUG_UI=1 build flag) ---------- */
export const DEBUG_UI_ENABLED = (() => {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1') return true;
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_UI === '1') return true;
  } catch { /* SSR / no location */ }
  return false;
})();

/* ---------- footer (mounted at the bottom of the main column) ---------- */
export function DebugFooter() {
  const [enabled, setEnabled] = useStreamDebugEnabled();
  if (!DEBUG_UI_ENABLED) {
    return (
      <footer className="app-footer">
        <span className="app-footer__brand">ODA Productivity Suite</span>
      </footer>
    );
  }
  return (
    <footer className="app-footer">
      <span className="app-footer__brand">ODA Productivity Suite</span>
      <label className="dbg-switch-label">
        <span>Stream debug</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="footer-debug-toggle"
          className={`dbg-switch${enabled ? ' on' : ''}`}
          onClick={() => setEnabled(!enabled)}
        >
          <span className="dbg-switch__knob" />
        </button>
      </label>
    </footer>
  );
}

/* ---------- the drawer ---------- */
function freshRun() {
  return { openAt: null, firstDeltaAt: null, firstAnswerAt: null, answerChars: 0, ttft: null, tps: null };
}

function DebugDrawerInner() {
  const [enabled, setEnabled] = useStreamDebugEnabled();
  const [openDrawer, setOpenDrawer] = useState(false);
  const [tick, setTick] = useState(0);           // re-render pump for ref-held feed/metrics
  const [clock, setClock] = useState('');

  const rowsRef = useRef([]);                    // ring buffer, last 300 events
  const seqRef = useRef(0);
  const runRef = useRef(freshRun());             // current-run metric accumulators
  const countsRef = useRef({});                  // per-type counts (current run)
  const framesRef = useRef(0);                   // total frames (current run)
  const feedRef = useRef(null);

  /* subscribe to the bus */
  useEffect(() => {
    const off = streamDebugBus.on((e) => {
      const now = Date.now();
      if (e.kind === 'lifecycle' && e.type === 'open') {
        runRef.current = { ...freshRun(), openAt: now };
        countsRef.current = {};
        framesRef.current = 0;
      } else if (e.kind === 'frame') {
        const run = runRef.current;
        framesRef.current += 1;
        countsRef.current[e.type] = (countsRef.current[e.type] || 0) + 1;
        if ((e.type === 'thinking' || e.type === 'answer') && run.openAt && run.ttft == null) {
          run.ttft = now - run.openAt;
        }
        if (e.type === 'answer') {
          if (run.firstAnswerAt == null) run.firstAnswerAt = now;
          run.answerChars += e.chars || 0;
          const elapsed = Math.max(now - run.firstAnswerAt, 1) / 1000;
          run.tps = (run.answerChars / 4) / elapsed;
        }
      }
      const rows = rowsRef.current;
      rows.push({ seq: seqRef.current++, kind: e.kind, type: e.type, chars: e.chars, clientTs: e.clientTs, message: e.message });
      if (rows.length > 300) rows.splice(0, rows.length - 300);
      setTick(t => t + 1);
    });
    return off;
  }, []);

  /* UTC clock, 1s cadence — 'YYYY-MM-DD HH:MM:SSZ' */
  useEffect(() => {
    const fmt = () => { const iso = new Date().toISOString(); return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`; };
    setClock(fmt());
    const id = setInterval(() => setClock(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  /* keep feed pinned to the latest row */
  useEffect(() => {
    if (openDrawer && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [tick, openDrawer]);

  if (!enabled) return null;                     // footer toggle re-enables

  const run = runRef.current;
  const ttftLabel = run.ttft != null ? `${Math.round(run.ttft)} ms` : '—';
  const tpsLabel = run.tps != null ? run.tps.toFixed(1) : '—';
  const counts = countsRef.current;

  return (
    <aside className={`debug-drawer${openDrawer ? ' open' : ''}`} data-testid="debug-drawer">
      <div className="debug-drawer__header" onClick={() => setOpenDrawer(o => !o)}>
        <span className={`debug-drawer__dot${enabled ? ' on' : ''}`} />
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
            <label className="dbg-switch-label">
              <span>Capture</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                data-testid="debug-toggle"
                className={`dbg-switch${enabled ? ' on' : ''}`}
                onClick={() => setEnabled(!enabled)}
              >
                <span className="dbg-switch__knob" />
              </button>
            </label>
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
  if (!DEBUG_UI_ENABLED) return null;            // hard gate: never rendered for regular users
  return (
    <ErrorBoundary name="debug-drawer">
      <DebugDrawerInner />
    </ErrorBoundary>
  );
}
