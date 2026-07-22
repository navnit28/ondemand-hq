// orchestrator.js — the ODA application run engine (MIGRATION_MAP M1).
// Replaces the Claude `oda:oda` command: GLM 4.7 interpretation → pipeline plan →
// resumable approval gates → sequenced Sonnet 5 worker execution over verified
// handoffs → Thinker–Worker–Verifier gate per artifact → revision routed to the
// defect-OWNING skill → orchestrator synthesis. Every emitted event corresponds
// to real backend state (no timer-faked progress), and every status change goes
// through the runStore's validated transition graph.

import { createOdSession } from '../ondemand.js';
import { workerCall } from './models.js';
import { interpretRequest } from './interpreter.js';
import { getManifest } from './manifests.js';
import { validatePipeline, nextRunnableNodes } from './sequencing.js';
import { buildContextBundle } from './contextLoader.js';
import { buildHandoff } from './handoff.js';
import {
  transition, addArtifact, setArtifactStatus, addGate, resolveGate, addEvidence,
  addDecision, _flushSync,
} from './runStore.js';
import { emitRunEvent } from './events.js';
import { verifyArtifact, planRevision, REVISE_POLICY, shouldEscalate } from './verifier.js';
import { createGate, GATE_DEFS } from './gates.js';

/** Skill id → central model-config surface (models.js ODA_MODEL_ROUTING keys). */
const SKILL_SURFACE = Object.freeze({
  'problem-solve': 'problem-solving',
  benchmark: 'benchmarking',
  'data-scout': 'data-interpretation',
  model: 'model-construction',
  storyline: 'storyline',
  design: 'design',
  translate: 'translation',
  media: 'media',
});

/** Pre-execution approval gate per primary skill (FULL mode, M4). */
const PRE_EXECUTION_GATE = Object.freeze({
  'problem-solve': 'problem_definition',
  benchmark: 'scope_edit',
  model: 'model_structure',
  storyline: 'storyline',
  translate: 'english_before_arabic',
  design: 'scope_edit',
  media: 'scope_edit',
  'data-scout': 'scope_edit',
});

/** Default produced artifact (logicalId/type) per skill+route. */
function nodeArtifactSpec(node) {
  if (node.skill === 'storyline') {
    if (node.route === 'SUMMARY') return { logicalId: `${node.nodeId}-summary`, type: 'one-pager-summary', title: 'Executive one-pager (five zones)' };
    if (node.route === 'TITLES') return { logicalId: `${node.nodeId}-titles`, type: 'action-titles-md', title: 'Ranked action titles' };
    return { logicalId: `${node.nodeId}-storyline`, type: 'storyline-md', title: 'Storyline spec' };
  }
  const map = {
    'problem-solve': { type: 'workbook-md', title: 'Problem-solving workbook' },
    benchmark: { type: 'benchmark-report-md', title: 'Benchmarking report' },
    'data-scout': { type: 'insight-pack-md', title: 'Evidence pack (cited)' },
    model: { type: 'xlsx-model', title: 'Quantitative model spec' },
    design: { type: 'deck-html', title: 'Branded deck (HTML)' },
    translate: { type: 'markdown', title: 'Arabic deliverable' },
    media: { type: 'media-bilingual-md', title: 'Bilingual media deliverable' },
  };
  const m = map[node.skill] || { type: 'markdown', title: 'Deliverable' };
  return { logicalId: `${node.nodeId}-${node.skill}`, ...m };
}

/** Lazily create the run's OnDemand chat session (one per run). */
async function ensureSession(run) {
  if (!run.odSessionId) {
    run.odSessionId = await createOdSession(`oda-run-${run.runId}`, []);
    _flushSync(run);
  }
  return run.odSessionId;
}

/**
 * Start (or restart) the run engine for a run in status 'idle' | 'failed'.
 * Runs asynchronously; errors mark the run failed with run.failed emitted.
 */
