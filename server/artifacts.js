// artifacts.js — intent-based artifact orchestration.
// Routes each requested output type to the correct OnDemand capability
// (verified ADOPT registry ids), streams phase status (Queued → Planning →
// Generating → Rendering → Validating → Complete/Failed/Retrying) through the
// session SSE channel, validates artifact URLs before exposing them (HTTP
// HEAD, GET-range fallback), and persists task + link in the server-side store.
//
// Route map (BUILD spec §3):
//   docx  → HTML→Word plugin        plugin-1759408928
//   pdf   → Text & Markdown→PDF     plugin-1739264368
//   pptx/xlsx/csv → OnDemand Agent  plugin-1775547203
//   md/html      → local assembly (text formats — no external call needed)
//   image        → GPT Image 2      plugin-1776826082
//   audio        → Services text_to_speech (subscription-gated; graceful fail)
// Local pptxgenjs/exceljs/docx/pdfkit assembly (exports.js) remains the fallback
// so a plugin outage never breaks exports.
import crypto from 'node:crypto';
import { ADOPTED } from './plugins.js';
import { createOdSession, syncQuery } from './ondemand.js';
import { buildExport } from './exports.js';
import * as store from './store.js';
import * as log from './log.js';

export const ARTIFACT_ROUTES = {
  docx:  { via: 'plugin', pluginKey: 'htmlToDocx',  label: 'HTML → Word (DOCX)' },
  pdf:   { via: 'plugin', pluginKey: 'mdToPdf',     label: 'Text & Markdown → PDF' },
  pptx:  { via: 'plugin', pluginKey: 'onDemandAgent', label: 'OnDemand Agent (files)' },
  xlsx:  { via: 'plugin', pluginKey: 'onDemandAgent', label: 'OnDemand Agent (files)' },
  csv:   { via: 'plugin', pluginKey: 'onDemandAgent', label: 'OnDemand Agent (files)' },
  md:    { via: 'local',  label: 'Markdown assembly' },
  html:  { via: 'local',  label: 'HTML assembly' },
  image: { via: 'plugin', pluginKey: 'gptImage2',   label: 'GPT Image 2' },
  audio: { via: 'service', label: 'Text → Speech service' },
};

/** Detect artifact intent from a free-text request. Returns format key or null. */
export function detectArtifactIntent(text) {
  const t = (text || '').toLowerCase();
  const pairs = [
    [/\b(word|docx)\b/, 'docx'],
    [/\bpdf\b/, 'pdf'],
    [/\b(deck|pptx|powerpoint|slides? file)\b/, 'pptx'],
    [/\b(xlsx|excel|spreadsheet|workbook)\b/, 'xlsx'],
    [/\bcsv\b/, 'csv'],
    [/\bmarkdown file|\.md\b/, 'md'],
    [/\bhtml (file|page|export)\b/, 'html'],
    [/\b(image|logo|illustration|visual|picture)\b.*\b(generate|create|make|draw)\b|\b(generate|create|make|draw)\b.*\b(image|logo|illustration|visual|picture)\b/, 'image'],
    [/\b(audio|voice ?over|read (this|it) aloud|narrat)\b/, 'audio'],
  ];
  for (const [rx, fmt] of pairs) if (rx.test(t)) return fmt;
  return null;
}

const URL_RX = /https?:\/\/[^\s)"'<>\]]+/g;

