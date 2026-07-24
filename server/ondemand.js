// ondemand.js — OnDemand API client: session create + SSE streaming proxy.
// Verified behaviour (Phase-1 NOTES.md): session create returns 201 with data.id;
// stream frames: eventType "fulfillment" (answer token in .answer) vs
// "fulfillment_thinking" (thinking token in .thinking.delta); terminal data:[DONE].
import { ONDEMAND_API_KEY, ONDEMAND_BASE_URL, ENDPOINT_ID, REASONING_EFFORT, STREAM_DEBUG } from './env.js';

const H = { apikey: ONDEMAND_API_KEY, 'Content-Type': 'application/json' };

// ---------- API-key fail-fast guard (2026-07-22 HTTP-500 root-cause fix) ----------
// ROOT CAUSE (verified live 2026-07-22 against POST /chat/v1/sessions):
//   • apikey header EMPTY  -> upstream HTTP 500 "An unexpected error occurred"
//   • apikey header ABSENT -> HTTP 401 "No API key header"
//   • apikey header INVALID-> HTTP 401 "Invalid API Key"
// A deployment that omits ONDEMAND_API_KEY/ON_DEMAND_API_KEY therefore surfaces as
// an opaque 500 on EVERY OnDemand call. Fail fast with an actionable error instead
// of sending an empty header upstream.
function assertApiKey(op) {
  if (!ONDEMAND_API_KEY) {
    const err = new Error(`OnDemand ${op} blocked: ONDEMAND_API_KEY (or ON_DEMAND_API_KEY) is not set in this deployment — an empty apikey header would return upstream HTTP 500 "An unexpected error occurred". Set the env var and restart.`);
    err.status = 503;
    err.errorCode = 'MISSING_ONDEMAND_API_KEY';
    throw err;
  }
}

// 2026-07-19 live-verified platform change: the chat API now rejects `pluginIds`
// at query time with HTTP 400 "One or more agents are invalid: agent-XXXX"
// (details.invalidAgentIds). The working form — verified live today against
// Perplexity (200, 25.9s, real sourced answer) — is `agentIds` carrying the
// `agent-…` twin of each `plugin-…` id, on BOTH session create and query.
// All callers keep passing plugin-… ids; translation happens here, at the wire.
export const toAgentIds = (ids = []) => ids.map((id) =>
  typeof id === 'string' && id.startsWith('plugin-') ? id.replace(/^plugin-/, 'agent-') : id);

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
 * 2026-07-23 (incident 2bc9fe01): the live gateway intermittently returns
 * HTTP 401/403 "Unauthorized" on a small fraction of calls made with a VALID
 * apikey — a production run died when the verifier's sync query hit one
 * (run.failed UPSTREAM_HTTP_403, 0.7s into verification). Same shape as the
 * empirically-transient 404 on session create: a bounded, logged,
 * auth-specific retry — deliberately NOT folded into odFetch's generic
 * policy, and a PERSISTENT 401/403 still throws once attempts are exhausted.
 * @param {() => Promise<Response>} doFetch re-invocable fetch thunk
 * @param {string} label log label
 */
