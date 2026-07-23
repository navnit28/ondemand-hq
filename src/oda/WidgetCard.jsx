// WidgetCard.jsx — the ODA Live Widget renderer card (universal workspace).
// Contract: card appears immediately with a pulsing brand dot + rotating
// loading messages (REAL model-supplied messages; rotation is a UI affordance
// over the real stream, not fake progress — the card completes only on the
// real widget.done frame). Code assembles visibly as chunks arrive; scripts
// execute ONLY after the stream completes, inside a sandboxed iframe carrying
// the full design-token sheet (light + dark via matchMedia). One widget = one
// card = one task context. Hover toolbar: download · copy · re-run.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, RotateCcw } from 'lucide-react';

/** Design tokens injected into every widget iframe — flip in dark mode. */
const TOKEN_SHEET = `
:root{
  --surface-0:#FFFFFF; --surface-1:#F7F4EC; --surface-2:#FCFBF7;
  --bg-accent:#0F6E5A; --bg-danger:#8C2F23; --bg-success:#2F6E43; --bg-warning:#8A6A1F;
  --text-primary:#1D252C; --text-secondary:#5B6770; --text-muted:#8C96A0;
  --text-accent:#0F6E5A; --text-danger:#8C2F23; --text-success:#2F6E43; --text-warning:#8A6A1F;
  --border:rgba(29,37,44,.14); --border-strong:rgba(29,37,44,.32);
  --font-sans:'Montserrat',system-ui,sans-serif; --font-voice:'Lora',Georgia,serif; --font-mono:ui-monospace,Menlo,monospace;
  --radius:8px; --radius-card:12px;
}
@media (prefers-color-scheme: dark){
  :root{
    --surface-0:#12181C; --surface-1:#1A2228; --surface-2:#1F282F;
    --bg-accent:#1DAC89; --bg-danger:#C0564A; --bg-success:#4E9B68; --bg-warning:#C29A45;
    --text-primary:#EDF1F2; --text-secondary:#AEB9C0; --text-muted:#77828B;
    --text-accent:#3FC6A3; --text-danger:#E08A80; --text-success:#7CC495; --text-warning:#D9B96C;
    --border:rgba(237,241,242,.14); --border-strong:rgba(237,241,242,.32);
  }
}
html,body{margin:0;padding:0;background:transparent;color:var(--text-primary);font:400 16px/1.7 var(--font-sans)}
h1{font-size:22px;font-weight:500}h2{font-size:18px;font-weight:500}h3{font-size:16px;font-weight:500}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

/** Host bridge API — injected globals (contract: never redefined by widgets). */
const BRIDGE_SNIPPET = `
window.sendTask = function(text){ parent.postMessage({ odaBridge:'sendTask', text:String(text||'') }, '*') };
window.liveQuery = function(source, params, cb){ parent.postMessage({ odaBridge:'liveQuery', source:source, params:params }, '*'); if (typeof cb==='function') cb(null); };
window.refresh = function(){ parent.postMessage({ odaBridge:'refresh' }, '*') };
window.openLink = function(url){ parent.postMessage({ odaBridge:'openLink', url:String(url||'') }, '*') };
`;

export default function WidgetCard({ prompt, onSendTask, onDone }) {
  const [phase, setPhase] = useState('loading'); // loading | streaming | done | error
  const [meta, setMeta] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [msgIdx, setMsgIdx] = useState(0);
  const [runKey, setRunKey] = useState(0);
  const iframeRef = useRef(null);
  const abortRef = useRef(null);

  // Rotate the model-supplied loading messages while the REAL stream runs.
  useEffect(() => {
    if (phase !== 'loading' && phase !== 'streaming') return undefined;
    const msgs = meta?.loadingMessages || [];
    if (msgs.length < 2) return undefined;
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % msgs.length), 2200);
    return () => clearInterval(t);
  }, [phase, meta]);

  // Stream the widget (fetch-based SSE reader; scripts run only on widget.done).
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase('loading'); setMeta(null); setCode(''); setError(null); setMsgIdx(0);
    (async () => {
      try {
        const r = await fetch('/api/oda/widgets/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
          signal: ctrl.signal,
        });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const evm = frame.match(/^event:(.+)$/m);
            const dam = frame.match(/^data:(.+)$/m);
            if (!evm || !dam) continue;
            const data = JSON.parse(dam[1]);
            if (cancelled) break;
            if (evm[1] === 'widget.meta') { setMeta(data); setPhase('streaming'); }
            else if (evm[1] === 'widget.chunk') setCode((c) => c + data.delta);
            else if (evm[1] === 'widget.done') { setCode(data.code); setMeta((m) => ({ ...(m || {}), title: data.title })); setPhase('done'); onDone?.(data); }
            else if (evm[1] === 'widget.error') { setError(data.error); setPhase('error'); }
          }
        }
      } catch (e) {
        if (!cancelled) { setError(e.message); setPhase('error'); }
      }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [prompt, runKey, onDone]);

  // Bridge messages from the iframe.
  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.odaBridge === 'sendTask' && d.text) onSendTask?.(d.text);
      if (d.odaBridge === 'openLink' && d.url) window.open(d.url, '_blank', 'noopener');
      if (d.odaBridge === 'refresh') setRunKey((k) => k + 1);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [onSendTask]);

  // srcDoc: while streaming show the assembling code WITHOUT executing scripts
  // (scripts stripped); on done, the full code runs with the bridge installed.
  const srcDoc = useMemo(() => {
    const safe = phase === 'done' ? code : code.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    return `<!doctype html><html><head><meta charset="utf-8"><style>${TOKEN_SHEET}</style><script>${BRIDGE_SNIPPET}<\/script></head><body>${safe}</body></html>`;
  }, [code, phase]);

  const download = () => {
    const blob = new Blob([code], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${meta?.title || 'oda_widget'}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const copy = () => navigator.clipboard?.writeText(code).catch(() => {});

  const loadingMsg = (meta?.loadingMessages || ['Preparing the widget'])[msgIdx] || 'Preparing the widget';

  return (
    <div className="oda-card oda-widgetcard" style={{ position: 'relative', padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid #E5EDF2' }}>
        <span className="oda-widgetcard__dot" aria-hidden data-phase={phase} />
        <span className="oda-kicker" style={{ flex: 1, textTransform: 'none', letterSpacing: '.04em' }}>
          {phase === 'done' ? (meta?.title || 'widget').replace(/_/g, ' ') : loadingMsg}
        </span>
        <div className="oda-widgetcard__tools">
          <button type="button" title="Download" aria-label="Download widget" onClick={download} disabled={phase !== 'done'}><Download size={13} aria-hidden /></button>
          <button type="button" title="Copy" aria-label="Copy widget code" onClick={copy} disabled={phase !== 'done'}><Copy size={13} aria-hidden /></button>
          <button type="button" title="Re-run" aria-label="Re-run widget" onClick={() => setRunKey((k) => k + 1)}><RotateCcw size={13} aria-hidden /></button>
        </div>
      </div>
      {phase === 'error' ? (
        <div className="oda-muted" style={{ padding: 20, fontSize: 13 }}>The widget could not be rendered — {error}</div>
      ) : (
        <iframe
          ref={iframeRef}
          title={meta?.title || 'ODA widget'}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={{ width: '100%', minHeight: 260, height: 380, border: 0, background: 'transparent', display: 'block' }}
        />
      )}
    </div>
  );
}
