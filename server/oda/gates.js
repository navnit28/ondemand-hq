// server/oda/gates.js — ODA resumable approval gates (MIGRATION_MAP.md row M4).
//
// Ports every user approval gate previously implemented as an `ask_user_input_v0`
// elicitation form into a resumable backend gate state. A gate raises
// 'question.required' on the run event stream with typed options; the run parks
// in 'waiting_for_user'; `POST /api/oda/runs/:id/gates/:gateId` resolves it (via
// runStore.resolveGate, layered on {@link resolveGateState}); the run then resumes
// exactly where it paused.
//
// Collaborators that touch durable run state (adding a gate, transitioning run
// status, emitting run events) are supplied by the caller via dependency
// injection. This module deliberately does NOT import runStore.js or events.js,
// which are being ported in parallel by other agents — it stays decoupled and
// independently testable.

import { randomUUID } from 'node:crypto';

/** @typedef {import('./contracts.d.ts').ODAGateType} ODAGateType */
/** @typedef {import('./contracts.d.ts').ODAGate} ODAGate */
/** @typedef {import('./contracts.d.ts').ODARun} ODARun */
/** @typedef {import('./contracts.d.ts').ODASkillId} ODASkillId */

// ---------------------------------------------------------------------------
// Gate catalogue
// ---------------------------------------------------------------------------

/**
 * Every gate type the ODA bundle can raise, in pipeline order.
 * @type {ReadonlyArray<ODAGateType>}
 */
export const GATE_TYPES = Object.freeze([
  'problem_definition',
  'scope_edit',
  'benchmark_shortlist',
  'hypotheses',
  'model_structure',
  'assumptions_low_base_high',
  'recommendations',
  'storyline',
  'english_before_arabic',
  'verification_findings',
]);

const DEFAULT_OPTIONS = Object.freeze(['Approve', 'Edit', 'Reject']);
const APPROVE_WITH_CHANGES_OPTIONS = Object.freeze(['Approve', 'Edit', 'Reject', 'Approve with changes']);

/**
 * Static definition for each gate type: its display title, its one-sentence
 * ODA-voice prompt (British English), the option set offered to the user, and
 * which skill typically raises it. `defaultOptions` and each definition object
 * are frozen so callers cannot mutate the catalogue at runtime.
 * @type {Readonly<Record<ODAGateType, { title: string, prompt: string, defaultOptions: string[], skillContext: ODASkillId }>>}
 */
export const GATE_DEFS = Object.freeze({
  problem_definition: Object.freeze({
    title: 'Problem definition',
    prompt: 'Confirm the problem definition before structuring begins.',
    defaultOptions: DEFAULT_OPTIONS,
    skillContext: 'problem-solve',
  }),
  scope_edit: Object.freeze({
    title: 'Scope edit',
    prompt: 'Confirm the scope edit before the run continues.',
    defaultOptions: DEFAULT_OPTIONS,
    skillContext: 'problem-solve',
  }),
  benchmark_shortlist: Object.freeze({
    title: 'Benchmark shortlist',
    prompt: 'Confirm the benchmark shortlist before analysis proceeds.',
    defaultOptions: APPROVE_WITH_CHANGES_OPTIONS,
    skillContext: 'benchmark',
  }),
  hypotheses: Object.freeze({
    title: 'Hypotheses',
    prompt: 'Confirm the hypotheses before analysis proceeds.',
    defaultOptions: DEFAULT_OPTIONS,
    skillContext: 'problem-solve',
  }),
  model_structure: Object.freeze({
    title: 'Model structure',
    prompt: 'Confirm the model structure before the model is built.',
    defaultOptions: DEFAULT_OPTIONS,
    skillContext: 'model',
  }),
  assumptions_low_base_high: Object.freeze({
    title: 'Assumptions (low, base, high)',
    prompt: 'Confirm the low, base and high assumptions before the model is built.',
    defaultOptions: DEFAULT_OPTIONS,
    skillContext: 'model',
  }),
  recommendations: Object.freeze({
    title: 'Recommendations',
    prompt: 'Confirm the recommendations before the storyline is drafted.',
    defaultOptions: DEFAULT_OPTIONS,
    skillContext: 'problem-solve',
  }),
  storyline: Object.freeze({
    title: 'Storyline',
    prompt: 'Confirm the storyline before the deliverable is built.',
    defaultOptions: APPROVE_WITH_CHANGES_OPTIONS,
    skillContext: 'storyline',
  }),
  english_before_arabic: Object.freeze({
    title: 'English before Arabic',
    prompt: 'Confirm the English deliverable before Arabic translation begins.',
    defaultOptions: Object.freeze(['Approve English — start Arabic', 'Request changes to English']),
    skillContext: 'translate',
  }),
  verification_findings: Object.freeze({
    title: 'Verification findings',
    prompt: 'Review the verification findings before the run proceeds.',
    defaultOptions: Object.freeze(['Accept findings — apply revisions', 'Override and proceed', 'Return to earlier stage']),
    skillContext: 'oda',
  }),
});

