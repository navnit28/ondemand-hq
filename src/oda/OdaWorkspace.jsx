// OdaWorkspace.jsx — the dedicated ODA workspace route (Phase 3 §1).
// Three-area layout: LEFT persistent sidebar (identity, composer, history,
// controls) · CENTRE adaptive live canvas (one renderer per active stage) ·
// RIGHT collapsible artifact rail. All state flows from useOdaRun (real SSE
// events only). The EXISTING suite home (executive brief + quick starts) is
// untouched — this mounts as a separate /oda route over it and 'Back to suite'
// returns without any state loss.
import React, { useCallback, useEffect, useState } from 'react';
import useOdaRun from './useOdaRun.js';
import OdaSidebar from './OdaSidebar.jsx';
import ArtifactRail from './ArtifactRail.jsx';
import Canvas from './Canvas.jsx';
import WidgetCard from './WidgetCard.jsx';
import { installDownloadDelegationListener, downloadFile } from './downloadFinalDoc.js';
import './oda.css';

export default function OdaWorkspace({ onExit }) {
  const { run, connected, start, attach, resolveGate, lifecycle, reset, fetchArtifact } = useOdaRun();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [controls, setControls] = useState({ lang: 'en', output: 'auto', depth: 'fast', brain: 'sonnet-5' });
  // ODA Live Widgets: one widget = one card = one task context (new task
  // NEVER reuses an old card — each entry is its own immutable prompt).
  const [widgets, setWidgets] = useState([]);

  // Run history (durable server list — refresh-safe).
  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch('/api/oda/runs');
      if (r.ok) setHistory((await r.json()).runs.map((x) => ({ runId: x.runId, intent: x.intent || '(interpreting…)', status: x.status, createdAt: x.createdAt })));
    } catch { /* offline tolerated */ }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory, run.status]);
  // Parent-side download delegation: when a nested frame posts
  // {action:'download', url} we open it from this (top-level) context so the
  // native save-to-disk fires even when the child sits in a download sandbox.
  useEffect(() => { installDownloadDelegationListener(); }, []);

  const onSubmit = useCallback(async ({ text, files = [] }) => {
    // Widget fast-path: 'widget:' prefix renders a live widget card in-canvas
    // (GLM 4.7 streamed assembly) instead of a full document run.
    if (/^widget\s*:/i.test(text)) {
      const prompt = text.replace(/^widget\s*:/i, '').trim();
      if (prompt) setWidgets((w) => [{ id: `w${Date.now()}`, prompt }, ...w]);
      return;
    }
    setBusy(true); setError(null);
    try {
      let finalText = text;
      const extras = [];
      if (controls.lang !== 'en') extras.push(`Language: ${controls.lang === 'ar' ? 'Arabic' : 'bilingual English and Arabic'}`);
      if (controls.output !== 'auto') extras.push(`Output: ${controls.output}`);
      if (controls.depth !== 'fast') extras.push('Depth: full engagement with approval gates');
      if (extras.length) finalText += ` — ${extras.join('; ')}`;
      await start({ text: finalText, attachments: files.map((f) => ({ name: f.name, size: f.size })), brain: controls.brain || 'sonnet-5' });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, [start, controls]);

  const onLifecycle = useCallback(async (op) => {
    setError(null);
    try { await lifecycle(op); } catch (e) { setError(e.message); }
  }, [lifecycle]);

  const onDownload = useCallback((a) => {
    // 2026-07-24: webview-safe — window.open is popup-blocked in the embedded
    // canvas; downloadFile probes then navigates same-frame to the attachment.
    if (a.url) downloadFile(a.url, { fallbackName: `${a.logicalId || 'artifact'}-v${a.version || 1}` });
  }, []);

  return (
    <div className="oda-ws">
      <OdaSidebar
        run={run}
        connected={connected}
        busy={busy}
        history={history}
        controls={controls}
        onControlsChange={setControls}
        onSubmit={onSubmit}
        onLifecycle={onLifecycle}
        onNewTask={() => { reset(); setError(null); }}
        onSelectRun={(id) => attach(id).catch((e) => setError(e.message))}
        onExit={onExit}
      />
      <div style={{ position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {error && <div className="oda-wserr">{error}</div>}
        {widgets.length > 0 && (
          <div style={{ padding: '18px 34px 0', display: 'grid', gap: 14 }}>
            {widgets.map((w) => (
              <WidgetCard key={w.id} prompt={w.prompt}
                onSendTask={(t) => onSubmit({ text: t })} />
            ))}
          </div>
        )}
        <Canvas run={run} resolveGate={resolveGate} fetchArtifact={fetchArtifact} />
      </div>
      <ArtifactRail
        run={run}
        collapsed={railCollapsed}
        onToggle={() => setRailCollapsed((c) => !c)}
        onDownload={onDownload}
        onPreview={() => { /* preview opens in-canvas via the document stage */ }}
      />
    </div>
  );
}
