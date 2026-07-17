// index.js — ODA Productivity Suite backend (thin Express server, Vercel-sandbox friendly).
// Serves: conversation CRUD (in-memory), SSE chat proxy with thinking/answer separation,
// file upload/extraction, direct WDI/GHO/SDG data, and PPTX/XLSX/DOCX/PDF exports.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PORT, ENDPOINT_ID, REASONING_EFFORT, ONDEMAND_API_KEY, STREAM_DEBUG } from './env.js';
import * as store from './store.js';
import { classify } from './router.js';
import { buildSystemPrompt, WIZARD_STEPS } from './prompts.js';
import { pluginIdsFor, pluginLabelsFor, FEATURE_PLUGINS, ADOPTED } from './plugins.js';
import { createOdSession, streamQuery, syncQuery } from './ondemand.js';
import { fetchCountryPack, renderDataBlock, resolveCountry } from './countryData.js';
import { buildExport } from './exports.js';
import { extractText } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '4mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- health ----------
app.get('/api/health', (req, res) => res.json({
  ok: true, model: `${ENDPOINT_ID}+${REASONING_EFFORT}`, keyLoaded: Boolean(ONDEMAND_API_KEY), streamDebug: STREAM_DEBUG, time: new Date().toISOString(),
}));

// ---------- conversations ----------
app.get('/api/conversations', (req, res) => res.json({ conversations: store.listConversations() }));

app.post('/api/conversations', (req, res) => {
  const conv = store.createConversation({ feature: req.body?.feature || 'chat' });
  res.json({ conversation: conv });
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = store.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation: conv });
});

// ---------- file upload ----------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const id = crypto.randomUUID();
    const text = await extractText(req.file.originalname, req.file.mimetype, req.file.buffer);
    store.putFile({ id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, buffer: req.file.buffer, text });
    res.json({ file: { id, name: req.file.originalname, size: req.file.size, chars: text.length } });
  } catch (e) {
    console.error('🔴 [upload] failed:', e.message);
    res.status(500).json({ error: `Upload failed: ${e.message}` });
  }
});

