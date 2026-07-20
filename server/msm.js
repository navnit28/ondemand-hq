// msm.js — MSM Analysis (daily mainstream-media monitor) backend module.
//
// Pipeline (all live-verified 2026-07-18, see PLUGIN_TESTS.md):
//   1. TRANSCRIBE — OnDemand Media API: POST /media/v1/public/file with the YouTube
//      watch URL (responseMode "sync"; body per the live docs' YouTube sample:
//      sessionId + url + plugins + sizeBytes). Live-verified HTTP 200 in ~8s with
//      actionStatus "completed" and a fetchable extractedTextUrl (Azure blob, plain
//      text). If actionStatus is not yet "completed", we poll
//      GET /media/v1/public/file (sort=-createdAt) until the record flips to
//      completed/failed (5s interval, 300s budget) — the documented actionStatus
//      polling path from NOTES.md.
//   2. ANALYSE — per video, gpt-5.6-sol-medium (predefined-gpt-5.6-sol +
//      reasoningEffort "medium") with responseMode "stream" via streamQuery();
//      thinking deltas (planning_thinking / step_thinking / fulfillment_thinking)
//      are captured SEPARATELY from answer tokens and persisted per video.
//      Output is strict JSON: ODA-audience summary, sentiment on ODA themes with
//      confidence, narrative-impact flag + reasoning, entities, topic tags.
//   3. STORE + DEDUPE — disk-persisted per-day records under server/data/msm/
//      keyed by videoId; a global index guarantees a videoId is NEVER
//      re-transcribed once processed (transcripts are reused across runs/days).
//   4. DIGEST — one extra gpt-5.6-sol-medium streamed call builds the daily
//      digest strip (top 3 ODA-relevant stories + narrative); sentiment balance
//      and flag counts are computed deterministically in code (never invented).
//
// NOTE — YouTube captions fallback: the platform captionsList/captionsDownload
// plugin pair was probed by the orchestration layer for all 17 seed videos on
// 2026-07-18 and EVERY call failed with {"error":"field key is missing in agent
// plugin config"} (plugin config lacks its API key server-side). Logged as REJECT
// in PLUGIN_TESTS.md. The Media API above is therefore the primary AND only
// transcription path; per-video failures degrade to status "transcription-failed"
// which the UI renders gracefully.
//
// Scheduled run: the product contract is a daily 06:00 Gulf Standard Time run
// (Asia/Dubai, UTC+4 → 02:00 UTC; cron "0 6 * * *" TZ=Asia/Dubai, equivalently
// "0 2 * * *" UTC). Serverless previews cannot host a persistent cron, so the
// schedule ships as configuration (GET /api/msm/config + ARCHITECTURE.md §MSM);
// POST /api/msm/run is the idempotent entrypoint the scheduler (or the UI
// "Refresh now" button) fires — dedupe makes repeated fires cheap.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { ONDEMAND_API_KEY, ONDEMAND_BASE_URL } from './env.js';
import { createOdSession, streamQuery } from './ondemand.js';
import { DATA_DIR as DATA_BASE } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MSM_DIR = path.join(DATA_BASE, 'msm');
const TX_DIR = path.join(MSM_DIR, 'transcripts');
try { fs.mkdirSync(TX_DIR, { recursive: true }); } catch (e) { console.error('[msm] mkdir failed:', e.message); }

const H = { apikey: ONDEMAND_API_KEY, 'Content-Type': 'application/json' };
// The docs' own YouTube media sample attaches this plugin id; live-verified working 2026-07-18.
const MEDIA_YT_PLUGIN = 'plugin-1713961903';

// ---------- outlet registry (the 8 monitored outlets) ----------
export const OUTLETS = [
  { key: 'fox',       en: 'Fox News',             ar: 'فوكس نيوز',           color: '#003366', text: '#FFFFFF' },
  { key: 'cnn',       en: 'CNN',                  ar: 'سي إن إن',            color: '#CC0000', text: '#FFFFFF' },
  { key: 'bbc',       en: 'BBC News',             ar: 'بي بي سي نيوز',       color: '#BB1919', text: '#FFFFFF' },
  { key: 'aje',       en: 'Al Jazeera English',   ar: 'الجزيرة الإنجليزية',  color: '#FA9000', text: '#1D252C' },
  { key: 'bloomberg', en: 'Bloomberg Television', ar: 'بلومبرغ',             color: '#111111', text: '#FFFFFF' },
  { key: 'ft',        en: 'Financial Times',      ar: 'فايننشال تايمز',      color: '#FFF1E5', text: '#990F3D' },
  { key: 'reuters',   en: 'Reuters',              ar: 'رويترز',              color: '#FF8000', text: '#1D252C' },
  { key: 'alarabiya', en: 'Al Arabiya English',   ar: 'العربية الإنجليزية',  color: '#1B6CA8', text: '#FFFFFF' },
];

