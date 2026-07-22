// runStore.js — Durable ODARun store: validated status graph + disk persistence
// (MIGRATION_MAP M8/M12/M13).
//
// M12: LEGAL_TRANSITIONS is the single source of truth for the run status graph.
// transition() is the ONLY sanctioned way run.status may change; illegal moves
// throw ODA_ILLEGAL_TRANSITION rather than warn, per the migration rule that
// workflow-guard violations "throw, they don't warn".
//
// M13: every mutation persists write-through — debounced (50ms trailing),
// atomic (tmp file + rename) — so a durable ODARun document survives process
// restarts. loadAllRuns() hydrates the in-memory Map from
// server/oda/data/runs/*.json at import time; combined with events.js#subscribe
// replaying run.events for reconnecting SSE clients, "resume after refresh" is
// simply "read the run document, then replay its event log".
//
// M8: addArtifact() implements artifact versioning — regenerating a logicalId
// supersedes the prior version rather than deleting it, so every version stays
// inspectable in run.artifacts.
//
// Event wiring: this module imports emitRunEvent from events.js and fires it
// at every point where a mutation here has an unambiguous, one-to-one ODARunEventType
// counterpart (run.created on createRun, artifact.created on addArtifact,
// evidence.added on addEvidence, question.required on addGate, the
// verification.started/passed/failed triad on setArtifactStatus mirroring the
// verifying/verified/failed ODAArtifactStatus values, and run.completed/run.failed
// on transition() into those terminal statuses). Node/skill-level events
// (skill.queued/started/progress/completed, pipeline.selected,
// request.interpreted, artifact.preview.updated) need orchestration context
// (which skill, which control JSON) this generic store does not hold, so they
// are left for the orchestrator workstream to emit alongside its own calls
// into this store — kept out of here to avoid fabricating events that do not
// correspond to a real state change this module actually owns (M5).
//
// Plain ES module, JSDoc typed against contracts.d.ts. No external dependencies.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { emitRunEvent } from './events.js';

/**
 * @typedef {import('./contracts.d.ts').ODARun} ODARun
 * @typedef {import('./contracts.d.ts').ODARunStatus} ODARunStatus
 * @typedef {import('./contracts.d.ts').ODAArtifact} ODAArtifact
 * @typedef {import('./contracts.d.ts').ODAArtifactType} ODAArtifactType
 * @typedef {import('./contracts.d.ts').ODAGate} ODAGate
 * @typedef {import('./contracts.d.ts').ODAPipelineNode} ODAPipelineNode
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNS_DIR = path.join(__dirname, 'data', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

/** @type {Map<string, ODARun>} */
const runs = new Map();

const runFile = (runId) => path.join(RUNS_DIR, `run-${runId}.json`);

// ---------------------------------------------------------------------------
// Debounced, atomic, write-through persistence (M13)
// ---------------------------------------------------------------------------

/** @type {Map<string, NodeJS.Timeout>} runId -> pending debounce timer */
const pendingTimers = new Map();

function writeRunFileSync(run) {
  const file = runFile(run.runId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
  fs.renameSync(tmp, file); // atomic on POSIX filesystems — no half-written run files
}

/**
 * Schedule a debounced (50ms trailing) atomic write of `run` to disk. Repeated
 * calls within the window collapse into a single write, so a burst of
 * mutations (e.g. several addEvidence calls in a row) costs one disk write.
 * @param {ODARun} run
 */
function persist(run) {
  const existing = pendingTimers.get(run.runId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(run.runId);
    try {
      writeRunFileSync(run);
    } catch (err) {
      console.error(`[oda/runStore] persist failed for run ${run.runId}:`, err.message);
    }
  }, 50);
  timer.unref?.(); // never keep the process alive solely for a pending flush
  pendingTimers.set(run.runId, timer);
}

/**
 * Force an immediate synchronous flush of `run` to disk, bypassing the
 * debounce window. Used by tests and graceful-shutdown hooks that need the
 * on-disk state to be current before they return/exit.
 * @param {ODARun} run
 */
export function _flushSync(run) {
  const existing = pendingTimers.get(run.runId);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(run.runId);
  }
  writeRunFileSync(run);
}

/**
 * Hydrate the in-memory run Map from disk. Called once at import time below
 * (recovery after a process restart, M13); safe to call again if ever needed.
 * @returns {Map<string, ODARun>}
 */
