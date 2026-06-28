/**
 * DOCX extractor (.docx)
 *
 * Produces:
 *   - 1 `document` node (whole file)
 *   - N `section` nodes (one per detected heading paragraph)
 *   - `document --contains--> section` edges
 *   - Prose chunks per section (or full body if no headings)
 *
 * No native build required. Uses adm-zip (pure JS) to unpack the OOXML ZIP
 * and regex-based XML text extraction (no full XML parser dependency).
 *
 * Binary file: the extractor re-reads the file from disk as a Buffer because
 * indexAll reads all files as UTF-8 strings, which corrupts binary content.
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

/** Extract all text runs from a single XML string, returning one string per paragraph. */
function extractParagraphs(xml: string): Array<{ text: string; style: string }> {
  const paragraphs: Array<{ text: string; style: string }> = [];

  // Split on paragraph boundaries <w:p ...> ... </w:p>
  const paraPattern = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = paraPattern.exec(xml)) !== null) {
    const paraXml = pMatch[1] ?? '';

    // Detect paragraph style (Heading1 … Heading9)
    const styleMatch = /<w:pStyle\s+w:val="([^"]+)"/.exec(paraXml);
    const style = styleMatch?.[1] ?? '';

    // Collect all text runs <w:t>…</w:t> (including xml:space="preserve")
    const textParts: string[] = [];
    const textPattern = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = textPattern.exec(paraXml)) !== null) {
      textParts.push(tMatch[1] ?? '');
    }

    const text = textParts.join('').trim();
    if (text) {
      paragraphs.push({ text, style });
    }
  }

  return paragraphs;
}

function isHeadingStyle(style: string): boolean {
  return /^Heading\d+$/i.test(style) || /^[Hh]eading/i.test(style);
}

interface Section {
  title: string;
  paragraphs: string[];
  paraIndex: number; // 1-based paragraph number where heading sits
}

export class DocxExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    // source is ignored — binary file re-read below
    _source: string
  ) {}

  extract(): ExtractionResult {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const now = Date.now();

    let xmlContent = '';
    try {
      const buffer = fs.readFileSync(this.filePath);
      if (buffer.length < 4) {
        throw new Error('file is empty or too small to be a valid DOCX');
      }
      const zip = new AdmZip(buffer);
      const entry = zip.getEntry('word/document.xml');
      if (!entry) {
        throw new Error('word/document.xml not found in ZIP');
      }
      xmlContent = entry.getData().toString('utf-8');
    } catch (err) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Failed to read DOCX: ${err instanceof Error ? err.message : String(err)}`, filePath: this.filePath, severity: 'error' }],
        durationMs: Date.now() - start,
      };
    }

    const paragraphs = extractParagraphs(xmlContent);

    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'docx',
      startLine: 1,
      endLine: paragraphs.length,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: now,
    };

    const nodes: Node[] = [docNode];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    let chunkOffset = 0;

    // Group paragraphs into sections by heading style
    const sections: Section[] = [];
    let currentSection: Section | null = null;

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i]!;
      if (isHeadingStyle(para.style)) {
        currentSection = { title: para.text, paragraphs: [], paraIndex: i + 1 };
        sections.push(currentSection);
      } else if (currentSection) {
        currentSection.paragraphs.push(para.text);
      }
    }

    if (sections.length === 0) {
      // No headings — chunk entire body under document node
      const fullText = paragraphs.map((p) => p.text).join('\n\n');
      const rawChunks = chunkText(fullText);
      for (const c of rawChunks) {
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
        const sectionNode: Node = {
          id: makeNodeId(this.filePath, 'section', section.title, section.paraIndex),
          kind: 'section',
          name: section.title,
          qualifiedName: `${this.filePath}#${section.title}`,
          filePath: this.filePath,
          language: 'docx',
          startLine: section.paraIndex,
          endLine: section.paraIndex + section.paragraphs.length,
          startColumn: 0,
          endColumn: 0,
          docstring: section.paragraphs.slice(0, 2).join(' ').slice(0, 200),
          isExported: false,
          updatedAt: now,
        };

        nodes.push(sectionNode);
        edges.push({ source: docNode.id, target: sectionNode.id, kind: 'contains' });

        const body = section.paragraphs.join('\n\n');
        if (body.trim()) {
          const rawChunks = chunkText(body);
          for (const c of rawChunks) {
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
