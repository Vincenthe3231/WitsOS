/**
 * Markdown extractor (.md, .mdx, .markdown)
 *
 * Produces:
 *   - 1 `document` node (whole file)
 *   - N `section` nodes (one per ATX heading: # / ## / … / ######)
 *   - `document --contains--> section` edges
 *   - Prose chunks per section (or the full body if no headings)
 *
 * No native deps. Pure regex over the raw markdown text.
 */
import * as path from 'path';
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

interface HeadingSpan {
  level: number;
  title: string;
  startLine: number;
  endLine: number;
  body: string; // section content (excludes heading line)
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;

function parseHeadings(text: string): HeadingSpan[] {
  const lines = text.split('\n');
  const headings: Array<{ level: number; title: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = ATX_HEADING.exec(line);
    if (m) {
      headings.push({ level: (m[1] ?? '').length, title: (m[2] ?? '').trim(), line: i + 1 }); // 1-indexed
    }
  }

  const spans: HeadingSpan[] = headings.map((h, i) => {
    const nextStart = i + 1 < headings.length ? (headings[i + 1]?.line ?? lines.length) - 1 : lines.length;
    const bodyLines = lines.slice(h.line, nextStart); // lines after heading
    return {
      level: h.level,
      title: h.title,
      startLine: h.line,
      endLine: nextStart,
      body: bodyLines.join('\n').trim(),
    };
  });

  return spans;
}

export class MdExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    private readonly source: string
  ) {}

  extract(): ExtractionResult {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const lines = this.source.split('\n');
    const totalLines = lines.length;

    const now = Date.now();
    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: totalLines,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: now,
    };

    const nodes: Node[] = [docNode];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    let chunkOffset = 0;

    const headings = parseHeadings(this.source);

    if (headings.length === 0) {
      // No headings → chunk entire body under document node
      const rawChunks = chunkText(this.source);
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
      for (const span of headings) {
        const sectionNode: Node = {
          id: makeNodeId(this.filePath, 'section', span.title, span.startLine),
          kind: 'section',
          name: span.title,
          qualifiedName: `${this.filePath}#${span.title}`,
          filePath: this.filePath,
          language: 'markdown',
          startLine: span.startLine,
          endLine: span.endLine,
          startColumn: 0,
          endColumn: 0,
          docstring: span.body.length > 200 ? span.body.slice(0, 200) + '…' : span.body,
          isExported: false,
          updatedAt: now,
        };

        nodes.push(sectionNode);
        edges.push({
          source: docNode.id,
          target: sectionNode.id,
          kind: 'contains',
        });

        if (span.body) {
          const rawChunks = chunkText(span.body);
          for (const c of rawChunks) {
            chunks.push({
              id: chunkId(this.filePath, chunkOffset++),
              filePath: this.filePath,
              nodeId: sectionNode.id,
              chunkIndex: chunkOffset - 1,
              charStart: c.charStart,
              charEnd: c.charEnd,
              body: c.body,
              metadata: { title: span.title, headingLevel: span.level },
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