async function odFetchAuthRetry(doFetch, label) {
  let r = await doFetch();
  for (let extra = 1; (r.status === 401 || r.status === 403) && extra <= 2; extra++) {
    console.error(`[od-retry] ${label} transient HTTP ${r.status} (attempt ${extra}/3) — retrying in ${600 * extra}ms`);
    await new Promise((res) => setTimeout(res, 600 * extra));
    r = await doFetch();
  }
  return r;
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
  assertApiKey('session create');
  // Session-create contract re-verified against the LIVE public docs 2026-07-22
  // (GET /config/v1/public/docs/reference/api/createchatsession):
  //   POST {base}/chat/v1/sessions · header `apikey` · body requires externalUserId;
  //   docs schema lists pluginIds[]; the live API also accepts agentIds[] (201-proven
  //   2026-07-22 with a real session id) — agentIds retained per the 2026-07-19
  //   platform change where query-time pluginIds returned HTTP 400.
  // (2026-07-20 streaming-bug fix) The gateway INTERMITTENTLY answers session-create
  // with 404 "no Route matched with those values" (observed live: first typed-prompt
  // call 404s, immediate identical retry 201s). odFetch only retries network/5xx, so
  // this transient 404 previously killed the whole first turn of every NEW
  // conversation right after thinking had streamed — the "typed prompt stops after
  // Thought process" bug. Conversation starters worked because their conversations
  // already held an odSessionId. Fix: up to 2 extra attempts on 404 with a short
  // backoff — bounded, logged, and only for this specific route-miss signature.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(res => setTimeout(res, 400 * attempt));
    const r = await odFetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ externalUserId, agentIds: toAgentIds(pluginIds) }),
    });
    // Docs label success 200; the live API returns 201 Created — r.ok covers the whole 200-299
    // range, so any 2xx (200 or 201) is treated as success here.
    if (r.ok) {
      const j = await r.json();
      return j?.data?.id;
    }
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    const hint = r.status === 500 && /unexpected error/i.test(message)
      ? ' [hint: upstream returns this exact 500 when the apikey header is EMPTY — check ONDEMAND_API_KEY wiring]' : '';
    const err = new Error(`OnDemand session create failed (HTTP ${r.status}): ${message}${hint}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    lastErr = err;
    if ((r.status === 404 || r.status === 401 || r.status === 403) && attempt < 2) {
      console.error(`[WARN] OnDemand session create transient HTTP ${r.status} (attempt ${attempt + 1}/3) — retrying: ${message} (upstreamErrorCode=${upstreamErrorCode || 'n/a'})`);
      continue;
    }
    console.error(`[FAIL] [HARD-FAIL] OnDemand session create HTTP ${r.status}: ${message}`);
    throw err;
  }
  throw lastErr;
}

/**
 * Stream a query — PURE PASSTHROUGH (2026-07-17 refactor per raw-dump investigation).
 * Every upstream SSE frame is forwarded UNTOUCHED via onRaw(sseEventName, rawDataString):
 * planning_thinking, planning_output, step_thinking, step_output (plugin-call args),
 * fulfillment, statusLog, metricsLog, heartbeat frames, and the [DONE] sentinel —
 * no filtering, no buffering beyond SSE line assembly, no re-synthesis.
 * The server still PARSES frames read-only for: fullAnswer accumulation (persistence),
 * error-frame detection, [DONE] termination, and STREAM_DEBUG logging.
 * Default model policy: ENDPOINT_ID + TOP-LEVEL reasoningEffort (decomposed form —
 * suffixed ids like 'gpt-5.6-sol-medium' are a proven HTTP 400). Main chat default:
 * predefined-gpt-5.6-sol + 'low' (2026-07-20 streaming fix). Streaming always ON.
 */
export async function streamQuery({ odSessionId, query, pluginIds = [], systemPrompt, onRaw, onEvent, signal, endpointId: endpointOverride, reasoningEffort: reasoningOverride, fulfillmentOnly = false }) {
  assertApiKey('query stream');
  const body = {
    query,
    endpointId: endpointOverride || ENDPOINT_ID,
    reasoningEffort: reasoningOverride || REASONING_EFFORT,   // reasoning tokens ON (thinking frames surface when the model emits them)
                                          // NOTE: `reasoningEffort` is not in the documented submitquery schema but is
                                          // accepted by the live API — live-accepted extension beyond the documented schema.
    responseMode: 'stream',
    chatMode: 'standard', // ALWAYS standard — 'plan' is rejected by the public API ("not supported")
                          // and standard avoids the agentic planning/step decomposition frames.
    agentIds: toAgentIds(pluginIds),
    ...(fulfillmentOnly ? { fulfillmentOnly: true } : {}),
    modelConfigs: systemPrompt ? { fulfillmentPrompt: systemPrompt, temperature: 0.4 } : { temperature: 0.4 },
  };
  // odFetch retry is safe here ONLY because no bytes have been consumed yet (pre-stream).
  // Once reading begins below, the existing watchdog/error paths — not retry — handle failures.
  // 2026-07-23: pre-stream fetches also get the bounded 401/403 auth retry.
  const r = await odFetchAuthRetry(() => odFetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions/${odSessionId}/query`, {
    method: 'POST',
    headers: { ...H, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  }), 'stream query');
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
  assertApiKey('sync query');
  const r = await odFetchAuthRetry(() => odFetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions/${odSessionId}/query`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      query,
      endpointId: endpointId || ENDPOINT_ID,
      // reasoningEffort: live-accepted extension beyond the documented submitquery schema (see streamQuery note above).
      reasoningEffort: reasoningEffort || REASONING_EFFORT,
      responseMode: 'sync',
      chatMode: 'standard', // ALWAYS standard (see streamQuery note) — 'plan' is rejected by the public API.
      agentIds: toAgentIds(pluginIds),
      modelConfigs: systemPrompt ? { fulfillmentPrompt: systemPrompt, temperature: 0.2 } : { temperature: 0.2 },
    }),
  }), 'sync query');
  if (!r.ok) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] [HARD-FAIL] OnDemand sync HTTP ${r.status}: ${message} (upstreamErrorCode=${upstreamErrorCode || 'n/a'})`);
    const err = new Error(`OnDemand sync query failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }
  const j = await r.json();
  return j?.data?.answer || '';
}

/** Start OAuth for a connector (POST /plugin/v1/oauth/init). */
export async function initPluginOAuth({ pluginId, metadata = {} } = {}) {
  assertApiKey('oauth init');
  const r = await odFetchAuthRetry(() => odFetch(`${ONDEMAND_BASE_URL}/plugin/v1/oauth/init`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ pluginId, metadata }),
  }), 'oauth init');
  if (!r.ok) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] OnDemand oauth init HTTP ${r.status}: ${message}`);
    const err = new Error(`OnDemand oauth init failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }
  return r.json();
}

/** Unsubscribe / disconnect a connector (DELETE /plugin/v1/plugin_configuration/:id). */
export async function unsubscribePluginConfiguration(id) {
  assertApiKey('plugin unsubscribe');
  const r = await odFetchAuthRetry(() => odFetch(`${ONDEMAND_BASE_URL}/plugin/v1/plugin_configuration/${id}`, {
    method: 'DELETE',
    headers: H,
  }), 'plugin unsubscribe');
  if (!r.ok) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] OnDemand plugin unsubscribe HTTP ${r.status}: ${message}`);
    const err = new Error(`OnDemand plugin unsubscribe failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }
  return r.json().catch(() => ({}));
}

/** Complete OAuth after provider redirect (POST /plugin/v1/plugin_configuration/oauth/complete). */
export async function completePluginOAuth({ state, code } = {}) {
  assertApiKey('oauth complete');
  const r = await odFetchAuthRetry(() => odFetch(`${ONDEMAND_BASE_URL}/plugin/v1/plugin_configuration/oauth/complete`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ state, code }),
  }), 'oauth complete');
  if (!r.ok) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] OnDemand oauth complete HTTP ${r.status}: ${message}`);
    const err = new Error(`OnDemand oauth complete failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }
  return r.json();
}

/** List OAuth connectors (GET /plugin/v1/list — apikey only). */
export async function listClientPlugins({ v2 = 1, limit = 50, page = 1, scope = '', authType = 'OAUTH' } = {}) {
  assertApiKey('plugin list');
  const qs = new URLSearchParams({
    v2: String(v2),
    limit: String(limit),
    page: String(page),
    scope,
    authType,
  });
  const r = await odFetchAuthRetry(() => odFetch(`${ONDEMAND_BASE_URL}/plugin/v1/list?${qs}`, {
    method: 'GET',
    headers: { apikey: ONDEMAND_API_KEY },
  }), 'plugin list');
  if (!r.ok) {
    const { message, upstreamErrorCode } = await parseUpstreamError(r);
    console.error(`[FAIL] OnDemand plugin list HTTP ${r.status}: ${message}`);
    const err = new Error(`OnDemand plugin list failed (HTTP ${r.status}): ${message}`);
    err.status = r.status;
    err.errorCode = `UPSTREAM_HTTP_${r.status}`;
    err.upstreamErrorCode = upstreamErrorCode;
    throw err;
  }
  return r.json();
}
