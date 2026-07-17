// exports.js — PPTX / XLSX / DOCX / PDF assembly with ODA branding + watermark on covers.
// PPTX via pptxgenjs, XLSX via exceljs, DOCX via docx, PDF via pdfkit.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun, Footer, AlignmentType } from 'docx';
import PDFDocument from 'pdfkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');
const WATERMARK = path.join(PUB, 'oda-watermark-faded.png'); // pre-faded 10% alpha
const LOGO = path.join(PUB, 'oda-logo.png');

const ODA = { ink: '1D252C', gold: 'AD833B', cream: 'F1E7D6', mist: 'CBDCE6', steel: '678CA5' };

// ---------- content model ----------
// We parse the assistant's draft (markdown or oda-slide HTML) into
// {title, sections:[{heading, bullets[], paragraphs[]}], citations[], gaps[]}
export function parseDraft(text, fallbackTitle = 'ODA Deliverable') {
  const citations = [...new Set([...text.matchAll(/(?:source|Source):\s*([^\n|\]]+)/g)].map(m => m[1].trim()).filter(s => s.length > 3))];
  const gapsMatch = text.match(/(?:^|\n)#{0,3}\s*Gaps?:?\s*([\s\S]{0,500}?)(?=\n#|\n```|$)/i);
  const gaps = gapsMatch ? gapsMatch[1].split('\n').map(s => s.replace(/^[-*\s]+/, '').trim()).filter(s => s && s.toLowerCase() !== 'none') : [];

  let title = fallbackTitle;
  const sections = [];

  if (/<section[^>]*class="[^"]*oda-slide/i.test(text)) {
    // HTML slide draft
    const secs = [...text.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/gi)];
    for (const s of secs) {
      const inner = s[1];
      const h = inner.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      const heading = h ? strip(h[1]) : '';
      const bullets = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => strip(m[1])).filter(Boolean);
      const paras = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => strip(m[1])).filter(Boolean);
      if (heading || bullets.length || paras.length) sections.push({ heading: heading || 'Slide', bullets, paragraphs: paras });
    }
    if (sections.length && sections[0].heading) title = sections[0].heading;
  } else {
    // Markdown draft
    const lines = text.split('\n');
    let cur = null;
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      const h1 = line.match(/^#\s+(.+)/); const h23 = line.match(/^#{2,3}\s+(.+)/);
      if (h1) { title = strip(h1[1]); continue; }
      if (h23) { cur = { heading: strip(h23[1]), bullets: [], paragraphs: [] }; sections.push(cur); continue; }
      if (/^```/.test(line)) { cur = cur; continue; }
      const b = line.match(/^\s*[-*•]\s+(.+)/);
      if (b) { if (!cur) { cur = { heading: 'Overview', bullets: [], paragraphs: [] }; sections.push(cur); } cur.bullets.push(strip(b[1])); continue; }
      if (line.trim() && !/^\|/.test(line) && !/^Mode:/.test(line)) {
        if (!cur) { cur = { heading: 'Overview', bullets: [], paragraphs: [] }; sections.push(cur); }
        cur.paragraphs.push(strip(line.trim()));
      }
    }
  }
  if (!sections.length) sections.push({ heading: 'Content', bullets: [], paragraphs: [strip(text).slice(0, 2000)] });
  return { title: title.slice(0, 120), sections: sections.slice(0, 24), citations, gaps };
}
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\*\*?|__|\[(fact|assumption|from-web)\]/gi, m => /\[(fact|assumption|from-web)\]/i.test(m) ? m : '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

const COVER_DATE = 'July 2026'; // blueprint rule: current month + year, both words

// ---------- PPTX ----------
export async function buildPptx(model) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'ODA169', width: 13.33, height: 7.5 });
  pptx.layout = 'ODA169';

  // Cover — white, watermark low-opacity centre-right, Montserrat gold title (the one exception), ink subtitle
  const cover = pptx.addSlide();
  cover.background = { color: 'FFFFFF' };
  try { cover.addImage({ path: WATERMARK, x: 8.4, y: 1.5, w: 4.5, h: 4.5 }); } catch {}
  try { cover.addImage({ path: LOGO, x: 0.7, y: 0.55, w: 2.6, h: 0.8 }); } catch {}
  cover.addText(model.title, { x: 0.7, y: 2.7, w: 8.2, h: 1.8, fontFace: 'Montserrat', bold: true, fontSize: 34, color: ODA.gold, align: 'left' });
  cover.addText('Office of Development Affairs — Abu Dhabi', { x: 0.7, y: 4.4, w: 8, h: 0.5, fontFace: 'Lora', fontSize: 16, color: ODA.ink });
  cover.addText(COVER_DATE, { x: 0.7, y: 4.95, w: 6, h: 0.4, fontFace: 'Montserrat', fontSize: 12, color: ODA.ink });

  for (const [i, sec] of model.sections.entries()) {
    const s = pptx.addSlide();
    s.background = { color: 'FFFFFF' };
    // action title band
    s.addText(sec.heading, { x: 0.55, y: 0.5, w: 12.2, h: 0.9, fontFace: 'Lora', bold: true, fontSize: 22, color: ODA.ink });
    s.addShape('rect', { x: 0.55, y: 1.45, w: 1.6, h: 0.045, fill: { color: ODA.gold } });
    const bodyItems = [];
    for (const p of sec.paragraphs.slice(0, 4)) bodyItems.push({ text: p, options: { bullet: false, fontSize: 14, color: ODA.ink, breakLine: true, paraSpaceAfter: 8 } });
    for (const b of sec.bullets.slice(0, 9)) bodyItems.push({ text: b, options: { bullet: { code: '2022' }, fontSize: 14, color: ODA.ink, breakLine: true, paraSpaceAfter: 6 } });
    if (bodyItems.length) s.addText(bodyItems, { x: 0.55, y: 1.75, w: 12.2, h: 4.9, fontFace: 'Montserrat', valign: 'top' });
    s.addText(`${i + 2}`, { x: 12.55, y: 7.02, w: 0.6, h: 0.35, fontFace: 'Montserrat', fontSize: 10, color: ODA.steel, align: 'right' });
  }

  // Sources & gaps slide
  const last = pptx.addSlide();
  last.background = { color: 'FFFFFF' };
  last.addText('Sources and gaps', { x: 0.55, y: 0.5, w: 12, h: 0.9, fontFace: 'Lora', bold: true, fontSize: 22, color: ODA.ink });
  const rows = [];
  for (const c of (model.citations.length ? model.citations : ['User-supplied content (no external figures)'])) rows.push({ text: c, options: { bullet: { code: '2022' }, fontSize: 12, color: ODA.ink, breakLine: true } });
  if (model.gaps.length) {
    rows.push({ text: 'Gaps / unverifiable items:', options: { bold: true, fontSize: 12, color: ODA.gold, breakLine: true, paraSpaceBefore: 10 } });
    for (const g of model.gaps) rows.push({ text: g, options: { bullet: { code: '2022' }, fontSize: 12, color: ODA.ink, breakLine: true } });
  }
  last.addText(rows, { x: 0.55, y: 1.7, w: 12.2, h: 5, fontFace: 'Montserrat', valign: 'top' });

  return Buffer.from(await pptx.write('arraybuffer'));
}

// ---------- XLSX ----------
export async function buildXlsx(model, dataRows = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ODA Productivity Suite';
  const cover = wb.addWorksheet('Cover');
  cover.getCell('B2').value = model.title;
  cover.getCell('B2').font = { name: 'Montserrat', size: 20, bold: true, color: { argb: 'FF' + ODA.gold } };
  cover.getCell('B3').value = 'Office of Development Affairs — Abu Dhabi';
  cover.getCell('B4').value = COVER_DATE;
  try {
    const imgId = wb.addImage({ filename: WATERMARK, extension: 'png' });
    cover.addImage(imgId, { tl: { col: 5, row: 1 }, ext: { width: 220, height: 220 } });
  } catch {}

  const dataWs = wb.addWorksheet('Data');
  if (dataRows.length) {
    dataWs.columns = [
      { header: 'Indicator', key: 'indicator', width: 46 }, { header: 'Value', key: 'value', width: 18 },
      { header: 'Year', key: 'year', width: 10 }, { header: 'Unit', key: 'unit', width: 20 },
      { header: 'Source (citation)', key: 'cite', width: 52 },
    ];
    dataRows.forEach(r => dataWs.addRow(r));
  } else {
    dataWs.columns = [{ header: 'Section', key: 's', width: 40 }, { header: 'Content', key: 'c', width: 100 }];
    model.sections.forEach(sec => { [...sec.paragraphs, ...sec.bullets].forEach(t => dataWs.addRow({ s: sec.heading, c: t })); });
  }
  dataWs.getRow(1).font = { bold: true, name: 'Montserrat', color: { argb: 'FFFFFFFF' } };
  dataWs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ODA.ink } };

  const srcWs = wb.addWorksheet('Sources & QA');
  srcWs.columns = [{ header: 'Type', key: 't', width: 16 }, { header: 'Entry', key: 'e', width: 110 }];
  (model.citations.length ? model.citations : ['User-supplied content']).forEach(c => srcWs.addRow({ t: 'Citation', e: c }));
  model.gaps.forEach(g => srcWs.addRow({ t: 'GAP', e: g }));
  srcWs.addRow({ t: 'QA', e: `Generated ${new Date().toISOString()} · model gpt-5.6-sol-medium · no-invent rule enforced upstream` });
  srcWs.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- DOCX ----------
export async function buildDocx(model) {
  const children = [];
  try {
    const img = fs.readFileSync(WATERMARK);
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: img, transformation: { width: 260, height: 260 } })] }));
  } catch {}
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: model.title, bold: true, size: 56, color: ODA.gold, font: 'Montserrat' })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Office of Development Affairs — Abu Dhabi', size: 26, font: 'Lora' })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: COVER_DATE, size: 22, font: 'Montserrat', color: ODA.steel })] }));
  children.push(new Paragraph({ pageBreakBefore: true, text: '' }));

  for (const sec of model.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: sec.heading, bold: true, color: ODA.ink, font: 'Lora' })] }));
    for (const p of sec.paragraphs) children.push(new Paragraph({ children: [new TextRun({ text: p, size: 22, font: 'Montserrat' })] }));
    for (const b of sec.bullets) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: b, size: 22, font: 'Montserrat' })] }));
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Sources and gaps', bold: true, font: 'Lora' })] }));
  for (const c of (model.citations.length ? model.citations : ['User-supplied content (no external figures)'])) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: c, size: 20 })] }));
  for (const g of model.gaps) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `GAP: ${g}`, size: 20, color: ODA.gold })] }));

  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ---------- PDF ----------
export async function buildPdf(model) {
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Cover with watermark
    try { doc.image(WATERMARK, doc.page.width - 300, 120, { width: 240 }); } catch {}
    try { doc.image(LOGO, 56, 56, { width: 150 }); } catch {}
    doc.moveDown(8);
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#' + ODA.gold).text(model.title, 56, 260, { width: doc.page.width - 112 });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(13).fillColor('#' + ODA.ink).text('Office of Development Affairs — Abu Dhabi');
    doc.fontSize(11).fillColor('#' + ODA.steel).text(COVER_DATE);

    for (const sec of model.sections) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#' + ODA.ink).text(sec.heading);
      doc.moveTo(56, doc.y + 4).lineTo(200, doc.y + 4).lineWidth(2).strokeColor('#' + ODA.gold).stroke();
      doc.moveDown(0.8);
      doc.font('Helvetica').fontSize(11).fillColor('#' + ODA.ink);
      for (const p of sec.paragraphs) { doc.text(p, { width: doc.page.width - 112 }); doc.moveDown(0.4); }
      for (const b of sec.bullets) { doc.text(`•  ${b}`, { width: doc.page.width - 122, indent: 8 }); doc.moveDown(0.2); }
    }

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#' + ODA.ink).text('Sources and gaps');
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(10).fillColor('#' + ODA.ink);
    for (const c of (model.citations.length ? model.citations : ['User-supplied content (no external figures)'])) { doc.text(`•  ${c}`); doc.moveDown(0.2); }
    if (model.gaps.length) {
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fillColor('#' + ODA.gold).text('Gaps / unverifiable items');
      doc.font('Helvetica').fillColor('#' + ODA.ink);
      for (const g of model.gaps) { doc.text(`•  ${g}`); doc.moveDown(0.2); }
    }
    doc.end();
  });
}

const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf:  'application/pdf',
};

export async function buildExport(format, draftText, { dataRows = [], titleHint } = {}) {
  const model = parseDraft(draftText, titleHint);
  let buffer;
  if (format === 'pptx') buffer = await buildPptx(model);
  else if (format === 'xlsx') buffer = await buildXlsx(model, dataRows);
  else if (format === 'docx') buffer = await buildDocx(model);
  else if (format === 'pdf') buffer = await buildPdf(model);
  else throw new Error(`Unsupported export format: ${format}`);
  const slug = model.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'oda-deliverable';
  return {
    id: crypto.randomUUID(),
    name: `${slug}.${format}`,
    mime: MIME[format],
    buffer,
    createdAt: new Date().toISOString(),
    citations: model.citations,
    gaps: model.gaps,
  };
}