// ---------- verified daily video seed ----------
// 2026-07-18 list supplied and verified by the ODA editorial task; Fox News IDs
// resolved live 2026-07-18 08:19 UTC from the OFFICIAL Fox News channel RSS feed
// (https://www.youtube.com/feeds/videos.xml?channel_id=UCXIJgqnII2ZOINSWNOGFThA,
// feed title "Fox News" — official channel only, never fan re-uploads).
export const SEED = {
  '2026-07-18': [
    { videoId: 'pEAnENxNiZs', outlet: 'cnn' },
    { videoId: 'K9C2upCeESs', outlet: 'cnn' },
    { videoId: 'KmO_nii-9QM', outlet: 'cnn', subLabel: 'CNN-News18' },
    { videoId: 'eaBUNBDOgkU', outlet: 'bbc' },
    { videoId: 'b1bOVBHtSho', outlet: 'bbc' },
    { videoId: 'gCNeDWCI0vo', outlet: 'aje' },
    { videoId: 'e93MaEwrsfc', outlet: 'aje' },
    { videoId: 'qLuiF3DNkJY', outlet: 'bloomberg' },
    { videoId: '2IYDWDja3E0', outlet: 'bloomberg' },
    { videoId: 'JQSB2Fdv398', outlet: 'bloomberg' },
    { videoId: 'ohAstmb29lE', outlet: 'ft' },
    { videoId: 'E76BzrJPDWY', outlet: 'ft' },
    { videoId: 'sHKSIVg7rqU', outlet: 'reuters' },
    { videoId: 'wzcoHTVAobY', outlet: 'reuters' },
    { videoId: 'Y0gi4Pd9wkQ', outlet: 'reuters' },
    { videoId: 'C0a3Q2NtAD0', outlet: 'alarabiya' },
    { videoId: 'NaDT5rVDm60', outlet: 'alarabiya' },
    { videoId: 'njPpXh8pjpc', outlet: 'fox' },
    { videoId: 'cBWOtw-ofbw', outlet: 'fox' },
    { videoId: '2gUKBwDTxzA', outlet: 'fox' },
  ],
};

export const SCHEDULE = {
  cron: '0 6 * * *',
  timezone: 'Asia/Dubai',
  utcEquivalent: '0 2 * * *',
  description: 'Daily MSM Analysis run at 06:00 Gulf Standard Time (Asia/Dubai, UTC+4 = 02:00 UTC). Fire POST /api/msm/run {"date":"<gulf-date>"} — the run is idempotent: already-transcribed videos are served from the store, so repeated fires only fill gaps.',
};

// ---------- disk store ----------
const dayFile = (date) => path.join(MSM_DIR, `${date}.json`);
const idxFile = () => path.join(MSM_DIR, 'index.json');
const txFile = (videoId) => path.join(TX_DIR, `${videoId}.txt`);

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 1)); }