export async function startRun(run) {
  try {
    // ---- 1. INTERPRET (GLM 4.7 → control JSON; heuristic fallback never fails) ----
    transition(run, 'interpreting');
    const sessionId = await ensureSession(run);
    const { control, source } = await interpretRequest({
      sessionId,
      text: run.request.text,
      attachmentsSummary: (run.request.attachments || []).map((a) => a.artifactId || a.name || '').join(', '),
    });
    run.intent = control.intent;
    run.mode = control.mode;
    run.control = control;
    emitRunEvent(run, 'request.interpreted', { control, source, safeStatus: control.safe_status });

    // ---- 2. PLAN (validate pipeline against sequencing rules) ----
    transition(run, 'planning');
    validatePipeline(control.pipeline); // throws on an illegal graph (interpreter already normalises)
    run.pipeline = control.pipeline;
    run.nodeStates = {};
    for (const node of run.pipeline) {
      run.nodeStates[node.nodeId] = { status: 'queued', attempts: 0 };
      emitRunEvent(run, 'skill.queued', { nodeId: node.nodeId, skill: node.skill, mode: node.mode, route: node.route || null });
    }
    emitRunEvent(run, 'pipeline.selected', {
      pipeline: run.pipeline, deliverables: control.deliverables,
      workspaceRenderer: control.workspace_renderer, mode: control.mode,
    });
    _flushSync(run);

    // ---- 3. PRE-EXECUTION GATE (FULL mode / interpreter-requested) ----
    if (control.requires_user_gate && control.mode === 'full') {
      const gateType = PRE_EXECUTION_GATE[control.primary_skill] || 'scope_edit';
      await raiseRunGate(run, {
        gateType,
        nodeId: run.pipeline[0]?.nodeId || null,
        payload: { intent: control.intent, pipeline: run.pipeline, deliverables: control.deliverables },
      });
      return run; // parked in waiting_for_user — resolveGateAndContinue resumes
    }

    // ---- 4. EXECUTE ----
    transition(run, 'executing');
    await executePipeline(run);
    return run;
  } catch (err) {
    failRun(run, err);
    return run;
  }
}

/** Raise a gate: park the run and emit question.required (M4). */
async function raiseRunGate(run, { gateType, nodeId = null, payload = null, promptOverride = null, options = null }) {
  const gate = createGate({ gateType, nodeId, payload, promptOverride, options });
  addGate(run, gate); // emits the enriched question.required frame
  transition(run, 'waiting_for_user', { reason: `gate:${gateType}` });
  _flushSync(run);
  return gate;
}

/**
 * Resolve a gate and resume the engine. Approved/edited → continue execution;
 * rejected → the run returns to planning and parks (the client may cancel or
 * re-plan). This is the resumable-gate contract: state lives server-side.
 */
export async function resolveGateAndContinue(run, gateId, { approved, choice = null, edits = null }) {
  const gate = (run.gates || []).find((g) => g.gateId === gateId);
  if (!gate) { const e = new Error(`gate ${gateId} not found on run ${run.runId}`); e.status = 404; throw e; }
  if (gate.status !== 'open') { const e = new Error(`gate ${gateId} already ${gate.status}`); e.status = 409; throw e; }

  const status = edits ? 'edited' : approved ? 'approved' : 'rejected';
  resolveGate(run, gateId, { approved: status !== 'rejected', choice, edits });
  gate.status = status;
  addDecision(run, { summary: `Gate ${gate.gateType} ${status}${choice ? ` (${choice})` : ''}`, decidedBy: 'user' });

  if (status === 'rejected') {
    transition(run, 'planning', { reason: 'gate rejected' });
    _flushSync(run);
    return run;
  }
  // Apply edits to the parked payload where relevant (scope/problem edits ride
  // into the next handoff as user-approved facts).
  if (edits && typeof edits === 'object') {
    run.assumptions.push(`User edit at ${gate.gateType}: ${JSON.stringify(edits).slice(0, 400)}`);
  }
  transition(run, 'executing', { reason: `gate ${gate.gateType} ${status}` });
  // Continue the engine ASYNCHRONOUSLY — the gate endpoint answers immediately
  // and the client follows progress on the SSE stream (same contract as
  // POST /runs). verification_findings gates resume the REVISION path.
  const continuation = (gate.gateType === 'verification_findings' && gate.nodeId)
    ? executePipeline(run, { reviseNodeId: choice === 'Override and proceed' ? null : gate.nodeId, overrideNodeId: choice === 'Override and proceed' ? gate.nodeId : null })
    : executePipeline(run);
  continuation.catch((err) => failRun(run, err));
  return run;
}

/** Mark a run failed (single funnel — always emits run.failed). */
function failRun(run, err, nodeId = null) {
  try {
    run.error = { message: err?.message || String(err), ...(nodeId ? { nodeId } : {}) };
    if (run.status !== 'failed') transition(run, 'failed', { error: run.error.message });
    emitRunEvent(run, 'run.failed', { error: run.error.message, nodeId, errorCode: err?.errorCode || err?.code });
    _flushSync(run);
  } catch (inner) {
    console.error(`[oda-orchestrator] failRun cascade on ${run.runId}: ${inner.message}`);
  }
}

