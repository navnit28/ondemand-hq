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
  const { text, attachments = [], externalUserId = 'oda-user', brain = null } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text (string) is required' });
  // Brain validation (live-render upgrade): unknown brains are a 400, never a
  // silent fallback; forbidden endpoints throw per the central guard.
  let brainId = null;
  if (brain) {
    try {
      const { resolveBrain, assertBrainAllowed } = await import('./brains.js');
      brainId = assertBrainAllowed(resolveBrain(brain)).id;
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'ODA_UNKNOWN_BRAIN' });
    }
  }
  const run = runStore.createRun({ text, attachments, externalUserId, brain: brainId });
  // (runStore.createRun already emits run.created — exactly one frame per state change.)
  // Fire the engine asynchronously — the client follows progress on the SSE stream.
  startRun(run).catch((err) => console.error(`[oda-routes] startRun ${run.runId}: ${err.message}`));
  res.status(201).json({ runId: run.runId, status: run.status, brain: run.brain || 'sonnet-5' });
}));

router.get('/runs', (req, res) => res.json({ runs: runStore.listRuns() }));

router.get('/runs/:id', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  // Full durable state (recovery after refresh — M13). Trim event payloads to
  // the last 200 to keep the JSON light; the SSE stream replays the rest.
  const { events, _live, ...rest } = run;
  res.json({
    ...rest,
    events: events.slice(-200),
    openGates: openGates(run),
    gateSummary: gateSummary(run),
    downloadUrl: run.finalArtifact?.downloadUrl || null,
    liveDeck: run.liveDeck || null,
  });
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

// ---------------------------------------------------------------------------
// Phase 4 — artifact materialisation (editable PPTX/DOCX/XLSX + PDF/HTML/MD)
// ---------------------------------------------------------------------------

const FORMAT_MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

/**
 * POST /runs/:id/artifacts/:artifactId/materialize  { format }
 * Materialises a VERIFIED content artifact into an editable file via the
 * Phase 4 builders (per-slide QA for PPTX, live formulas for XLSX, RTL runs
 * for DOCX…). The file lands under server/oda/data/files/ and is served by
 * GET /files/:name; the run records the artifact URL + QA report.
 */
router.post('/runs/:id/artifacts/:artifactId/materialize', asyncH(async (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  const a = run.artifacts.find((x) => x.artifactId === req.params.artifactId);
  if (!a) return notFound(res, 'artifact');
  if (a.status !== 'verified') return res.status(409).json({ error: `artifact ${a.artifactId} is ${a.status} — only verified artifacts materialise` });
  const format = String(req.body?.format || '').toLowerCase();
  if (!FORMAT_MIME[format]) return res.status(400).json({ error: `format must be one of ${Object.keys(FORMAT_MIME).join('|')}` });

  const { parseContentSpec, buildArtifact } = await import('./builders/index.js');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'files');
  fs.mkdirSync(dir, { recursive: true });

  const spec = parseContentSpec(a.content || a.preview || '');
  if (!spec.title) spec.title = a.title;
  const langHint = /arabic|بالعربية/i.test(a.type) || a.type.startsWith('arabic-') ? 'ar' : 'en';
  spec.lang = spec.lang || langHint;
  const base = `${run.runId.slice(0, 8)}-${a.logicalId}-v${a.version}`.replace(/[^a-zA-Z0-9_-]/g, '');
  const outPath = path.join(dir, `${base}.${format}`);
  const result = await buildArtifact({ format, spec, outPath });

  const url = `/api/oda/files/${path.basename(outPath)}`;
  a.url = url;
  a.materialized = { format, bytes: result.bytes, qa: result.qa, at: new Date().toISOString() };
  runStore._flushSync(run);
  const { emitRunEvent } = await import('./events.js');
  emitRunEvent(run, 'artifact.preview.updated', { artifactId: a.artifactId, url, format, qa: result.qa });
  res.json({ artifactId: a.artifactId, url, format, bytes: result.bytes, qa: result.qa });
}));

/**
 * GET /runs/:id/download — ROBUST final-document download (2026-07-23 fix).
 * Re-packages the primary verified artifact on demand when the materialised
 * file is missing (fresh sandbox / restarted pod), then streams it with
 * correct Content-Type + Content-Disposition so the browser always gets a
 * real file download. This is what the gold 'Download final document'
 * button calls.
 */
router.get('/runs/:id/download', asyncH(async (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) return notFound(res, 'run');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'files');

  let rec = run.finalArtifact || null;
  let file = rec ? path.join(dir, path.basename(rec.downloadUrl)) : null;
  // 2026-07-23: re-package when the file is missing (ephemeral pod) OR the
  // recorded format predates the always-docx contract (md/html records from
  // older runs upgrade to a real .docx on their next download).
  const stale = rec && ['md', 'html'].includes(rec.format);
  if (!rec || stale || !fs.existsSync(file)) {
    const { packageRunArtifact } = await import('./autoArtifact.js');
    const pkg = await packageRunArtifact(run);
    if (!pkg.downloadUrl) return res.status(409).json({ error: `no downloadable document: ${pkg.reason || 'no verified artifact'}` });
    runStore._flushSync(run);
    rec = run.finalArtifact;
    file = path.join(dir, path.basename(rec.downloadUrl));
  }
  const name = path.basename(file);
  const ext = name.split('.').pop().toLowerCase();
  res.setHeader('Content-Type', FORMAT_MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', fs.statSync(file).size);
  res.setHeader('Accept-Ranges', 'none'); // probes get 200 + full headers, never 206/416
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'file read failed' }); else res.destroy(); });
  stream.pipe(res);
}));


/** GET /files/:name — serve materialised artifact files (download dock). */
router.get('/files/:name', asyncH(async (req, res) => {
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'files');
  const name = path.basename(req.params.name); // no traversal
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return notFound(res, 'file');
  const ext = name.split('.').pop().toLowerCase();
  res.setHeader('Content-Type', FORMAT_MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', fs.statSync(file).size);
  res.setHeader('Accept-Ranges', 'none');
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'file read failed' }); else res.destroy(); });
  stream.pipe(res);
}));

/** GET /brains — the selectable final-document brains (live-render upgrade). */
router.get('/brains', asyncH(async (req, res) => {
  const { describeBrains } = await import('./brains.js');
  res.json(describeBrains());
}));

/**
 * POST /widgets/stream — ODA Live Widget renderer (universal workspace).
 * Body { prompt }. Streams widget.meta / widget.chunk / widget.done SSE frames
 * from the REAL GLM 4.7 stream (contract: server/oda/widgetRenderer.js).
 */
router.post('/widgets/stream', asyncH(async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt (string) is required' });
  const { streamWidget } = await import('./widgetRenderer.js');
  const sessionId = await createOdSession('oda-widget', []);
  await streamWidget({ sessionId, prompt, res });
}));

/** GET /builders — observability: available Phase 4 builders. */
router.get('/builders', asyncH(async (req, res) => {
  const { listBuilders } = await import('./builders/index.js');
  res.json({ builders: listBuilders() });
}));

// 2026-07-23: terminal JSON error middleware — every unexpected throw in an
// ODA route yields JSON {error}, never Express's HTML error page.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[oda/routes] unhandled:', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'internal error' });
  else res.destroy();
});

export default router;