/** Validate an artifact URL actually exists: HEAD first, ranged GET fallback. */
export async function validateArtifactUrl(url) {
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (r.ok) return { ok: true, status: r.status, size: Number(r.headers.get('content-length')) || null, contentType: r.headers.get('content-type') };
    // some blob hosts reject HEAD — try a 1-byte ranged GET
    r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { ok: r.ok || r.status === 206, status: r.status, size: null, contentType: r.headers.get('content-type') };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/**
 * Run an artifact task end-to-end with phase streaming.
 * emit(type, payload) mirrors frames onto the chat SSE channel:
 *   emit('task', {taskId, phase, format, tool, ...})
 * Returns the completed task record.
 */
export async function runArtifactTask({ conv, format, sourceText, emit, reqId }) {
  const route = ARTIFACT_ROUTES[format];
  if (!route) throw Object.assign(new Error(`Unsupported artifact format: ${format}`), { errorCode: 'BAD_FORMAT' });

  const task = store.createTask({ conversationId: conv.id, kind: 'artifact', format });
  const phase = (p, extra = {}) => {
    store.updateTask(task.id, { phase: p, ...extra });
    emit('task', { taskId: task.id, phase: p, format, tool: route.label, ...extra });
    log.info('artifact.phase', { reqId, taskId: task.id, format, phase: p });
  };

  phase('Queued');
  phase('Planning', { detail: `route=${route.via}` });

  try {
    let artifactMeta = null;

    if (route.via === 'local' || format === 'pptx' || format === 'xlsx' || format === 'docx' || format === 'pdf' || format === 'csv') {
      // LOCAL ASSEMBLY path (deterministic, always available).
      // For plugin-routed document formats we ALSO try the plugin first below —
      // but pptx/xlsx/docx/pdf/csv all have a guaranteed local pipeline.
      let pluginTried = false;
      if (route.via === 'plugin' && ['docx', 'pdf'].includes(format)) {
        // Try the converter plugin for its hosted-URL output; fall back to local bytes.
        pluginTried = true;
        phase('Generating', { detail: `via ${route.label} (${ADOPTED[route.pluginKey].id})` });
        try {
          const odSessionId = await createOdSession(`oda-artifact-${task.id}`, [ADOPTED[route.pluginKey].id]);
          const instruction = format === 'docx'
            ? `Convert the following content into a Word document using the HTML to Word tool and return ONLY the download URL of the generated .docx file.\n\nCONTENT:\n${sourceText.slice(0, 6000)}`
            : `Convert the following markdown into a PDF using the markdown-to-PDF tool and return ONLY the download URL of the generated .pdf file.\n\nCONTENT:\n${sourceText.slice(0, 6000)}`;
          const answer = await syncQuery({ odSessionId, query: instruction, pluginIds: [ADOPTED[route.pluginKey].id] });
          const urls = answer.match(URL_RX) || [];
          const cand = urls.find(u => u.toLowerCase().includes(format)) || urls[0];
          if (cand) {
            phase('Validating', { detail: 'checking hosted artifact URL' });
            const v = await validateArtifactUrl(cand);
            if (v.ok) {
              artifactMeta = { hostedUrl: cand, size: v.size, contentType: v.contentType, source: route.label };
            } else {
              log.warn('artifact.hosted_url_invalid', { reqId, taskId: task.id, status: v.status });
            }
          }
        } catch (e) {
          log.warn('artifact.plugin_route_failed', { reqId, taskId: task.id, error: e.message, fallback: 'local-assembly' });
          phase('Retrying', { detail: 'plugin route failed — falling back to local assembly' });
        }
      }

      if (!artifactMeta) {
        phase(pluginTried ? 'Rendering' : 'Generating', { detail: 'local deterministic assembly' });
        const exp = await buildExport(format === 'csv' ? 'xlsx' : format, sourceText, { dataRows: conv._lastDataRows || [] });
        store.putExport(exp);
        phase('Validating', { detail: 'verifying stored bytes' });
        if (!exp.buffer || exp.buffer.length < 100) throw Object.assign(new Error('Generated artifact is empty'), { errorCode: 'EMPTY_ARTIFACT' });
        artifactMeta = { artifactId: exp.id, name: exp.name, size: exp.buffer.length, url: `/api/export/${exp.id}/download`, source: 'local assembly' };
      }
    } else if (route.via === 'plugin' && format === 'image') {
      phase('Generating', { detail: `via ${route.label} (${ADOPTED.gptImage2.id})` });
      const odSessionId = await createOdSession(`oda-artifact-${task.id}`, [ADOPTED.gptImage2.id]);
      const answer = await syncQuery({ odSessionId, query: `Generate an image: ${sourceText.slice(0, 1500)}. Return ONLY the image URL.`, pluginIds: [ADOPTED.gptImage2.id] });
      const url = (answer.match(URL_RX) || [])[0];
      if (!url) throw Object.assign(new Error('Image plugin returned no URL'), { errorCode: 'NO_ARTIFACT_URL' });
      phase('Validating', { detail: 'checking image URL' });
      const v = await validateArtifactUrl(url);
      if (!v.ok) throw Object.assign(new Error(`Image URL failed validation (HTTP ${v.status})`), { errorCode: 'ARTIFACT_URL_INVALID' });
      artifactMeta = { hostedUrl: url, size: v.size, contentType: v.contentType, source: route.label };
    } else if (route.via === 'service' && format === 'audio') {
      // Subscription-gated on this key (live-verified 400 "Please subscribe") — fail gracefully.
      phase('Generating', { detail: 'text_to_speech service' });
      const { ttsGenerate } = await import('./speech.js');
      const out = await ttsGenerate(sourceText.slice(0, 3800));
      if (!out.ok) throw Object.assign(new Error(out.userMessage), { errorCode: out.errorCode });
      artifactMeta = out.meta;
    }

    phase('Complete', { ...artifactMeta });
    store.updateTask(task.id, { artifactId: artifactMeta.artifactId || null, url: artifactMeta.hostedUrl || artifactMeta.url || null });
    return store.getTask(task.id);
  } catch (e) {
    phase('Failed', { errorCode: e.errorCode || 'ARTIFACT_FAILED', userMessage: e.message });
    store.updateTask(task.id, { error: e.message });
    throw e;
  }
}