/**
 * The pipeline executor: runs every runnable node (verification-gated — a node
 * becomes runnable only when its dependencies are completed WITH verified
 * artifacts), parallelising genuinely independent nodes, until the pipeline
 * completes, parks at a gate, or fails.
 */
async function executePipeline(run, { reviseNodeId = null, overrideNodeId = null } = {}) {
  // A verification_findings override: accept the draft as-is (user decision).
  if (overrideNodeId) {
    const ns = run.nodeStates[overrideNodeId];
    const draft = [...run.artifacts].reverse().find((a) => a.nodeId === overrideNodeId && a.status !== 'superseded');
    if (draft) {
      setArtifactStatus(run, draft.artifactId, 'verified', { status: 'passed', findings: [], overriddenByUser: true }); // emits verification.passed
    }
    if (ns) { ns.status = 'completed'; ns.completedAt = new Date().toISOString(); }
    emitRunEvent(run, 'skill.completed', { nodeId: overrideNodeId, overriddenByUser: true });
  }
  if (reviseNodeId) {
    const ns = run.nodeStates[reviseNodeId];
    if (ns) ns.status = 'queued'; // re-run the node through the revise path
  }

  for (;;) {
    if (run.status === 'cancelled' || run.status === 'failed') return;
    if (run.status === 'waiting_for_user') return; // a mid-run gate parked us
    const runnable = nextRunnableNodes(run.pipeline, run.nodeStates, run.artifacts);
    if (!runnable.length) break;
    // Genuinely independent runnable nodes execute concurrently.
    const results = await Promise.allSettled(runnable.map((node) => executeNode(run, node)));
    const firstFailure = results.find((r) => r.status === 'rejected');
    if (firstFailure) { failRun(run, firstFailure.reason); return; }
    if (['waiting_for_user', 'cancelled', 'failed'].includes(run.status)) return;
  }

  const unfinished = Object.entries(run.nodeStates).filter(([, s]) => !['completed', 'skipped'].includes(s.status));
  if (unfinished.length) {
    // Nothing runnable but nodes remain → a dependency failed verification and
    // parked at a gate, or the graph stalled; if no open gate, that is a fault.
    if ((run.gates || []).some((g) => g.status === 'open')) return;
    failRun(run, new Error(`pipeline stalled: nodes ${unfinished.map(([id]) => id).join(', ')} not runnable and no open gate`));
    return;
  }

  await completeRun(run);
}

