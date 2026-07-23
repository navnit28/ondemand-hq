// widgetRenderer.js — ODA Live Widget renderer (universal workspace, 2026-07-23).
// GLM 4.7 streams widget code that assembles visibly in an in-canvas card.
// Wire protocol from the model (parse-friendly, no JSON-in-stream fragility):
//   TITLE: snake_case_title
//   LOADING: msg one here | msg two here | msg three | msg four
//   ---
//   <widget code streams from here>
// The route forwards REAL stream deltas as SSE frames: widget.meta (title +
// loading messages as soon as the header parses), widget.chunk (code deltas),
// widget.done (full code + byte count). No timers, no simulated assembly.
import { streamQuery } from '../ondemand.js';
import { GLM_47_INTERPRETER_ENDPOINT_ID } from './models.js';

/** Allowed external hosts inside widget code (contract CDN allowlist). */
export const ALLOWED_CDNS = Object.freeze([
  'cdnjs.cloudflare.com', 'esm.sh', 'cdn.jsdelivr.net', 'unpkg.com',
  'fonts.googleapis.com', 'fonts.gstatic.com',
]);

/** The full widget output contract, encoded as the GLM system prompt. */
export function buildWidgetSystemPrompt() {
  return [
    'You are the ODA live widget renderer. Produce ONE widget for the request.',
    'OUTPUT FORMAT (exactly, no fences, no commentary):',
    'TITLE: <snake_case_specific_title>',
    'LOADING: <~5-word playful message> | <msg 2> | <msg 3> | <msg 4>',
    '---',
    '<widget_code>',
    'LOADING messages stay serious for serious topics (crises, casualties, famine).',
    'widget_code rules: raw HTML fragment or a single <svg>. No <html>/<head>/<body> shell.',
    'Transparent background, no top-level padding. Never position:fixed. No internal scrolling or overflow.',
    'STREAMING ORDER: one short <style> block (<=15 lines) FIRST, then content HTML, then <script> LAST. Prefer inline styles. No code comments.',
    'No gradients, no box-shadows, no blur, no glow. No tabs, carousels, or display:none during streaming.',
    'Libraries: UMD builds only, loaded via <script src> BEFORE inline usage. Allowed hosts ONLY: ' + ALLOWED_CDNS.join(', ') + '.',
    'DESIGN TOKENS ONLY for UI text and surfaces — never raw hex for those: var(--surface-0), var(--surface-1), var(--surface-2), var(--bg-accent), var(--bg-danger), var(--bg-success), var(--bg-warning), var(--text-primary), var(--text-secondary), var(--text-muted), var(--text-accent), var(--text-danger), var(--text-success), var(--text-warning), var(--border), var(--border-strong), var(--font-sans), var(--font-voice), var(--font-mono), var(--radius) 8px controls, var(--radius-card) 12px cards. All tokens flip in dark mode.',
    'Typography: body 16px weight 400 line-height 1.7; h1 22px, h2 18px, h3 16px, all weight 500. ONLY weights 400 and 500. No font below 11px. Sentence case everywhere — no ALL CAPS.',
    'Brand accent only for agent-initiated actions; at most ONE accent-filled button per view.',
    'Cards: var(--surface-2), 0.5px var(--border), var(--radius-card), padding 1rem 1.25rem. Metric cards: var(--surface-1), no border.',
    'Outline icons only, no emoji. Every number formatted with toLocaleString or toFixed.',
    'Charts: Chart.js UMD from cdnjs; canvas inside a position:relative wrapper with the height on the WRAPPER only; responsive:true, maintainAspectRatio:false; custom HTML legend; cap history near 40 points.',
    'SVG diagrams: viewBox="0 0 680 H"; role="img" with <title> and <desc> first; safe area x=40..640; max 5 nodes; connector paths fill="none"; text uses dominant-baseline="central".',
    'Accessibility: HTML widgets OPEN with <h2 class="sr-only">one-sentence summary</h2>. Canvas gets role="img" + aria-label + fallback text.',
    'Bridge API (host-injected globals — call, never redefine): sendTask(text) for drill-downs (label buttons with a trailing \u2197), liveQuery(source, params, callback), refresh(), openLink(url). EXACTLY ONE sendTask drill-down per widget.',
    'Voice: sentence case, no terminal punctuation on labels, contractions fine, verb-first, no ampersands, never mention models or providers.',
  ].join('\n');
}

/**
 * Incremental parser for the TITLE/LOADING/---/code wire format.
 * Feed chunks; it emits meta once and code deltas after the separator.
 */
export function createWidgetParser() {
  let buffer = '';
  let meta = null;
  let sepIndex = -1;
  return {
    /** @returns {{meta?: {title, loadingMessages}, codeDelta?: string}} */
    push(chunk) {
      buffer += chunk;
      const out = {};
      if (!meta) {
        const m = buffer.match(/TITLE:\s*([a-z0-9_]+)/i);
        const l = buffer.match(/LOADING:\s*([^\n]+)/i);
        const sep = buffer.indexOf('---');
        if (m && l && sep > -1) {
          meta = {
            title: m[1].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'oda_widget',
            loadingMessages: l[1].split('|').map((x) => x.trim()).filter(Boolean).slice(0, 4),
          };
          sepIndex = sep + 3;
          out.meta = meta;
          const tail = buffer.slice(sepIndex).replace(/^\s*\n/, '');
          if (tail) out.codeDelta = tail;
        }
      } else {
        out.codeDelta = chunk;
      }
      return out;
    },
    getCode() {
      if (sepIndex < 0) return '';
      return buffer.slice(sepIndex).replace(/^\s*\n/, '').replace(/```(?:html)?/g, '').trim();
    },
    getMeta() { return meta; },
  };
}

/** Strip scripts whose src is not on the CDN allowlist (defence in depth). */
export function sanitizeWidgetCode(code) {
  return String(code || '').replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    try {
      const host = new URL(src, 'https://x.invalid').hostname;
      return ALLOWED_CDNS.includes(host) ? tag : '';
    } catch { return ''; }
  });
}

/**
 * Stream a widget render over an Express response as SSE.
 * Every frame corresponds to a REAL model stream delta.
 */
export async function streamWidget({ sessionId, prompt, res }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event:${event}\ndata:${JSON.stringify(data)}\n\n`);
  const parser = createWidgetParser();
  let metaSent = false;
  try {
    await streamQuery({
      odSessionId: sessionId,
      query: prompt,
      systemPrompt: buildWidgetSystemPrompt(),
      pluginIds: [],
      endpointId: GLM_47_INTERPRETER_ENDPOINT_ID, // GLM streams the widget; final DOCUMENTS stay on opus-4.8
      reasoningEffort: 'low',
      fulfillmentOnly: true,
      onEvent: (ev) => {
        const delta = ev?.answer ?? ev?.delta ?? '';
        if (!delta) return;
        const { meta, codeDelta } = parser.push(String(delta));
        if (meta && !metaSent) { metaSent = true; send('widget.meta', meta); }
        if (codeDelta) send('widget.chunk', { delta: codeDelta });
      },
    });
    const code = sanitizeWidgetCode(parser.getCode());
    send('widget.done', { title: parser.getMeta()?.title || 'oda_widget', code, bytes: code.length });
  } catch (err) {
    send('widget.error', { error: err.message });
  } finally {
    res.end();
  }
}
