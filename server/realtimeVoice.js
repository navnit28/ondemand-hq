// server/realtimeVoice.js — OpenAI Realtime API (voice) ephemeral-token route.
// The browser talks speech-to-speech to gpt-realtime over WebRTC; this route mints the
// short-lived client secret so the REAL OpenAI key never leaves the server. Session config
// (persona instructions, voice, server-VAD turn detection, tools) is baked into the token
// request, so the ephemeral session already knows how to behave the moment WebRTC connects.
//
// Grounding: the model has NO ODA intelligence in memory. The `query_intel` tool (executed
// CLIENT-SIDE against the app's own /api/intel/* endpoints) is how it pulls real, citable data.
// `world_command` drives the globe; `render_card` shows data cards. All three mirror the
// existing client validators (src/voice/commands.js, src/voice/uiSchema.js) — the client
// re-validates every tool call, so these schemas are guidance, not the trust boundary.
import crypto from 'node:crypto';
import { OPENAI_API_KEY, OPENAI_REALTIME_MODEL, OPENAI_REALTIME_VOICE } from './env.js';

const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

// ---------- tiny fixed-window rate limiter (per IP) — mirrors server/voice.js ----------
const rl = new Map();
function rateLimited(ip, max = 20, windowMs = 60000) {
  const now = Date.now();
  const e = rl.get(ip) || { count: 0, windowStart: now };
  if (now - e.windowStart > windowMs) { e.count = 0; e.windowStart = now; }
  e.count += 1; rl.set(ip, e);
  return e.count > max;
}

// ---------- persona (adapted from server/voice.js; TOOL protocol replaces fenced-JSON) ----------
const PERSONA = `You are ODA World Intelligence — the live voice of the Office of Development Affairs world view.
PERSONA: warm, calm, institutionally professional. Polished, approachable American English; fluent Modern Standard Arabic with graceful Gulf/Emirati vocabulary accommodation. Always respond in the user's language and switch naturally when they switch. Pronounce UAE, ODA, and country/organisation names carefully. You are speaking aloud — keep turns short, conversational, and easy to follow; never read out raw JSON, ids, or URLs.

KNOWLEDGE DISCIPLINE: (a) verified facts — cite the evidence returned by query_intel; (b) retrieved evidence — attribute source + date; (c) your own inference — label it "assessment"; (d) uncertainty — say plainly what is not known; (e) recommendations — frame clearly as recommendations. NEVER present unsupported strategic assumptions as facts.

GROUNDING (critical): You do NOT hold the ODA intelligence database in memory. For ANY question about a country's risk, opportunities, facts, figures, recent events, or evidence, you MUST call query_intel FIRST and base your answer on what it returns. If it returns little or nothing, say so plainly rather than inventing figures.

TOOLS (this is how you act — free speech never acts on the world view):
- world_command: move/control the globe and panels (rotate, zoom, open a country, open a layer, compare, reset, set the timeline, open/close a panel).
- render_card: show a structured data card to accompany what you say (country summary, comparison, metric, timeline, risk matrix, sources, evidence, scenario, recommendation, small chart, alert, key finding, action list). Include sources in props whenever you have them.
- query_intel: retrieve grounded ODA data before making factual claims.
When the user asks you to act on the view (e.g. "take me to Yemen", "compare UAE and Egypt"), call world_command. Pair substantive answers with a relevant render_card when it helps comprehension.`;

// ---------- tool defs (Realtime session.tools format) ----------
const CMD_ACTIONS = ['rotateTo', 'zoom', 'showCountry', 'openLayer', 'compare', 'resetView', 'setTimeline', 'openPanel', 'closePanel'];
const UI_COMPONENTS = ['CountrySummaryCard', 'ComparisonTable', 'MetricCard', 'Timeline', 'RiskMatrix', 'RouteSummary', 'SourceList', 'EvidenceCard', 'ScenarioCard', 'RecommendationCard', 'SmallChart', 'Alert', 'KeyFinding', 'ActionList'];