export function getIndex() { return readJson(idxFile(), { videos: {} }); }
function putIndexEntry(videoId, entry) {
  const idx = getIndex();
  idx.videos[videoId] = { ...(idx.videos[videoId] || {}), ...entry };
  writeJson(idxFile(), idx);
}
export function getTranscriptText(videoId) {
  try { return fs.readFileSync(txFile(videoId), 'utf8'); } catch { return null; }
}
export function listDates() {
  try {
    return fs.readdirSync(MSM_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
  } catch { return []; }
}
export function getDay(date) { return readJson(dayFile(date), null); }
function saveDay(day) { writeJson(dayFile(day.date), day); }

// Public (browser-safe) projection — transcripts stay on disk, only metadata ships.
export function publicDay(day) {
  if (!day) return null;
  return {
    ...day,
    videos: day.videos.map(v => ({ ...v, analysis: v.analysis ? { ...v.analysis } : null })),
  };
}

// ---------- helpers ----------
const nowIso = () => new Date().toISOString();

function log(day, video, entry) {
  const e = { ts: nowIso(), ...entry };
  video.log = video.log || [];
  video.log.push(e);
  saveDay(day);
  console.log(`[msm] ${video.videoId} ${e.step} http=${e.http ?? '-'} ms=${e.ms ?? '-'} ${e.note || ''}`);
  return e;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// Best-effort YouTube metadata (title/author via oEmbed; duration/publish via watch
// page). Both degrade to nulls gracefully — never block the pipeline on metadata.
async function fetchYtMeta(videoId) {
  const meta = { title: null, author: null, durationSec: null, publishedAt: null };
  try {
    const u = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    const r = await fetchWithTimeout(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 12000);
    if (r.ok) { const j = await r.json(); meta.title = j.title || null; meta.author = j.author_name || null; }
  } catch { /* graceful */ }
  try {
    const r = await fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Accept-Language': 'en' },
    }, 15000);
    if (r.ok) {
      const html = await r.text();
      const d = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
      const p = html.match(/"publishDate"\s*:\s*"([^"]+)"/) || html.match(/itemprop="datePublished" content="([^"]+)"/);
      if (d) meta.durationSec = parseInt(d[1], 10);
      if (p) meta.publishedAt = p[1];
    }
  } catch { /* graceful */ }
  return meta;
}

