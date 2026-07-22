// Correlation Engine client API (2026-07-19).
const j = async (r) => { if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); } return r.json(); };

export const getRuns = (iso) => fetch(`/api/correlation/runs/${iso}`).then(j);
export const getRun = (iso, runId) => fetch(`/api/correlation/run/${iso}/${runId}`).then(j);
export const getDiff = (iso) => fetch(`/api/correlation/diff/${iso}`).then(j);
export const runDownloadUrl = (iso, runId) => `/api/correlation/run/${iso}/${runId}/download`;
export const regenerate = (iso) => fetch(`/api/correlation/regenerate/${iso}`, { method: 'POST' }).then(j);
export const pipelineStatus = (iso) => fetch(`/api/correlation/status/${iso}`).then(j);

// ---- Start Correlation Engine + latest-result (2026-07-20) ----
export const startEngine = (iso, opts = {}) => fetch(`/api/correlation/deep/${iso}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) }).then(j);
export const getLatest = (iso) => fetch(`/api/correlation/latest/${iso}`).then(j);

/** Stream the Connected Dots narrative (real SSE from the analysis model).
 *  onToken(text) per fulfillment delta; returns final full text. */
export function streamNarrative(iso, runId, { onToken, onError } = {}) {
  return new Promise((resolve) => {
    const es = new EventSource(`/api/correlation/narrative/${iso}/${runId}/stream`);
    let full = '';
    es.onmessage = (e) => {
      if (e.data === '[DONE]') { es.close(); resolve(full); return; }
      try {
        const evt = JSON.parse(e.data);
        if (evt.eventType === 'fulfillment' && typeof evt.answer === 'string') { full += evt.answer; onToken?.(evt.answer, full); }
      } catch { /* keep-alive */ }
    };
    es.onerror = () => { es.close(); onError?.(); resolve(full); };
  });
}

/** Quick Query (GLM 4.7 Cerebras) — SSE: answer tokens, then a `metrics` frame
 *  carrying {latencyMs, approxTokens, stoppedEarly, model}. */
export function quickQuery({ context, question, onToken, onMetrics, onError }) {
  const ctrl = new AbortController();
  fetch('/api/quick-query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, question }), signal: ctrl.signal,
  }).then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = (frame.match(/^event: (.+)$/m) || [])[1] || 'message';
        const data = (frame.match(/^data: (.*)$/m) || [])[1];
        if (!data || data === '[DONE]') continue;
        try {
          const jsn = JSON.parse(data);
          if (ev === 'metrics') onMetrics?.(jsn);
          else if (ev === 'error') onError?.(jsn.error);
          else if (jsn.eventType === 'fulfillment' && typeof jsn.answer === 'string') onToken?.(jsn.answer);
        } catch { /* partial */ }
      }
    }
  }).catch((e) => { if (e.name !== 'AbortError') onError?.(e.message); });
  return ctrl;
}

// ---- V2 inspector support (restored 2026-07-19) ----
/** Stream a structured article summary for one evidence record (Fable 5 MAX). */
export function summarizeEvidence({ iso, runId, evidenceId, onToken, onDone, onError }) {
  const ctrl = new AbortController();
  fetch('/api/correlation/summarize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ iso, runId, evidenceId }), signal: ctrl.signal,
  }).then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = (frame.match(/^data: (.*)$/m) || [])[1];
        if (!data) continue;
        if (data === '[DONE]') { onDone?.(full); return; }
        try {
          const jsn = JSON.parse(data);
          if (jsn.error) { onError?.(jsn.error); return; }
          if (jsn.eventType === 'fulfillment' && typeof jsn.answer === 'string') { full += jsn.answer; onToken?.(jsn.answer, full); }
        } catch { /* keep-alive */ }
      }
    }
    onDone?.(full);
  }).catch((e) => { if (e.name !== 'AbortError') onError?.(e.message); });
  return ctrl;
}

/** Stream the one-click Story Mode narration (Fable 5 MAX). */
export function streamStory(iso, runId, { onToken, onError } = {}) {
  return new Promise((resolve) => {
    const es = new EventSource(`/api/correlation/story/${iso}/${runId}/stream`);
    let full = '';
    es.onmessage = (e) => {
      if (e.data === '[DONE]') { es.close(); resolve(full); return; }
      try {
        const evt = JSON.parse(e.data);
        if (evt.eventType === 'fulfillment' && typeof evt.answer === 'string') { full += evt.answer; onToken?.(evt.answer, full); }
      } catch { /* keep-alive */ }
    };
    es.onerror = () => { es.close(); onError?.(); resolve(full); };
  });
}