export const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'world_command',
    description: [
      'Control the world view. Pick one action and provide its args:',
      '- rotateTo {lat:-90..90, lng:-180..180}',
      '- zoom {level:0.6..3.5}',
      '- showCountry {iso:"2-letter ISO"} (navigate to a country)',
      '- openLayer {layer:"intel"|"correlations"|"x"|"opps"|"risks"|"agreements"|"timeline"}',
      '- compare {isoA:"ISO2", isoB:"ISO2"}',
      '- resetView {}',
      '- setTimeline {from?:"YYYY-MM-DD", to?:"YYYY-MM-DD"} (at least one of from/to)',
      '- openPanel {panel:"intelligence"|"tray"|"captions"}',
      '- closePanel {panel:"intelligence"|"tray"|"captions"}',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: CMD_ACTIONS },
        args: { type: 'object', additionalProperties: true, description: 'Arguments for the chosen action (see description).' },
      },
      required: ['action', 'args'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'render_card',
    description: 'Display a structured data card in the voice tray to accompany your spoken answer. Include a sources array in props whenever you have grounded evidence (each {id?,source,date?,url?}).',
    parameters: {
      type: 'object',
      properties: {
        component: { type: 'string', enum: UI_COMPONENTS },
        props: { type: 'object', additionalProperties: true, description: 'Props for the chosen component. Keep concise and spoken-answer-relevant.' },
        anchor: { type: 'string', description: 'Optional ISO code this card is anchored to.' },
      },
      required: ['component', 'props'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'query_intel',
    description: 'Retrieve grounded ODA intelligence. Use mode="search" for a natural-language question, "facts" for a country fact sheet, "country" for a country snapshot + history, "overview" for the global picture. Call this BEFORE stating any ODA figure, risk, opportunity, or event.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['search', 'facts', 'country', 'overview'] },
        query: { type: 'string', description: 'Natural-language question (mode="search").' },
        iso: { type: 'string', description: '2-letter ISO country code (mode="facts" or "country").' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
];

// Render the live view context into a short instructions addendum (typed, minimal).
function contextBlock(ctx = {}) {
  const c = {
    selectedCountry: ctx.selectedCountry ?? null,
    selectedRegion: ctx.selectedRegion ?? null,
    activeLayer: ctx.activeLayer ?? null,
    timelineRange: ctx.timelineRange ?? null,
    cameraFocus: ctx.cameraFocus ?? null,
  };
  return `\n\nCURRENT VIEW CONTEXT (what the user is looking at right now): ${JSON.stringify(c)}`;
}

export function buildInstructions({ context = {}, language = null } = {}) {
  let s = PERSONA + contextBlock(context);
  if (language) s += `\n\nMANUAL LANGUAGE OVERRIDE: respond in "${language}" regardless of detected input language.`;
  return s;
}

export function registerRealtimeVoiceRoutes(app) {
  // Mint an ephemeral client secret for a browser WebRTC Realtime session.
  app.post('/api/voice/realtime/token', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'rate_limited' });
    if (!OPENAI_API_KEY) return res.status(503).json({ error: 'openai_key_not_loaded' });
    const { context = {}, language = null } = req.body || {};
    const safetyId = crypto.createHash('sha256').update(String(req.ip || 'anon')).digest('hex').slice(0, 32);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), 15000);
    try {
      const r = await fetch(OPENAI_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': safetyId,
        },
        signal: controller.signal,
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: OPENAI_REALTIME_MODEL,
            instructions: buildInstructions({ context, language }),
            // Current API: turn detection (server-VAD) lives under audio.input, not top-level.
            audio: {
              input: { turn_detection: { type: 'server_vad' } },
              output: { voice: OPENAI_REALTIME_VOICE },
            },
            tools: REALTIME_TOOLS,
          },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Surface OpenAI's own message (e.g. invalid voice/model, billing) without leaking the key.
        const msg = j?.error?.message || j?.message || `HTTP ${r.status}`;
        console.error('[realtime] token mint failed:', String(msg).slice(0, 200));
        return res.status(502).json({ error: 'token_mint_failed', detail: String(msg).slice(0, 200) });
      }
      // Response shape: { value: "<EPHEMERAL_KEY>", ... }
      const value = j?.value || j?.client_secret?.value || null;
      if (!value) {
        console.error('[realtime] token response missing value:', JSON.stringify(j).slice(0, 200));
        return res.status(502).json({ error: 'token_no_value' });
      }
      res.json({ value, model: OPENAI_REALTIME_MODEL, voice: OPENAI_REALTIME_VOICE });
    } catch (e) {
      console.error('[realtime] token error:', String(e.message).slice(0, 160));
      res.status(502).json({ error: 'token_error' });
    } finally { clearTimeout(timeout); }
  });
}
