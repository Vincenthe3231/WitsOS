/**
 * Phase 3: Office extractor tests — DocxExtractor, XlsxExtractor, PptxExtractor.
 *
 * Strategy: build minimal valid OOXML ZIP buffers in-memory using adm-zip,
 * write to a temp file, let the extractor re-read it (as it would in production),
 * then assert on nodes/edges/chunks. Cleans up in afterEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';

import { DocxExtractor } from '../src/extraction/languages/docx-extractor';
import { XlsxExtractor } from '../src/extraction/languages/xlsx-extractor';
import { PptxExtractor } from '../src/extraction/languages/pptx-extractor';
import { PdfExtractor } from '../src/extraction/languages/pdf-extractor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmp(name: string, buffer: Buffer): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsos-office-test-'));
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

const tmpFiles: string[] = [];
function track(p: string): string { tmpFiles.push(p); return p; }

afterEach(() => {
  for (const p of tmpFiles) {
    try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

// ---------------------------------------------------------------------------
// DOCX builder helpers
// ---------------------------------------------------------------------------

function buildDocxXml(paragraphs: Array<{ style?: string; text: string }>): string {
  const paras = paragraphs.map(({ style, text }) => {
    const pPr = style
      ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
      : '';
    return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paras}</w:body>
</w:document>`;
}

function buildDocx(paragraphs: Array<{ style?: string; text: string }>): Buffer {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(buildDocxXml(paragraphs), 'utf-8'));
  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// XLSX builder helpers
// ---------------------------------------------------------------------------

function buildXlsx(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  const zip = new AdmZip();

  // xl/workbook.xml
  const sheetEls = sheets.map((s, i) =>
    `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('');
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEls}</sheets>
</workbook>`, 'utf-8'));

  // xl/_rels/workbook.xml.rels
  const rels = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels}
</Relationships>`, 'utf-8'));

  // xl/sharedStrings.xml — all string values
  const allStrings: string[] = [];
  const stringIndex = new Map<string, number>();
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (!stringIndex.has(cell)) {
          stringIndex.set(cell, allStrings.length);
          allStrings.push(cell);
        }
      }
    }
  }
  const siEls = allStrings.map((s) => `<si><t>${s}</t></si>`).join('');
  zip.addFile('xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${allStrings.length}" uniqueCount="${allStrings.length}">
  ${siEls}
</sst>`, 'utf-8'));

  // xl/worksheets/sheetN.xml — cells reference shared strings
  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si]!;
    const cols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const rowEls = sheet.rows.map((row, ri) => {
      const cellEls = row.map((val, ci) => {
        const idx = stringIndex.get(val) ?? 0;
        return `<c r="${cols[ci]}${ri + 1}" t="s"><v>${idx}</v></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cellEls}</row>`;
    }).join('');
    zip.addFile(`xl/worksheets/sheet${si + 1}.xml`, Buffer.from(`<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowEls}</sheetData>
</worksheet>`, 'utf-8'));
  }

  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// PPTX builder helpers
// ---------------------------------------------------------------------------

function buildSlideXml(title: string, bodyText: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${bodyText}</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

function buildPptx(slides: Array<{ title: string; body: string }>): Buffer {
  const zip = new AdmZip();
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]!;
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(buildSlideXml(slide.title, slide.body), 'utf-8'));
  }
  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// DocxExtractor tests
// ---------------------------------------------------------------------------

describe('DocxExtractor', () => {
  it('emits document node for simple DOCX', () => {
    const fp = track(writeTmp('test.docx', buildDocx([{ text: 'Hello world' }])));
    const r = new DocxExtractor(fp, '').extract();
    expect(r.nodes.find((n) => n.kind === 'document')).toBeDefined();
    expect(r.nodes[0]?.language).toBe('docx');
  });

  it('produces chunks for body text', () => {
    const fp = track(writeTmp('test.docx', buildDocx([{ text: 'This is some content.' }])));
    const r = new DocxExtractor(fp, '').extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    expect(r.chunks![0].body).toContain('content');
  });

  it('emits section nodes for heading paragraphs', () => {
    const fp = track(writeTmp('test.docx', buildDocx([
      { style: 'Heading1', text: 'Introduction' },
      { text: 'Intro body paragraph.' },
      { style: 'Heading1', text: 'Methods' },
      { text: 'Methods body paragraph.' },
    ])));
    const r = new DocxExtractor(fp, '').extract();
    const sections = r.nodes.filter((n) => n.kind === 'section');
    expect(sections.length).toBe(2);
    expect(sections.map((s) => s.name)).toContain('Introduction');
    expect(sections.map((s) => s.name)).toContain('Methods');
  });

  it('emits contains edges from document to sections', () => {
    const fp = track(writeTmp('test.docx', buildDocx([
      { style: 'Heading1', text: 'Section A' },
      { text: 'Body.' },
    ])));
    const r = new DocxExtractor(fp, '').extract();
    const doc = r.nodes.find((n) => n.kind === 'document')!;
    const containsEdges = r.edges.filter((e) => e.source === doc.id && e.kind === 'contains');
    expect(containsEdges.length).toBe(1);
  });

  it('returns error result for non-ZIP file', () => {
    const fp = track(writeTmp('bad.docx', Buffer.from('not a zip', 'utf-8')));
    const r = new DocxExtractor(fp, '').extract();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.severity).toBe('error');
  });

  it('no section nodes when no headings', () => {
    const fp = track(writeTmp('test.docx', buildDocx([
      { text: 'Just prose.' },
      { text: 'More prose.' },
    ])));
    const r = new DocxExtractor(fp, '').extract();
    expect(r.nodes.filter((n) => n.kind === 'section')).toHaveLength(0);
    expect(r.chunks!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// XlsxExtractor tests
// ---------------------------------------------------------------------------

describe('XlsxExtractor', () => {
  it('emits document node', () => {
    const fp = track(writeTmp('test.xlsx', buildXlsx([{ name: 'Sheet1', rows: [['a', 'b'], ['1', '2']] }])));
    const r = new XlsxExtractor(fp, '').extract();
    const doc = r.nodes.find((n) => n.kind === 'document');
    expect(doc).toBeDefined();
    expect(doc!.language).toBe('xlsx');
    expect(doc!.docstring).toContain('Sheet1');
  });

  it('emits one section node per sheet', () => {
    const fp = track(writeTmp('test.xlsx', buildXlsx([
      { name: 'Data', rows: [['x', 'y'], ['1', '2']] },
      { name: 'Summary', rows: [['total'], ['100']] },
    ])));
    const r = new XlsxExtractor(fp, '').extract();
    const sections = r.nodes.filter((n) => n.kind === 'section');
    expect(sections.length).toBe(2);
    expect(sections.map((s) => s.name)).toContain('Data');
    expect(sections.map((s) => s.name)).toContain('Summary');
  });

  it('emits contains edges', () => {
    const fp = track(writeTmp('test.xlsx', buildXlsx([{ name: 'Sheet1', rows: [['v']] }])));
    const r = new XlsxExtractor(fp, '').extract();
    const doc = r.nodes.find((n) => n.kind === 'document')!;
    const containsEdges = r.edges.filter((e) => e.source === doc.id && e.kind === 'contains');
    expect(containsEdges.length).toBe(1);
  });

  it('produces chunks with row data', () => {
    const rows = [['name', 'age'], ['Alice', '30'], ['Bob', '25']];
    const fp = track(writeTmp('test.xlsx', buildXlsx([{ name: 'People', rows }])));
    const r = new XlsxExtractor(fp, '').extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    const body = r.chunks!.map((c) => c.body).join('\n');
    expect(body).toContain('Alice');
  });

  it('chunk metadata includes sheet name', () => {
    const fp = track(writeTmp('test.xlsx', buildXlsx([{ name: 'Financials', rows: [['revenue'], ['1000']] }])));
    const r = new XlsxExtractor(fp, '').extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    const meta = r.chunks![0].metadata as Record<string, unknown>;
    expect(meta.sheet).toBe('Financials');
  });

  it('returns error for non-ZIP file', () => {
    const fp = track(writeTmp('bad.xlsx', Buffer.from('not a zip', 'utf-8')));
    const r = new XlsxExtractor(fp, '').extract();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PptxExtractor tests
// ---------------------------------------------------------------------------

describe('PptxExtractor', () => {
  it('emits document node', () => {
    const fp = track(writeTmp('test.pptx', buildPptx([{ title: 'Welcome', body: 'Intro text' }])));
    const r = new PptxExtractor(fp, '').extract();
    const doc = r.nodes.find((n) => n.kind === 'document');
    expect(doc).toBeDefined();
    expect(doc!.language).toBe('pptx');
    expect(doc!.docstring).toContain('slide');
  });

  it('emits one section node per slide', () => {
    const fp = track(writeTmp('test.pptx', buildPptx([
      { title: 'Overview', body: 'Some overview.' },
      { title: 'Details', body: 'Some details.' },
    ])));
    const r = new PptxExtractor(fp, '').extract();
    const sections = r.nodes.filter((n) => n.kind === 'section');
    expect(sections.length).toBe(2);
    expect(sections.map((s) => s.name)).toContain('Overview');
    expect(sections.map((s) => s.name)).toContain('Details');
  });

  it('emits contains edges from document to sections', () => {
    const fp = track(writeTmp('test.pptx', buildPptx([{ title: 'S1', body: 'body' }])));
    const r = new PptxExtractor(fp, '').extract();
    const doc = r.nodes.find((n) => n.kind === 'document')!;
    const containsEdges = r.edges.filter((e) => e.source === doc.id && e.kind === 'contains');
    expect(containsEdges.length).toBe(1);
  });

  it('produces chunks with slide body text', () => {
    const fp = track(writeTmp('test.pptx', buildPptx([
      { title: 'My Slide', body: 'The body content is here.' },
    ])));
    const r = new PptxExtractor(fp, '').extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    const body = r.chunks!.map((c) => c.body).join(' ');
    expect(body).toContain('content');
  });

  it('chunk metadata includes slide number', () => {
    const fp = track(writeTmp('test.pptx', buildPptx([{ title: 'T', body: 'Body text here.' }])));
    const r = new PptxExtractor(fp, '').extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    const meta = r.chunks![0].metadata as Record<string, unknown>;
    expect(meta.slide).toBe(1);
  });

  it('returns error for non-ZIP file', () => {
    const fp = track(writeTmp('bad.pptx', Buffer.from('not a zip', 'utf-8')));
    const r = new PptxExtractor(fp, '').extract();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('empty PPTX (no slides) produces only document node', () => {
    const fp = track(writeTmp('empty.pptx', buildPptx([])));
    const r = new PptxExtractor(fp, '').extract();
    expect(r.nodes.filter((n) => n.kind === 'document')).toHaveLength(1);
    expect(r.nodes.filter((n) => n.kind === 'section')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PdfExtractor — Phase 4
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PDF containing the given text on one page.
 * Uses only PDF 1.4 primitives — no third-party library required.
 */
