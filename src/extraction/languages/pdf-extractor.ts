/**
 * PDF extractor (.pdf) — Phase 4
 *
 * Extracts the text layer from PDF files using pdf-parse (pure JS, no native
 * build). Produces:
 *   - 1 `document` node (whole file)
 *   - N `section` nodes per detected heading (heuristic: short ALL-CAPS or
 *     Title-Case lines common in PDF-extracted text)
 *   - `document --contains--> section` edges
 *   - Prose chunks per section (or full body if no headings)
 *
 * Scanned / image-only PDFs return empty text — document node only, no chunks.
 * Phase 5 (OCR via PaddleOCR) will handle those.
 *
 * Binary file: re-read from disk as Buffer; the orchestrator reads files as
 * UTF-8 which corrupts binary content (same pattern as DocxExtractor).
 */
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ExtractionResult, Node, Edge, ChunkRecord } from '../../types';
import { StandaloneExtractor } from '../extractor-registry';
import { chunkText, chunkId } from '../chunker';

function makeNodeId(filePath: string, kind: string, name: string, line: number): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/**
 * Heuristic: a line looks like a section heading when it is:
 * - Non-empty, ≤ 120 chars
 * - ALL-CAPS (≥ 2 letters), or Title Case (≥ 80% significant words capitalised)
 * - Not purely numeric (page numbers)
 * - ≤ 12 words
 */
function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  if (/^\d+\.?\s*$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length === 0 || words.length > 12) return false;
  if (t === t.toUpperCase() && /[A-Z]{2}/.test(t)) return true;
  const significant = words.filter(
    (w) => !/^(a|an|the|and|or|but|in|on|at|to|of|for|with|by|from)$/i.test(w),
  );
  if (significant.length === 0) return false;
  return significant.filter((w) => /^[A-Z]/.test(w)).length / significant.length >= 0.8;
}

interface PdfSection {
  title: string;
  lines: string[];
  lineIndex: number; // 1-based line in extracted text
}

function parseSections(text: string): PdfSection[] {
  const lines = text.split('\n');
  const sections: PdfSection[] = [];
  let current: PdfSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (looksLikeHeading(line)) {
      current = { title: line.trim(), lines: [], lineIndex: i + 1 };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

export class PdfExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    // source is ignored — binary file re-read below
    _source: string,
  ) {}

  /** extract() returns a Promise; the orchestrator/parse-worker awaits it. */
  extract(): Promise<ExtractionResult> {
    return this._extract();
  }

  private async _extract(): Promise<ExtractionResult> {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const now = Date.now();

    // Re-read as Buffer (orchestrator passes UTF-8 which corrupts binary)
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.filePath);
      if (buffer.length < 4) throw new Error('file too small to be a valid PDF');
      if (!buffer.slice(0, 5).toString('ascii').startsWith('%PDF')) {
        throw new Error('missing %PDF header — not a valid PDF');
      }
    } catch (err) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read PDF: ${err instanceof Error ? err.message : String(err)}`,
            filePath: this.filePath,
            severity: 'error',
          },
        ],
        durationMs: Date.now() - start,
      };
    }

    // Extract text via pdf-parse v1 (pure JS, no worker required in Node.js)
    let fullText = '';
    let pageCount = 0;
    try {
      // pdf-parse v1 is a CJS default export: require('pdf-parse')(buffer)
      // Use dynamic import to stay ESM-compatible; fall back to require() in CJS.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse: (buf: Buffer, opts?: { max?: number }) => Promise<{ text: string; numpages: number }> =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('pdf-parse');
      const parsed = await pdfParse(buffer, { max: 0 }); // max:0 = no page limit
      fullText = parsed.text ?? '';
      pageCount = parsed.numpages ?? 0;
    } catch (err) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`,
            filePath: this.filePath,
            severity: 'error',
          },
        ],
        durationMs: Date.now() - start,
      };
    }

    const totalLines = fullText ? fullText.split('\n').length : 1;

    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'pdf',
      startLine: 1,
      endLine: totalLines,
      startColumn: 0,
      endColumn: 0,
      docstring: pageCount > 0 ? `${pageCount} page${pageCount !== 1 ? 's' : ''}` : undefined,
      isExported: false,
      updatedAt: now,
    };

    const nodes: Node[] = [docNode];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    let chunkOffset = 0;

    if (!fullText.trim()) {
      // Scanned / image-only PDF — no text layer. Phase 5 (OCR) handles these.
      return {
        nodes,
        edges,
        unresolvedReferences: [],
        errors: [],
        durationMs: Date.now() - start,
        chunks,
      };
    }

    const sections = parseSections(fullText);

    if (sections.length === 0) {
      // No detected headings — chunk entire body under document node
      for (const c of chunkText(fullText)) {
        chunks.push({
          id: chunkId(this.filePath, chunkOffset++),
          filePath: this.filePath,
          nodeId: docNode.id,
          chunkIndex: c.index,
          charStart: c.charStart,
          charEnd: c.charEnd,
          body: c.body,
          metadata: { title: name },
          updatedAt: now,
        });
      }
    } else {
      for (const section of sections) {
        const body = section.lines.join('\n').trim();
        const sectionNode: Node = {
          id: makeNodeId(this.filePath, 'section', section.title, section.lineIndex),
          kind: 'section',
          name: section.title,
          qualifiedName: `${this.filePath}#${section.title}`,
          filePath: this.filePath,
          language: 'pdf',
          startLine: section.lineIndex,
          endLine: section.lineIndex + section.lines.length,
          startColumn: 0,
          endColumn: 0,
          docstring: body.length > 200 ? body.slice(0, 200) + '…' : body || undefined,
          isExported: false,
          updatedAt: now,
        };

        nodes.push(sectionNode);
        edges.push({ source: docNode.id, target: sectionNode.id, kind: 'contains' });

        if (body) {
          for (const c of chunkText(body)) {
            chunks.push({
              id: chunkId(this.filePath, chunkOffset++),
              filePath: this.filePath,
              nodeId: sectionNode.id,
              chunkIndex: chunkOffset - 1,
              charStart: c.charStart,
              charEnd: c.charEnd,
              body: c.body,
              metadata: { title: section.title },
              updatedAt: now,
            });
          }
        }
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
