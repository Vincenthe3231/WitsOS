/**
 * CSV / TSV extractor (.csv, .tsv)
 *
 * Produces:
 *   - 1 `document` node (whole file; docstring = header row)
 *   - Prose chunks: rows grouped into blocks of ~50 rows each
 *
 * No native deps. Simple line-split parser (handles quoted fields for header).
 * .tsv uses tab delimiter, .csv uses comma.
 */
import * as path from 'path';
import * as crypto from 'crypto';
import { ExtractionResult, Node, ChunkRecord } from '../../types';
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

function detectDelimiter(filePath: string, firstLine: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsv') return '\t';
  // Heuristic: if header has more tabs than commas, treat as TSV.
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

function parseHeaderRow(line: string, delimiter: string): string[] {
  // Simple quoted-field parser for the header row only.
  const fields: string[] = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { field += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === delimiter && !inQuote) {
      fields.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field.trim());
  return fields;
}

export class CsvExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    private readonly source: string
  ) {}

  extract(): ExtractionResult {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const allLines = this.source.split('\n');
    const totalLines = allLines.length;

    const firstLine = allLines[0] ?? '';
    const delimiter = detectDelimiter(this.filePath, firstLine);
    const headers = parseHeaderRow(firstLine, delimiter);
    const headerStr = headers.join(', ');

    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'csv',
      startLine: 1,
      endLine: totalLines,
      startColumn: 0,
      endColumn: 0,
      docstring: `Columns: ${headerStr}`,
      isExported: false,
      updatedAt: Date.now(),
    };

    // Chunk data rows (skip header) into blocks.
    const dataLines = allLines.slice(1).filter((l) => l.trim() !== '');
    const chunks: ChunkRecord[] = [];
    const now = Date.now();

    for (let i = 0; i < dataLines.length; i += ROWS_PER_CHUNK) {
      const rowBlock = dataLines.slice(i, i + ROWS_PER_CHUNK);
      // Prepend headers so FTS queries can match column names.
      const body = `${headerStr}\n${rowBlock.join('\n')}`;
      const chunkIndex = Math.floor(i / ROWS_PER_CHUNK);

      // Compute approximate char offsets (relative to data section).
      const charStart = dataLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
      const charEnd = charStart + rowBlock.join('\n').length;

      chunks.push({
        id: chunkId(this.filePath, chunkIndex),
        filePath: this.filePath,
        nodeId: docNode.id,
        chunkIndex,
        charStart,
        charEnd,
        body,
        metadata: { columns: headers, rowStart: i + 2, rowEnd: i + 1 + rowBlock.length },
        updatedAt: now,
      });
    }

    return {
      nodes: [docNode],
      edges: [],
      unresolvedReferences: [],
      errors: [],
      durationMs: Date.now() - start,
      chunks,
    };
  }
}
