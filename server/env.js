// env.js — loads .env (server-side only). The API key NEVER ships to the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  // Look for .env at app root (../.env relative to server/)
  for (const p of [path.join(__dirname, '..', '.env'), path.join(process.cwd(), '.env')]) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return p;
    } catch { /* try next */ }
  }
  return null;
}
const envPath = loadDotEnv();

// Env-wiring fix (2026-07-19): accept BOTH naming variants. `.env.example` declares
// ONDEMAND_API_KEY; some deploy runtimes export the platform-standard spelling
// ON_DEMAND_API_KEY. The 500 root cause was a deploy that injected neither — the
// fallback makes runtime injection work under either name. Never hardcoded/logged.
export const ONDEMAND_API_KEY = process.env.ONDEMAND_API_KEY || process.env.ON_DEMAND_API_KEY || '';
export const ONDEMAND_BASE_URL = (process.env.ONDEMAND_BASE_URL || process.env.ON_DEMAND_BASE_URL || 'https://api.on-demand.io').replace(/\/$/, '');
export const PORT = parseInt(process.env.PORT || '8080', 10);

// ---------- Reasoning-mode configuration (2026-07-20 streaming fix) ----------
// The DECOMPOSED model config is the only valid form: endpointId + TOP-LEVEL
// reasoningEffort. Suffixed model ids (e.g. 'gpt-5.6-sol-medium') are a PROVEN
// HTTP 400 (dead end D2) and must never appear in a request body.
// Supported modes come from GET /config/v1/public/endpoints for
// predefined-gpt-5.6-sol: reasoning_efforts ["low","medium","max"] (re-verified
// live 2026-07-20T20:35Z). Any configured value is validated against this list.
export const REASONING_EFFORTS = ['low', 'medium', 'max'];
// THE only ACTIVE GLM 4.7 endpoint (live registry 2026-07-20T20:57:56Z): Cerebras BYOI,
// model_id zai-glm-4.7, 65k ctx, streaming true. predefined-glm-4.7 and
// predefined-glm-4.7-flash are INACTIVE registry entries — never ship against them.
export const GLM_BYOI_ENDPOINT_ID = 'byoi-6e314690-4eaf-4def-a33c-380809acf1f5';
export function validEffort(effort, fallback) {
  if (REASONING_EFFORTS.includes(effort)) return effort;
  if (effort) console.warn(`[env] invalid reasoningEffort "${effort}" — must be one of ${REASONING_EFFORTS.join('|')}; using "${fallback}"`);
  return fallback;
}

// MAIN CHAT model policy (2026-07-20 GLM switch): ALL non-workflow completion calls
// run on the ACTIVE GLM 4.7 Cerebras BYOI endpoint with TOP-LEVEL reasoningEffort,
// DEFAULT 'low' — explicitly NOT medium and NOT max (validator above enforces the
// enum; invalid values fall back to 'low'). Decomposed form only — suffixed model
// ids are a proven HTTP 400 (dead end D2). Workflows stay on their own platform-side
// model config (gpt-5.6-sol) — workflow defs are NOT touched by this policy.
// Override via CHAT_ENDPOINT_ID / CHAT_REASONING_EFFORT (validated above).
export const ENDPOINT_ID = process.env.CHAT_ENDPOINT_ID || GLM_BYOI_ENDPOINT_ID;
export const REASONING_EFFORT = validEffort(process.env.CHAT_REASONING_EFFORT, 'low');
// Data-gathering model (Perplexity/X plugin stages) — GLM BYOI (2026-07-20 switch;
// GLM+agent attachment live-probed 200 "OK" at 20:58:24Z). Env-overridable.
export const GATHER_ENDPOINT_ID = process.env.GATHER_ENDPOINT_ID || GLM_BYOI_ENDPOINT_ID;
export const GATHER_REASONING_EFFORT = validEffort(process.env.GATHER_REASONING_EFFORT, 'medium');

// ANALYSIS model policy for the ODA Intelligence pipeline (server/intel.js).
// PRODUCTION: predefined-gpt-5.6-sol + medium (same as chat). Overridable via env
// for controlled test passes — e.g. ANALYSIS_ENDPOINT_ID=predefined-gemini-3.5-flash
// (id verified live against GET /config/v1/public/endpoints, 2026-07-17).
export const ANALYSIS_ENDPOINT_ID = process.env.ANALYSIS_ENDPOINT_ID || ENDPOINT_ID;
export const ANALYSIS_REASONING_EFFORT = validEffort(process.env.ANALYSIS_REASONING_EFFORT, REASONING_EFFORT);

// STREAM_DEBUG: verbose SSE frame logging (upstream + browser side).
// endpoint. ON by default at start; set STREAM_DEBUG=false to turn off (STREAM_DEBUG=true = explicit-on).
export const STREAM_DEBUG = String(process.env.STREAM_DEBUG ?? 'true').toLowerCase() !== 'false';

