/**
 * Plain-text extractor (.txt, .text)
 *
 * Produces one `document` node + prose chunks. No structural analysis —
 * every file is treated as a flat block of text and chunked for FTS.
 */
import * as path from 'path';
import * as crypto from 'crypto';
import { ExtractionResult, Node, ChunkRecord } from '../../types';
import { StandaloneExtractor } from '../extractor-registry';
import { chunkText, chunkId } from '../chunker';

function nodeId(filePath: string, kind: string, name: string, line: number): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

function lineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}

export class TxtExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    private readonly source: string
  ) {}

  extract(): ExtractionResult {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const totalLines = lineCount(this.source);

    const now = Date.now();
    const docNode: Node = {
      id: nodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'plaintext',
      startLine: 1,
      endLine: totalLines,
      startColumn: 0,
      endColumn: 0,
      docstring: this.source.length > 200 ? this.source.slice(0, 200) + '…' : this.source,
      isExported: false,
      updatedAt: now,
    };

    const rawChunks = chunkText(this.source);
    const chunks: ChunkRecord[] = rawChunks.map((c) => ({
      id: chunkId(this.filePath, c.index),
      filePath: this.filePath,
      nodeId: docNode.id,
      chunkIndex: c.index,
      charStart: c.charStart,
      charEnd: c.charEnd,
      body: c.body,
      metadata: {},
      updatedAt: now,
    }));

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
