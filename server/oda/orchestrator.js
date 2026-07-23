// orchestrator.js — the ODA application run engine (MIGRATION_MAP M1).
// Replaces the Claude `oda:oda` command: GLM 4.7 interpretation → pipeline plan →
// resumable approval gates → sequenced Sonnet 5 worker execution over verified
// handoffs → Thinker–Worker–Verifier gate per artifact → revision routed to the
// defect-OWNING skill → orchestrator synthesis. Every emitted event corresponds
// to real backend state (no timer-faked progress), and every status change goes
// through the runStore's validated transition graph.

import { createOdSession } from '../ondemand.js';
import { workerCall, interpreterCall, FINAL_DOC_BRAIN, FINAL_DOC_ENDPOINT_ID, assertFinalDocEndpoint } from './models.js';
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
// Live-render upgrade (2026-07-22): GLM 4.7 slide director + selectable final-
// document brain + mandatory downloadable artifact + terminal ASCII banner.
import { initLiveDeck, directorHooks, isSubstantiveEvidence } from './liveDeck.js';
import { resolveBrain, brainCall, DEFAULT_BRAIN, BRAINS } from './brains.js';
import { packageRunArtifact } from './autoArtifact.js';
import { streamAuthoringWithLiveFeed } from './liveStream.js';
import { printRunBanner, printRunFooter } from './asciiLogo.js';

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