export function loadAllRuns() {
  let files = [];
  try {
    files = fs.readdirSync(RUNS_DIR);
  } catch {
    files = []; // directory was just created by mkdirSync above — nothing to load yet
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(RUNS_DIR, name), 'utf8');
      const run = JSON.parse(raw);
      if (run && run.runId) runs.set(run.runId, run);
    } catch (err) {
      console.error(`[oda/runStore] failed to load run file ${name}:`, err.message);
    }
  }
  return runs;
}

loadAllRuns();

// ---------------------------------------------------------------------------
// Status graph (M12)
// ---------------------------------------------------------------------------

/** Every legal ODARunStatus value. */
export const STATUS = Object.freeze([
  'idle',
  'interpreting',
  'planning',
  'waiting_for_user',
  'executing',
  'verifying',
  'revising',
  'completed',
  'failed',
  'cancelled',
]);

// Explicit adjacency map. NOTE (deviation, documented): the brief's literal
// table omits three edges that its own pauseRun()/resumeRun() description
// requires — revising→waiting_for_user (pause while revising) and
// waiting_for_user→verifying / waiting_for_user→revising (resume back into
// those stages). Every edge below reproduces the brief's table verbatim; the
// three extra edges are additive only (nothing specified is removed) and are
// tagged "// pause/resume" so the reconciliation is easy to review.
const LEGAL_TRANSITIONS = Object.freeze({
  idle: ['interpreting', 'cancelled'],
  interpreting: ['planning', 'failed', 'cancelled'],
  planning: ['waiting_for_user', 'executing', 'failed', 'cancelled'],
  waiting_for_user: ['executing', 'planning', 'cancelled', 'failed', 'verifying', 'revising'], // last two: pause/resume
  executing: ['verifying', 'waiting_for_user', 'completed', 'failed', 'cancelled'],
  verifying: ['revising', 'executing', 'waiting_for_user', 'completed', 'failed', 'cancelled'],
  revising: ['executing', 'verifying', 'failed', 'cancelled', 'waiting_for_user'], // last: pause/resume
  completed: ['executing'], // return-to-earlier-approved-stage / single-artifact regeneration
  failed: ['executing', 'interpreting'], // retry
  cancelled: [],
});

const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);

function illegalTransitionError(runId, from, to) {
  const legal = LEGAL_TRANSITIONS[from] || [];
  const err = new Error(
    `ODA_ILLEGAL_TRANSITION: cannot move run ${runId} from '${from}' to '${to}' ` +
      `(legal transitions from '${from}': [${legal.join(', ')}])`
  );
  err.code = 'ODA_ILLEGAL_TRANSITION';
  return err;
}

/**
 * The ONLY sanctioned way to change run.status. Throws ODA_ILLEGAL_TRANSITION
 * if `nextStatus` is not reachable from the run's current status.
 * @param {ODARun} run
 * @param {ODARunStatus} nextStatus
 * @param {object} [meta] extra fields merged onto the run (e.g. { error }) —
 *   applied after the status/timestamp update, before persisting.
 * @returns {ODARun}
 */
export function transition(run, nextStatus, meta = {}) {
  const legal = LEGAL_TRANSITIONS[run.status] || [];
  if (!legal.includes(nextStatus)) {
    throw illegalTransitionError(run.runId, run.status, nextStatus);
  }
  run.status = nextStatus;
  run.timestamps.updatedAt = new Date().toISOString();
  if (meta && Object.keys(meta).length) Object.assign(run, meta);
  // Event narration policy (M5, single-narrator): the ORCHESTRATOR emits
  // run.completed / run.failed with rich payloads — transition() itself emits
  // nothing, so no status edge ever produces a duplicate frame.
  persist(run);
  return run;
}

// ---------------------------------------------------------------------------
// Run creation / lookup
// ---------------------------------------------------------------------------

/**
 * @param {{ text: string, attachments?: import('./contracts.d.ts').ArtifactReference[], externalUserId: string }} params
 * @returns {ODARun}
 */
export function createRun({ text, attachments = [], externalUserId }) {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  /** @type {ODARun} */
  const run = {
    runId,
    status: 'idle',
    request: { text, attachments, externalUserId },
    intent: null,
    mode: null,
    control: null,
    pipeline: [],
    currentNodeId: null,
    nodeStates: {},
    contextBundle: null,
    evidence: [],
    assumptions: [],
    decisions: [],
    artifacts: [],
    gates: [],
    verification: [],
    events: [],
    timestamps: { createdAt: now, updatedAt: now },
  };
  runs.set(runId, run);
  emitRunEvent(run, 'run.created', { text, externalUserId });
  persist(run);
  return run;
}

/**
 * @param {string} runId
 * @returns {ODARun|null}
 */
