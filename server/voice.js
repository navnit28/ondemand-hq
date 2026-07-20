// server/voice.js — ODA World Intelligence voice-turn routes (additive, 2026-07-20).
// TURN-BASED streaming pathway (the closest supported realtime path per NOTES.md:
// realtime/WS/VAD/barge-in are NOT in the public docs): streamed STT input handling →
// streamed GLM 4.7 session query (SSE tokens forwarded as they arrive) → sentence-
// chunked TTS kicked off as EARLY SENTENCES COMPLETE (not record-full-upload-wait).
// Security: server-side key only; per-IP rate limiting; redacted logs (never keys,
// never transcripts, never raw audio); timeouts on every upstream call; abort on
// client disconnect (barge-in propagates as request abort → upstream AbortSignal).
import crypto from 'node:crypto';
import { createSession, streamQuery, speechToText, textToSpeech, executeWorkflow } from './ondemand/adapters.js';
import { putAudio } from './speech.js';
import { ONDEMAND_API_KEY } from './env.js';

// GLM 4.7 — the ONLY ACTIVE variant (byoi Cerebras; NOTES.md 2026-07-20). Fallback is
// NEVER silent: only used when VOICE_FALLBACK_ENDPOINT is explicitly set, and every
// turn response carries {model, fallbackActive} so the UI displays it.
export const VOICE_ENDPOINT_ID = process.env.VOICE_ENDPOINT_ID || 'byoi-6e314690-4eaf-4def-a33c-380809acf1f5';
export const VOICE_FALLBACK_ENDPOINT = process.env.VOICE_FALLBACK_ENDPOINT || ''; // e.g. predefined-gpt-5.6-sol
export const WORLD_INTEL_WORKFLOW_ID = process.env.WORLD_INTEL_WORKFLOW_ID || '6a5d90228a845853270b9b53';

const PERSONA = `You are ODA World Intelligence — the voice of the Office of Development Affairs world view.
PERSONA: warm, calm, institutionally professional. Polished, approachable American English; fluent Modern Standard Arabic with graceful Gulf/Emirati vocabulary accommodation (e.g. common Gulf terms are understood and mirrored respectfully). Always respond in the user's detected language; switch naturally mid-session when the user switches. Pronounce UAE, ODA, country and organisation names carefully (spell speech-friendly forms).
KNOWLEDGE DISCIPLINE: (a) verified facts — only with evidence ids, cite like [E12]; (b) retrieved evidence — attribute source + date; (c) model inference — label as "assessment"; (d) uncertainty — say plainly what is not known; (e) recommendations — clearly framed as recommendations. NEVER present unsupported strategic assumptions as facts.
OUTPUT PROTOCOL: interleave short spoken-style sentences (for TTS) with fenced json blocks:
\`\`\`json
{"type":"ui","component":"<CountrySummaryCard|ComparisonTable|MetricCard|Timeline|RiskMatrix|RouteSummary|SourceList|EvidenceCard|ScenarioCard|RecommendationCard|SmallChart|Alert|KeyFinding|ActionList>","anchor":"<iso or null>","props":{...include sources:[{id,source,date,url?}] where applicable}}
\`\`\`
and, only when the user asked to act on the world view:
\`\`\`json
{"type":"command","action":"<rotateTo|zoom|showCountry|openLayer|compare|resetView|setTimeline|openPanel|closePanel>","args":{...}}
\`\`\`
UI actions come ONLY from these blocks; free text never executes actions. Keep spoken sentences short (TTS-friendly).`;

// ---------- tiny fixed-window rate limiter (per IP, voice routes only) ----------
const rl = new Map(); // ip -> {count, windowStart}
function rateLimited(ip, max = 30, windowMs = 60000) {
  const now = Date.now();
  const e = rl.get(ip) || { count: 0, windowStart: now };
  if (now - e.windowStart > windowMs) { e.count = 0; e.windowStart = now; }
  e.count += 1; rl.set(ip, e);
  return e.count > max;
}

