// handoff.js — typed ODASkillHandoff contracts (MIGRATION_MAP §6).
// Skills communicate through VERIFIED artifacts and structured state only. A
// handoff is the precise brief the next skill receives: objective, definition of
// done, verified-artifact inputs, verified facts, assumptions, unresolved
// questions, expected output type. Construction validates the edge against the
// sequencing rules and refuses inputs that are not verified artifacts of the run.

import crypto from 'node:crypto';
import { isEdgeAllowed } from './sequencing.js';

const REQUIRED_FIELDS = Object.freeze([
  'runId', 'taskId', 'sourceSkill', 'targetSkill', 'objective', 'definitionOfDone',
  'inputs', 'verifiedFacts', 'assumptions', 'unresolvedQuestions', 'expectedOutputType',
  'mode', 'userApproved',
]);

/**
 * Build a validated ODASkillHandoff.
 *
 * @param {object} p
 * @param {object} p.run           the durable run (used to validate artifact inputs)
 * @param {string} p.sourceSkill   'oda' or a worker id
 * @param {string} p.targetSkill   worker id
 * @param {string} p.objective
 * @param {string[]} p.definitionOfDone
 * @param {Array<{artifactId:string, version?:number}>} p.inputs  MUST reference verified artifacts
 * @param {string[]} [p.verifiedFacts]
 * @param {string[]} [p.assumptions]
 * @param {string[]} [p.unresolvedQuestions]
 * @param {string} p.expectedOutputType
 * @param {'fast'|'full'} p.mode
 * @param {boolean} [p.userApproved]
 * @param {string} [p.parentTaskId]
 * @param {string} [p.route]       target route (storyline SUMMARY/TITLES) for edge validation
 * @returns {object} ODASkillHandoff
 */
export function buildHandoff({
  run, sourceSkill, targetSkill, objective, definitionOfDone, inputs = [],
  verifiedFacts = [], assumptions = [], unresolvedQuestions = [],
  expectedOutputType, mode, userApproved = false, parentTaskId, route,
}) {
  const defects = [];
  if (!run?.runId) defects.push('run with runId is required');
  if (!objective || typeof objective !== 'string') defects.push('objective (string) is required');
  if (!Array.isArray(definitionOfDone) || definitionOfDone.length === 0) defects.push('definitionOfDone must be a non-empty array');
  if (!expectedOutputType) defects.push('expectedOutputType is required');
  if (mode !== 'fast' && mode !== 'full') defects.push(`mode must be 'fast'|'full' (got ${mode})`);

  // Edge legality — the orchestrator may open any worker; worker→worker edges
  // must be in the allowed sequencing graph.
  if (sourceSkill !== 'oda' && !isEdgeAllowed(sourceSkill, targetSkill, { route })) {
    defects.push(`sequencing violation: ${sourceSkill} → ${targetSkill}${route ? ` (route ${route})` : ''} is not an allowed edge`);
  }

  // Inputs must be VERIFIED artifacts of this run (skills never pass raw prose).
  const verifiedIds = new Set((run?.artifacts || []).filter((a) => a.status === 'verified').map((a) => a.artifactId));
  for (const ref of inputs) {
    if (!ref?.artifactId) { defects.push('input reference missing artifactId'); continue; }
    if (!verifiedIds.has(ref.artifactId)) defects.push(`input ${ref.artifactId} is not a VERIFIED artifact of run ${run?.runId}`);
  }

  if (defects.length) {
    const err = new Error(`Invalid ODASkillHandoff (${sourceSkill}→${targetSkill}):\n${defects.map((d, i) => `${i + 1}. ${d}`).join('\n')}`);
    err.code = 'ODA_INVALID_HANDOFF';
    throw err;
  }

  const handoff = {
    runId: run.runId,
    taskId: crypto.randomUUID(),
    sourceSkill,
    targetSkill,
    objective: objective.slice(0, 600),
    definitionOfDone,
    inputs: inputs.map((r) => ({ artifactId: r.artifactId, ...(r.version ? { version: r.version } : {}) })),
    verifiedFacts,
    assumptions,
    unresolvedQuestions,
    expectedOutputType,
    mode,
    userApproved: Boolean(userApproved),
  };
  if (parentTaskId) handoff.parentTaskId = parentTaskId;
  return handoff;
}

/** Assert an object already shaped as a handoff is structurally complete. */
export function assertHandoff(h) {
  const missing = REQUIRED_FIELDS.filter((f) => !(f in (h || {})));
  if (missing.length) {
    const err = new Error(`ODASkillHandoff missing fields: ${missing.join(', ')}`);
    err.code = 'ODA_INVALID_HANDOFF';
    throw err;
  }
  return h;
}
