// log.js — structured logging / observability. JSON lines with request ids,
// event names, error codes, and durations. No secrets are ever logged.
import crypto from 'node:crypto';

const REDACT = [/apikey/i, /authorization/i, /token/i, /secret/i, /password/i];

function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT.some(rx => rx.test(k))) { out[k] = '[redacted]'; continue; }
    out[k] = (v && typeof v === 'object') ? scrub(v) : v;
  }
  return out;
}

/** Structured JSON log line: {ts, level, event, reqId?, ...fields} */
export function jlog(level, event, fields = {}) {
  const line = { ts: new Date().toISOString(), level, event, ...scrub(fields) };
  const s = JSON.stringify(line);
  if (level === 'error') console.error(s);
  else console.log(s);
}

export const info = (event, fields) => jlog('info', event, fields);
export const warn = (event, fields) => jlog('warn', event, fields);
export const error = (event, fields) => jlog('error', event, fields);

/** Express middleware: assigns req.id, logs request start/end with duration. */
export function requestLogger(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  res.setHeader('X-Request-Id', req.id);
  res.on('finish', () => {
    // Skip noisy static asset logs; keep API observability.
    if (req.path.startsWith('/api/')) {
      info('http.request', { reqId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 });
    }
  });
  next();
}