/** Live-deck hooks accessor — re-attaches after resume/restart (functions don't persist). */
function liveOf(run) {
  if (!run._live || typeof run._live.onInterpreted !== 'function') {
    if (!run.liveDeck) initLiveDeck(run);
    run._live = directorHooks(run, { persist: () => _flushSync(run) });
  }
  return run._live;
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
    // ---- 0. LIVE DECK + BRAIN + TERMINAL BANNER (live-render upgrade) ----
    // Brain: validated at run creation (routes.js); default sonnet-5. GLM 4.7
    // remains interpreter-only — the brain authors the final document.
    run.brain = run.brain || DEFAULT_BRAIN;
    initLiveDeck(run);
    const live = liveOf(run);
    printRunBanner({ runId: run.runId, brain: run.brain, intent: run.request.text });

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
    live.onInterpreted(control); // slide 1 fills from the REAL interpretation

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
    live.onPipelineSelected(run.pipeline); // slides 1→final + 4 plan preview
    _flushSync(run);

    // ---- 3. PRE-EXECUTION SCOPE CONFIRMATION (2026-07-23: NEVER PARKS) ----
    // The pipeline engages IMMEDIATELY on Start run — with or without
    // attachments. Scope confirmation is a recorded decision + non-blocking
    // notice, never a 'Waiting for you' stop. The app NEVER asks for
    // documents; attachments stay optional via the Attach button only.
    if (control.requires_user_gate && control.mode === 'full') {
      const hasAttachments = (run.request.attachments || []).length > 0;
      addDecision(run, {
        summary: `Scope auto-approved (${hasAttachments ? 'attachments supplied as optional input' : 'no attachments — web-sourced evidence'}) — runs never park on scope confirmation`,
        decidedBy: 'system',
      });
      emitRunEvent(run, 'skill.progress', {
        nodeId: run.pipeline[0]?.nodeId || null,
        note: `notice: scope confirmation auto-approved — pipeline engaging immediately${hasAttachments ? ' (attachments in context)' : ' on web-sourced evidence'}`,
        notice: 'auto_approved_scope_gate',
      });
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
  // FINAL-DOCUMENT ENFORCEMENT (2026-07-22): every substantive authoring call
  // runs on opus-4.8, whatever brain was requested. The requested brain stays
  // recorded on the run; enforcement is surfaced on the event stream with the
  // REAL endpoint id (proof logging). assertFinalDocEndpoint throws on any
  // substitution — no silent downgrades.
  const requestedBrain = run.brain || DEFAULT_BRAIN;
  run.enforcedBrain = FINAL_DOC_BRAIN;
  assertFinalDocEndpoint(BRAINS[FINAL_DOC_BRAIN].endpointId);
  emitRunEvent(run, 'skill.progress', {
    nodeId: node.nodeId,
    note: `authoring endpoint ${BRAINS[FINAL_DOC_BRAIN].endpointId} (final-doc policy: opus-4.8 enforced${requestedBrain !== FINAL_DOC_BRAIN ? `; requested ${requestedBrain}` : ''})`,
    endpointId: BRAINS[FINAL_DOC_BRAIN].endpointId,
    enforcedBrain: FINAL_DOC_BRAIN,
    requestedBrain,
  });
  // Concurrent Cerebras live feed (2026-07-23): the opus-4.8 authoring runs as
  // a TOKEN STREAM; every 200 tokens the chunk is dispatched to Cerebras in
  // parallel and its digest patches the live-render cards progressively.
  // Falls back to the blocking brainCall only if streaming itself fails.
  let draftText;
  try {
    draftText = await streamAuthoringWithLiveFeed({
      run, node, sessionId, query, systemPrompt,
      persist: () => _flushSync(run),
    });
  } catch (streamErr) {
    console.warn(`[oda-live] streaming authoring failed (${streamErr.message}) — falling back to sync opus-4.8 call`);
    try {
      draftText = await brainCall({ brainId: FINAL_DOC_BRAIN, sessionId, query, systemPrompt });
    } catch (authErr) {
      // 2026-07-23: one extra spaced retry — the transport layer already
      // retries 401/403/5xx/network, so this only fires on longer blips.
      console.warn(`[oda-live] sync authoring failed too (${authErr.message}) — one spaced retry in 5s`);
      await new Promise((res) => setTimeout(res, 5000));
      draftText = await brainCall({ brainId: FINAL_DOC_BRAIN, sessionId, query, systemPrompt });
    }
  }

  const artifact = addArtifact(run, {
    logicalId: spec.logicalId, type: spec.type, title: spec.title,
    producedBy: node.skill, nodeId: node.nodeId,
    content: draftText, preview: String(draftText).slice(0, 800),
  });
  emitRunEvent(run, 'artifact.preview.updated', { artifactId: artifact.artifactId, preview: artifact.preview });

  // Evidence extraction (structured state, not prose): record tagged facts the
  // worker declared, if any, as evidence items (best-effort, non-fatal).
  for (const m of String(draftText).matchAll(/\*\*(?:tagged )?fact\*\*[:\s—-]*(.{10,180}?)(?:\n|$)/gi)) {
    const claim = m[1].trim();
    if (!isSubstantiveEvidence(claim)) continue; // meta/status lines never pollute run.evidence
    const evItem = addEvidence(run, { claim, tag: 'fact', addedBy: node.skill, nodeId: node.nodeId }); // emits evidence.added
    liveOf(run).onEvidence(evItem); // slide 2 fills from REAL evidence state
  }

  // GLM 4.7 slide director: slides 3+4 fill from the REAL draft artifact.
  try {
    await liveOf(run).onArtifactPreview(artifact, { interpreterCall, sessionId });
  } catch (dirErr) {
    console.warn(`[oda-live] slide director skipped: ${dirErr.message}`);
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

    // 2026-07-23 (incident 2bc9fe01): the verifier INFRASTRUCTURE call is
    // guarded — a thrown 401/403/timeout/network error must NEVER hard-kill
    // the run. The artifact ships as verified/'passed_unverified' with an
    // honest decision + non-blocking notice, and the pipeline continues
    // (never-park rule). A verifier that RAN and returned findings keeps the
    // existing pass/revise/ship machinery below.
    let findings;
    try {
      findings = await verifyArtifact({
        artifact,
        definitionOfDone,
        checks: manifest.verificationPolicy.checks,
        sharedRules: 'Bundle hard rules apply: no-invent; fact/assumption/web tagging; WAM/u.ae entity verification; ODA voice; entity-name hyperlink sourcing; uppercase k/M/B/T units.',
        workerCall: (args) => workerCall({ ...args, sessionId }),
        independent: manifest.verificationPolicy.independentVerifier,
      });
    } catch (verifierErr) {
      const msg = verifierErr?.message || String(verifierErr);
      console.warn(`[oda-verify] verifier infrastructure error for ${artifact.artifactId}: ${msg} — shipping unverified (never fatal)`);
      addDecision(run, { summary: `Verifier unavailable for ${artifact.artifactId} (${msg}) — shipped unverified; runs never fail on verifier infrastructure errors`, decidedBy: 'system' });
      emitRunEvent(run, 'skill.progress', {
        nodeId: node.nodeId,
        note: `notice: verifier unavailable (${msg}) — shipping with unverified-findings note`,
        notice: 'verifier_unavailable',
        artifactId: artifact.artifactId,
        errorCode: verifierErr?.errorCode || null,
      });
      setArtifactStatus(run, artifact.artifactId, 'verified', {
        status: 'passed_unverified', artifactId: artifact.artifactId, nodeId: node.nodeId,
        verifiedAt: new Date().toISOString(), findings: [], infraError: msg,
        errorCode: verifierErr?.errorCode || verifierErr?.code || null,
      });
      liveOf(run).onVerificationPassed(artifact.artifactId);
      ns.status = 'completed';
      ns.completedAt = new Date().toISOString();
      emitRunEvent(run, 'skill.completed', { nodeId: node.nodeId, skill: node.skill, artifactId: artifact.artifactId });
      if (run.status === 'verifying') transition(run, 'executing');
      _flushSync(run);
      return;
    }
    findings.nodeId = node.nodeId;
    run.verification.push(findings);

    if (findings.status === 'passed') {
      setArtifactStatus(run, artifact.artifactId, 'verified', findings); // emits verification.passed
      liveOf(run).onVerificationPassed(artifact.artifactId);
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
      // ESCALATE (bundle cap reached). 2026-07-23: the run NEVER parks here —
      // the best artifact ships WITH its open findings recorded honestly
      // (decision + non-blocking notice) and the pipeline continues. This
      // removes the 'Waiting for you' dead-end entirely.
      addDecision(run, {
        summary: `Shipped ${artifact.artifactId} with ${findings.findings.length} open verification finding(s) — runs never park on verifier escalation`,
        decidedBy: 'system',
      });
      emitRunEvent(run, 'skill.progress', {
        nodeId: node.nodeId,
        note: `notice: shipped with ${findings.findings.length} open finding(s) — review recommended`,
        notice: 'shipped_with_open_findings',
        artifactId: artifact.artifactId,
      });
      setArtifactStatus(run, artifact.artifactId, 'verified', { ...findings, status: 'passed_with_findings' });
      liveOf(run).onVerificationPassed(artifact.artifactId);
      ns.status = 'completed';
      ns.completedAt = new Date().toISOString();
      emitRunEvent(run, 'skill.completed', { nodeId: node.nodeId, skill: node.skill, artifactId: artifact.artifactId });
      if (run.status === 'verifying') transition(run, 'executing');
      _flushSync(run);
      return;
    }

    // REVISE loop: each defect group goes to its owning skill's surface.
    // 2026-07-23: the revision authoring calls are guarded — an infrastructure
    // throw ships the CURRENT draft with its open findings instead of killing
    // the run (never-park, never-fatal).
    ns.status = 'revising';
    transition(run, 'revising');
    const groups = planRevision(findings, { producedBy: node.skill });
    let revisedText = artifact.content;
    try {
    for (const group of groups) {
      const owningSurface = SKILL_SURFACE[group.owningSkill] || SKILL_SURFACE[node.skill];
      emitRunEvent(run, 'skill.progress', { nodeId: node.nodeId, note: `revision by ${group.owningSkill}`, defects: group.findings.length });
      const { systemPrompt } = buildContextBundle({ run, node: { ...node, skill: group.owningSkill in SKILL_SURFACE ? group.owningSkill : node.skill }, handoff: null, attachments: [], projectMemory: [], stepHint: 'revision' });
      emitRunEvent(run, 'skill.progress', { nodeId: node.nodeId, note: `revision authoring endpoint ${BRAINS[FINAL_DOC_BRAIN].endpointId} (final-doc policy)`, endpointId: BRAINS[FINAL_DOC_BRAIN].endpointId, owningSurface });
      revisedText = await brainCall({
        brainId: FINAL_DOC_BRAIN,
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
    } catch (revErr) {
      const msg = revErr?.message || String(revErr);
      console.warn(`[oda-revise] revision authoring unavailable for ${artifact.artifactId}: ${msg} — shipping current draft (never fatal)`);
      addDecision(run, { summary: `Revision authoring unavailable for ${artifact.artifactId} (${msg}) — shipped current draft with its open findings`, decidedBy: 'system' });
      emitRunEvent(run, 'skill.progress', {
        nodeId: node.nodeId,
        note: `notice: revision unavailable (${msg}) — shipping current draft with open findings`,
        notice: 'revision_unavailable',
        artifactId: artifact.artifactId,
      });
      setArtifactStatus(run, artifact.artifactId, 'verified', { ...findings, status: 'passed_with_findings', infraError: msg });
      liveOf(run).onVerificationPassed(artifact.artifactId);
      ns.status = 'completed';
      ns.completedAt = new Date().toISOString();
      emitRunEvent(run, 'skill.completed', { nodeId: node.nodeId, skill: node.skill, artifactId: artifact.artifactId });
      if (run.status === 'revising' || run.status === 'verifying') transition(run, 'executing');
      _flushSync(run);
      return;
    }
  }
}

/** Final synthesis (surface 'orchestrator-synthesis', Sonnet 5) + completion. */
async function completeRun(run) {
  const sessionId = await ensureSession(run);
  const verified = run.artifacts.filter((a) => a.status === 'verified');
  try {
    const synthesis = await brainCall({
      brainId: FINAL_DOC_BRAIN,
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
  // MANDATORY download URL (live-render upgrade): package the primary verified
  // artifact into a downloadable file BEFORE completing; surface it in the SSE
  // stream (artifact.download.ready + run.completed payload) and the run state.
  const pkg = await packageRunArtifact(run);
  if (pkg.downloadUrl) {
    emitRunEvent(run, 'artifact.download.ready', {
      artifactId: pkg.artifactId, downloadUrl: pkg.downloadUrl, format: pkg.format, bytes: pkg.bytes,
    });
  } else {
    console.warn(`[oda-live] packaging produced no download URL: ${pkg.reason}`);
  }
  liveOf(run).onRunCompleted({ downloadUrl: pkg.downloadUrl });
  transition(run, 'completed');
  run.timestamps.completedAt = new Date().toISOString();
  emitRunEvent(run, 'run.completed', {
    artifacts: run.artifacts.filter((a) => a.status === 'verified').map((a) => ({ artifactId: a.artifactId, type: a.type, title: a.title, version: a.version })),
    downloadUrl: pkg.downloadUrl || null,
    brain: run.brain || DEFAULT_BRAIN,
    durationMs: Date.parse(run.timestamps.completedAt) - Date.parse(run.timestamps.createdAt),
  });
  printRunFooter({ runId: run.runId, status: 'completed', downloadUrl: pkg.downloadUrl });
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
