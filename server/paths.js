// paths.js — resolves the data directory for both persistent servers and serverless.
//
// On a normal long-running host the app reads AND writes under server/data.
// On Vercel (and most serverless runtimes) the deployment bundle is READ-ONLY —
// only /tmp is writable. A top-level fs.mkdirSync/writeFileSync into the bundle
// throws EROFS during cold-start module init, which surfaces as
// FUNCTION_INVOCATION_FAILED before any route runs.
//
// Fix: when running on Vercel, mirror the committed data (seeds + static
// datasets) into /tmp ONCE, then point every data path at that writable mirror.
// Both reads (seeds) and writes (live runs, caches, snapshots) then work.
// NOTE: /tmp is ephemeral and per-instance — data written at runtime does not
// persist across cold starts or between concurrent lambda instances.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_DATA = path.join(__dirname, 'data');
const ON_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export const DATA_DIR = ON_SERVERLESS ? '/tmp/oda-data' : BUNDLE_DATA;

if (ON_SERVERLESS) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.cpSync(BUNDLE_DATA, DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('[paths] failed to mirror bundled data into /tmp:', e.message);
  }
}
