// ondemandDirect.js — talk to the OnDemand API STRAIGHT from the browser, no
// Node proxy. Mirrors server/ondemand.js (createOdSession + streamQuery) but the
// `apikey` header now travels with the browser request. CORS is open on the
// gateway (access-control-allow-origin: *, apikey header allowed), so this works.
//
// SECURITY: the API key ships inside the client bundle (VITE_ vars are inlined at
// build time). Anyone can read it in devtools. Use a rotatable / scoped key.
//
// Transport: @microsoft/fetch-event-source. Native EventSource can't POST or set
// an `apikey` header; fetchEventSource's onmessage fires for EVERY frame (even
// ones with a custom `event:` name), which matches how the UI routes on the JSON
// `eventType` field.
import { fetchEventSource } from "@microsoft/fetch-event-source";

const API_KEY = import.meta.env.VITE_ONDEMAND_API_KEY || "";
const BASE_URL = (
  import.meta.env.VITE_ONDEMAND_BASE_URL || "https://api.on-demand.io"
).replace(/\/$/, "");
const ENDPOINT_ID =
  import.meta.env.VITE_ONDEMAND_ENDPOINT_ID || "predefined-glm-5.1";
const REASONING_EFFORT =
  import.meta.env.VITE_ONDEMAND_REASONING_EFFORT || "low";
// Attach ALL adopted plugins to each query. Default ON; set
// VITE_ONDEMAND_ALL_PLUGINS=false to only send explicitly-selected plugins.
const ALL_PLUGINS =
  String(import.meta.env.VITE_ONDEMAND_ALL_PLUGINS ?? "true").toLowerCase() !==
  "false";

// The VERIFIED plugin registry (mirrors server/plugins.js ADOPTED) — every id here
// passed a real chat-session test (HTTP 200 + completed). These are the "all agents"
// attached to every query in direct mode.
export const ADOPTED_PLUGIN_IDS = [
  "plugin-1713924030", // Internet Search
  "plugin-1722260873", // Perplexity
  "plugin-1741871229", // GPT Search
  "plugin-1740745780", // AI Search (Tavily)
  "plugin-1737365406", // Web Content Extractor
  "plugin-1743257072", // File Directory Search
  // 'plugin-1739264368', // Text & Markdown → PDF
  // 'plugin-1759408928', // HTML → Word (DOCX)
  "plugin-1776826082", // GPT Image 2
  "plugin-1775547203", // OnDemand Agent (files/XLSX)
];

/** Fatal, non-retryable — signals a genuine HTTP/response failure from the gateway. */
class FatalStreamError extends Error {
  constructor(message, { status, errorCode, invalidAgentIds } = {}) {
    super(message);
    this.name = "FatalStreamError";
    this.status = status;
    this.errorCode = errorCode;
    this.invalidAgentIds = invalidAgentIds; // agent-… ids the gateway rejected (HTTP 400)
  }
}

