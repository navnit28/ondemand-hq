// speech.js — OnDemand Services API speech routes (schemas fetched LIVE from the
// public docs this run, 2026-07-17 03:28 UTC — never guessed):
//   STT: POST https://api.on-demand.io/services/v1/public/service/execute/speech_to_text
//        headers: apikey · body: { audioUrl: string (REQUIRED) } · 200 → {message, data}
//   TTS: POST https://api.on-demand.io/services/v1/public/service/execute/text_to_speech
//        headers: apikey · body: { model, input, voice } (all REQUIRED) · 200 → {message, data}
// LIVE PROBE on this key returned 400 {"message":"Please subscribe to the service
// to use it"} for BOTH services — so these routes implement the full contract and
// surface a structured SERVICE_NOT_SUBSCRIBED state the UI renders gracefully.
import crypto from 'node:crypto';
import { ONDEMAND_API_KEY, ONDEMAND_BASE_URL } from './env.js';
import * as store from './store.js';
import * as log from './log.js';

const SVC = (name) => `${ONDEMAND_BASE_URL}/services/v1/public/service/execute/${name}`;
const H = { apikey: ONDEMAND_API_KEY, 'Content-Type': 'application/json' };

// In-memory audio blobs served back to the browser (uploaded mic clips + TTS output)
const audioBlobs = new Map(); // id -> {buffer, mime, createdAt}
export function putAudio(buffer, mime) {
  const id = crypto.randomUUID();
  audioBlobs.set(id, { buffer, mime, createdAt: Date.now() });
  // retire blobs after 30 min to bound memory
  setTimeout(() => audioBlobs.delete(id), 30 * 60 * 1000).unref?.();
  return id;
}
export function getAudio(id) { return audioBlobs.get(id) || null; }

function classifyServiceError(status, body) {
  const msg = body?.message || `HTTP ${status}`;
  if (/subscribe/i.test(msg)) {
    return {
      errorCode: 'SERVICE_NOT_SUBSCRIBED',
      userMessage: 'Speech services are not enabled on this OnDemand workspace yet. The rest of the product is unaffected.',
      debugDetails: `${status} ${msg}`,
    };
  }
  return { errorCode: body?.errorCode || `SERVICE_HTTP_${status}`, userMessage: msg, debugDetails: `${status} ${JSON.stringify(body || {}).slice(0, 300)}` };
}

/** Speech-to-text: the browser posts an audio blob; we host it at a public-ish
 * data URL is not possible server-side, so we pass the platform our own
 * /api/audio/:id URL when the deployment is publicly reachable (PUBLIC_BASE_URL),
 * else return SERVICE_NEEDS_PUBLIC_URL so the UI can explain. */