// ---------- 1) TRANSCRIBE (Media API) ----------
async function transcribeVideo(day, video, mediaSessionId) {
  const url = `https://www.youtube.com/watch?v=${video.videoId}`;
  const body = {
    createdBy: 'oda-msm', updatedBy: 'oda-msm',
    sessionId: mediaSessionId,
    url,
    name: `msm-${video.outlet}-${video.videoId}`,
    plugins: [MEDIA_YT_PLUGIN],
    sizeBytes: 0,
    responseMode: 'sync',
  };
  let t0 = Date.now();
  let r, j;
  let media = null;
  let postTimedOut = false;
  try {
    r = await fetchWithTimeout(`${ONDEMAND_BASE_URL}/media/v1/public/file`, {
      method: 'POST', headers: H, body: JSON.stringify(body),
    }, 180000);
    j = await r.json().catch(() => ({}));
  } catch (e) {
    // A sync-mode POST on a LONG video can outlive any sane client timeout while the
    // server-side transcription keeps running. Treat the abort as "submitted — recover
    // by polling the listing for our sourceUrl" instead of failing outright.
    postTimedOut = true;
    log(day, video, { step: 'transcribe.post', http: 0, ms: Date.now() - t0, note: `client timeout/abort (${e.message}) — recovering via GET listing poll` });
  }
  if (!postTimedOut) {
    log(day, video, { step: 'transcribe.post', http: r.status, ms: Date.now() - t0, note: `actionStatus=${j?.data?.actionStatus || '-'}` });
    if (!r.ok) return { ok: false, reason: `Media API HTTP ${r.status}: ${j?.message || 'error'}` };
    media = j.data;
  } else {
    // Recovery poll: find the just-created record by sourceUrl (newest first).
    const RECOVER_BUDGET_MS = 360000, RECOVER_EVERY_MS = 10000;
    const rStart = Date.now();
    while (!media || (media.actionStatus !== 'completed' && media.actionStatus !== 'failed')) {
      if (Date.now() - rStart > RECOVER_BUDGET_MS) {
        log(day, video, { step: 'transcribe.recover', http: 0, ms: Date.now() - rStart, note: 'recovery poll budget exhausted (360s)' });
        return { ok: false, reason: 'POST timed out and the media record did not complete within the recovery window' };
      }
      await new Promise(res => setTimeout(res, RECOVER_EVERY_MS));
      const t1 = Date.now();
      try {
        const pr = await fetchWithTimeout(`${ONDEMAND_BASE_URL}/media/v1/public/file?limit=50&sort=-createdAt`, { headers: H }, 30000);
        const pj = await pr.json().catch(() => ({}));
        const found = (Array.isArray(pj?.data) ? pj.data : []).find(m => (m.sourceUrl || m.url || '').includes(video.videoId));
        log(day, video, { step: 'transcribe.recover', http: pr.status, ms: Date.now() - t1, note: `actionStatus=${found?.actionStatus || 'not-found'}` });
        if (found) media = found;
      } catch (e2) {
        log(day, video, { step: 'transcribe.recover', http: 0, ms: Date.now() - t1, note: `network: ${e2.message}` });
      }
    }
  }
  // actionStatus polling path (NOTES.md): poll the GET listing until completed/failed.
  const POLL_BUDGET_MS = 300000, POLL_EVERY_MS = 5000;
  const pollStart = Date.now();
  while (media?.actionStatus && media.actionStatus !== 'completed' && media.actionStatus !== 'failed') {
    if (Date.now() - pollStart > POLL_BUDGET_MS) {
      log(day, video, { step: 'transcribe.poll', http: 0, ms: Date.now() - pollStart, note: 'poll budget exhausted (300s)' });
      return { ok: false, reason: 'Transcription did not complete within 300s' };
    }
    await new Promise(res => setTimeout(res, POLL_EVERY_MS));
    t0 = Date.now();
    try {
      const pr = await fetchWithTimeout(`${ONDEMAND_BASE_URL}/media/v1/public/file?limit=50&sort=-createdAt`, { headers: H }, 30000);
      const pj = await pr.json().catch(() => ({}));
      const found = (Array.isArray(pj?.data) ? pj.data : []).find(m => m.id === media.id);
      log(day, video, { step: 'transcribe.poll', http: pr.status, ms: Date.now() - t0, note: `actionStatus=${found?.actionStatus || 'not-found'}` });
      if (found) media = found;
    } catch (e) {
      log(day, video, { step: 'transcribe.poll', http: 0, ms: Date.now() - t0, note: `network: ${e.message}` });
    }
  }
  if (media?.actionStatus === 'failed') {
    return { ok: false, reason: `Media API reported failure: ${media.failedReason || 'unknown'}` };
  }
  if (!media?.extractedTextUrl) {
    return { ok: false, reason: 'Completed but no extractedTextUrl in the media record' };
  }

  // Fetch the transcript text from the returned blob URL.
  t0 = Date.now();
  let text;
  try {
    const tr = await fetchWithTimeout(media.extractedTextUrl, {}, 120000);
    text = await tr.text();
    log(day, video, { step: 'transcribe.fetchText', http: tr.status, ms: Date.now() - t0, note: `${text.length} chars` });
    if (!tr.ok || !text || text.length < 40) {
      return { ok: false, reason: `Transcript fetch HTTP ${tr.status} or unusable (${(text || '').length} chars)` };
    }
  } catch (e) {
    log(day, video, { step: 'transcribe.fetchText', http: 0, ms: Date.now() - t0, note: `network: ${e.message}` });
    return { ok: false, reason: `Transcript fetch failed: ${e.message}` };
  }

  fs.writeFileSync(txFile(video.videoId), text);
  putIndexEntry(video.videoId, {
    mediaId: media.id, transcriptChars: text.length,
    transcriptionHours: media.transcriptionHours ?? null,
    firstProcessedAt: nowIso(), sourceUrl: url,
  });
  return { ok: true, mediaId: media.id, chars: text.length };
}

// ---------- 2) ANALYSE (gpt-5.6-sol-medium, streaming, thinking captured) ----------
const MSM_SYSTEM = `You are the media-analysis desk of the UAE Office of Development Affairs (ODA), Abu Dhabi.
You receive ONE broadcast transcript. Ground EVERY statement strictly in that transcript — never invent facts, names, or numbers that are not in it. If the content is unrelated to ODA themes, say so honestly.
ODA themes: UAE, Gulf, international development, aid, humanitarian affairs, economic development, Abu Dhabi, regional stability.
Respond with ONE JSON object only (no prose before or after) with EXACTLY these keys:
{
 "summary": "3-4 sentence executive summary written for ODA leadership",
 "sentiment": {"label": "positive|neutral|negative", "confidence": 0.0-1.0},
 "odaImpact": {"flag": "None|Watch|Notable|High", "reasoning": "one line"},
 "entities": ["up to 8 key people/orgs/places actually named in the transcript"],
 "topics": ["up to 6 short topic tags"],
 "odaRelevant": true|false
}
Sentiment is scored ON ODA THEMES specifically (how the coverage bears on UAE/Gulf/development narratives), not general mood. A video with no ODA-theme content is sentiment neutral with low confidence, odaRelevant false, and flag None.`;