export function getRun(runId) {
  return runs.get(runId) || null;
}

/**
 * Lightweight run summaries for list views.
 * @returns {Array<{ id: string, status: ODARunStatus, intent: string|null, mode: string|null, createdAt: string, updatedAt: string }>}
 */
export function listRuns() {
  return [...runs.values()]
    .sort((a, b) => b.timestamps.updatedAt.localeCompare(a.timestamps.updatedAt))
    .map(({ runId, status, intent, mode, timestamps }) => ({
      id: runId,
      status,
      intent,
      mode,
      createdAt: timestamps.createdAt,
      updatedAt: timestamps.updatedAt,
    }));
}

// ---------------------------------------------------------------------------
// Artifact versioning (M8)
// ---------------------------------------------------------------------------

/**
 * Add a new artifact version for `logicalId`, superseding whichever version
 * of that logicalId was not already superseded. Prior versions are preserved
 * in run.artifacts (never removed) so the full lineage stays inspectable.
 * @param {ODARun} run
 * @param {{ logicalId: string, type: ODAArtifactType, title: string, producedBy: string, nodeId: string, content?: string, url?: string, preview?: string }} params
 * @returns {ODAArtifact}
 */
export function addArtifact(run, { logicalId, type, title, producedBy, nodeId, content, url, preview }) {
  const priorVersions = run.artifacts.filter((a) => a.logicalId === logicalId);
  const latest = priorVersions.length
    ? priorVersions.reduce((a, b) => (b.version > a.version ? b : a))
    : null;
  if (latest && latest.status !== 'superseded') {
    latest.status = 'superseded';
  }
  const version = latest ? latest.version + 1 : 1;
  /** @type {ODAArtifact} */
  const artifact = {
    artifactId: `${logicalId}-v${version}`,
    logicalId,
    type,
    title,
    version,
    status: 'draft',
    producedBy,
    nodeId,
    createdAt: new Date().toISOString(),
  };
  if (content !== undefined) artifact.content = content;
  if (url !== undefined) artifact.url = url;
  if (preview !== undefined) artifact.preview = preview;
  run.artifacts.push(artifact);
  run.timestamps.updatedAt = new Date().toISOString();
  emitRunEvent(run, 'artifact.created', { artifactId: artifact.artifactId, logicalId, type, version, nodeId });
  persist(run);
  return artifact;
}

// Maps the ODAArtifactStatus values that have an unambiguous 1:1 verification
// ODARunEventType onto that event type — 'draft'/'superseded' are bookkeeping
// states with no dedicated verification event (M5: only real, distinct state
// changes get a frame).
const VERIFICATION_EVENT_BY_STATUS = Object.freeze({
  verifying: 'verification.started',
  verified: 'verification.passed',
  failed: 'verification.failed',
});

/**
 * @param {ODARun} run
 * @param {string} artifactId
 * @param {import('./contracts.d.ts').ODAArtifactStatus} status
 * @param {import('./contracts.d.ts').VerificationFindings|null} [verification]
 * @returns {ODAArtifact}
 */
export function setArtifactStatus(run, artifactId, status, verification = null) {
  const artifact = run.artifacts.find((a) => a.artifactId === artifactId);
  if (!artifact) {
    const err = new Error(`ODA_ARTIFACT_NOT_FOUND: no artifact '${artifactId}' on run ${run.runId}`);
    err.code = 'ODA_ARTIFACT_NOT_FOUND';
    throw err;
  }
  artifact.status = status;
  if (verification) artifact.verification = verification;
  run.timestamps.updatedAt = new Date().toISOString();
  const eventType = VERIFICATION_EVENT_BY_STATUS[status];
  if (eventType) emitRunEvent(run, eventType, { artifactId, verification: verification || null });
  persist(run);
  return artifact;
}

/**
 * Highest-version artifact for `logicalId` whose status is 'verified', or
 * null if none has passed verification yet.
 * @param {ODARun} run
 * @param {string} logicalId
 * @returns {ODAArtifact|null}
 */
export function latestVerifiedArtifact(run, logicalId) {
  const verified = run.artifacts.filter((a) => a.logicalId === logicalId && a.status === 'verified');
  if (!verified.length) return null;
  return verified.reduce((a, b) => (b.version > a.version ? b : a));
}

// ---------------------------------------------------------------------------
// Pipeline graph helpers
// ---------------------------------------------------------------------------

/**
 * All nodeIds transitively downstream of `nodeId` (i.e. every node whose
 * dependsOn chain — direct or indirect — includes `nodeId`). Excludes
 * `nodeId` itself.
 * @param {ODAPipelineNode[]} pipeline
 * @param {string} nodeId
 * @returns {Set<string>}
 */
