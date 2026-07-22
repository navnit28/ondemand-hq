// Vercel serverless entry point.
// Vercel treats files under /api as serverless functions. This re-exports the
// Express app as the request handler; server/index.js detects the serverless
// environment (process.env.VERCEL) and skips app.listen() accordingly.
// server/data/** is bundled via the includeFiles config in vercel.json, and
// server/paths.js mirrors it into /tmp at runtime (the bundle is read-only).
import app from '../server/index.js';

export default app;