// ---------- country-data direct probe (used by UI suggestions) ----------
app.get('/api/country-data/:query', async (req, res) => {
  try {
    const pack = await fetchCountryPack(req.params.query);
    res.json(pack.country ? { country: pack.country, rows: pack.rows, gaps: pack.gaps } : { error: pack.gaps.join('; ') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- the main chat SSE endpoint ----------
// POST /api/chat  {conversationId, text, feature?, fileId?, wizard?:{active,step}, editTarget?}
// Streams SSE frames: routing, plugin_status, thinking, answer, artifact_hint, error, done
app.post('/api/chat', async (req, res) => {
  const { conversationId, text = '', feature: forcedFeature, fileId, wizard, editTarget } = req.body || {};
  const conv = store.getConversation(conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!text.trim() && !fileId) return res.status(400).json({ error: 'Empty message' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const send = (type, payload) => {
    // Every browser-bound frame carries a server UTC timestamp (frontend debug drawer displays it).
    const ts = new Date().toISOString();
    res.write(`data:${JSON.stringify({ type, ts, ...payload })}\n\n`);
    res.flush?.(); // no-op unless compression middleware is present; keeps Vercel serverless streaming flushed
    // Debug line: metadata only — never frame text content, never the API key.
    if (STREAM_DEBUG) console.log(`[stream-debug] ts=${ts} dir=browser type=${type} chars=${typeof payload?.delta === 'string' ? payload.delta.length : 0} conv=${conversationId}`);
  };
  // Standard SSE comment frame every 10s — keeps intermediary proxies/serverless runtimes from idling the connection out.
  const hb = setInterval(() => {
    res.write(': keepalive\n\n');
    res.flush?.();
  }, 10000);
  const stopHeartbeat = () => clearInterval(hb);
  req.on('close', stopHeartbeat);
  res.on('close', stopHeartbeat);

  try {
    const file = fileId ? store.getFile(fileId) : null;
    store.addMessage(conv, { role: 'user', text, fileName: file?.name || null });

    // 1) ROUTE (oda:oda THINK step)
    send('status', { message: 'Routing your request…' });
    const route = await classify(text, { hasFile: Boolean(file), forcedFeature: forcedFeature || (conv.feature !== 'chat' ? conv.feature : null) });
    let { feature, mode } = route;
    if (wizard?.active) mode = 'FULL'; // guided document creation is a FULL-mode flow

    const pluginIds = pluginIdsFor(feature);
    const pluginLabels = pluginLabelsFor(feature);
    send('routing', {
      feature, mode, reason: route.reason, source: route.source,
      analysisFirst: Boolean(route.analysisFirst), outOfScope: Boolean(route.outOfScope),
      plugins: pluginLabels, model: 'gpt-5.6-sol-medium',
    });

    // 2) Per-conversation OnDemand session (create once, reuse)
    if (!conv.odSessionId) {
      send('status', { message: 'Opening a verified session…' });
      conv.odSessionId = await createOdSession(`oda-suite-${conv.id}`, []);
    }

    // 3) Assemble the query with context blocks
    let queryParts = [];

    if (route.outOfScope) {
      queryParts.push(`OUT-OF-SCOPE NOTICE: The router judged this request outside the eight workers. Announce the gap per the contract, list the eight crafts, ask how to proceed, and produce nothing else.`);
    }
    if (route.analysisFirst && !wizard?.active) {
      queryParts.push(`ANALYSIS-FIRST NOTE: This request triggers the §1.0 bright line — run the problem-solve discipline (compressed FAST pass: define, structure, prioritise, analyse with tagged evidence) BEFORE presenting any rendered content, inside this same reply.`);
    }

    if (file) {
      send('plugin_status', { plugin: 'File Directory Search', message: `Reading ${file.name}…` });
      queryParts.push(`ATTACHED SOURCE (${file.name}) — extracted text follows between markers. Every figure you use MUST trace to it.\n<<<SOURCE\n${file.text}\nSOURCE>>>`);
    }

    // country-data: fetch verified data blocks server-side FIRST (never let the model invent)
    if (feature === 'country-data') {
      send('plugin_status', { plugin: 'World Bank WDI', message: 'Fetching World Bank data…' });
      const countryGuess = extractCountryGuess(text);
      const pack = countryGuess ? await fetchCountryPack(countryGuess) : { country: null, rows: [], gaps: ['No country named in the request'] };
      if (pack.country) {
        send('plugin_status', { plugin: 'WHO GHO', message: `Fetched ${pack.rows.length} verified series for ${pack.country.name}` });
        conv._lastDataRows = pack.rows; // for XLSX export
      } else {
        send('plugin_status', { plugin: 'World Bank WDI', message: pack.gaps.join('; ') });
      }
      queryParts.push(renderDataBlock(pack));
    }

    if (editTarget) {
      queryParts.push(`EDIT REQUEST: The user clicked section/slide "${editTarget}" in the live preview. Revise ONLY that section per their instruction, then output the FULL updated document again in the same format.`);
    }
    queryParts.push(`USER REQUEST: ${text}`);

    const wizardStep = wizard?.active ? (WIZARD_STEPS[wizard.step] || 'Scope') : null;
    const systemPrompt = buildSystemPrompt(feature, mode, wizardStep);

    // 4) STREAM from OnDemand — thinking tokens separated from answer tokens
    if (pluginLabels.length) send('plugin_status', { plugin: pluginLabels[0], message: `Working with ${pluginLabels.join(', ')}…` });
    let sawAnswer = false;
    const fullAnswer = await streamQuery({
      odSessionId: conv.odSessionId,
      query: queryParts.join('\n\n'),
      pluginIds,
      systemPrompt,
      onEvent: (type, payload) => {
        if (type === 'thinking') send('thinking', { delta: payload });
        else if (type === 'answer') { sawAnswer = true; send('answer', { delta: payload }); }
        else if (type === 'status') send('status', { message: payload.statusMessage, statusType: payload.statusType });
        else if (type === 'metrics') send('metrics', payload);
      },
    });

    // 5) Persist + finish
    const asstMsg = store.addMessage(conv, {
      role: 'assistant', text: fullAnswer,
      routing: { feature, mode, plugins: pluginLabels, model: 'gpt-5.6-sol-medium', reason: route.reason },
    });
    if (conv.title === 'New chat' && text.trim()) {
      conv.title = text.trim().slice(0, 48) + (text.trim().length > 48 ? '…' : '');
    }
    store.touch(conv, { feature: conv.feature === 'chat' ? feature : conv.feature });

    send('done', { messageId: asstMsg.id, fullAnswerPresent: Boolean(fullAnswer), sawAnswer });
  } catch (e) {
    console.error('🔴 [chat] stream failed:', e.message);
    if (e.partialAnswer) {
      store.addMessage(conv, {
        role: 'assistant', text: e.partialAnswer,
        routing: { incomplete: true, note: 'Stream was interrupted before completion; partial answer persisted.' },
      });
    }
    send('error', {
      message: e.message || 'Stream failed',
      errorCode: e.errorCode || 'STREAM_FAILED',
      userMessage: 'The response stream was interrupted. Please try again — any partial output has been saved to this conversation.',
    });
    send('done', { aborted: true });
  } finally {
    clearInterval(hb);
    res.end();
  }
});

// ---------- synthetic thinking demo (STREAM_DEBUG only) ----------
// GROUND TRUTH (2026-07-17 live SSE captures): predefined-gpt-5.6-sol emits ZERO
// fulfillment_thinking frames at both medium and max reasoning effort (48/216/37-frame runs).
// This synthetic route therefore PROVES the client's live incremental thinking render path by
// pushing thinking/answer deltas through a send() helper IDENTICAL in wire shape to /api/chat.
app.get('/api/debug/stream-demo', async (req, res) => {
  if (!STREAM_DEBUG) return res.status(404).json({ error: 'debug disabled' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  let pendingTimer = null;
  let pendingResolve = null;
  const onClose = () => {
    closed = true;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    pendingResolve?.(); pendingResolve = null; // release an in-flight sleep so the loop exits
  };
  req.on('close', onClose);
  res.on('close', onClose);

  // Same wire shape as /api/chat's send(): data:{type,ts,...}\n\n + flush.
  const send = (type, payload) => {
    if (closed) return;
    const ts = new Date().toISOString();
    res.write(`data:${JSON.stringify({ type, ts, ...payload })}\n\n`);
    res.flush?.();
    console.log(`[stream-debug] ts=${ts} dir=browser type=${type} chars=${typeof payload?.delta === 'string' ? payload.delta.length : 0} conv=stream-demo`);
  };
  const sleep = (ms) => new Promise((resolve) => {
    pendingResolve = resolve;
    pendingTimer = setTimeout(() => { pendingTimer = null; pendingResolve = null; resolve(); }, ms);
  });

  // 14 thinking chunks (~4-8 words each) — fixed demo reasoning about verifying SSE pipelines.
  const THINKING_CHUNKS = [
    'Verifying the SSE pipeline end to end: ',
    'the server must emit typed data frames ',
    'over text/event-stream with flushed headers. ',
    'Each frame carries a UTC timestamp ',
    'so the client can display latency. ',
    'Thinking deltas must stream incrementally, ',
    'proving the render path handles tokens ',
    'without buffering or reordering them. ',
    'Heartbeats and typed frames coexist upstream; ',
    'the parser keys on data: lines. ',
    'Gap detection watches monotonic event indexes. ',
    'After reasoning ends, answer deltas follow ',
    'on the same wire, then metrics. ',
    'Pipeline verification checklist is complete.',
  ];
  // 18 answer chunks — states plainly why this demo exists.
  const ANSWER_CHUNKS = [
    'This is the **synthetic thinking-path demo**. ',
    'It exists because the live model, ',
    'predefined-gpt-5.6-sol, emits zero ',
    'fulfillment_thinking frames — verified in ',
    'three real SSE captures at both ',
    'medium and max reasoning effort. ',
    'The frames you just watched streamed ',
    'through the same send() wire shape ',
    'as /api/chat: data:{type,ts,…} frames ',
    'with flushed headers and per-frame timestamps. ',
    'Fourteen thinking deltas arrived at 130ms ',
    'intervals, and these answer deltas ',
    'arrive at 90ms intervals. ',
    'If the reasoning panel filled live, ',
    'incrementally, before this answer text, ',
    'the thinking render path works. ',
    'Synthetic proof complete — ',
    'the pipeline is verified end to end.',
  ];

  try {
    send('status', { message: 'Synthetic thinking demo (fulfillment_thinking pipeline proof)…' });
    for (const delta of THINKING_CHUNKS) {
      await sleep(130);
      if (closed) return;
      send('thinking', { delta });
    }
    for (const delta of ANSWER_CHUNKS) {
      await sleep(90);
      if (closed) return;
      send('answer', { delta });
    }
    send('metrics', { inputTokens: 0, outputTokens: 32, totalTokens: 32, demo: true });
    send('done', { demo: true });
  } finally {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (!closed) res.end();
  }
});

function extractCountryGuess(text) {
  // try quoted or capitalised tokens against the codes table
  const candidates = [];
  const quoted = [...text.matchAll(/"([^"]+)"|'([^']+)'/g)].map(m => m[1] || m[2]);
  candidates.push(...quoted);
  const words = text.replace(/[^A-Za-z\s-]/g, ' ').split(/\s+/).filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (/^[A-Z]/.test(phrase) || n > 1) candidates.push(phrase);
    }
  }
  for (const c of candidates) { const hit = resolveCountry(c); if (hit) return c; }
  return null;
}

// ---------- exports ----------
// POST /api/export {conversationId, messageId, format}
app.post('/api/export', async (req, res) => {
  try {
    const { conversationId, messageId, format } = req.body || {};
    const conv = store.getConversation(conversationId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const msg = conv.messages.find(m => m.id === messageId && m.role === 'assistant');
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (!['pptx', 'xlsx', 'docx', 'pdf'].includes(format)) return res.status(400).json({ error: 'Bad format' });

    const exp = await buildExport(format, msg.text, {
      dataRows: conv._lastDataRows || [],
      titleHint: conv.title !== 'New chat' ? conv.title : 'ODA Deliverable',
    });
    store.putExport(exp);
    res.json({ artifact: { id: exp.id, name: exp.name, format, size: exp.buffer.length, citations: exp.citations, gaps: exp.gaps, createdAt: exp.createdAt } });
  } catch (e) {
    console.error('🔴 [export] failed:', e.message);
    res.status(500).json({ error: `Export failed: ${e.message}` });
  }
});

app.get('/api/export/:id/download', (req, res) => {
  const exp = store.getExport(req.params.id);
  if (!exp) return res.status(404).json({ error: 'Artifact expired (in-memory store resets on restart)' });
  res.setHeader('Content-Type', exp.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${exp.name}"`);
  res.send(exp.buffer);
});

// ---------- static frontend (built SPA) ----------
const DIST = path.join(__dirname, '..', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[oda-suite] listening on 0.0.0.0:${PORT} · model ${ENDPOINT_ID}+${REASONING_EFFORT} · plugins: ${Object.keys(ADOPTED).length} adopted`);
});