function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const c of [fence?.[1], text]) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start < 0) continue;
    for (let end = c.length; end > start; end--) {
      try { return JSON.parse(c.slice(start, end)); } catch { /* shrink */ }
    }
  }
  return null;
}

const SENTIMENTS = new Set(['positive', 'neutral', 'negative']);
const FLAGS = new Set(['None', 'Watch', 'Notable', 'High']);

function validateAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sentiment = raw.sentiment || {};
  const impact = raw.odaImpact || {};
  const label = String(sentiment.label || '').toLowerCase();
  let flag = String(impact.flag || 'None');
  flag = flag.charAt(0).toUpperCase() + flag.slice(1).toLowerCase();
  if (flag === 'none') flag = 'None';
  return {
    summary: String(raw.summary || '').slice(0, 1200),
    sentiment: {
      label: SENTIMENTS.has(label) ? label : 'neutral',
      confidence: Math.max(0, Math.min(1, Number(sentiment.confidence) || 0)),
    },
    odaImpact: {
      flag: FLAGS.has(flag) ? flag : 'None',
      reasoning: String(impact.reasoning || '').slice(0, 300),
    },
    entities: (Array.isArray(raw.entities) ? raw.entities : []).slice(0, 8).map(e => String(e).slice(0, 60)),
    topics: (Array.isArray(raw.topics) ? raw.topics : []).slice(0, 6).map(t => String(t).slice(0, 40)),
    odaRelevant: Boolean(raw.odaRelevant),
  };
}

const ANALYSIS_INPUT_CAP = 22000;

async function analyseVideo(day, video, transcript) {
  let t0 = Date.now();
  let sid;
  try {
    sid = await createOdSession(`msm-${day.date}-${video.videoId}`, []);
    log(day, video, { step: 'analyse.session', http: 201, ms: Date.now() - t0, note: sid });
  } catch (e) {
    log(day, video, { step: 'analyse.session', http: e.status || 0, ms: Date.now() - t0, note: e.message });
    return { ok: false, reason: `Session create failed: ${e.message}` };
  }

  const truncated = transcript.length > ANALYSIS_INPUT_CAP;
  const excerpt = truncated ? transcript.slice(0, ANALYSIS_INPUT_CAP) : transcript;
  const query = [
    `VIDEO METADATA: outlet=${outletName(video.outlet)}${video.subLabel ? ` (${video.subLabel})` : ''}; title=${video.title || 'unknown'}; youtubeId=${video.videoId}; duration=${video.durationSec ? `${video.durationSec}s` : 'unknown'}.`,
    truncated ? `NOTE: transcript truncated to the first ${ANALYSIS_INPUT_CAP} characters of ${transcript.length}.` : '',
    `TRANSCRIPT between markers:\n<<<TRANSCRIPT\n${excerpt}\nTRANSCRIPT>>>`,
    'Return the single JSON object now.',
  ].filter(Boolean).join('\n\n');

  let thinking = '';
  const onRaw = (evName, rawData) => {
    if (rawData === '[DONE]') return;
    try {
      const evt = JSON.parse(rawData);
      const et = evt.eventType;
      if ((et === 'planning_thinking' || et === 'step_thinking' || et === 'fulfillment_thinking') && typeof evt?.thinking?.delta === 'string') {
        thinking += evt.thinking.delta;
      }
    } catch { /* non-JSON keepalive */ }
  };

  t0 = Date.now();
  let answer;
  try {
    answer = await streamQuery({ odSessionId: sid, query, pluginIds: [], systemPrompt: MSM_SYSTEM, onRaw });
    log(day, video, { step: 'analyse.stream', http: 200, ms: Date.now() - t0, note: `answer=${(answer || '').length}ch thinking=${thinking.length}ch` });
  } catch (e) {
    log(day, video, { step: 'analyse.stream', http: e.status || 0, ms: Date.now() - t0, note: e.message });
    return { ok: false, reason: `Analysis stream failed: ${e.message}` };
  }

  const parsed = validateAnalysis(extractJson(answer));
  if (!parsed) {
    log(day, video, { step: 'analyse.parse', http: 200, ms: 0, note: 'model output was not parseable JSON' });
    return { ok: false, reason: 'Model output was not parseable JSON' };
  }
  parsed.thinking = thinking.slice(0, 20000);
  parsed.model = 'gpt-5.6-sol-medium';
  parsed.streamed = true;
  parsed.analysedAt = nowIso();
  parsed.transcriptTruncatedForAnalysis = truncated;
  return { ok: true, analysis: parsed };
}

