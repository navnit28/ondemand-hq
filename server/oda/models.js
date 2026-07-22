// models.js — ODA central model configuration & routing (MIGRATION_MAP.md row M14).
// Single source of truth for WHICH OnDemand endpoint answers WHICH ODA skill surface.
// Replaces "model recommendations as prose" with explicit, testable, observable
// routing: every substantive skill surface is a Sonnet 5 WORKER (it authors
// deliverable content); GLM 4.7 (Cerebras BYOI) is used ONLY as a low-latency
// INTERPRETER that emits control JSON for request interpretation and never
// authors shipped content. There are NO silent downgrades — a forbidden or
// empty endpoint throws, and a failed upstream call surfaces its own error
// rather than being retried against a different model.
//
// Plain ES module (repo "type":"module"), no external dependencies — the only
// sibling import is ../ondemand.js (syncQuery/streamQuery), per MIGRATION_MAP
// row M14 and the ODAModelRouting/ODAModelRole contracts in ./contracts.d.ts.

import { syncQuery, streamQuery } from '../ondemand.js';

/** @typedef {import('./contracts.d.ts').ODAModelRouting} ODAModelRouting */
/** @typedef {import('./contracts.d.ts').ODAModelRole} ODAModelRole */

/**
 * @typedef {object} ODACallLogEntry
 * @property {number} id             Monotonic ring-buffer sequence number.
 * @property {string} ts             ISO timestamp when the call started.
 * @property {string} surface        Skill surface key (see ODA_MODEL_ROUTING).
 * @property {ODAModelRole} role     'worker' | 'interpreter'.
 * @property {string} endpointId     Endpoint actually called.
 * @property {'low'|'medium'|'max'} reasoningEffort
 * @property {number} durationMs     Wall-clock duration of the call.
 * @property {boolean} ok            Whether the call resolved without throwing.
 * @property {number} [httpStatus]   Upstream HTTP status, present only on failure.
 * @property {number} chars          Length of the returned answer text (0 on failure).
 */

/**
 * @typedef {object} ODACallStats
 * @property {number} total
 * @property {Record<string, number>} byRole
 * @property {Record<string, number>} bySurface
 * @property {number} failures
 */

// ---------------------------------------------------------------------------
// Live-verified endpoint facts (registry check performed 2026-07-22).
// These are the ONLY two endpoint families ODA is permitted to route to.
// ---------------------------------------------------------------------------

/**
 * Sonnet 5 — the WORKER endpoint for every substantive ODA skill surface.
 * Live-verified 2026-07-22 against GET /config/v1/public/endpoints:
 * status active, context window 1,000,000 tokens, streaming true,
 * reasoning_efforts ['low','medium','max'].
 */
export const SONNET_5_ENDPOINT_ID = 'predefined-claude-sonnet-5';

/**
 * GLM 4.7 (Cerebras BYOI) — the ONLY endpoint permitted for the INTERPRETER
 * role (request-interpretation control-JSON emission). Live-verified
 * 2026-07-22 against GET /config/v1/public/endpoints: model_id zai-glm-4.7,
 * status active, context window 65k, hosted on Cerebras.
 * NOTE (live registry, 2026-07-22): `predefined-glm-4.7` and
 * `predefined-glm-4.7-flash` are INACTIVE registry entries — ODA must never
 * route to either, regardless of any caller-supplied override.
 */
export const GLM_47_INTERPRETER_ENDPOINT_ID = 'byoi-6e314690-4eaf-4def-a33c-380809acf1f5';

/** The two inactive GLM registry ids (live-verified 2026-07-22) — always forbidden. */
const INACTIVE_GLM_ENDPOINT_IDS = Object.freeze(['predefined-glm-4.7', 'predefined-glm-4.7-flash']);

const VALID_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'max']);

/**
 * Validate a caller-supplied reasoningEffort override against the documented
 * enum (same defensive pattern as server/env.js's validEffort) — an invalid
 * override falls back rather than being sent upstream and risking an HTTP 400.
 * @param {string|undefined} value
 * @param {'low'|'medium'|'max'} fallback
 * @returns {'low'|'medium'|'max'}
 */
