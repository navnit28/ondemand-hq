// routes.js — /api/oda Express router: the ODA application surface.
// Runs CRUD + lifecycle (pause/resume/retry/cancel/return-to-stage/regenerate),
// SSE run-event streaming (with ?since= replay for reconnection recovery),
// resumable gate resolution, and observability (registry, model config, call log).
// Mounted additively from server/index.js — no existing route is touched.

import express from 'express';
import * as runStore from './runStore.js';
import { subscribe, subscriberCount } from './events.js';
import { startRun, resolveGateAndContinue } from './orchestrator.js';
import { listManifests, getManifest, COMPAT_ROUTES } from './manifests.js';
import { ALLOWED_EDGES } from './sequencing.js';
import { describeModelConfig, getCallLog, getCallStats } from './models.js';
import { GATE_TYPES, GATE_DEFS, openGates, gateSummary } from './gates.js';
import { interpretRequest, heuristicInterpret } from './interpreter.js';
import { createOdSession } from '../ondemand.js';

const router = express.Router();

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });

// ---------------------------------------------------------------------------
// Observability / registry
// ---------------------------------------------------------------------------

router.get('/registry', (req, res) => {
  res.json({
    skills: listManifests().map((m) => ({
      id: m.id, version: m.version, name: m.name, purpose: m.purpose,
      supportedModes: m.supportedModes, producedArtifacts: m.producedArtifacts,
      requiredConnectors: m.requiredConnectors, permittedSkillCalls: m.permittedSkillCalls,
      modelEndpoint: m.modelEndpoint, routes: m.routes || null,
    })),
    compatRoutes: COMPAT_ROUTES,
    allowedEdges: ALLOWED_EDGES,
    gateTypes: GATE_TYPES,
  });
});

router.get('/registry/:id', (req, res) => {
  try {
    const { manifest, route } = getManifest(req.params.id);
    res.json({ manifest, route });
  } catch (err) {
    notFound(res, `skill ${req.params.id}`);
  }
});

router.get('/models', (req, res) => {
  res.json({ config: describeModelConfig(), stats: getCallStats() });
});

router.get('/models/calls', (req, res) => {
  res.json({ calls: getCallLog() });
});

// ---------------------------------------------------------------------------
// Interpretation probe (test surface — GLM 4.7 control JSON, no run created)
// ---------------------------------------------------------------------------

router.post('/interpret', asyncH(async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text (string) is required' });
  const sessionId = await createOdSession('oda-interpret-probe', []);
  const out = await interpretRequest({ sessionId, text });
  res.json(out);
}));

router.post('/interpret/heuristic', (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text (string) is required' });
  res.json({ control: heuristicInterpret(text), source: 'heuristic' });
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

router.post('/runs', asyncH(async (req, res) => {
  const { text, attachments = [], externalUserId = 'oda-user' } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text (string) is required' });
  const run = runStore.createRun({ text, attachments, externalUserId });
  // (runStore.createRun already emits run.created — exactly one frame per state change.)
  // Fire the engine asynchronously — the client follows progress on the SSE stream.
  startRun(run).catch((err) => console.error(`[oda-routes] startRun ${run.runId}: ${err.message}`));
  res.status(201).json({ runId: run.runId, status: run.status });
}));

router.get('/runs', (req, res) => res.json({ runs: runStore.listRuns() }));

router.get('/runs/:id', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  // Full durable state (recovery after refresh — M13). Trim event payloads to
  // the last 200 to keep the JSON light; the SSE stream replays the rest.
  const { events, ...rest } = run;
  res.json({ ...rest, events: events.slice(-200), openGates: openGates(run), gateSummary: gateSummary(run) });
});

// SSE event stream with reconnection replay: GET /runs/:id/events?since=<seq>
router.get('/runs/:id/events', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  const since = Number(req.query.since || 0) || 0;
  subscribe(run.runId, res, { since, run });
});

router.get('/runs/:id/subscribers', (req, res) => {
  res.json({ count: subscriberCount(req.params.id) });
});

// ---------------------------------------------------------------------------
// Gates (resumable approval states — M4)
// ---------------------------------------------------------------------------

router.post('/runs/:id/gates/:gateId', asyncH(async (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  const { approved = false, choice = null, edits = null } = req.body || {};
  try {
    await resolveGateAndContinue(run, req.params.gateId, { approved: Boolean(approved), choice, edits });
    res.json({ runId: run.runId, status: run.status, gate: run.gates.find((g) => g.gateId === req.params.gateId) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Lifecycle: pause / resume / cancel / retry / return-to-stage / regenerate
// ---------------------------------------------------------------------------

router.post('/runs/:id/pause', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  try { runStore.pauseRun(run); res.json({ runId: run.runId, status: run.status }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

router.post('/runs/:id/resume', asyncH(async (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  try {
    runStore.resumeRun(run);
    // Re-enter the engine so queued nodes continue after an explicit pause.
    const { resumeEngine } = await import('./orchestrator.js');
    resumeEngine(run).catch((err) => console.error(`[oda-routes] resumeEngine ${run.runId}: ${err.message}`));
    res.json({ runId: run.runId, status: run.status });
  } catch (err) { res.status(409).json({ error: err.message }); }
}));

router.post('/runs/:id/cancel', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  try { runStore.cancelRun(run); res.json({ runId: run.runId, status: run.status }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

router.post('/runs/:id/nodes/:nodeId/retry', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  try { runStore.retryNode(run, req.params.nodeId); res.json({ runId: run.runId, status: run.status, nodeStates: run.nodeStates }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

router.post('/runs/:id/nodes/:nodeId/return', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  try { runStore.returnToStage(run, req.params.nodeId); res.json({ runId: run.runId, status: run.status, nodeStates: run.nodeStates }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

router.post('/runs/:id/artifacts/:logicalId/regenerate', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  try { runStore.regenerateArtifact(run, req.params.logicalId); res.json({ runId: run.runId, status: run.status }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

router.get('/runs/:id/artifacts/:artifactId', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  const a = run.artifacts.find((x) => x.artifactId === req.params.artifactId);
  if (!a) return notFound(res, 'artifact');
  res.json(a);
});

export default router;