/** Stable per-browser externalUserId (OnDemand requires one on session create). */
function getExternalUserId() {
  const KEY = "oda-external-user-id";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = `web-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "web-anon";
  }
}

/** plugin-XXXX -> agent-XXXX (the wire form the query/session APIs accept). */
const toAgentIds = (ids = []) =>
  ids.map((id) =>
    typeof id === "string" && id.startsWith("plugin-")
      ? id.replace(/^plugin-/, "agent-")
      : id,
  );

function assertApiKey() {
  if (API_KEY) return;
  throw new FatalStreamError(
    "VITE_ONDEMAND_API_KEY is not set — add it to .env and restart Vite. Direct mode sends this key from the browser.",
    { status: 503, errorCode: "MISSING_ONDEMAND_API_KEY" },
  );
}

/**
 * Create an OnDemand chat session directly. Returns the session id (data.id).
 * Cached per conversation below so repeat turns reuse one session.
 */
export async function createOdSession(pluginIds = []) {
  assertApiKey();
  const r = await fetch(`${BASE_URL}/chat/v1/sessions`, {
    method: "POST",
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      externalUserId: getExternalUserId(),
      agentIds: toAgentIds(pluginIds),
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new FatalStreamError(
      `OnDemand session create failed (HTTP ${r.status}): ${body.message || "unknown error"}`,
      { status: r.status, errorCode: `UPSTREAM_HTTP_${r.status}` },
    );
  }
  const j = await r.json();
  return j?.data?.id;
}

// One OnDemand session per app conversation. Survives reloads via sessionStorage
// so a refreshed tab keeps talking to the same upstream session.
const sessionCache = new Map();
const SESSION_PREFIX = "oda-direct-session-";

async function getSessionId(conversationId, pluginIds) {
  const key = conversationId || "default";
  if (sessionCache.has(key)) return sessionCache.get(key);
  try {
    const stored = sessionStorage.getItem(`${SESSION_PREFIX}${key}`);
    if (stored) {
      sessionCache.set(key, stored);
      return stored;
    }
  } catch {
    /* private mode */
  }
  const id = await createOdSession(pluginIds);
  sessionCache.set(key, id);
  try {
    sessionStorage.setItem(`${SESSION_PREFIX}${key}`, id);
  } catch {
    /* ignore quota */
  }
  return id;
}

/**
 * Stream a chat turn STRAIGHT from OnDemand. Signature-compatible with the old
 * server-backed streamChat: onEvent(type, payload) receives raw upstream
 * eventTypes (planning_thinking, planning_output, step_thinking, step_output,
 * fulfillment, statusLog, metricsLog, ondemand_agent.*) plus synthesized
 * heartbeat / stream_end / done frames — exactly what App.jsx already handles.
 *
 * @param {object} body   the app's chat payload ({ conversationId, text, pluginIds, systemPrompt?, ... })
 * @param {(type: string, evt: object) => void} onEvent
 * @param {AbortSignal} [signal]
 * @param {(index: number) => void} [onIndex]  fired per upstream eventIndex (resume cursor)
 * @param {object} debugBus  streamDebugBus from api.js (optional frame taps)
 */
export async function streamChatDirect(
  body,
  onEvent,
  signal,
  onIndex,
  debugBus,
) {
  assertApiKey();
  const {
    conversationId,
    text,
    pluginIds = [],
    skillIds = [],
    systemPrompt,
    endpointId,
    reasoningEffort,
    modelConfigs,
  } = body;

  // Plugin set: ALL adopted plugins (default) unioned with any explicit selection,
  // else just the explicit selection. Converted to the agent-… wire form.
  const pluginSet = ALL_PLUGINS
    ? [...new Set([...ADOPTED_PLUGIN_IDS, ...pluginIds])]
    : pluginIds;
  // Mutable — the gateway may reject some agents (HTTP 400 invalidAgentIds); we strip
  // those and retry so one bad agent never kills a turn that has all plugins attached.
  let agentIds = toAgentIds(pluginSet);

  const sessionId = await getSessionId(conversationId, pluginSet);

  const buildBody = (resume) => ({
    query: text,
    endpointId: endpointId || ENDPOINT_ID,
    reasoningEffort: reasoningEffort || REASONING_EFFORT,
    responseMode: "stream",
    chatMode: "standard",
    debugMode: "on",
    agentIds,
    ...(Array.isArray(skillIds) && skillIds.length
      ? { skillIds: skillIds.filter((id) => typeof id === "string" && id) }
      : {}),
    modelConfigs: {
      temperature: 0.4,
      ...(systemPrompt ? { fulfillmentPrompt: systemPrompt } : {}),
      ...(modelConfigs || {}),
    },
    ...(resume && messageId ? { messageId, lastEventIndex } : {}), // resume cursor
  });

  debugBus?.emit({ kind: "lifecycle", type: "open" });
  let doneEmitted = false;
  // Resume cursor — updated live from every frame. On a mid-stream drop we re-issue
  // the SAME query body with these two values appended so OnDemand continues from
  // where it broke instead of re-answering from scratch.
  let messageId = null;
  let lastEventIndex = -1;

  const handleFrame = (raw) => {
    // Log EVERY raw SSE message to the browser console (parity with the reference
    // handleMessages "[SSE Event]" logging), timestamped so ordering is verifiable.
    console.log(`[SSE Event] Received: ${new Date().toISOString()} ${raw}`);
    if (raw === "[DONE]") {
      debugBus?.emit({ kind: "frame", type: "[DONE]", chars: 0 });
      onEvent("stream_end", {});
      if (!doneEmitted) {
        doneEmitted = true;
        onEvent("done", { fullAnswerPresent: true });
      }
      return;
    }
    let evt;
    try {
      evt = JSON.parse(raw);
    } catch {
      console.log("[SSE Event] Unparseable frame:", raw);
      return;
    }
    // Structured, expandable view of the parsed event object.
    console.log(`[SSE Event] Parsed (${evt.eventType || "no-type"}):`, evt);
    // Track the resume cursor from any frame that carries it.
    if (evt.messageId) messageId = evt.messageId;
    if (typeof evt.eventIndex === "number" && evt.eventIndex > lastEventIndex) {
      lastEventIndex = evt.eventIndex;
      onIndex?.(evt.eventIndex);
    }
    const et = evt.eventType;
    if (!et) {
      // Heartbeat frame {sessionId, messageId, time} — keep the UI stall watchdog fed.
      if (evt.sessionId && evt.time) {
        debugBus?.emit({
          kind: "frame",
          type: "heartbeat",
          chars: 0,
          raw: evt,
        });
        onEvent("heartbeat", {});
      }
      return;
    }
    // Surface a genuine upstream error frame the same way the server did.
    if (et === "error" || evt.error) {
      const message =
        (typeof evt.error === "string" && evt.error) ||
        evt.error?.message ||
        evt.message ||
        "Upstream OnDemand error";
      onEvent("error", { message, errorCode: "UPSTREAM_ERROR_FRAME" });
      return;
    }
    const chars =
      typeof evt.answer === "string"
        ? evt.answer.length
        : typeof evt?.thinking?.delta === "string"
          ? evt.thinking.delta.length
          : typeof evt?.output?.delta === "string"
            ? evt.output.delta.length
            : 0;
    debugBus?.emit({ kind: "frame", type: et, chars, raw: evt });
    onEvent(et, evt);
  };

  // One streaming attempt against the query endpoint. `resume` appends the cursor
  // (messageId + lastEventIndex) to the body so the gateway continues the same answer.
  const runAttempt = ({ resume }) =>
    fetchEventSource(`${BASE_URL}/chat/v1/sessions/${sessionId}/query`, {
      method: "POST",
      headers: { apikey: API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(resume)),
      signal,
      openWhenHidden: true, // never pause the stream when the tab is backgrounded
      async onopen(res) {
        const ct = res.headers.get("content-type") || "";
        if (res.ok && ct.includes("text/event-stream")) return;
        const errBody = await res.json().catch(() => ({}));
        // The gateway returns HTTP 400 with details.invalidAgentIds when one of the
        // attached agents isn't valid/subscribed — capture them so the loop can strip.
        const invalidAgentIds = Array.isArray(errBody?.details?.invalidAgentIds)
          ? errBody.details.invalidAgentIds
          : undefined;
        throw new FatalStreamError(
          `OnDemand query failed (HTTP ${res.status}): ${errBody.message || ct || "unexpected response"}`,
          {
            status: res.status,
            errorCode: `UPSTREAM_HTTP_${res.status}`,
            invalidAgentIds,
          },
        );
      },
      onmessage(ev) {
        // Called for ALL frames regardless of the SSE `event:` name.
        if (typeof ev.id === "string" && ev.id) {
          const n = Number.parseInt(ev.id, 10);
          if (Number.isFinite(n) && n > lastEventIndex) {
            lastEventIndex = n;
            onIndex?.(n);
          }
        }
        handleFrame(ev.data);
      },
      onclose() {
        debugBus?.emit({ kind: "lifecycle", type: "close" });
        if (!doneEmitted) {
          doneEmitted = true;
          onEvent("done", { fullAnswerPresent: true });
        }
      },
      // Throw so fetchEventSource's OWN auto-retry is disabled — the loop below
      // owns resume, re-issuing the query with the messageId + lastEventIndex cursor.
      onerror(err) {
        throw err;
      },
    });

  // Bounded resume loop: first attempt is a fresh query; every retry after a
  // transient drop resumes from the cursor. Fatal HTTP errors and user aborts
  // are never resumed.
  const MAX_RESUME_ATTEMPTS = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      await runAttempt({ resume: attempt > 0 });
      return; // clean close (onclose fired) — turn is finished
    } catch (err) {
      if (doneEmitted) return; // stream already completed before the throw
      // HTTP 400 naming invalid agents: drop them and retry with the rest (doesn't
      // consume a resume attempt) so one bad plugin never kills the whole turn.
      if (err instanceof FatalStreamError && err.invalidAgentIds?.length) {
        const bad = new Set(err.invalidAgentIds);
        const next = agentIds.filter((id) => !bad.has(id));
        if (next.length < agentIds.length) {
          agentIds = next;
          debugBus?.emit({
            kind: "lifecycle",
            type: "drop",
            message: `stripped ${bad.size} invalid agent(s); retrying with ${agentIds.length}`,
          });
          attempt -= 1; // don't count this as a resume attempt
          continue;
        }
      }
      if (err instanceof FatalStreamError) throw err; // bad HTTP / missing key — don't resume
      if (signal?.aborted) throw err; // user pressed Stop
      if (attempt >= MAX_RESUME_ATTEMPTS) throw err; // give up after N resumes
      const delay = 500 * (attempt + 1); // 0.5s, 1s, 1.5s
      debugBus?.emit({
        kind: "lifecycle",
        type: "drop",
        message: `resuming (attempt ${attempt + 1}/${MAX_RESUME_ATTEMPTS}) from messageId=${messageId || "n/a"} lastEventIndex=${lastEventIndex}`,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
      // loop: next runAttempt resumes with messageId + lastEventIndex
    }
  }
}

// ---------------------------------------------------------------------------
// ODA preset — fetched STRAIGHT from OnDemand (GET /plugin/v1/preset + skill
// list), replacing the server's /api/presets/oda. Same normalized shape.
// ---------------------------------------------------------------------------
const ODA_PRESET_ID =
  import.meta.env.VITE_ODA_PRESET_ID || "6a64473931a6f986a9a147c1";

function normalizePreset(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: raw.id,
    name: raw.name || "ODA",
    endpoint: raw.endpoint,
    chatPlugins: Array.isArray(raw.chatPlugins)
      ? raw.chatPlugins.filter(Boolean)
      : [],
    filePlugins: Array.isArray(raw.filePlugins)
      ? raw.filePlugins.filter(Boolean)
      : [],
    skillIds: Array.isArray(raw.skillIds) ? raw.skillIds.filter(Boolean) : [],
    responseMode: raw.responseMode || "stream",
    temperature: typeof raw.temperature === "number" ? raw.temperature : 0.7,
    topP: typeof raw.topP === "number" ? raw.topP : 1,
    presencePenalty:
      typeof raw.presencePenalty === "number" ? raw.presencePenalty : 0,
    stopSequences: Array.isArray(raw.stopSequences) ? raw.stopSequences : [],
    fulfillmentPrompt: raw.fulfillmentPrompt || "",
    reasoningEffort: raw.reasoningEffort || "medium",
    reasoningMode: raw.reasoningMode || null,
    debugMode: Boolean(raw.debugMode),
    maxTokens: raw.maxTokens ?? null,
    status: raw.status || null,
    category: raw.category || "",
    ragVersion: raw.ragVersion || null,
    updatedAt: raw.updatedAt || null,
  };
}

/**
 * Build the OnDemand query overrides from a normalized preset (mirror of the
 * server's presetQueryOptions). These are merged into the chat payload so the
 * preset's endpoint, reasoning effort, skills, and fulfillment prompt actually
 * reach the query in direct mode.
 */
export function presetQueryOptions(preset) {
  if (!preset) return {};
  return {
    endpointId: preset.endpoint,
    reasoningEffort: preset.reasoningEffort,
    skillIds: preset.skillIds,
    pluginIds: preset.chatPlugins,
    systemPrompt: preset.fulfillmentPrompt,
    modelConfigs: {
      ...(typeof preset.temperature === 'number' ? { temperature: preset.temperature } : {}),
      ...(typeof preset.topP === 'number' ? { topP: preset.topP } : {}),
      ...(typeof preset.presencePenalty === 'number' ? { presencePenalty: preset.presencePenalty } : {}),
      ...(Array.isArray(preset.stopSequences) && preset.stopSequences.length
        ? { stopSequences: preset.stopSequences }
        : {}),
      ...(preset.fulfillmentPrompt ? { fulfillmentPrompt: preset.fulfillmentPrompt } : {}),
    },
  };
}

const pickList = (payload, ...keys) => {
  const root = payload?.data ?? payload;
  if (Array.isArray(root)) return root;
  for (const k of keys) if (Array.isArray(root?.[k])) return root[k];
  if (Array.isArray(root?.data)) return root.data;
  return [];
};

/** Fetch + resolve the ODA preset (with skill names) directly from OnDemand. */
export async function fetchOdaPresetDirect() {
  assertApiKey();
  const qs = new URLSearchParams({
    page: "1",
    limit: "100",
    sortBy: "updatedAt",
  });
  const r = await fetch(`${BASE_URL}/plugin/v1/preset?${qs}`, {
    headers: { apikey: API_KEY },
  });
  if (!r.ok) {
    throw new FatalStreamError(
      `OnDemand preset list failed (HTTP ${r.status})`,
      {
        status: r.status,
        errorCode: `UPSTREAM_HTTP_${r.status}`,
      },
    );
  }
  const presets = pickList(await r.json(), "items", "presets");
  const raw =
    presets.find((p) => p?.id === ODA_PRESET_ID) ||
    presets.find((p) => p?.name === "ODA");
  const preset = normalizePreset(raw);

  let skills = [];
  if (preset?.skillIds?.length) {
    try {
      const sq = new URLSearchParams();
      for (const id of preset.skillIds) sq.append("skillId[]", id);
      const sr = await fetch(`${BASE_URL}/plugin/v1/skill/list?${sq}`, {
        headers: { apikey: API_KEY },
      });
      const rows = pickList(await sr.json(), "skills", "items");
      const byId = new Map(
        rows.map((s) => [s.id, s.name || s.title || s.slug || s.id]),
      );
      skills = preset.skillIds.map((id) => ({ id, name: byId.get(id) || id }));
    } catch {
      skills = preset.skillIds.map((id) => ({ id, name: id }));
    }
  }
  return { preset, skills };
}

/** Drop the cached OnDemand session for a conversation (e.g. on reset). */
export function clearDirectSession(conversationId) {
  const key = conversationId || "default";
  sessionCache.delete(key);
  try {
    sessionStorage.removeItem(`${SESSION_PREFIX}${key}`);
  } catch {
    /* ignore */
  }
}