// observability (safe: counts/timings only — no payloads, keys, or transcripts)
const metrics = { activations: 0, turns: 0, errors: 0, aborts: 0, ttft: [] };

const sessions = new Map(); // voiceSessionId -> {odSessionId, createdAt, turns}

export function registerVoiceRoutes(app, upload) {
  // ---- activation: create the OnDemand chat session that carries conversation state
  app.post('/api/voice/session', async (req, res) => {
    if (rateLimited(req.ip, 10)) return res.status(429).json({ error: 'rate_limited' });
    if (!ONDEMAND_API_KEY) return res.status(503).json({ error: 'key_not_loaded' });
    try {
      const vid = crypto.randomUUID();
      const odSessionId = await createSession(`oda-world-voice-${vid}`);
      sessions.set(vid, { odSessionId, createdAt: Date.now(), turns: 0 });
      metrics.activations += 1;
      console.log(`[voice] session activated vid=${vid.slice(0, 8)}… (od len=${odSessionId.length})`);
      res.json({ voiceSessionId: vid, model: VOICE_ENDPOINT_ID, fallbackConfigured: Boolean(VOICE_FALLBACK_ENDPOINT), workflowId: WORLD_INTEL_WORKFLOW_ID });
    } catch (e) {
      metrics.errors += 1;
      console.error('[voice] activation failed:', String(e.message).slice(0, 120));
      res.status(502).json({ error: 'activation_failed' });
    }
  });

  // ---- STT: mic clip upload → hosted URL → documented speech_to_text call
  app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'rate_limited' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'no_audio' });
    try {
      const id = putAudio(req.file.buffer, req.file.mimetype || 'audio/webm');
      const host = `${req.protocol}://${req.get('host')}`;
      const out = await speechToText(`${host}/api/speech/audio/${id}`);
      if (!out.ok) return res.status(out.notSubscribed ? 402 : 502).json({ error: out.notSubscribed ? 'stt_not_subscribed' : 'stt_failed' });
      res.json({ text: out.text });
    } catch (e) {
      metrics.errors += 1;
      console.error('[voice] stt error:', String(e.message).slice(0, 120));
      res.status(502).json({ error: 'stt_failed' });
    }
  });

  // ---- the voice turn: SSE — GLM 4.7 tokens stream out as they arrive; sentence
  // boundaries emit tts_ready markers so the client starts TTS/playback EARLY.
  app.post('/api/voice/turn', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'rate_limited' });
    const { voiceSessionId, transcript, context = {}, language = null } = req.body || {};
    const sess = sessions.get(voiceSessionId);
    if (!sess) return res.status(404).json({ error: 'no_session' });
    if (!transcript?.trim()) return res.status(400).json({ error: 'empty_transcript' });

    // typed minimal context only — never whole app state (allowlist mirror of client)
    const ctx = {
      selectedCountry: context.selectedCountry ?? null,
      selectedRegion: context.selectedRegion ?? null,
      activeLayer: context.activeLayer ?? null,
      timelineRange: context.timelineRange ?? null,
      selectedMarker: context.selectedMarker ?? null,
      activeFilters: context.activeFilters ?? null,
      cameraFocus: context.cameraFocus ?? null,
    };

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (type, payload) => { try { res.write(`data:${JSON.stringify({ type, ts: new Date().toISOString(), ...payload })}\n\n`); res.flush?.(); } catch { /* closed */ } };

    // barge-in: client abort (fetch AbortController) closes req → propagate upstream
    const upstream = new AbortController();
    req.on('close', () => { if (!res.writableEnded) { metrics.aborts += 1; upstream.abort(); } });

    const t0 = Date.now();
    let firstToken = 0;
    let endpoint = VOICE_ENDPOINT_ID;
    let fallbackActive = false;
    send('model', { model: endpoint, fallbackActive });

    const runTurn = async (endpointId) => streamQuery({
      sessionId: sess.odSessionId,
      endpointId,
      fulfillmentOnly: true,
      fulfillmentPrompt: PERSONA + (language ? `\nMANUAL LANGUAGE OVERRIDE: respond in "${language}".` : ''),
      query: `CONTEXT (typed, minimal): ${JSON.stringify(ctx)}\nUSER (voice transcript): ${transcript}`,
      signal: upstream.signal,
      timeoutMs: 60000,
      onEvent: (type, frame) => {
        if (type === 'token') {
          if (!firstToken) { firstToken = Date.now() - t0; send('ttft', { ms: firstToken }); }
          send('token', { delta: frame.answer });
          // sentence-boundary marker → client can begin chunked TTS immediately
          if (/[.!؟?…]\s*$/.test(frame.answer)) send('tts_ready', {});
        } else if (frame.usage) {
          send('usage', { usage: frame.usage }); // ONLY real usage if the stream exposes it
        }
      },
    });

    try {
      let out;
      try {
        out = await runTurn(endpoint);
      } catch (e) {
        if (e.aborted) throw e;
        if (VOICE_FALLBACK_ENDPOINT) {
          // VISIBLE fallback — configured via env, surfaced in the stream + logged
          endpoint = VOICE_FALLBACK_ENDPOINT; fallbackActive = true;
          console.warn(`[voice] primary endpoint failed → VISIBLE fallback to ${endpoint}`);
          send('model', { model: endpoint, fallbackActive: true });
          out = await runTurn(endpoint);
        } else throw e;
      }
      sess.turns += 1; metrics.turns += 1; metrics.ttft.push(firstToken);
      send('done', { chars: out.fullAnswer.length, model: endpoint, fallbackActive, ttftMs: firstToken, durationMs: Date.now() - t0 });
    } catch (e) {
      if (e.aborted) send('interrupted', {});
      else { metrics.errors += 1; console.error('[voice] turn error:', String(e.message).slice(0, 120)); send('error', { error: 'turn_failed' }); }
    }
    res.end();
  });

  // ---- TTS for a completed sentence chunk (client calls per early sentence)
  app.post('/api/voice/tts', async (req, res) => {
    if (rateLimited(req.ip, 60)) return res.status(429).json({ error: 'rate_limited' });
    const { text, voice = 'alloy', language = 'en' } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: 'empty_text' });
    try {
      const out = await textToSpeech({ input: String(text).slice(0, 600), voice });
      if (!out.ok) return res.status(out.notSubscribed ? 402 : 502).json({ error: out.notSubscribed ? 'tts_not_subscribed' : 'tts_failed', language });
      res.json({ ok: true, data: out.data });
    } catch (e) {
      console.error('[voice] tts error:', String(e.message).slice(0, 120));
      res.status(502).json({ error: 'tts_failed' });
    }
  });

  // ---- world-intelligence workflow trigger (documented execute mechanism)
  app.post('/api/voice/workflow/refresh', async (req, res) => {
    if (rateLimited(req.ip, 5)) return res.status(429).json({ error: 'rate_limited' });
    try {
      const out = await executeWorkflow(WORLD_INTEL_WORKFLOW_ID);
      res.json({ ok: true, executionID: out.executionID ?? out.data ?? null, workflowId: WORLD_INTEL_WORKFLOW_ID });
    } catch (e) {
      console.error('[voice] workflow execute error:', String(e.message).slice(0, 120));
      res.status(502).json({ error: 'workflow_failed' });
    }
  });

  // ---- termination/cleanup + observability snapshot (no sensitive payloads)
  app.delete('/api/voice/session/:vid', (req, res) => {
    sessions.delete(req.params.vid);
    res.json({ ok: true });
  });
  app.get('/api/voice/metrics', (_req, res) => {
    const t = metrics.ttft.filter(Boolean);
    res.json({
      activations: metrics.activations, turns: metrics.turns, errors: metrics.errors,
      aborts: metrics.aborts, activeSessions: sessions.size,
      ttftAvgMs: t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null,
    });
  });
}
