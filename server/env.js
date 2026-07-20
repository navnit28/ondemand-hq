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

// The ONE model policy: every call, everywhere, uses gpt-5.6-sol-medium =
// endpoint predefined-gpt-5.6-sol + reasoningEffort "medium" (verified live in Phase 1:
// the suffixed id form returns HTTP 400; the decomposition returns 200).
// (2026-07-20 model switch) Platform prompts/queries — chat, search, Quick Query,
// regenerate streams — now run on GLM 4.7 Cerebras BYOI with TOP-LEVEL
// reasoningEffort 'max' (decomposed; suffixed ids are a proven 400 — dead end D2).
// Data-gathering call sites (Perplexity/X stages) stay pinned to gpt-5.6-sol below.
export const ENDPOINT_ID = process.env.CHAT_ENDPOINT_ID || 'byoi-6e314690-4eaf-4def-a33c-380809acf1f5'; // zai-glm-4.7 (Cerebras)
export const REASONING_EFFORT = process.env.CHAT_REASONING_EFFORT || 'max';
// Data-gathering model (Perplexity/X plugin stages) — UNCHANGED per 2026-07-20 task.
export const GATHER_ENDPOINT_ID = 'predefined-gpt-5.6-sol';
export const GATHER_REASONING_EFFORT = 'medium';

// ANALYSIS model policy for the ODA Intelligence pipeline (server/intel.js).
// PRODUCTION: predefined-gpt-5.6-sol + medium (same as chat). Overridable via env
// for controlled test passes — e.g. ANALYSIS_ENDPOINT_ID=predefined-gemini-3.5-flash
// (id verified live against GET /config/v1/public/endpoints, 2026-07-17).
export const ANALYSIS_ENDPOINT_ID = process.env.ANALYSIS_ENDPOINT_ID || ENDPOINT_ID;
export const ANALYSIS_REASONING_EFFORT = process.env.ANALYSIS_REASONING_EFFORT || REASONING_EFFORT;

// STREAM_DEBUG: verbose SSE frame logging (upstream + browser side).
// endpoint. ON by default at start; set STREAM_DEBUG=false to turn off (STREAM_DEBUG=true = explicit-on).
export const STREAM_DEBUG = String(process.env.STREAM_DEBUG ?? 'true').toLowerCase() !== 'false';

if (!ONDEMAND_API_KEY) {
  console.error('[FAIL] [FATAL-CONFIG] ONDEMAND_API_KEY is not set. Create .env from .env.example. Refusing to start with a hardcoded or missing key.');
} else {
  console.log(`[env] loaded ${envPath ? envPath : 'process env'} · base=${ONDEMAND_BASE_URL} · endpoint=${ENDPOINT_ID}+${REASONING_EFFORT} · streamDebug=${STREAM_DEBUG} · key=****${ONDEMAND_API_KEY.slice(-4)}`);
}

// ---------- Correlation Engine model policy (2026-07-19) ----------
// Plugin/evidence-gathering calls: Claude endpoints REJECT plugin attachment on this
// platform (HTTP 400 "agents are invalid", live-logged 2026-07-19 in PLUGIN_TESTS.md),
// so plugins run on the proven fulfillment model. Overridable via env.
export const CE_PLUGIN_ENDPOINT_ID = process.env.CE_PLUGIN_ENDPOINT_ID || 'predefined-gpt-5.6-sol';
// Analysis/extraction/narrative: PRODUCTION default claude-fable-5 + medium reasoning.
// Build/test override: CE_ANALYSIS_ENDPOINT_ID=predefined-claude-sonnet-5 (both 200-verified
// 2026-07-19). Set in config here — never hardcoded at call sites.
export const CE_ANALYSIS_ENDPOINT_ID = process.env.CE_ANALYSIS_ENDPOINT_ID || 'predefined-claude-fable-5';
export const CE_ANALYSIS_REASONING_EFFORT = process.env.CE_ANALYSIS_REASONING_EFFORT || 'medium';
// Quick Query: GLM 4.7 Cerebras BYOI only (200-proven 2026-07-19, ~1.28s). No documented
// max-tokens param → hard stop enforced client-side at QUICK_QUERY_MAX_TOKENS.
export const GLM_ENDPOINT_ID = 'byoi-6e314690-4eaf-4def-a33c-380809acf1f5';
export const QUICK_QUERY_MAX_TOKENS = 150;
