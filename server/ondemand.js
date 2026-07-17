// ondemand.js — OnDemand API client: session create + SSE streaming proxy.
// Verified behaviour (Phase-1 NOTES.md): session create returns 201 with data.id;
// stream frames: eventType "fulfillment" (answer token in .answer) vs
// "fulfillment_thinking" (thinking token in .thinking.delta); terminal data:[DONE].
import { ONDEMAND_API_KEY, ONDEMAND_BASE_URL, ENDPOINT_ID, REASONING_EFFORT, STREAM_DEBUG } from './env.js';

const H = { apikey: ONDEMAND_API_KEY, 'Content-Type': 'application/json' };

// STREAM_DEBUG one-liner: key=value pairs only — NEVER the API key, NEVER frame text content.
const dbg = (fields) => { if (STREAM_DEBUG) console.log('[stream-debug] ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')); };

/**
 * fetch() wrapper with retry-with-exponential-backoff for the OnDemand API.
 * Retries ONLY on network/fetch errors (TypeError/ECONNRESET/etc.) and HTTP 5xx responses;
 * 4xx client errors are NEVER retried (not transient). Backoff: baseDelayMs * 2^attempt
 * -> 500ms, 1s, 2s (default retries=3 => 4 total attempts).
 * Returns the Response object for ANY HTTP outcome (2xx/4xx/5xx) so callers keep their own
 * r.ok handling; only throws (the raw network error) once every retry is exhausted and the
 * network itself is still failing.
 */
async function odFetch(url, options, { retries = 3, baseDelayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(url, options);
    } catch (netErr) {
      if (attempt >= retries) throw netErr;
      const delay = baseDelayMs * 2 ** attempt;
      console.error(`[od-retry] attempt=${attempt + 1} status=network next=${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    if (r.status >= 500 && attempt < retries) {
      const delay = baseDelayMs * 2 ** attempt;
      console.error(`[od-retry] attempt=${attempt + 1} status=${r.status} next=${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    return r; // success (2xx), non-retryable 4xx, or 5xx with retries exhausted
  }
}

/**
 * Parse a failed OnDemand response per the documented error envelope — both the 4XX
 * ClientErrorResponse and 5XX ServerErrorResponse are shaped {errorCode, message}.
 * Falls back to a raw text slice (300 chars) if the body isn't valid JSON.
 */
async function parseUpstreamError(r) {
  const raw = await r.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    return { message: j?.message || raw.slice(0, 300), upstreamErrorCode: j?.errorCode };
  } catch {
    return { message: raw.slice(0, 300), upstreamErrorCode: undefined };
  }
}

export async function createOdSession(externalUserId, pluginIds = []) {
  const r = await odFetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ externalUserId, pluginIds }),
  });
  // Docs label success 200; the live API returns 201 Created — r.ok covers the whole 200-299
  // range, so any 2xx (200 or 201) is treated as success here.
  if (!r.ok) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] [HARD-FAIL] OnDemand session create HTTP ${r.status}: ${message}`);
    const err = new Error(`OnDemand session create failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }
  const j = await r.json();
  return j?.data?.id;
}

/**
 * Stream a query — PURE PASSTHROUGH (2026-07-17 refactor per raw-dump investigation).
 * Every upstream SSE frame is forwarded UNTOUCHED via onRaw(sseEventName, rawDataString):
 * planning_thinking, planning_output, step_thinking, step_output (plugin-call args),
 * fulfillment, statusLog, metricsLog, heartbeat frames, and the [DONE] sentinel —
 * no filtering, no buffering beyond SSE line assembly, no re-synthesis.
 * The server still PARSES frames read-only for: fullAnswer accumulation (persistence),
 * error-frame detection, [DONE] termination, and STREAM_DEBUG logging.
 * EVERY call uses gpt-5.6-sol-medium (ENDPOINT_ID + REASONING_EFFORT) with streaming ON.
 */