export async function sttTranscribe({ buffer, mime, publicBaseUrl }) {
  if (!publicBaseUrl) {
    return { ok: false, errorCode: 'SERVICE_NEEDS_PUBLIC_URL', userMessage: 'Transcription needs a publicly reachable server URL (set PUBLIC_BASE_URL).', debugDetails: 'audioUrl must be fetchable by the OnDemand service' };
  }
  const id = putAudio(buffer, mime || 'audio/webm');
  const audioUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/audio/${id}`;
  const t0 = Date.now();
  const r = await fetch(SVC('speech_to_text'), {
    method: 'POST', headers: H, body: JSON.stringify({ audioUrl }), signal: AbortSignal.timeout(120000),
  });
  let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
  log.info('speech.stt', { status: r.status, ms: Date.now() - t0 });
  if (!r.ok) return { ok: false, ...classifyServiceError(r.status, body) };
  const text = typeof body?.data === 'string' ? body.data : (body?.data?.text || body?.data?.transcript || JSON.stringify(body?.data || '').slice(0, 4000));
  return { ok: true, text, raw: body?.message || 'ok' };
}

/** Text-to-speech per live schema {model, input, voice}. Returns a served blob URL. */
export async function ttsGenerate(input, { model = 'tts-1', voice = 'alloy' } = {}) {
  const t0 = Date.now();
  const r = await fetch(SVC('text_to_speech'), {
    method: 'POST', headers: H, body: JSON.stringify({ model, input, voice }), signal: AbortSignal.timeout(120000),
  });
  const ct = r.headers.get('content-type') || '';
  log.info('speech.tts', { status: r.status, contentType: ct, ms: Date.now() - t0 });
  if (!r.ok) {
    let body = null; try { body = await r.json(); } catch { /* ignore */ }
    return { ok: false, ...classifyServiceError(r.status, body) };
  }
  if (ct.includes('application/json')) {
    const body = await r.json();
    // REAL live shape (verified 2026-07-17 18:24 UTC raw dumps): {message, data: {audioUrl: "<signed blob URL>"}}
    const d = body?.data;
    if (d && typeof d === 'object' && typeof d.audioUrl === 'string' && /^https?:\/\//.test(d.audioUrl)) {
      return { ok: true, meta: { hostedUrl: d.audioUrl, source: 'text_to_speech service' } };
    }
    if (typeof d === 'string' && /^https?:\/\//.test(d)) {
      return { ok: true, meta: { hostedUrl: d, source: 'text_to_speech service' } };
    }
    if (typeof d === 'string' && d.length > 100) {
      const buf = Buffer.from(d, 'base64');
      const id = putAudio(buf, 'audio/mpeg');
      return { ok: true, meta: { url: `/api/audio/${id}`, size: buf.length, source: 'text_to_speech service' } };
    }
    return { ok: false, errorCode: 'TTS_UNEXPECTED_SHAPE', userMessage: 'Speech service returned an unexpected payload.', debugDetails: JSON.stringify(body).slice(0, 300) };
  }
  // binary audio body
  const buf = Buffer.from(await r.arrayBuffer());
  const id = putAudio(buf, ct || 'audio/mpeg');
  return { ok: true, meta: { url: `/api/audio/${id}`, size: buf.length, source: 'text_to_speech service' } };
}

/** Express route registrar. */
export function registerSpeechRoutes(app, upload) {
  // serve audio blobs (mic uploads + TTS output)
  app.get('/api/audio/:id', (req, res) => {
    const blob = getAudio(req.params.id);
    if (!blob) return res.status(404).json({ error: { userMessage: 'Audio expired', errorCode: 'AUDIO_EXPIRED' } });
    res.setHeader('Content-Type', blob.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(blob.buffer);
  });

  // POST /api/speech/transcribe (multipart audio) → {ok, text} | structured error
  app.post('/api/speech/transcribe', upload.single('audio'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: { userMessage: 'No audio received', errorCode: 'NO_AUDIO' } });
      const publicBaseUrl = process.env.PUBLIC_BASE_URL || req.headers['x-public-base-url'] || null;
      const out = await sttTranscribe({ buffer: req.file.buffer, mime: req.file.mimetype, publicBaseUrl });
      if (!out.ok) return res.status(200).json({ ok: false, error: { userMessage: out.userMessage, errorCode: out.errorCode, debugDetails: out.debugDetails } });
      res.json({ ok: true, text: out.text });
    } catch (e) {
      log.error('speech.transcribe_failed', { error: e.message });
      res.status(500).json({ error: { userMessage: 'Transcription failed', errorCode: 'STT_FAILED', debugDetails: e.message } });
    }
  });

  // POST /api/speech/tts {text, voice?} → {ok, url} | structured error
  app.post('/api/speech/tts', async (req, res) => {
    try {
      const { text, voice, model } = req.body || {};
      if (!text || !text.trim()) return res.status(400).json({ error: { userMessage: 'No text to speak', errorCode: 'NO_TEXT' } });
      const out = await ttsGenerate(text.slice(0, 3800), { voice: voice || 'alloy', model: model || 'tts-1' });
      if (!out.ok) return res.status(200).json({ ok: false, error: { userMessage: out.userMessage, errorCode: out.errorCode, debugDetails: out.debugDetails } });
      res.json({ ok: true, ...out.meta });
    } catch (e) {
      log.error('speech.tts_failed', { error: e.message });
      res.status(500).json({ error: { userMessage: 'Audio generation failed', errorCode: 'TTS_FAILED', debugDetails: e.message } });
    }
  });
}