function outletName(key) { return (OUTLETS.find(o => o.key === key) || {}).en || key; }

// ---------- 4) DIGEST ----------
async function buildDigest(day, emit) {
  const done = day.videos.filter(v => v.status === 'done' && v.analysis);
  if (!done.length) return null;
  // Deterministic counts — computed in code, never by the model.
  const balance = { positive: 0, neutral: 0, negative: 0 };
  const flags = { None: 0, Watch: 0, Notable: 0, High: 0 };
  for (const v of done) {
    balance[v.analysis.sentiment.label] += 1;
    flags[v.analysis.odaImpact.flag] += 1;
  }
  const lines = done.map(v =>
    `- videoId=${v.videoId} | outlet=${outletName(v.outlet)} | title=${v.title || 'unknown'} | flag=${v.analysis.odaImpact.flag} | sentiment=${v.analysis.sentiment.label} | odaRelevant=${v.analysis.odaRelevant} | summary=${v.analysis.summary.slice(0, 220)}`);
  const query = [
    `Today's analysed MSM videos (${day.date}), one per line:`,
    lines.join('\n'),
    `From ONLY this list pick the top 3 most ODA-relevant stories (prefer High > Notable > Watch flags, then odaRelevant true, then geopolitical/economic weight for the Gulf).`,
    `Respond with ONE JSON object only: {"top3":[{"videoId":"...","headline":"<=90 chars","why":"<=120 chars"}], "narrative":"2-3 sentence ODA-audience digest of today's mainstream-media picture"}`,
  ].join('\n\n');

  let t0 = Date.now(), sid;
  try { sid = await createOdSession(`msm-digest-${day.date}`, []); } catch (e) {
    day.digestError = `Digest session failed: ${e.message}`; saveDay(day); return null;
  }
  let thinking = '';
  let streamedNarrative = '';
  const onRaw = (evName, rawData) => {
    if (rawData === '[DONE]') return;
    try {
      const evt = JSON.parse(rawData);
      const et = evt.eventType;
      if ((et === 'planning_thinking' || et === 'step_thinking' || et === 'fulfillment_thinking') && typeof evt?.thinking?.delta === 'string') thinking += evt.thinking.delta;
      if (et === 'fulfillment' && typeof evt.answer === 'string') {
        streamedNarrative += evt.answer;
        emit?.({ type: 'digest_delta', delta: evt.answer });
      }
    } catch { /* keepalive */ }
  };
  let answer;
  try {
    answer = await streamQuery({ odSessionId: sid, query, pluginIds: [], systemPrompt: 'You are the ODA media desk. Use ONLY the provided list. Output the single JSON object, nothing else.', onRaw });
  } catch (e) {
    day.digestError = `Digest stream failed (HTTP ${e.status || 0}): ${e.message}`; saveDay(day); return null;
  }
  const j = extractJson(answer) || {};
  const validIds = new Set(done.map(v => v.videoId));
  const digest = {
    top3: (Array.isArray(j.top3) ? j.top3 : []).filter(t => validIds.has(t.videoId)).slice(0, 3)
      .map(t => ({ videoId: t.videoId, headline: String(t.headline || '').slice(0, 120), why: String(t.why || '').slice(0, 160) })),
    narrative: String(j.narrative || '').slice(0, 800),
    sentimentBalance: balance,
    flagCounts: flags,
    analysedCount: done.length,
    model: 'gpt-5.6-sol-medium', streamed: true,
    thinking: thinking.slice(0, 8000),
    builtAt: nowIso(),
    latencyMs: Date.now() - t0,
  };
  day.digest = digest;
  delete day.digestError;
  saveDay(day);
  return digest;
}

// ---------- run orchestration ----------
const running = new Map(); // date -> true

function ensureDay(date) {
  let day = getDay(date);
  if (!day) {
    day = { date, createdAt: nowIso(), lastRunAt: null, videos: [], digest: null, schedule: SCHEDULE };
  }
  const seed = SEED[date] || [];
  const have = new Set(day.videos.map(v => v.videoId));
  for (const s of seed) {
    if (!have.has(s.videoId)) {
      day.videos.push({
        videoId: s.videoId, outlet: s.outlet, subLabel: s.subLabel || null,
        title: null, author: null, durationSec: null, publishedAt: null,
        status: 'pending', transcript: null, analysis: null, failReason: null, log: [],
      });
    }
  }
  saveDay(day);
  return day;
}

