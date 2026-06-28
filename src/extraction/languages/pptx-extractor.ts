/**
 * PPTX extractor (.pptx)
 *
 * Produces:
 *   - 1 `document` node (whole file)
 *   - N `section` nodes (one per slide)
 *   - `document --contains--> section` edges
 *   - Prose chunks per slide (text content)
 *
 * No native build required. Uses adm-zip (pure JS) to unpack OOXML ZIP and
 * regex-based XML text extraction.
 *
 * Binary file: re-reads from disk as Buffer (indexAll reads UTF-8 which corrupts binary).
 */
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
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

/** Extract all visible text from a slide XML. Returns paragraphs joined by newlines. */
function extractSlideText(xml: string): string {
  const paragraphs: string[] = [];
  // DrawingML paragraphs: <a:p>…</a:p>
  const paraPattern = /<a:p[ >]([\s\S]*?)<\/a:p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = paraPattern.exec(xml)) !== null) {
    const paraXml = pMatch[1] ?? '';
    const textParts: string[] = [];
    const tPattern = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tPattern.exec(paraXml)) !== null) {
      textParts.push(tMatch[1] ?? '');
    }
    const text = textParts.join('').trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs.join('\n');
}

/** Extract slide title from <p:sp> with <p:ph type="title"> or <p:ph type="ctrTitle">. */
function extractSlideTitle(xml: string): string | null {
  // Find placeholder shapes with title type
  const titlePattern = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let spMatch: RegExpExecArray | null;
  while ((spMatch = titlePattern.exec(xml)) !== null) {
    const spXml = spMatch[1] ?? '';
    if (/<p:ph\s[^>]*type="(?:title|ctrTitle)"/.test(spXml)) {
      // Extract text from this shape
      const textParts: string[] = [];
      const tPattern = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
      let tMatch: RegExpExecArray | null;
      while ((tMatch = tPattern.exec(spXml)) !== null) {
        textParts.push(tMatch[1] ?? '');
      }
      const title = textParts.join('').trim();
      if (title) return title;
    }
  }
  return null;
}

/** Sort slide entry paths: ppt/slides/slide1.xml < slide2.xml < … */
function slideOrder(entryName: string): number {
  const m = /slide(\d+)\.xml$/.exec(entryName);
  return m ? parseInt(m[1] ?? '0', 10) : 9999;
}

export class PptxExtractor implements StandaloneExtractor {
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
      if (buffer.length < 4) throw new Error('file is empty or too small to be a valid PPTX');
      zip = new AdmZip(buffer);
    } catch (err) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Failed to read PPTX: ${err instanceof Error ? err.message : String(err)}`, filePath: this.filePath, severity: 'error' }],
        durationMs: Date.now() - start,
      };
    }

    // Enumerate slide entries: ppt/slides/slideN.xml (excludes slideLayouts/slideMasters)
    const slideEntries = zip.getEntries()
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => slideOrder(a.entryName) - slideOrder(b.entryName));

    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'pptx',
      startLine: 1,
      endLine: slideEntries.length,
      startColumn: 0,
      endColumn: 0,
      docstring: `${slideEntries.length} slide${slideEntries.length !== 1 ? 's' : ''}`,
      isExported: false,
      updatedAt: now,
    };

    const nodes: Node[] = [docNode];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    let chunkOffset = 0;

    for (let si = 0; si < slideEntries.length; si++) {
      const entry = slideEntries[si]!;
      const xml = entry.getData().toString('utf-8');
      const slideTitle = extractSlideTitle(xml) ?? `Slide ${si + 1}`;
      const slideText = extractSlideText(xml);

      const sectionNode: Node = {
        id: makeNodeId(this.filePath, 'section', slideTitle, si + 1),
        kind: 'section',
        name: slideTitle,
        qualifiedName: `${this.filePath}#slide${si + 1}`,
        filePath: this.filePath,
        language: 'pptx',
        startLine: si + 1,
        endLine: si + 1,
        startColumn: 0,
        endColumn: 0,
        docstring: slideText.slice(0, 200),
        isExported: false,
        updatedAt: now,
      };

      nodes.push(sectionNode);
      edges.push({ source: docNode.id, target: sectionNode.id, kind: 'contains' });

      if (slideText.trim()) {
        const rawChunks = chunkText(slideText);
        for (const c of rawChunks) {
          chunks.push({
            id: chunkId(this.filePath, chunkOffset++),
            filePath: this.filePath,
            nodeId: sectionNode.id,
            chunkIndex: chunkOffset - 1,
            charStart: c.charStart,
            charEnd: c.charEnd,
            body: c.body,
            metadata: { slide: si + 1, title: slideTitle },
            updatedAt: now,
          });
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