// ---------------------------------------------------------------------------
// Gate lifecycle
// ---------------------------------------------------------------------------

/**
 * Constructs a fresh, open {@link ODAGate}. Pure and side-effect free — raising it
 * onto a run's durable state is {@link raiseGate}'s job.
 * @param {object} args
 * @param {ODAGateType} args.gateType
 * @param {string | null} [args.nodeId]
 * @param {object | null} [args.payload] - the thing being approved (problem statement, shortlist, etc.).
 * @param {string | null} [args.promptOverride]
 * @param {string[] | null} [args.options]
 * @returns {ODAGate}
 */
export function createGate({ gateType, nodeId = null, payload = null, promptOverride = null, options = null }) {
  if (!GATE_TYPES.includes(gateType)) {
    throw new Error(`createGate: unknown gateType '${gateType}' — must be one of ${GATE_TYPES.join(', ')}`);
  }
  const def = GATE_DEFS[gateType];
  return {
    gateId: randomUUID(),
    gateType,
    nodeId,
    status: 'open',
    prompt: promptOverride || def.prompt,
    options: options || def.defaultOptions,
    payload,
    raisedAt: new Date().toISOString(),
  };
}

/**
 * Raises a gate onto a run: creates it, appends it to durable run state, parks the
 * run in 'waiting_for_user', and emits 'question.required' on the run event
 * stream. This is the ONLY sanctioned way a gate reaches the event stream — a
 * raised gate is always real parked state, never a UI-only prompt.
 *
 * All collaborators that touch run state are injected so this module never
 * imports runStore.js or events.js directly.
 * @param {object} args
 * @param {ODARun} args.run
 * @param {ODAGateType} args.gateType
 * @param {string | null} [args.nodeId]
 * @param {object | null} [args.payload]
 * @param {string | null} [args.promptOverride]
 * @param {string[] | null} [args.options]
 * @param {(run: ODARun, gate: ODAGate) => void} args.addGate
 * @param {(run: ODARun, status: string, meta?: object) => void} args.transition
 * @param {(run: ODARun, type: string, data: object) => void} args.emitRunEvent
 * @returns {Promise<ODAGate>}
 */
export async function raiseGate({
  run,
  gateType,
  nodeId = null,
  payload = null,
  promptOverride = null,
  options = null,
  addGate,
  transition,
  emitRunEvent,
}) {
  const gate = createGate({ gateType, nodeId, payload, promptOverride, options });
  addGate(run, gate);
  transition(run, 'waiting_for_user', { reason: `gate:${gateType}` });
  emitRunEvent(run, 'question.required', {
    gateId: gate.gateId,
    gateType: gate.gateType,
    nodeId: gate.nodeId,
    prompt: gate.prompt,
    options: gate.options,
    payload: gate.payload,
  });
  return gate;
}

/**
 * Computes the state transition for resolving an open gate. Pure — applying it to
 * durable storage (and resuming the run) is the route layer's job, via
 * runStore.resolveGate.
 *
 * - `approved === true` → status 'approved'.
 * - `edits` present (non-null) → status 'edited' (an edited resolution still
 *   counts as approved-with-changes: `resolution.approved` is `true`).
 * - otherwise → status 'rejected'.
 * @param {ODAGate} gate
 * @param {{ approved: boolean, choice?: string | null, edits?: object | null }} args
 * @returns {{ status: 'approved' | 'edited' | 'rejected', resolution: { approved: boolean, choice: string | null, edits: object | null }, resolvedAt: string }}
 */
export function resolveGateState(gate, { approved, choice = null, edits = null }) {
  if (gate.status !== 'open') {
    throw new Error('gate already resolved');
  }

  let status;
  if (edits != null) {
    status = 'edited';
  } else if (approved === true) {
    status = 'approved';
  } else {
    status = 'rejected';
  }

  return {
    status,
    resolution: { approved: status !== 'rejected', choice, edits },
    resolvedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * @param {ODARun} run
 * @returns {ODAGate[]} every gate on the run that is still open.
 */
export function openGates(run) {
  return run.gates.filter((g) => g.status === 'open');
}

/**
 * @param {ODARun} run
 * @returns {Array<{ gateId: string, gateType: ODAGateType, nodeId: string | null, status: string, raisedAt: string, resolvedAt?: string }>}
 *   compact list suitable for the run-state UI.
 */
export function gateSummary(run) {
  return run.gates.map((g) => ({
    gateId: g.gateId,
    gateType: g.gateType,
    nodeId: g.nodeId,
    status: g.status,
    raisedAt: g.raisedAt,
    resolvedAt: g.resolvedAt,
  }));
}