export function isRunning(date) { return running.has(date); }

/**
 * Run (or resume) a day's pipeline. emit(event) receives progressive events:
 *  {type:'video', video}         — a video's status/analysis changed
 *  {type:'digest_delta', delta}  — streamed digest tokens
 *  {type:'digest', digest}       — final digest
 *  {type:'day', day}             — final day record
 * DEDUPE GUARANTEES: a videoId with a stored transcript is NEVER re-transcribed
 * (global index check); a video already status "done" is never re-analysed.
 */
export async function runDay(date, emit) {
  if (running.has(date)) { const e = new Error('A run is already in progress for this date'); e.code = 409; throw e; }
  running.set(date, true);
  try {
    const day = ensureDay(date);
    day.lastRunAt = nowIso();
    saveDay(day);

    const pub = (v) => emit?.({ type: 'video', video: v });

    const processVideo = async (video) => {
      try {
        if (video.status === 'done' && video.analysis) { pub(video); return; } // dedupe: fully processed

        // metadata (best-effort, refresh if missing)
        if (!video.title) {
          const meta = await fetchYtMeta(video.videoId);
          Object.assign(video, {
            title: meta.title || video.title, author: meta.author || video.author,
            durationSec: meta.durationSec ?? video.durationSec, publishedAt: meta.publishedAt || video.publishedAt,
          });
          saveDay(day); pub(video);
        }

        // 1) transcript — reuse from global index if this videoId was EVER processed
        let text = getTranscriptText(video.videoId);
        if (text) {
          if (!video.transcript) {
            const idxEntry = getIndex().videos[video.videoId] || {};
            video.transcript = { chars: text.length, mediaId: idxEntry.mediaId || null, cached: true };
            log(day, video, { step: 'transcribe.cache', http: 200, ms: 0, note: `reused stored transcript (${text.length} chars) — dedupe: no re-transcription` });
          }
        } else {
          video.status = 'transcribing'; saveDay(day); pub(video);
          if (!day._mediaSessionId) {
            const t0 = Date.now();
            day._mediaSessionId = await createOdSession(`msm-media-${date}`, []);
            log(day, video, { step: 'media.session', http: 201, ms: Date.now() - t0, note: day._mediaSessionId });
          }
          const res = await transcribeVideo(day, video, day._mediaSessionId);
          if (!res.ok) {
            video.status = 'transcription-failed';
            video.failReason = res.reason;
            saveDay(day); pub(video);
            return;
          }
          text = getTranscriptText(video.videoId);
          video.transcript = { chars: res.chars, mediaId: res.mediaId, cached: false };
        }

        // 2) analysis
        if (!video.analysis) {
          video.status = 'analysing'; saveDay(day); pub(video);
          const res = await analyseVideo(day, video, text);
          if (!res.ok) {
            video.status = 'analysis-failed';
            video.failReason = res.reason;
            saveDay(day); pub(video);
            return;
          }
          video.analysis = res.analysis;
        }
        video.status = 'done';
        video.failReason = null;
        saveDay(day); pub(video);
      } catch (e) {
        video.status = video.transcript ? 'analysis-failed' : 'transcription-failed';
        video.failReason = e.message;
        log(day, video, { step: 'video.error', http: e.status || 0, ms: 0, note: e.message });
        saveDay(day); pub(video);
      }
    };

    // limited-parallelism pool (3) — progressive card rendering, no grid-blocking
    const queue = [...day.videos];
    const workers = Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const v = queue.shift();
        if (v) await processVideo(v);
      }
    });
    await Promise.all(workers);

    // 3) digest (rebuild each run so late-arriving analyses are included)
    const digest = await buildDigest(day, emit);
    if (digest) emit?.({ type: 'digest', digest });

    delete day._mediaSessionId;
    day.lastRunAt = nowIso();
    saveDay(day);
    emit?.({ type: 'day', day: publicDay(day) });
    return day;
  } finally {
    running.delete(date);
  }
}

