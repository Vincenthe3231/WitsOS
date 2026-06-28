/**
 * XLSX extractor (.xlsx, .xltx)
 *
 * Produces:
 *   - 1 `document` node (whole file; docstring = sheet names)
 *   - N `section` nodes (one per worksheet)
 *   - `document --contains--> section` edges
 *   - Prose chunks: rows grouped into blocks of ~50 per sheet
 *
 * No native build required. Uses adm-zip (pure JS) to unpack OOXML ZIP and
 * regex-based XML cell extraction.
 *
 * Binary file: re-reads from disk as Buffer (indexAll reads UTF-8 which corrupts binary).
 */
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { ExtractionResult, Node, Edge, ChunkRecord } from '../../types';
import { StandaloneExtractor } from '../extractor-registry';
import { chunkId } from '../chunker';

const ROWS_PER_CHUNK = 50;

function makeNodeId(filePath: string, kind: string, name: string, line: number): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/** Parse xl/sharedStrings.xml → ordered string array. */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  // Each <si> element holds one string. Text is in <t> elements (may be multiple runs).
  const siPattern = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siPattern.exec(xml)) !== null) {
    const siXml = m[1] ?? '';
    const textParts: string[] = [];
    const tPattern = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tPattern.exec(siXml)) !== null) {
      textParts.push(t[1] ?? '');
    }
    strings.push(textParts.join(''));
  }
  return strings;
}

/** Parse xl/workbook.xml → ordered list of { name, rId } */
function parseSheetList(xml: string): Array<{ name: string; rId: string }> {
  const sheets: Array<{ name: string; rId: string }> = [];
  const pattern = /<sheet\s[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(xml)) !== null) {
    sheets.push({ name: m[1] ?? 'Sheet', rId: m[2] ?? '' });
  }
  return sheets;
}

/** Parse xl/_rels/workbook.xml.rels → rId → target path */
function parseWorkbookRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /<Relationship\s[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(xml)) !== null) {
    map.set(m[1] ?? '', m[2] ?? '');
  }
  return map;
}

interface CellValue {
  col: string;
  value: string;
}

/** Extract rows from a worksheet XML using the shared string table. */
function extractRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowPattern = /<row\s[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const rowXml = rowMatch[2] ?? '';
    const cells: CellValue[] = [];
    const cellPattern = /<c\s[^>]*r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellPattern.exec(rowXml)) !== null) {
      const col = cellMatch[1] ?? '';
      const attrs = cellMatch[2] ?? '';
      const cellContent = cellMatch[3] ?? '';
      const isSharedString = /t="s"/.test(attrs);

      const vMatch = /<v>([^<]*)<\/v>/.exec(cellContent);
      if (!vMatch) continue;
      const raw = vMatch[1] ?? '';

      const value = isSharedString
        ? (sharedStrings[parseInt(raw, 10)] ?? raw)
        : raw;

      if (value.trim()) {
        cells.push({ col, value });
      }
    }

    if (cells.length > 0) {
      rows.push(cells.map((c) => c.value));
    }
  }

  return rows;
}

export class XlsxExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    _source: string
  ) {}

  extract(): ExtractionResult {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const now = Date.now();

    let zip: AdmZip;
    try {
      const buffer = fs.readFileSync(this.filePath);
      if (buffer.length < 4) throw new Error('file is empty or too small to be a valid XLSX');
      zip = new AdmZip(buffer);
    } catch (err) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Failed to read XLSX: ${err instanceof Error ? err.message : String(err)}`, filePath: this.filePath, severity: 'error' }],
        durationMs: Date.now() - start,
      };
    }

    // Load shared strings (may not exist if workbook has no string cells)
    let sharedStrings: string[] = [];
    const ssEntry = zip.getEntry('xl/sharedStrings.xml');
    if (ssEntry) {
      sharedStrings = parseSharedStrings(ssEntry.getData().toString('utf-8'));
    }

    // Load sheet list from workbook.xml
    let sheets: Array<{ name: string; rId: string }> = [];
    const wbEntry = zip.getEntry('xl/workbook.xml');
    if (wbEntry) {
      sheets = parseSheetList(wbEntry.getData().toString('utf-8'));
    }

    // Map rId → worksheet path
    let rIdToPath = new Map<string, string>();
    const relsEntry = zip.getEntry('xl/_rels/workbook.xml.rels');
    if (relsEntry) {
      rIdToPath = parseWorkbookRels(relsEntry.getData().toString('utf-8'));
    }

    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'xlsx',
      startLine: 1,
      endLine: sheets.length,
      startColumn: 0,
      endColumn: 0,
      docstring: sheets.length > 0 ? `Sheets: ${sheets.map((s) => s.name).join(', ')}` : undefined,
      isExported: false,
      updatedAt: now,
    };

    const nodes: Node[] = [docNode];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    let chunkOffset = 0;

    for (let si = 0; si < sheets.length; si++) {
      const sheet = sheets[si]!;
      const relPath = rIdToPath.get(sheet.rId);
      const wsPath = relPath ? `xl/${relPath.replace(/^\.\.\//, '')}` : `xl/worksheets/sheet${si + 1}.xml`;
      const wsEntry = zip.getEntry(wsPath);
      const rows = wsEntry ? extractRows(wsEntry.getData().toString('utf-8'), sharedStrings) : [];

      const sectionNode: Node = {
        id: makeNodeId(this.filePath, 'section', sheet.name, si + 1),
        kind: 'section',
        name: sheet.name,
        qualifiedName: `${this.filePath}#${sheet.name}`,
        filePath: this.filePath,
        language: 'xlsx',
        startLine: si + 1,
        endLine: si + 1 + rows.length,
        startColumn: 0,
        endColumn: 0,
        docstring: rows.length > 0 ? `${rows.length} rows` : 'empty sheet',
        isExported: false,
        updatedAt: now,
      };

      nodes.push(sectionNode);
      edges.push({ source: docNode.id, target: sectionNode.id, kind: 'contains' });

      // Chunk rows into blocks
      for (let r = 0; r < rows.length; r += ROWS_PER_CHUNK) {
        const rowBlock = rows.slice(r, r + ROWS_PER_CHUNK);
        const body = rowBlock.map((row) => row.join('\t')).join('\n');
        const chunkIndex = Math.floor(r / ROWS_PER_CHUNK);
        const charStart = rows.slice(0, r).map((row) => row.join('\t')).join('\n').length + (r > 0 ? 1 : 0);
        const charEnd = charStart + body.length;

        chunks.push({
          id: chunkId(this.filePath, chunkOffset++),
          filePath: this.filePath,
          nodeId: sectionNode.id,
          chunkIndex,
          charStart,
          charEnd,
          body,
          metadata: { sheet: sheet.name, rowStart: r + 1, rowEnd: r + rowBlock.length },
          updatedAt: now,
        });
      }
    }

    return {
      nodes,
      edges,
      unresolvedReferences: [],
      errors: [],
      durationMs: Date.now() - start,
      chunks,
    };
  }
}
