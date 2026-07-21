// server/ondemand/adapters.js — typed integration boundary around the REAL OnDemand
// public API schemas (fetched live 2026-07-19/20, see NOTES.md digests — never invented).
// All credentials stay server-side (env.js: ONDEMAND_API_KEY w/ ON_DEMAND_API_KEY
// fallback, injected at deploy). Types in adapters.d.ts. Every call has a timeout and
// redacted logging (no keys, no transcripts).
import { z } from 'zod';
import { ONDEMAND_API_KEY, ONDEMAND_BASE_URL } from '../env.js';

const H = () => ({ apikey: ONDEMAND_API_KEY, 'Content-Type': 'application/json' });
const withTimeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error(`timeout after ${ms}ms`)), ms);
  return { signal: c.signal, done: () => clearTimeout(t), controller: c };
};
const redact = (s) => String(s).replace(/apikey[^,}]*/gi, 'apikey:****');

// ---------- schemas (mirror the documented request/response shapes) ----------
export const SessionCreateResponse = z.object({ data: z.object({ id: z.string() }).passthrough() }).passthrough();
export const SttResponse = z.object({ message: z.string().optional(), data: z.any() }).passthrough();
export const TtsResponse = z.object({ message: z.string().optional(), data: z.any() }).passthrough();
export const WorkflowExecuteResponse = z.object({ executionID: z.string().optional(), data: z.any().optional() }).passthrough();

// ---------- sessions (POST /chat/v1/sessions — externalUserId REQUIRED) ----------
export async function createSession(externalUserId, agentIds = [], { timeoutMs = 15000 } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions`, {
      method: 'POST', headers: H(), signal: t.signal,
      body: JSON.stringify({ externalUserId, agentIds }),
    });
    if (!r.ok) throw Object.assign(new Error(`session create HTTP ${r.status}`), { status: r.status });
    const parsed = SessionCreateResponse.parse(await r.json());
    return parsed.data.id;
  } finally { t.done(); }
}

// ---------- streamed query (POST /chat/v1/sessions/{id}/query, responseMode:stream) ----------
// onEvent(eventType, dataObj) fires per SSE frame; returns {fullAnswer, usage|null}.
// `signal` lets the voice route abort in-flight generation on barge-in.
export async function streamQuery({ sessionId, query, endpointId, reasoningEffort, fulfillmentPrompt, fulfillmentOnly = true, signal, timeoutMs = 90000, onEvent }) {
  const t = withTimeout(timeoutMs);
  const anySignal = signal ? AbortSignal.any([signal, t.signal]) : t.signal;
  try {
    const body = { query, endpointId, responseMode: 'stream', chatMode: 'standard', fulfillmentOnly };
    // chatMode ALWAYS 'standard' — 'plan' is rejected by the public API ("not supported").
    if (fulfillmentPrompt) body.modelConfigs = { fulfillmentPrompt };
    // reasoningEffort is a TOP-LEVEL body key (live-accepted; NOT inside modelConfigs,
    // NEVER a suffixed model id — decomposed form only, 2026-07-20 mode audit).
    if (reasoningEffort) body.reasoningEffort = reasoningEffort;
    const r = await fetch(`${ONDEMAND_BASE_URL}/chat/v1/sessions/${sessionId}/query`, {
      method: 'POST', headers: H(), signal: anySignal, body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) throw Object.assign(new Error(`query HTTP ${r.status}`), { status: r.status });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', usage = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = (frame.match(/^data:\s?(.*)$/m) || [])[1];
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (j.eventType === 'fulfillment' && typeof j.answer === 'string') { full += j.answer; onEvent?.('token', j); }
          else if (j.eventType) onEvent?.(j.eventType, j);
          if (j.usage) usage = j.usage; // only surfaced if the stream actually exposes it
        } catch { /* keep-alive/partial */ }
      }
    }
    return { fullAnswer: full, usage };
  } catch (e) {
    if (e?.name === 'AbortError' || /abort/i.test(String(e?.message))) throw Object.assign(new Error('aborted'), { aborted: true });
    console.error('[voice-adapter]', redact(e.message));
    throw e;
  } finally { t.done(); }
}

// ---------- STT (POST /services/.../speech_to_text — {audioUrl} REQUIRED) ----------
export async function speechToText(audioUrl, { timeoutMs = 30000 } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(`${ONDEMAND_BASE_URL}/services/v1/public/service/execute/speech_to_text`, {
      method: 'POST', headers: H(), signal: t.signal, body: JSON.stringify({ audioUrl }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, message: j?.message || `HTTP ${r.status}`, notSubscribed: /subscribe/i.test(j?.message || '') };
    const p = SttResponse.parse(j);
    return { ok: true, text: p.data?.text ?? p.data ?? '' };
  } finally { t.done(); }
}

// ---------- TTS (POST /services/.../text_to_speech — {model,input,voice} REQUIRED) ----------
export async function textToSpeech({ input, model = 'tts-1', voice = 'alloy', timeoutMs = 30000 }) {
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(`${ONDEMAND_BASE_URL}/services/v1/public/service/execute/text_to_speech`, {
      method: 'POST', headers: H(), signal: t.signal, body: JSON.stringify({ model, input, voice }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, message: j?.message || `HTTP ${r.status}`, notSubscribed: /subscribe/i.test(j?.message || '') };
    const p = TtsResponse.parse(j);
    return { ok: true, data: p.data };
  } finally { t.done(); }
}

// ---------- workflow execute + stream_logs (documented activation mechanism) ----------
export async function executeWorkflow(workflowId, { timeoutMs = 20000 } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(`${ONDEMAND_BASE_URL}/automation/api/workflow/${workflowId}/execute`, {
      method: 'POST', headers: H(), signal: t.signal, body: '{}',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`workflow execute HTTP ${r.status}`), { status: r.status });
    return WorkflowExecuteResponse.parse(j);
  } finally { t.done(); }
}
export async function streamWorkflowLogs(executionID, onLine, { signal, timeoutMs = 120000 } = {}) {
  const t = withTimeout(timeoutMs);
  const anySignal = signal ? AbortSignal.any([signal, t.signal]) : t.signal;
  try {
    const r = await fetch(`${ONDEMAND_BASE_URL}/automation/api/workflow/stream_logs`, {
      method: 'POST', headers: H(), signal: anySignal, body: JSON.stringify({ executionID }),
    });
    if (!r.ok || !r.body) throw new Error(`stream_logs HTTP ${r.status}`);
    const reader = r.body.getReader(); const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onLine?.(dec.decode(value, { stream: true }));
    }
  } finally { t.done(); }
}
