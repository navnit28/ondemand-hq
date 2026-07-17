// api.js — frontend client for the ODA suite backend. SSE parsing for /api/chat.

/**
 * Debug event bus — a tiny dependency-free pub/sub tapped by streamChat so the
 * DebugDrawer can observe every SSE frame without altering onEvent semantics.
 * Events: {kind:'frame', type, serverTs?, chars, raw?} and
 *         {kind:'lifecycle', type:'open'|'close'|'drop', message?}.
 * Every emitted event gains `clientTs` (browser UTC ISO timestamp).
 */
export const streamDebugBus = {
  listeners: new Set(),
  enabled: (typeof localStorage !== 'undefined' && localStorage.getItem('streamDebug') !== 'off'),
  emit(e) {
    if (!this.enabled) return;
    e.clientTs = new Date().toISOString();
    for (const fn of this.listeners) fn(e);
  },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  setEnabled(v) {
    this.enabled = v;
    try { localStorage.setItem('streamDebug', v ? 'on' : 'off'); } catch { /* private mode etc. */ }
  },
};

export async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
export async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Upload failed (HTTP ${r.status})`);
  return (await r.json()).file;
}

/**
 * Build a safe, human-readable message from any thrown/received value.
 * Never lets a raw object get string-interpolated into an Error message
 * (which would otherwise stringify to "[object Object]").
 */
function errorMessage(value, fallback) {
  if (typeof value === 'string' && value) return value;
  if (value instanceof Error) return value.message || fallback;
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.error === 'string' && value.error) return value.error;
    try { return JSON.stringify(value); } catch { /* fall through */ }
  }
  return fallback;
}

/**
 * Normalize a fetch/reader failure into an Error the caller can act on:
 *  - a real AbortError keeps `.errorCode = 'ABORTED'`
 *  - anything else (TypeError, network drop, reader throw) becomes a
 *    `.errorCode = 'STREAM_DROPPED'` error with a friendly `.userMessage`,
 *    distinguishing transport drops from explicit server 'error' events.
 */
function dropError(e) {
  if (e && e.name === 'AbortError') {
    const err = new Error(errorMessage(e, 'The request was cancelled.'));
    err.errorCode = 'ABORTED';
    streamDebugBus.emit({ kind: 'lifecycle', type: 'drop', message: err.message });
    return err;
  }
  const err = new Error('The connection dropped mid-stream.');
  err.errorCode = 'STREAM_DROPPED';
  err.userMessage = 'The connection dropped mid-stream.';
  streamDebugBus.emit({ kind: 'lifecycle', type: 'drop', message: err.userMessage });
  return err;
}

/**
 * Stream a chat turn. onEvent(type, payload) receives:
 *  routing / status / plugin_status / thinking / answer / metrics / error / done
 * Returns when the stream closes. Throws on transport-level failure:
 *  - AbortError -> Error with `.errorCode = 'ABORTED'`
 *  - any other fetch/read failure -> Error with `.errorCode = 'STREAM_DROPPED'`
 *    and `.userMessage` set. Explicit server 'error' events are surfaced via
 *    onEvent itself and are never rewrapped here, so callers can tell a
 *    transport drop apart from a real server-side error.
 */
export async function streamChat(body, onEvent, signal) {
  let r;
  try {
    r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw dropError(e);
  }
  if (!r.ok || !r.body) {
    const errBody = await r.json().catch(() => ({}));
    throw new Error(errorMessage(errBody.error, `HTTP ${r.status}`));
  }
  const reader = r.body.getReader();
  streamDebugBus.emit({ kind: 'lifecycle', type: 'open' });
  const dec = new TextDecoder();
  let buf = '';
  const processLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    // Keepalive comment lines (`: keepalive`) — surfaced to the debug bus, never to onEvent.
    if (line.startsWith(':')) { streamDebugBus.emit({ kind: 'frame', type: 'keepalive', chars: 0 }); return; }
    if (!line.startsWith('data:')) return;
    let evt;
    try { evt = JSON.parse(line.slice(5)); } catch { return; }
    streamDebugBus.emit({ kind: 'frame', type: evt.type, serverTs: evt.ts, chars: (evt.delta || '').length, raw: evt });
    onEvent(evt.type, evt);
  };
  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (e) {
      throw dropError(e);
    }
    if (done) {
      // Flush the decoder (handles a trailing multi-byte sequence) and process
      // a final unterminated `data:` line, if the stream ended without \n.
      buf += dec.decode();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        processLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
      if (buf.trim()) processLine(buf);
      streamDebugBus.emit({ kind: 'lifecycle', type: 'close' });
      break;
    }
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      processLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  }
}