function resolveReasoningEffort(value, fallback) {
  if (VALID_REASONING_EFFORTS.includes(value)) return value;
  if (value) console.warn(`[oda/models] invalid reasoningEffort "${value}" — must be one of ${VALID_REASONING_EFFORTS.join('|')}; using "${fallback}"`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Env overrides (all optional; each STILL passes the forbidden-endpoint guard
// below — an override can misconfigure ODA, but it can never bypass the guard).
// ---------------------------------------------------------------------------

const WORKER_ENDPOINT_ID = process.env.ODA_WORKER_ENDPOINT_ID || SONNET_5_ENDPOINT_ID;
const INTERPRETER_ENDPOINT_ID = process.env.ODA_INTERPRETER_ENDPOINT_ID || GLM_47_INTERPRETER_ENDPOINT_ID;
const WORKER_REASONING_EFFORT = resolveReasoningEffort(process.env.ODA_WORKER_REASONING_EFFORT, 'medium');
const INTERPRETER_REASONING_EFFORT = resolveReasoningEffort(process.env.ODA_INTERPRETER_REASONING_EFFORT, 'low');

// ---------------------------------------------------------------------------
// Forbidden-endpoint guard — enforced in code, never left as a comment-only rule.
// ---------------------------------------------------------------------------

/**
 * Patterns/ids ODA may never route to, under any role. Gemini and any "flash"
 * (low-effort/quality-capped) tier are hard-banned by ODA model policy; the two
 * inactive GLM registry ids are banned because they are not live endpoints.
 * @type {Array<RegExp|string>}
 */
export const FORBIDDEN_ENDPOINT_PATTERNS = Object.freeze([
  /gemini/i,
  /flash/i,
  ...INACTIVE_GLM_ENDPOINT_IDS,
]);

function matchesForbiddenPattern(endpointId) {
  return FORBIDDEN_ENDPOINT_PATTERNS.some((p) => (p instanceof RegExp ? p.test(endpointId) : endpointId === p));
}

/** True for the active GLM interpreter endpoint, either inactive GLM id, or any id that looks GLM-flavoured. */
function isInterpreterFamilyEndpoint(endpointId) {
  return endpointId === GLM_47_INTERPRETER_ENDPOINT_ID
    || INACTIVE_GLM_ENDPOINT_IDS.includes(endpointId)
    || /glm/i.test(endpointId);
}

function forbiddenEndpointError(message) {
  const err = new Error(`ODA forbidden endpoint: ${message}`);
  err.code = 'ODA_FORBIDDEN_ENDPOINT';
  return err;
}

/**
 * Throws if `endpointId` may not be used for `role`. NO silent downgrades:
 * there is no fallback list and no alternate-endpoint retry here — callers
 * must let a thrown error propagate rather than substitute another endpoint.
 * @param {string} endpointId
 * @param {ODAModelRole} [role]
 * @returns {true}
 */
export function assertEndpointAllowed(endpointId, role) {
  if (!endpointId) {
    throw forbiddenEndpointError(`empty endpointId supplied (role=${role || 'unspecified'})`);
  }
  if (matchesForbiddenPattern(endpointId)) {
    throw forbiddenEndpointError(`endpointId "${endpointId}" matches a forbidden pattern (Gemini, Flash, or an inactive GLM registry id) — role=${role || 'unspecified'}`);
  }
  if (role === 'worker' && isInterpreterFamilyEndpoint(endpointId)) {
    throw forbiddenEndpointError(`endpointId "${endpointId}" is a GLM/interpreter endpoint — GLM never authors deliverables, so it cannot serve the worker role`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Central routing table (MIGRATION_MAP M14) — every substantive skill surface
// is a Sonnet 5 worker; request interpretation alone runs on the GLM interpreter.
// ---------------------------------------------------------------------------

/** Worker surfaces at the standard (env-overridable) reasoning effort. */
const WORKER_SURFACE_EFFORTS = Object.freeze({
  'orchestrator-synthesis': WORKER_REASONING_EFFORT,
  'problem-solving': WORKER_REASONING_EFFORT,
  'benchmarking': WORKER_REASONING_EFFORT,
  'data-interpretation': WORKER_REASONING_EFFORT,
  'model-construction': WORKER_REASONING_EFFORT,
  'storyline': WORKER_REASONING_EFFORT,
  'slide-document-content': WORKER_REASONING_EFFORT,
  'design': WORKER_REASONING_EFFORT,
  'translation': WORKER_REASONING_EFFORT,
  // Quality gates below are always run at 'max' effort — not tied to the
  // general worker default, so lowering ODA_WORKER_REASONING_EFFORT can never
  // quietly weaken verification or Arabic register review.
  'arabic-review': 'max',
  'media': WORKER_REASONING_EFFORT,
  'verification': 'max',
  'revision': WORKER_REASONING_EFFORT,
});

const routingTable = {};
for (const [surface, reasoningEffort] of Object.entries(WORKER_SURFACE_EFFORTS)) {
  routingTable[surface] = Object.freeze({
    role: 'worker',
    endpointId: WORKER_ENDPOINT_ID,
    reasoningEffort,
    authorsDeliverables: true,
  });
}
// GLM 4.7 interpreter — request-interpretation ONLY; never authors deliverables.
routingTable['request-interpretation'] = Object.freeze({
  role: 'interpreter',
  endpointId: INTERPRETER_ENDPOINT_ID,
  reasoningEffort: INTERPRETER_REASONING_EFFORT,
  authorsDeliverables: false,
});

/** @type {Readonly<Record<string, ODAModelRouting>>} */
export const ODA_MODEL_ROUTING = Object.freeze(routingTable);

/**
 * Look up the routing entry for a skill surface.
 * @param {string} surface
 * @returns {ODAModelRouting}
 */
export function routingFor(surface) {
  const entry = ODA_MODEL_ROUTING[surface];
  if (!entry) {
    const err = new Error(`ODA model routing: unknown skill surface "${surface}" — no entry in ODA_MODEL_ROUTING`);
    err.code = 'ODA_UNKNOWN_SURFACE';
    throw err;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Observability — in-memory ring buffer of the last 200 model calls.
// ---------------------------------------------------------------------------

const CALL_LOG_LIMIT = 200;
/** @type {ODACallLogEntry[]} */
const callLog = [];
let callSeq = 0;

/** @param {Omit<ODACallLogEntry, 'id'>} fields */
function recordCall(fields) {
  callSeq += 1;
  callLog.push({ id: callSeq, ...fields });
  if (callLog.length > CALL_LOG_LIMIT) callLog.shift();
}

/** @returns {ODACallLogEntry[]} A shallow copy of the ring buffer (oldest first). */
export function getCallLog() {
  return callLog.map((entry) => ({ ...entry }));
}

/** @returns {ODACallStats} */
export function getCallStats() {
  /** @type {ODACallStats} */
  const stats = { total: callLog.length, byRole: {}, bySurface: {}, failures: 0 };
  for (const entry of callLog) {
    stats.byRole[entry.role] = (stats.byRole[entry.role] || 0) + 1;
    stats.bySurface[entry.surface] = (stats.bySurface[entry.surface] || 0) + 1;
    if (!entry.ok) stats.failures += 1;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Worker call — the entry point every substantive ODA skill surface uses.
// ---------------------------------------------------------------------------

/**
 * Run a query against the Sonnet 5 worker for a given skill surface.
 * Resolves routing centrally (routingFor), asserts the endpoint is allowed,
 * then delegates to ../ondemand.js syncQuery/streamQuery with the routed
 * endpointId + reasoningEffort. NEVER swaps endpoint on failure — an upstream
 * error propagates as-is (tagged with `err.odaSurface`), there is no retry
 * against a different model.
 * @param {object} args
 * @param {string} args.surface           Skill surface key, e.g. 'storyline'.
 * @param {string} args.sessionId         OnDemand session id (odSessionId).
 * @param {string} args.query
 * @param {string} [args.systemPrompt]
 * @param {string[]} [args.pluginIds]
 * @param {boolean} [args.stream]         false => syncQuery, true => streamQuery.
 * @param {(eventName: string, raw: string) => void} [args.onRaw]   streamQuery passthrough only.
 * @param {(kind: string, data: any) => void} [args.onEvent]        streamQuery passthrough only.
 * @param {AbortSignal} [args.signal]     streamQuery passthrough only (syncQuery has no abort support today).
 * @param {number} [args.maxTokensHint]   Accepted for interface forward-compatibility; NOT forwarded —
 *                                        neither syncQuery nor streamQuery in ../ondemand.js exposes a
 *                                        max-tokens parameter today.
 * @returns {Promise<string>} The worker's answer text.
 */
export async function workerCall({ surface, sessionId, query, systemPrompt, pluginIds = [], stream = false, onRaw, onEvent, signal, maxTokensHint } = {}) {
  const routing = routingFor(surface);
  if (routing.role !== 'worker') {
    const err = new Error(`ODA workerCall: surface "${surface}" routes to role "${routing.role}", not "worker" — use interpreterCall instead`);
    err.code = 'ODA_ROLE_MISMATCH';
    err.odaSurface = surface;
    throw err;
  }
  assertEndpointAllowed(routing.endpointId, routing.role);
  void maxTokensHint; // reserved for future forwarding — see JSDoc above.

  const startedAt = Date.now();
  const ts = new Date(startedAt).toISOString();
  let ok = false;
  let httpStatus;
  let chars = 0;
  try {
    const result = stream
      ? await streamQuery({
        odSessionId: sessionId,
        query,
        systemPrompt,
        pluginIds,
        onRaw,
        onEvent,
        signal,
        endpointId: routing.endpointId,
        reasoningEffort: routing.reasoningEffort,
      })
      : await syncQuery({
        odSessionId: sessionId,
        query,
        systemPrompt,
        pluginIds,
        endpointId: routing.endpointId,
        reasoningEffort: routing.reasoningEffort,
      });
    ok = true;
    chars = typeof result === 'string' ? result.length : 0;
    return result;
  } catch (err) {
    httpStatus = typeof err?.status === 'number' ? err.status : undefined;
    err.odaSurface = surface;
    throw err;
  } finally {
    recordCall({
      ts,
      surface,
      role: routing.role,
      endpointId: routing.endpointId,
      reasoningEffort: routing.reasoningEffort,
      durationMs: Date.now() - startedAt,
      ok,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      chars,
    });
  }
}

// ---------------------------------------------------------------------------
// Interpreter call — request-interpretation ONLY, control JSON, never a deliverable.
// ---------------------------------------------------------------------------

/**
 * Run a query against the GLM 4.7 interpreter for request interpretation.
 * Always a plain syncQuery with no plugins (../ondemand.js's syncQuery has no
 * `fulfillmentOnly` parameter — nothing to opt into there; a plain call is
 * already the leanest form).
 *
 * IMPORTANT (MIGRATION_MAP M14): interpreter output NEVER ships in a
 * deliverable. It is raw text expected to hold ODAControlJSON (see
 * contracts.d.ts) — the caller parses/validates that JSON itself. Any
 * interpretation that affects final output MUST be confirmed by the relevant
 * Sonnet 5 worker before it is trusted; the interpreter's word alone is never
 * sufficient for anything user-facing.
 * @param {object} args
 * @param {string} args.sessionId    OnDemand session id (odSessionId).
 * @param {string} args.query
 * @param {string} [args.systemPrompt]
 * @param {AbortSignal} [args.signal]  Accepted for interface symmetry with workerCall;
 *                                     NOT forwarded — syncQuery has no abort support today.
 * @returns {Promise<string>} Raw interpreter text (parse as ODAControlJSON upstream).
 */
export async function interpreterCall({ sessionId, query, systemPrompt, signal } = {}) {
  const routing = routingFor('request-interpretation');
  if (routing.role !== 'interpreter') {
    const err = new Error(`ODA interpreterCall: "request-interpretation" routes to role "${routing.role}", expected "interpreter"`);
    err.code = 'ODA_ROLE_MISMATCH';
    err.odaSurface = 'request-interpretation';
    throw err;
  }
  assertEndpointAllowed(routing.endpointId, routing.role);
  void signal; // reserved for future forwarding — see JSDoc above.

  const startedAt = Date.now();
  const ts = new Date(startedAt).toISOString();
  let ok = false;
  let httpStatus;
  let chars = 0;
  try {
    const result = await syncQuery({
      odSessionId: sessionId,
      query,
      systemPrompt,
      pluginIds: [],
      endpointId: routing.endpointId,
      reasoningEffort: routing.reasoningEffort,
    });
    ok = true;
    chars = typeof result === 'string' ? result.length : 0;
    return result;
  } catch (err) {
    httpStatus = typeof err?.status === 'number' ? err.status : undefined;
    err.odaSurface = 'request-interpretation';
    throw err;
  } finally {
    recordCall({
      ts,
      surface: 'request-interpretation',
      role: routing.role,
      endpointId: routing.endpointId,
      reasoningEffort: routing.reasoningEffort,
      durationMs: Date.now() - startedAt,
      ok,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      chars,
    });
  }
}

// ---------------------------------------------------------------------------
// Observability / test surface — used by the /api/oda route and unit tests.
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   worker: { endpointId: string, reasoningEffort: string },
 *   interpreter: { endpointId: string, reasoningEffort: string },
 *   forbiddenPatterns: string[],
 *   routingSurfaces: string[],
 * }}
 */
export function describeModelConfig() {
  return {
    worker: { endpointId: WORKER_ENDPOINT_ID, reasoningEffort: WORKER_REASONING_EFFORT },
    interpreter: { endpointId: INTERPRETER_ENDPOINT_ID, reasoningEffort: INTERPRETER_REASONING_EFFORT },
    forbiddenPatterns: FORBIDDEN_ENDPOINT_PATTERNS.map((p) => (p instanceof RegExp ? p.toString() : p)),
    routingSurfaces: Object.keys(ODA_MODEL_ROUTING),
  };
}

// ---------------------------------------------------------------------------
// Self-check at import (MIGRATION_MAP M14): fail loudly at boot on misconfig —
// an env override that resolves to a forbidden endpoint must never be
// discovered lazily on the first real user call.
// ---------------------------------------------------------------------------

try {
  assertEndpointAllowed(WORKER_ENDPOINT_ID, 'worker');
  assertEndpointAllowed(INTERPRETER_ENDPOINT_ID, 'interpreter');
} catch (err) {
  console.error(`[FAIL] [FATAL-CONFIG] ODA model configuration self-check failed at boot: ${err.message}`);
  throw err;
}
