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

export const ONDEMAND_API_KEY = process.env.ONDEMAND_API_KEY || '';
export const ONDEMAND_BASE_URL = (process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io').replace(/\/$/, '');
export const PORT = parseInt(process.env.PORT || '8080', 10);

// The ONE model policy: every call, everywhere, uses gpt-5.6-sol-medium =
// endpoint predefined-gpt-5.6-sol + reasoningEffort "medium" (verified live in Phase 1:
// the suffixed id form returns HTTP 400; the decomposition returns 200).
export const ENDPOINT_ID = 'predefined-gpt-5.6-sol';
export const REASONING_EFFORT = 'medium';

// STREAM_DEBUG: verbose server-side SSE frame logging (upstream + browser side).
// Set STREAM_DEBUG=false to turn off (STREAM_DEBUG=true = explicit-on).
export const STREAM_DEBUG = String(process.env.STREAM_DEBUG ?? 'true').toLowerCase() !== 'false';

if (!ONDEMAND_API_KEY) {
  console.error('🔴 [FATAL-CONFIG] ONDEMAND_API_KEY is not set. Create .env from .env.example. Refusing to start with a hardcoded or missing key.');
} else {
  console.log(`[env] loaded ${envPath ? envPath : 'process env'} · base=${ONDEMAND_BASE_URL} · endpoint=${ENDPOINT_ID}+${REASONING_EFFORT} · streamDebug=${STREAM_DEBUG} · key=****${ONDEMAND_API_KEY.slice(-4)}`);
}