// ---------- Correlating model (2026-07-21 v3 switch): FABLE 5 MAX ----------
// The Correlation Engine is PREFILLED with Fable 5 MAX (predefined-claude-fable-5
// at MAX reasoning effort) as the DEFAULT/SELECTED model for every correlation
// surface: analysis, extraction, narrative, story mode, and the deep pipeline.
// Env-overridable via CE_CORRELATION_ENDPOINT_ID / CE_CORRELATION_REASONING_EFFORT.
export const FABLE_5_MAX_ENDPOINT_ID = process.env.CE_CORRELATION_ENDPOINT_ID || 'predefined-claude-fable-5';
export const FABLE_5_MAX_REASONING_EFFORT = validEffort(process.env.CE_CORRELATION_REASONING_EFFORT, 'max');
export const FABLE_5_MAX_LABEL = 'Fable 5 MAX';
// Kimi K3 is retained ONLY for plugin/evidence-gathering calls (Claude endpoints
// reject plugin attachment on this platform — HTTP 400 "agents are invalid",
// live-logged 2026-07-19 in PLUGIN_TESTS.md).
export const KIMI_K3_ENDPOINT_ID = process.env.CE_PLUGIN_GATHER_ENDPOINT_ID || 'predefined-kimi-k3';
export const KIMI_K3_REASONING_EFFORT = validEffort(process.env.CE_PLUGIN_GATHER_REASONING_EFFORT, 'medium');

// ---------- Hard-force data-fetch policy (2026-07-20; 2026-07-21 fable-only rewrite) ----------
// fable-5-medium is the ONLY synchronous data-population model (2026-07-21).
// Cerebras GLM 4.7 no longer sits in the synchronous ladder — it is retained
// SOLELY as the server-side BACKGROUND backfill engine that tops up a short
// fable pass (merge+dedupe, UI auto-refresh; see dataFetch.js cerebrasDeltaFetch).
export const FABLE_FALLBACK_ENDPOINT_ID = process.env.CE_DATAFETCH_ENDPOINT_ID || 'predefined-claude-fable-5';
export const FABLE_FALLBACK_REASONING_EFFORT = validEffort(process.env.CE_DATAFETCH_REASONING_EFFORT_FABLE, 'medium');
// ---------- Cerebras policy (2026-07-21 v3 restriction) ----------
// Cerebras (GLM 4.7 BYOI) is restricted to QUICK SUMMARIES and QUICK QUERIES ONLY.
// It is fully REMOVED from the correlation engine backend: no data-fetch pass,
// no background backfill, no analysis/narrative/story call may use it. The
// background delta backfill now runs on Fable (see dataFetch.js backgroundDeltaFetch).
export const CEREBRAS_QUICK_ENDPOINT_ID = process.env.CEREBRAS_QUICK_ENDPOINT_ID || GLM_BYOI_ENDPOINT_ID; // quick summaries + quick queries ONLY
export const CEREBRAS_QUICK_REASONING_EFFORT = validEffort(process.env.CEREBRAS_QUICK_REASONING_EFFORT, 'low');
export const CE_DATAFETCH_REASONING_EFFORT = validEffort(process.env.CE_BACKFILL_REASONING_EFFORT, 'low');
export const CE_MIN_DATA_POINTS = Math.max(100, parseInt(process.env.CE_MIN_DATA_POINTS || '100', 10) || 100);  // strict floor — clamped, can never be configured below 100

if (!ONDEMAND_API_KEY) {
  console.error('[FAIL] [FATAL-CONFIG] ONDEMAND_API_KEY is not set. Create .env from .env.example. Refusing to start with a hardcoded or missing key.');
} else {
  console.log(`[env] loaded ${envPath ? envPath : 'process env'} · base=${ONDEMAND_BASE_URL} · endpoint=${ENDPOINT_ID}+${REASONING_EFFORT} · streamDebug=${STREAM_DEBUG} · key=****${ONDEMAND_API_KEY.slice(-4)}`);
}

// ---------- Correlation Engine model policy (2026-07-19) ----------
// Plugin/evidence-gathering calls: Claude endpoints REJECT plugin attachment on this
// platform (HTTP 400 "agents are invalid", live-logged 2026-07-19 in PLUGIN_TESTS.md),
// so plugins run on the proven fulfillment model. Overridable via env.
export const CE_PLUGIN_ENDPOINT_ID = process.env.CE_PLUGIN_ENDPOINT_ID || KIMI_K3_ENDPOINT_ID; // Kimi K3 — plugin attachment only (Claude endpoints reject plugins)
// Analysis/extraction/narrative: PREFILLED default Fable 5 MAX (2026-07-21 v3).
// Build/test override: CE_ANALYSIS_ENDPOINT_ID=predefined-claude-sonnet-5 (both 200-verified
// 2026-07-19). Set in config here — never hardcoded at call sites.
export const CE_ANALYSIS_ENDPOINT_ID = process.env.CE_ANALYSIS_ENDPOINT_ID || FABLE_5_MAX_ENDPOINT_ID; // Fable 5 MAX — THE prefilled correlating model (2026-07-21 v3)
export const CE_ANALYSIS_REASONING_EFFORT = validEffort(process.env.CE_ANALYSIS_REASONING_EFFORT, FABLE_5_MAX_REASONING_EFFORT);
// Streamed CE surfaces (summarize/story/narrative): Fable 5 MAX (2026-07-21 v3 —
// correlation surfaces are Cerebras-free AND GLM-free). Var name kept for low-risk
// call-site compatibility; value is Fable 5 MAX.
export const GLM_ENDPOINT_ID = FABLE_5_MAX_ENDPOINT_ID;
// Streamed CE surfaces (quick-query/summarize/story) — validated, env-overridable.
export const CE_STREAM_REASONING_EFFORT = validEffort(process.env.CE_STREAM_REASONING_EFFORT, 'max');
export const QUICK_QUERY_MAX_TOKENS = 150;