function buildPdf(text: string): Buffer {
  // Encode text for PDF stream (escape parentheses/backslash)
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const streamLen = Buffer.byteLength(stream, 'utf-8');

  const obj1 = '1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n';
  const obj2 = '2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n';
  const obj3 = `3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>>>>>>>\nendobj\n`;
  const obj4 = `4 0 obj\n<</Length ${streamLen}>>\nstream\n${stream}\nendstream\nendobj\n`;

  const header = '%PDF-1.4\n';
  let pdf = header;
  const offsets: number[] = [];
  offsets.push(Buffer.byteLength(pdf, 'utf-8'));
  pdf += obj1;
  offsets.push(Buffer.byteLength(pdf, 'utf-8'));
  pdf += obj2;
  offsets.push(Buffer.byteLength(pdf, 'utf-8'));
  pdf += obj3;
  offsets.push(Buffer.byteLength(pdf, 'utf-8'));
  pdf += obj4;

  const xrefOffset = Buffer.byteLength(pdf, 'utf-8');
  pdf += 'xref\n';
  pdf += `0 5\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<</Size 5 /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf-8');
}

describe('PdfExtractor', () => {
  it('produces a document node for a text PDF', async () => {
    const fp = track(writeTmp('sample.pdf', buildPdf('Hello world')));
    const r = await new PdfExtractor(fp, '').extract();
    expect(r.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    const docs = r.nodes.filter((n) => n.kind === 'document');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.language).toBe('pdf');
    expect(docs[0]!.name).toBe('sample.pdf');
  });

  it('produces chunks for a text PDF body', async () => {
    const body = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const fp = track(writeTmp('body.pdf', buildPdf(body)));
    const r = await new PdfExtractor(fp, '').extract();
    expect(r.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(r.chunks?.length).toBeGreaterThan(0);
  });

  it('rejects a non-PDF file with error severity', async () => {
    const fp = track(writeTmp('fake.pdf', Buffer.from('not a pdf at all', 'utf-8')));
    const r = await new PdfExtractor(fp, '').extract();
    expect(r.errors.some((e) => e.severity === 'error')).toBe(true);
    expect(r.nodes).toHaveLength(0);
  });

  it('handles empty / image-only PDF gracefully (no chunks)', async () => {
    // Build a valid PDF with no text content (empty page stream)
    const fp = track(writeTmp('empty.pdf', buildPdf('')));
    const r = await new PdfExtractor(fp, '').extract();
    // Should not error — just no chunks
    expect(r.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(r.nodes.filter((n) => n.kind === 'document')).toHaveLength(1);
  });
});