function downstreamNodeIds(pipeline, nodeId) {
  const dependants = new Map(); // nodeId -> nodeIds that depend on it directly
  for (const node of pipeline) {
    for (const dep of node.dependsOn || []) {
      if (!dependants.has(dep)) dependants.set(dep, []);
      dependants.get(dep).push(node.nodeId);
    }
  }
  const seen = new Set();
  const queue = [...(dependants.get(nodeId) || [])];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of dependants.get(id) || []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function requeueNode(run, nodeId) {
  const prior = run.nodeStates[nodeId] || { attempts: 0 };
  run.nodeStates[nodeId] = { status: 'queued', attempts: prior.attempts || 0 };
}

function supersedeNonVerifiedDrafts(run, nodeIds) {
  for (const artifact of run.artifacts) {
    if (nodeIds.has(artifact.nodeId) && artifact.status !== 'superseded' && artifact.status !== 'verified') {
      artifact.status = 'superseded';
    }
  }
}

function reopenExecutionIfTerminal(run) {
  if (run.status === 'completed' || run.status === 'failed') {
    transition(run, 'executing');
  } else {
    run.timestamps.updatedAt = new Date().toISOString();
    persist(run);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle operations
// ---------------------------------------------------------------------------

const PAUSABLE_STATUSES = new Set(['executing', 'verifying', 'revising', 'planning']);

/**
 * Pause an in-flight run so the user can be asked something. Remembers the
 * status it was paused from so resumeRun() can return to exactly that stage.
 * @param {ODARun} run
 * @returns {ODARun}
 */
export function pauseRun(run) {
  if (!PAUSABLE_STATUSES.has(run.status)) {
    const err = new Error(
      `ODA_ILLEGAL_TRANSITION: cannot pause run ${run.runId} from '${run.status}' ` +
        `(pausable only from: ${[...PAUSABLE_STATUSES].join(', ')})`
    );
    err.code = 'ODA_ILLEGAL_TRANSITION';
    throw err;
  }
  run.pausedFromStatus = run.status;
  transition(run, 'waiting_for_user');
  addDecision(run, { summary: 'paused by user', decidedBy: 'user' });
  return run;
}

/**
 * Resume a paused run back to whichever status it was paused from.
 * @param {ODARun} run
 * @returns {ODARun}
 */
export function resumeRun(run) {
  if (run.status !== 'waiting_for_user') {
    const err = new Error(
      `ODA_ILLEGAL_TRANSITION: cannot resume run ${run.runId} from '${run.status}' ` +
        `(resume is only legal from 'waiting_for_user')`
    );
    err.code = 'ODA_ILLEGAL_TRANSITION';
    throw err;
  }
  const target = run.pausedFromStatus || 'executing';
  delete run.pausedFromStatus;
  transition(run, target);
  run.timestamps.resumedAt = new Date().toISOString();
  persist(run);
  return run;
}

/**
 * Cancel a run from any non-terminal status.
 * @param {ODARun} run
 * @returns {ODARun}
 */
export function cancelRun(run) {
  if (TERMINAL_STATUS.has(run.status)) {
    const err = new Error(`ODA_ILLEGAL_TRANSITION: cannot cancel run ${run.runId} from terminal status '${run.status}'`);
    err.code = 'ODA_ILLEGAL_TRANSITION';
    throw err;
  }
  return transition(run, 'cancelled');
}

/**
 * Retry a failed/stuck node: re-queues it and every node transitively
 * downstream of it, superseding their non-verified draft artifacts (verified
 * artifacts are left alone until explicitly regenerated).
 * @param {ODARun} run
 * @param {string} nodeId
 * @returns {ODARun}
 */
export function retryNode(run, nodeId) {
  requeueNode(run, nodeId);
  const downstream = downstreamNodeIds(run.pipeline, nodeId);
  for (const id of downstream) requeueNode(run, id);
  supersedeNonVerifiedDrafts(run, new Set([nodeId, ...downstream]));
  reopenExecutionIfTerminal(run);
  return run;
}

/**
 * Return to an earlier APPROVED stage: unlike retryNode, the target node
 * itself (and its verified artifacts) is left untouched — only the nodes
 * strictly AFTER it (its transitive dependants) are re-queued.
 * @param {ODARun} run
 * @param {string} nodeId
 * @returns {ODARun}
 */
export function returnToStage(run, nodeId) {
  const downstream = downstreamNodeIds(run.pipeline, nodeId);
  for (const id of downstream) requeueNode(run, id);
  supersedeNonVerifiedDrafts(run, downstream);
  reopenExecutionIfTerminal(run);
  return run;
}

/**
 * Regenerate a single artifact: re-queues ONLY the node that produced its
 * latest version (not anything downstream), marking that version superseded.
 * @param {ODARun} run
 * @param {string} logicalId
 * @returns {ODARun}
 */
export function regenerateArtifact(run, logicalId) {
  const versions = run.artifacts.filter((a) => a.logicalId === logicalId);
  if (!versions.length) {
    const err = new Error(`ODA_ARTIFACT_NOT_FOUND: no artifact with logicalId '${logicalId}' on run ${run.runId}`);
    err.code = 'ODA_ARTIFACT_NOT_FOUND';
    throw err;
  }
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  latest.status = 'superseded';
  requeueNode(run, latest.nodeId);
  if (run.status === 'completed') {
    transition(run, 'executing');
  } else {
    run.timestamps.updatedAt = new Date().toISOString();
    persist(run);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Gate helpers (minimal — full gate orchestration lives in gates.js later)
// ---------------------------------------------------------------------------

/**
 * @param {ODARun} run
 * @param {Partial<ODAGate> & { gateType: string, prompt: string }} gate
 * @returns {ODAGate}
 */
export function addGate(run, gate) {
  /** @type {ODAGate} */
  const fullGate = {
    gateId: gate.gateId || crypto.randomUUID(),
    gateType: gate.gateType,
    nodeId: gate.nodeId ?? null,
    status: gate.status || 'open',
    prompt: gate.prompt,
    options: gate.options || [],
    raisedAt: gate.raisedAt || new Date().toISOString(),
  };
  if (gate.payload !== undefined) fullGate.payload = gate.payload;
  run.gates.push(fullGate);
  run.timestamps.updatedAt = new Date().toISOString();
  emitRunEvent(run, 'question.required', {
    gateId: fullGate.gateId, gateType: fullGate.gateType, nodeId: fullGate.nodeId,
    prompt: fullGate.prompt, options: fullGate.options, payload: fullGate.payload ?? null,
  });
  persist(run);
  return fullGate;
}

/**
 * @param {ODARun} run
 * @param {string} gateId
 * @param {{ approved: boolean, choice?: string, edits?: object }} resolution
 * @returns {ODAGate}
 */
export function resolveGate(run, gateId, resolution) {
  const gate = run.gates.find((g) => g.gateId === gateId);
  if (!gate) {
    const err = new Error(`ODA_GATE_NOT_FOUND: no gate '${gateId}' on run ${run.runId}`);
    err.code = 'ODA_GATE_NOT_FOUND';
    throw err;
  }
  if (gate.status !== 'open') {
    const err = new Error(`ODA_GATE_NOT_OPEN: gate '${gateId}' is already '${gate.status}'`);
    err.code = 'ODA_GATE_NOT_OPEN';
    throw err;
  }
  gate.status = resolution?.approved ? (resolution.edits ? 'edited' : 'approved') : 'rejected';
  gate.resolvedAt = new Date().toISOString();
  gate.resolution = resolution;
  addDecision(run, { gateId, summary: `gate '${gate.gateType}' ${gate.status}`, decidedBy: 'user' });
  run.timestamps.updatedAt = new Date().toISOString();
  persist(run);
  return gate;
}

// ---------------------------------------------------------------------------
// Evidence / decisions
// ---------------------------------------------------------------------------

/**
 * @param {ODARun} run
 * @param {Partial<import('./contracts.d.ts').ODAEvidenceItem>} item
 * @returns {import('./contracts.d.ts').ODAEvidenceItem}
 */
export function addEvidence(run, item) {
  const evidence = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...item };
  run.evidence.push(evidence);
  run.timestamps.updatedAt = new Date().toISOString();
  emitRunEvent(run, 'evidence.added', { evidenceId: evidence.id, tag: evidence.tag, nodeId: evidence.nodeId });
  persist(run);
  return evidence;
}

/**
 * @param {ODARun} run
 * @param {Partial<import('./contracts.d.ts').ODADecision>} entry
 * @returns {import('./contracts.d.ts').ODADecision}
 */
export function addDecision(run, entry) {
  const decision = { id: crypto.randomUUID(), ts: new Date().toISOString(), decidedBy: 'system', ...entry };
  run.decisions.push(decision);
  run.timestamps.updatedAt = new Date().toISOString();
  persist(run);
  return decision;
}
