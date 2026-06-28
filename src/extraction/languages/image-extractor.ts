/**
 * Image extractor (.png/.jpg/.jpeg/.tiff/.tif/.bmp/.webp) — Phase 5 (OCR).
 *
 * Runs the opt-in OCR backend over an image and produces, exactly like the
 * other document extractors:
 *   - 1 `document` node (whole file)
 *   - prose chunks of the recognized text (under the document node)
 *
 * Gating (honors PLAN's "ship fully or not at all" / no-partial-coverage rule):
 *   - OCR disabled in `WitsOS.json` → document node only, zero chunks.
 *   - OCR enabled but the optional package not installed → document node only,
 *     zero chunks, plus a one-line warning (never an error result).
 *   - OCR enabled + backend present → recognized text becomes chunks in
 *     `chunks_fts`.
 *
 * Binary file: re-read from disk as a Buffer (the orchestrator passes UTF-8
 * which corrupts binary content — same pattern as PdfExtractor/DocxExtractor).
 */
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ExtractionResult, Node, Edge, ChunkRecord } from '../../types';
import { StandaloneExtractor } from '../extractor-registry';
import { chunkText, chunkId } from '../chunker';
import { loadOcrBackend, OcrOptions } from '../ocr/backend';
import type { OcrConfig } from '../../project-config';
import { logWarn } from '../../errors';

function makeNodeId(filePath: string, kind: string, name: string, line: number): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

export class ImageExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    // source is ignored — binary file re-read below
    _source: string,
    /** OCR config; when absent or disabled, the extractor emits document-only. */
    private readonly ocr?: OcrConfig,
    /**
     * Optional project root used to resolve a relative `filePath` to an absolute
     * path for binary file reading. When absent, `filePath` is used as-is
     * (callers that pass an absolute path or set the CWD to the project root).
     */
    private readonly rootDir?: string,
  ) {}

  extract(): Promise<ExtractionResult> {
    return this._extract();
  }

  private async _extract(): Promise<ExtractionResult> {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const now = Date.now();

    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'image',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: now,
    };

    const documentOnly = (): ExtractionResult => ({
      nodes: [docNode],
      edges: [],
      unresolvedReferences: [],
      errors: [],
      durationMs: Date.now() - start,
      chunks: [],
    });

    // OCR off → track the file, no text.
    if (!this.ocr?.enabled) return documentOnly();

    const backend = await loadOcrBackend();
    if (!backend) {
      logWarn(
        'OCR is enabled in WitsOS.json but the OCR package is not installed — indexing image as document-only. Install @gutenye/ocr-node to enable text recognition.',
        { filePath: this.filePath },
      );
      return documentOnly();
    }

    // Re-read as Buffer (orchestrator passes UTF-8 which corrupts binary).
    // Resolve to absolute path: filePath may be relative (from git ls-files),
    // so resolve against rootDir when provided.
    const readPath =
      this.rootDir && !path.isAbsolute(this.filePath)
        ? path.join(this.rootDir, this.filePath)
        : this.filePath;
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(readPath);
      if (buffer.length < 4) throw new Error('file too small to be a valid image');
    } catch (err) {
      return {
        nodes: [docNode],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read image: ${err instanceof Error ? err.message : String(err)}`,
            filePath: this.filePath,
            severity: 'error',
          },
        ],
        durationMs: Date.now() - start,
        chunks: [],
      };
    }

    const opts: OcrOptions = {
      languages: this.ocr.languages,
      maxImageMP: this.ocr.maxImageMP,
      minConfidence: this.ocr.minConfidence,
    };

    let text = '';
    let engine = backend.name;
    let avgConfidence = 0;
    try {
      const page = await backend.recognize(buffer, opts);
      engine = page.engine;
      text = page.lines.map((l) => l.text).join('\n').trim();
      if (page.lines.length > 0) {
        avgConfidence =
          page.lines.reduce((s, l) => s + l.confidence, 0) / page.lines.length;
      }
    } catch (err) {
      // A genuine OCR failure on one file should not error the whole index;
      // degrade to document-only with a warning (recoverable condition).
      logWarn(
        `OCR failed for image — indexing as document-only: ${err instanceof Error ? err.message : String(err)}`,
        { filePath: this.filePath },
      );
      return documentOnly();
    }

    if (!text) return documentOnly();

    docNode.docstring = `OCR (${engine})`;

    const nodes: Node[] = [docNode];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    let chunkOffset = 0;

    for (const c of chunkText(text)) {
      // Derive a short heading from the first line of the chunk body.
      const firstLine = (c.body.split('\n')[0] ?? '').trim();
      const heading =
        firstLine.length <= 60 ? firstLine : firstLine.slice(0, 57).trimEnd() + '…';

      const sectionNode: Node = {
        id: makeNodeId(this.filePath, 'section', heading, chunkOffset + 1),
        kind: 'section',
        name: heading,
        qualifiedName: `${this.filePath}#${chunkOffset + 1}`,
        filePath: this.filePath,
        language: 'image',
        startLine: chunkOffset + 1,
        endLine: chunkOffset + 1,
        startColumn: 0,
        endColumn: 0,
        docstring: c.body.length > 200 ? c.body.slice(0, 200) + '…' : c.body,
        isExported: false,
        updatedAt: now,
      };

      nodes.push(sectionNode);
      edges.push({ source: docNode.id, target: sectionNode.id, kind: 'contains' });

      chunks.push({
        id: chunkId(this.filePath, chunkOffset++),
        filePath: this.filePath,
        nodeId: sectionNode.id,
        chunkIndex: c.index,
        charStart: c.charStart,
        charEnd: c.charEnd,
        body: c.body,
        metadata: { title: name, ocrEngine: engine, ocrConfidence: avgConfidence },
        updatedAt: now,
      });
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
