// autoArtifact.js — MANDATORY post-run artifact packaging (live-render upgrade).
// When a run completes, the primary verified artifact is materialised into a
// downloadable file via the Phase 4 builders and its URL is surfaced in the
// run state, the SSE completion frames, and the API response. Packaging
// failure must NEVER crash run completion — it returns { downloadUrl: null,
// reason } and the caller surfaces the gap honestly.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Best output format per artifact type (default 'md'). */
const FORMAT_BY_TYPE = Object.freeze({
  'deck-html': 'html',
  'deck-pptx': 'pptx',
  'one-pager-summary': 'md',
  'storyline-md': 'md',
  'action-titles-md': 'md',
  'workbook-md': 'md',
  'benchmark-report-md': 'md',
  'insight-pack-md': 'md',
  'fast-facts-md': 'md',
  'xlsx-model': 'xlsx',
  'xlsx-data': 'xlsx',
  'media-bilingual-md': 'docx',
  'arabic-docx': 'docx',
  'arabic-pptx': 'pptx',
  markdown: 'md',
  docx: 'docx',
  pdf: 'pdf',
});

/**
 * Package the run's primary verified artifact into a downloadable file.
 * @param {object} run durable ODARun
 * @param {{format?: string|null}} [opts]
 * @returns {Promise<{downloadUrl: string|null, artifactId?: string, format?: string, bytes?: number, qa?: object, reason?: string}>}
 */
export async function packageRunArtifact(run, { format = null, preferredFormat = 'docx' } = {}) {
  try {
    const verified = (run.artifacts || []).filter((a) => a.status === 'verified');
    if (!verified.length) return { downloadUrl: null, reason: 'no verified artifact' };
    // Primary: newest verified non-synthesis artifact; fall back to synthesis.
    const primary = [...verified].reverse().find((a) => a.logicalId !== 'run-synthesis')
      || verified[verified.length - 1];

    // 2026-07-23: the final packaged deliverable is ALWAYS a .docx (product
    // contract — the final document is a Word deliverable, authored on
    // opus-4.8). Native format survives only for spreadsheet artifacts (a
    // model/data workbook cannot be a docx) or as an honest fallback when
    // the docx builder itself throws.
    const nativeFormat = FORMAT_BY_TYPE[primary.type] || 'md';
    const XLSX_NATIVE = new Set(['xlsx-model', 'xlsx-data']);
    let outputFormat = format || (XLSX_NATIVE.has(primary.type) ? nativeFormat : (preferredFormat || nativeFormat));
    const { parseContentSpec, buildArtifact } = await import('./builders/index.js');
    const spec = parseContentSpec(primary.content || primary.preview || '');
    if (!spec.title) spec.title = primary.title;

    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'files');
    fs.mkdirSync(dir, { recursive: true });
    const base = `${run.runId.slice(0, 8)}-final-${primary.logicalId}`.replace(/[^a-zA-Z0-9_-]/g, '');
    let outPath = path.join(dir, `${base}.${outputFormat}`);

    let result;
    try {
      result = await buildArtifact({ format: outputFormat, spec, outPath });
    } catch (fmtErr) {
      if (outputFormat === nativeFormat) throw fmtErr;
      console.warn(`[oda-artifact] ${outputFormat} build failed (${fmtErr.message}) — falling back to native ${nativeFormat}`);
      outputFormat = nativeFormat;
      outPath = path.join(dir, `${base}.${outputFormat}`);
      result = await buildArtifact({ format: outputFormat, spec, outPath });
    }

    const downloadUrl = `/api/oda/files/${path.basename(outPath)}`;
    primary.url = downloadUrl;
    run.finalArtifact = {
      artifactId: primary.artifactId,
      downloadUrl,
      format: outputFormat,
      bytes: result.bytes,
      qa: result.qa,
      packagedAt: new Date().toISOString(),
    };
    return { downloadUrl, artifactId: primary.artifactId, format: outputFormat, bytes: result.bytes, qa: result.qa };
  } catch (err) {
    console.warn(`[oda-artifact] packaging failed for run ${run?.runId}: ${err.message}`);
    return { downloadUrl: null, reason: err.message };
  }
}

/** The packaged final-artifact record, if any. */
export function getFinalArtifact(run) {
  return run.finalArtifact || null;
}