/** Execute ONE pipeline node end to end: brief → worker → verify → (revise loop). */
async function executeNode(run, node) {
  const ns = run.nodeStates[node.nodeId];
  ns.status = 'running';
  ns.startedAt = new Date().toISOString();
  ns.attempts = (ns.attempts || 0) + 1;
  emitRunEvent(run, 'skill.started', { nodeId: node.nodeId, skill: node.skill, mode: node.mode, route: node.route || null, attempt: ns.attempts });

  const sessionId = await ensureSession(run);
  const surface = SKILL_SURFACE[node.skill];
  const manifest = getManifest(node.skill).manifest;
  run.currentNodeId = node.nodeId;

  // ---- Typed handoff (M§6): inputs are the dependencies' verified artifacts ----
  const depArtifacts = (node.dependsOn || [])
    .map((depId) => [...run.artifacts].reverse().find((a) => a.nodeId === depId && a.status === 'verified'))
    .filter(Boolean);
  const sourceSkill = node.dependsOn?.length
    ? (run.pipeline.find((n) => n.nodeId === node.dependsOn[0])?.skill || 'oda')
    : 'oda';
  const spec = nodeArtifactSpec(node);
  const definitionOfDone = [
    `Produce the ${spec.title} (${spec.type}) satisfying the objective`,
    'Obey every shared ODA execution rule (voice, no-invent, tagging, sourcing, entity verification, partnership framing)',
    ...(manifest.verificationPolicy.checks || []).map((c) => `Pass check: ${c}`),
  ];
  const handoff = buildHandoff({
    run,
    sourceSkill,
    targetSkill: node.skill,
    objective: node.objective || run.intent || run.request.text,
    definitionOfDone,
    inputs: depArtifacts.map((a) => ({ artifactId: a.artifactId })),
    verifiedFacts: run.evidence.filter((e) => e.tag === 'fact').map((e) => e.claim).slice(0, 20),
    assumptions: run.assumptions.slice(0, 20),
    unresolvedQuestions: [],
    expectedOutputType: spec.type,
    mode: node.mode,
    userApproved: (run.gates || []).some((g) => g.status !== 'open' && g.status !== 'rejected'),
    route: node.route,
  });

  // ---- Selective context (M6) ----
  const { systemPrompt, contextBlock, loadedRefs } = buildContextBundle({
    run, node, handoff,
    attachments: run.request.attachments || [],
    projectMemory: [],
    stepHint: node.objective || '',
  });
  run.contextBundle = { sharedRulesDigest: 'shared-rules-v1', loadedRefs };
  emitRunEvent(run, 'skill.progress', { nodeId: node.nodeId, note: 'context assembled', loadedRefs, safeStatus: safeStatusFor(node) });

  // ---- WORKER (Sonnet 5 — the only author of deliverable content) ----
  const query = `${contextBlock}\n\n--- PRODUCE ---\n${spec.title} (${spec.type}) in mode ${node.mode.toUpperCase()}. Objective: ${handoff.objective}\nReturn ONLY the deliverable content in markdown (or HTML for deck-html) — no preamble, no self-commentary; append a final "Self-report" section (what you did, assumed, could not resolve).`;
  const draftText = await workerCall({
    surface, sessionId, query, systemPrompt,
    pluginIds: [], stream: false,
  });

  const artifact = addArtifact(run, {
    logicalId: spec.logicalId, type: spec.type, title: spec.title,
    producedBy: node.skill, nodeId: node.nodeId,
    content: draftText, preview: String(draftText).slice(0, 800),
  });
  emitRunEvent(run, 'artifact.preview.updated', { artifactId: artifact.artifactId, preview: artifact.preview });

  // Evidence extraction (structured state, not prose): record tagged facts the
  // worker declared, if any, as evidence items (best-effort, non-fatal).
  for (const m of String(draftText).matchAll(/\*\*fact\*\*[:\s—-]*(.{10,180}?)(?:\n|$)/gi)) {
    addEvidence(run, { claim: m[1].trim(), tag: 'fact', addedBy: node.skill, nodeId: node.nodeId }); // emits evidence.added
  }

  // ---- VERIFIER (Sonnet 5, surface 'verification'; independent per policy) ----
  await verifyNodeArtifact(run, node, artifact, definitionOfDone, manifest);
}

function safeStatusFor(node) {
  return {
    'data-scout': 'Gathering evidence',
    benchmark: 'Gathering evidence',
    'problem-solve': 'Structuring the analysis',
    model: 'Building the model',
    storyline: 'Preparing your document',
    design: 'Designing the deliverable',
    translate: 'Translating the document',
    media: 'Preparing your document',
  }[node.skill] || 'Understanding the request';
}