// ---------- DOCX transcript ----------
async function transcriptDocx(video, text) {
  const paras = [];
  paras.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: video.title || `YouTube ${video.videoId}`, bold: true })] }));
  paras.push(new Paragraph({ children: [new TextRun({ text: `${outletName(video.outlet)}${video.subLabel ? ` (${video.subLabel})` : ''} — https://www.youtube.com/watch?v=${video.videoId}`, italics: true, size: 20 })] }));
  paras.push(new Paragraph({ children: [new TextRun({ text: `Transcript exported ${nowIso()} · MSM Analysis · ODA Productivity Suite`, italics: true, size: 18, color: '888888' })] }));
  paras.push(new Paragraph({ text: '' }));
  // Chunk into readable paragraphs (~700 chars, split on sentence boundaries).
  const sentences = text.split(/(?<=[.!?؟])\s+/);
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).length > 700) { if (cur) paras.push(new Paragraph({ children: [new TextRun({ text: cur, size: 22 })] })); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) paras.push(new Paragraph({ children: [new TextRun({ text: cur, size: 22 })] }));
  const doc = new Document({ sections: [{ children: paras }] });
  return Packer.toBuffer(doc);
}

// ---------- Express routes ----------
export function registerMsmRoutes(app) {
  app.get('/api/msm/config', (req, res) => res.json({
    outlets: OUTLETS, schedule: SCHEDULE,
    transcription: { api: 'POST /media/v1/public/file (OnDemand Media API, YouTube URL, actionStatus polling)', analysisModel: 'gpt-5.6-sol-medium (streamed, thinking captured)' },
  }));

  app.get('/api/msm/dates', (req, res) => res.json({ dates: listDates() }));

  app.get('/api/msm/day/:date', (req, res) => {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
    let day = getDay(date);
    if (!day && SEED[date]) day = ensureDay(date); // seeded but not yet run — show pending cards
    if (!day) return res.status(404).json({ error: 'No MSM record for this date', date });
    res.json({ day: publicDay(day), running: isRunning(date) });
  });

  app.get('/api/msm/transcript/:videoId', (req, res) => {
    const text = getTranscriptText(req.params.videoId);
    if (text == null) return res.status(404).json({ error: 'No stored transcript for this video' });
    res.json({ videoId: req.params.videoId, chars: text.length, text });
  });

  app.get('/api/msm/transcript/:videoId/download', async (req, res) => {
    const { videoId } = req.params;
    const format = req.query.format === 'docx' ? 'docx' : 'txt';
    const text = getTranscriptText(videoId);
    if (text == null) return res.status(404).json({ error: 'No stored transcript for this video' });
    // find video meta in any day record for a nice title
    let video = { videoId, outlet: '', title: null, subLabel: null };
    for (const d of listDates()) {
      const day = getDay(d);
      const hit = day?.videos?.find(v => v.videoId === videoId);
      if (hit) { video = hit; break; }
    }
    const stem = `msm-transcript-${videoId}`;
    try {
      if (format === 'docx') {
        const buf = await transcriptDocx(video, text);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${stem}.docx"`);
        return res.send(buf);
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.txt"`);
      return res.send(text);
    } catch (e) {
      console.error('[FAIL] [msm] transcript export failed:', e.message);
      return res.status(500).json({ error: `Export failed: ${e.message}` });
    }
  });

  // POST /api/msm/run {date?} — SSE progress stream ("Refresh now" + scheduler entrypoint)
  app.post('/api/msm/run', async (req, res) => {
    const date = (req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : gulfToday();
    if (isRunning(date)) return res.status(409).json({ error: 'A run is already in progress for this date' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    let closed = false;
    res.on('close', () => { closed = true; });
    const hb = setInterval(() => { if (!closed) { res.write(': keepalive\n\n'); res.flush?.(); } }, 10000);
    const emit = (evt) => { if (!closed) { res.write(`data:${JSON.stringify(evt)}\n\n`); res.flush?.(); } };
    try {
      emit({ type: 'started', date, at: nowIso() });
      await runDay(date, emit); // keeps running even if the browser disconnects — the store is the source of truth
    } catch (e) {
      emit({ type: 'error', message: e.message });
    } finally {
      clearInterval(hb);
      if (!closed) { res.write('data:[DONE]\n\n'); res.end(); }
    }
  });
}

// Gulf Standard Time (UTC+4, no DST) "today"
export function gulfToday() {
  const d = new Date(Date.now() + 4 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