export async function streamQuery({ odSessionId, query, pluginIds = [], systemPrompt, onRaw, onEvent, signal }) {
  const body = {
    query,
    endpointId: ENDPOINT_ID,
    reasoningEffort: REASONING_EFFORT,   // reasoning tokens ON (thinking frames surface when the model emits them)
                                          // NOTE: `reasoningEffort` is not in the documented submitquery schema but is
                                          // accepted by the live API — live-accepted extension beyond the documented schema.
    responseMode: 'stream',
    pluginIds,
    modelConfigs: systemPrompt ? { fulfillmentPrompt: systemPrompt, temperature: 0.4 } : { temperature: 0.4 },
  };
  // odFetch retry is safe here ONLY because no bytes have been consumed yet (pre-stream).
  // Once reading begins below, the existing watchdog/error paths — not retry — handle failures.
  const r = await odFetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions/${odSessionId}/query`, {
    method: 'POST',
    headers: { ...H, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] [HARD-FAIL] OnDemand stream HTTP ${r.status} on ${ENDPOINT_ID}+${REASONING_EFFORT}: ${message} — NO silent model fallback; surfacing to caller.`);
    const err = new Error(`OnDemand query failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullAnswer = '';
  let sseEventName = 'message'; // current `event:` field per SSE spec; reset after each dispatch
  // STREAM_DEBUG counters (live-capture-verified: typed frames carry a monotonic eventIndex).
  let fulfillmentCount = 0;   // cumulative fulfillment (answer-token) frame count
  let lastEventIndex = null;  // for gap detection on typed frames

  const handleData = (payload) => {
    // 1) PASSTHROUGH FIRST — forward the raw frame untouched (event name + raw data string),
    //    before any parsing. This is the 1:1 wire path to the browser.
    onRaw?.(sseEventName, payload);

    if (payload === '[DONE]') {
      dbg({ ts: new Date().toISOString(), dir: 'upstream', type: 'DONE', idx: '-', chars: 0, tok: fulfillmentCount, session: odSessionId });
      return 'done';
    }
    // 2) READ-ONLY parse for persistence/error-detection/debug — never mutates what was forwarded.
    let evt;
    try { evt = JSON.parse(payload); } catch {
      dbg({ ts: new Date().toISOString(), dir: 'upstream', type: 'unparseable', idx: '-', chars: 0, tok: fulfillmentCount, session: odSessionId });
      return null; // unparseable keep-alives were still forwarded above
    }
    const et = evt.eventType;
    // Heartbeat (no eventType, shape {sessionId, messageId, time}) — forwarded above, no local action.
    if (!et && evt.sessionId && evt.time) {
      dbg({ ts: new Date().toISOString(), dir: 'upstream', type: 'heartbeat', idx: '-', chars: 0, tok: fulfillmentCount, session: odSessionId });
      return null;
    }
    // eventIndex gap detection (debug-only observability — never throws).
    if (et && typeof evt.eventIndex === 'number') {
      if (lastEventIndex !== null && evt.eventIndex - lastEventIndex > 1) {
        dbg({ ts: new Date().toISOString(), dir: 'upstream', type: 'gap-warning', from: lastEventIndex, to: evt.eventIndex, session: odSessionId });
      }
      lastEventIndex = evt.eventIndex;
    }
    if (et === 'fulfillment' && typeof evt.answer === 'string') fulfillmentCount++;
    const deltaLen = (et === 'fulfillment' && typeof evt.answer === 'string') ? evt.answer.length
      : (typeof evt?.thinking?.delta === 'string') ? evt.thinking.delta.length
      : (typeof evt?.output?.delta === 'string') ? evt.output.delta.length
      : 0;
    dbg({ ts: new Date().toISOString(), dir: 'upstream', type: et || 'heartbeat', idx: evt.eventIndex ?? '-', chars: deltaLen, tok: fulfillmentCount, session: odSessionId });
    if (et === 'error' || evt.error) {
      const msg = (typeof evt.error === 'string' && evt.error)
        || evt.error?.message
        || evt.message
        || 'Upstream OnDemand stream reported an error event';
      const err = new Error(msg);
      err.errorCode = 'UPSTREAM_ERROR_FRAME';
      throw err;
    }
    if (et === 'fulfillment' && typeof evt.answer === 'string') {
      fullAnswer += evt.answer; // server-side persistence only — browser already got the raw frame
      onEvent?.('answer', evt.answer);
    }
    return null;
  };

  // 90s inactivity watchdog: if the upstream reader yields no chunk within the window, abort the loop.
  const STALL_MS = 90000;
  let stallTimer = null;
  const clearStallTimer = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
  const armStallTimer = () => new Promise((_, reject) => {
    stallTimer = setTimeout(() => {
      const err = new Error('No stream activity for 90s — upstream stalled');
      err.errorCode = 'STREAM_STALLED';
      reject(err);
    }, STALL_MS);
  });

  try {
    dbg({ ts: new Date().toISOString(), dir: 'upstream', type: 'stream-open', idx: '-', chars: 0, tok: fulfillmentCount, session: odSessionId });
    while (true) {
      // Race the next chunk against the stall watchdog; rearmed fresh every iteration.
      const { done, value } = await Promise.race([reader.read(), armStallTimer()]);
      clearStallTimer(); // a chunk (or completion) arrived in time — disarm until the next iteration
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines; data lines start with "data:"
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('event:')) {
          // SSE event-name field — applies to the NEXT data line(s) (live wire: event:thinking/message/heartbeat)
          sseEventName = line.slice(6).trim() || 'message';
        } else if (line.startsWith('data:')) {
          const res = handleData(line.slice(5).trim());
          sseEventName = 'message'; // per SSE spec the event name resets after dispatch
          if (res === 'done') {
            dbg({ ts: new Date().toISOString(), dir: 'upstream', type: 'stream-close', idx: '-', chars: 0, tok: fulfillmentCount, session: odSessionId });
            onEvent?.('done', { fullAnswer });
            return fullAnswer;
          }
        }
      }
    }
    // Tail-flush: drain any buffered multi-byte remainder and process a final unterminated `data:` line.
    buf += decoder.decode();
    const tail = buf.replace(/\r$/, '');
    if (tail.startsWith('data:')) handleData(tail.slice(5).trim());
  } catch (err) {
    err.partialAnswer = fullAnswer;
    throw err;
  } finally {
    clearStallTimer();
  }
  dbg({ ts: new Date().toISOString(), dir: 'upstream', type: 'stream-close', idx: '-', chars: 0, tok: fulfillmentCount, session: odSessionId });
  onEvent?.('done', { fullAnswer });
  return fullAnswer;
}

/** Non-streaming helper for internal calls (router classification, title generation). Same model policy. */
export async function syncQuery({ odSessionId, query, systemPrompt, pluginIds = [], endpointId, reasoningEffort }) {
  const r = await odFetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions/${odSessionId}/query`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      query,
      endpointId: endpointId || ENDPOINT_ID,
      // reasoningEffort: live-accepted extension beyond the documented submitquery schema (see streamQuery note above).
      reasoningEffort: reasoningEffort || REASONING_EFFORT,
      responseMode: 'sync',
      pluginIds,
      modelConfigs: systemPrompt ? { fulfillmentPrompt: systemPrompt, temperature: 0.2 } : { temperature: 0.2 },
    }),
  });
  if (!r.ok) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] [HARD-FAIL] OnDemand sync HTTP ${r.status}: ${message}`);
    const err = new Error(`OnDemand sync query failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }
  const j = await r.json();
  return j?.data?.answer || '';
}