/** Verification + defect-owned revision loop for one node's artifact (M7). */
async function verifyNodeArtifact(run, node, artifact, definitionOfDone, manifest) {
  const ns = run.nodeStates[node.nodeId];
  const sessionId = await ensureSession(run);

  for (let round = 0; ; round++) {
    ns.status = 'verifying';
    transition(run, 'verifying');
    setArtifactStatus(run, artifact.artifactId, 'verifying'); // emits verification.started

    const findings = await verifyArtifact({
      artifact,
      definitionOfDone,
      checks: manifest.verificationPolicy.checks,
      sharedRules: 'Bundle hard rules apply: no-invent; fact/assumption/web tagging; WAM/u.ae entity verification; ODA voice; entity-name hyperlink sourcing; uppercase k/M/B/T units.',
      workerCall: (args) => workerCall({ ...args, sessionId }),
      independent: manifest.verificationPolicy.independentVerifier,
    });
    findings.nodeId = node.nodeId;
    run.verification.push(findings);

    if (findings.status === 'passed') {
      setArtifactStatus(run, artifact.artifactId, 'verified', findings); // emits verification.passed
      ns.status = 'completed';
      ns.completedAt = new Date().toISOString();
      emitRunEvent(run, 'skill.completed', { nodeId: node.nodeId, skill: node.skill, artifactId: artifact.artifactId });
      if (run.status === 'verifying') transition(run, 'executing');
      _flushSync(run);
      return;
    }

    // FAILED — route back to the defect-OWNING skill (never patch downstream).
    setArtifactStatus(run, artifact.artifactId, 'failed', findings); // emits verification.failed (full findings)

    if (shouldEscalate(round + 1)) {
      // ESCALATE (bundle cap reached): surface unresolved defects honestly via a
      // resumable verification_findings gate — never ship, never silently pass.
      ns.status = 'failed';
      await raiseRunGate(run, {
        gateType: 'verification_findings',
        nodeId: node.nodeId,
        payload: { artifactId: artifact.artifactId, findings: findings.findings },
      });
      return;
    }

    // REVISE loop: each defect group goes to its owning skill's surface.
    ns.status = 'revising';
    transition(run, 'revising');
    const groups = planRevision(findings, { producedBy: node.skill });
    let revisedText = artifact.content;
    for (const group of groups) {
      const owningSurface = SKILL_SURFACE[group.owningSkill] || SKILL_SURFACE[node.skill];
      emitRunEvent(run, 'skill.progress', { nodeId: node.nodeId, note: `revision by ${group.owningSkill}`, defects: group.findings.length });
      const { systemPrompt } = buildContextBundle({ run, node: { ...node, skill: group.owningSkill in SKILL_SURFACE ? group.owningSkill : node.skill }, handoff: null, attachments: [], projectMemory: [], stepHint: 'revision' });
      revisedText = await workerCall({
        surface: owningSurface, // revision runs on the defect-owning skill's surface (Sonnet 5)
        sessionId,
        systemPrompt,
        query: `--- ARTIFACT UNDER REVISION (${artifact.type}) ---\n${revisedText}\n\n--- VERIFIER FINDINGS (fix ONLY these; you own defects of your discipline) ---\n${group.findings.map((f, i) => `${i + 1}. [${f.severity}/${f.category}] at ${f.location}: ${f.message} → ${f.requiredAction}`).join('\n')}\n\nReturn the FULL corrected artifact content — no commentary.`,
      });
    }
    // New version of the same logical artifact; prior version preserved.
    artifact = addArtifact(run, {
      logicalId: artifact.logicalId, type: artifact.type, title: artifact.title,
      producedBy: node.skill, nodeId: node.nodeId,
      content: revisedText, preview: String(revisedText).slice(0, 800),
    });
    emitRunEvent(run, 'artifact.preview.updated', { artifactId: artifact.artifactId, preview: artifact.preview, revision: true });
    transition(run, 'executing'); // loop continues → verifying again
  }
}

/** Final synthesis (surface 'orchestrator-synthesis', Sonnet 5) + completion. */
async function completeRun(run) {
  const sessionId = await ensureSession(run);
  const verified = run.artifacts.filter((a) => a.status === 'verified');
  try {
    const synthesis = await workerCall({
      surface: 'orchestrator-synthesis',
      sessionId,
      systemPrompt: 'You are the ODA orchestrator. Synthesise ONE short answer-first completion note (≤150 words, British English, ODA voice) telling the user what was produced, which artifacts are ready, and any assumptions to note. No new claims, no new figures.',
      query: `Request: ${run.request.text}\nIntent: ${run.intent}\nVerified artifacts:\n${verified.map((a) => `• ${a.title} (${a.type}, v${a.version})`).join('\n')}\nAssumptions: ${run.assumptions.join('; ') || '(none)'}`,
    });
    const summary = addArtifact(run, {
      logicalId: 'run-synthesis', type: 'markdown', title: 'Run synthesis',
      producedBy: 'oda', nodeId: 'oda', content: synthesis, preview: String(synthesis).slice(0, 800),
    });
    setArtifactStatus(run, summary.artifactId, 'verified', { status: 'passed', findings: [] });
  } catch (err) {
    // Synthesis failure does not un-verify delivered artifacts — complete honestly without it.
    console.warn(`[oda-orchestrator] synthesis failed on ${run.runId}: ${err.message}`);
  }
  transition(run, 'completed');
  run.timestamps.completedAt = new Date().toISOString();
  emitRunEvent(run, 'run.completed', {
    artifacts: run.artifacts.filter((a) => a.status === 'verified').map((a) => ({ artifactId: a.artifactId, type: a.type, title: a.title, version: a.version })),
    durationMs: Date.parse(run.timestamps.completedAt) - Date.parse(run.timestamps.createdAt),
  });
  _flushSync(run);
}

/**
 * Re-enter the engine after an explicit pause/resume (or process restart with a
 * hydrated run): continues executing queued nodes from durable state.
 */
export async function resumeEngine(run) {
  if (!['executing', 'verifying', 'revising'].includes(run.status)) return run;
  try {
    await executePipeline(run);
  } catch (err) {
    failRun(run, err);
  }
  return run;
}

export { SKILL_SURFACE, PRE_EXECUTION_GATE };
