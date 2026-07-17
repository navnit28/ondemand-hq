// extract.js — text extraction from uploaded pptx/docx/pdf/xlsx (server-side, in-memory).
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

export async function extractText(name, mime, buffer) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'pdf') {
      const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
      const out = await pdfParse(buffer);
      return clean(out.text);
    }
    if (ext === 'docx') {
      const { default: mammoth } = await import('mammoth');
      const out = await mammoth.extractRawText({ buffer });
      return clean(out.value);
    }
    if (ext === 'pptx') {
      const zip = await JSZip.loadAsync(buffer);
      const slideFiles = Object.keys(zip.files)
        .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
      const parts = [];
      for (const [i, f] of slideFiles.entries()) {
        const xml = await zip.files[f].async('string');
        const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
        parts.push(`## Slide ${i + 1}\n${texts.join(' ')}`);
      }
      return clean(parts.join('\n\n'));
    }
    if (ext === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      const parts = [];
      wb.eachSheet(ws => {
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          rows.push(row.values.slice(1).map(v => (v && v.result !== undefined ? v.result : v)).join(' | '));
        });
        parts.push(`## Sheet: ${ws.name}\n${rows.slice(0, 200).join('\n')}`);
      });
      return clean(parts.join('\n\n'));
    }
    if (ext === 'txt' || ext === 'md' || ext === 'csv') return clean(buffer.toString('utf8'));
  } catch (e) {
    console.error(`⚠️ [extract] ${name}: ${e.message}`);
    return `[Extraction failed for ${name}: ${e.message}]`;
  }
  return `[Unsupported file type: ${ext}]`;
}

const clean = (s) => (s || '').replace(/\u0000/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 60000);
