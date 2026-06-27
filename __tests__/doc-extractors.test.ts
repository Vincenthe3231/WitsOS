import { describe, it, expect } from 'vitest';
import { TxtExtractor } from '../src/extraction/languages/txt-extractor';
import { MdExtractor } from '../src/extraction/languages/md-extractor';
import { CsvExtractor } from '../src/extraction/languages/csv-extractor';

// ---------------------------------------------------------------------------
// TxtExtractor
// ---------------------------------------------------------------------------
describe('TxtExtractor', () => {
  it('emits one document node for a plain text file', () => {
    const r = new TxtExtractor('docs/notes.txt', 'Hello world.\nSecond line.').extract();
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].kind).toBe('document');
    expect(r.nodes[0].name).toBe('notes.txt');
    expect(r.nodes[0].language).toBe('plaintext');
    expect(r.nodes[0].filePath).toBe('docs/notes.txt');
  });

  it('produces chunks', () => {
    const text = 'word '.repeat(400); // ~2000 chars — should chunk
    const r = new TxtExtractor('a.txt', text).extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    expect(r.chunks![0].filePath).toBe('a.txt');
    expect(r.chunks![0].body.length).toBeGreaterThan(0);
  });

  it('chunk nodeId references document node', () => {
    const r = new TxtExtractor('a.txt', 'Some text.').extract();
    const docId = r.nodes[0].id;
    expect(r.chunks!.every((c) => c.nodeId === docId)).toBe(true);
  });

  it('short text produces exactly one chunk', () => {
    const r = new TxtExtractor('a.txt', 'Short.').extract();
    expect(r.chunks).toHaveLength(1);
  });

  it('no edges for plain text', () => {
    const r = new TxtExtractor('a.txt', 'text').extract();
    expect(r.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MdExtractor
// ---------------------------------------------------------------------------
describe('MdExtractor', () => {
  const md = `# Introduction

This is the intro paragraph.

## Installation

Run npm install.

### Advanced

Nested section.
`;

  it('emits document node', () => {
    const r = new MdExtractor('README.md', md).extract();
    const doc = r.nodes.find((n) => n.kind === 'document');
    expect(doc).toBeDefined();
    expect(doc!.name).toBe('README.md');
    expect(doc!.language).toBe('markdown');
  });

  it('emits section nodes for each heading', () => {
    const r = new MdExtractor('README.md', md).extract();
    const sections = r.nodes.filter((n) => n.kind === 'section');
    expect(sections.length).toBe(3); // Introduction, Installation, Advanced
    expect(sections.map((s) => s.name)).toContain('Introduction');
    expect(sections.map((s) => s.name)).toContain('Installation');
    expect(sections.map((s) => s.name)).toContain('Advanced');
  });

  it('emits contains edges from document to sections', () => {
    const r = new MdExtractor('README.md', md).extract();
    const doc = r.nodes.find((n) => n.kind === 'document')!;
    const containsEdges = r.edges.filter((e) => e.source === doc.id && e.kind === 'contains');
    expect(containsEdges.length).toBe(3);
  });

  it('produces chunks for sections with body text', () => {
    const r = new MdExtractor('README.md', md).extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    const chunkWithBody = r.chunks!.find((c) => c.body.includes('intro paragraph'));
    expect(chunkWithBody).toBeDefined();
  });

  it('no headings → chunks under document node', () => {
    const r = new MdExtractor('flat.md', 'Just a paragraph with no headings.\n').extract();
    const sections = r.nodes.filter((n) => n.kind === 'section');
    expect(sections).toHaveLength(0);
    const doc = r.nodes.find((n) => n.kind === 'document')!;
    expect(r.chunks!.every((c) => c.nodeId === doc.id)).toBe(true);
  });

  it('chunk metadata includes headingLevel', () => {
    const r = new MdExtractor('README.md', md).extract();
    const chunkWithMeta = r.chunks!.find((c) => (c.metadata as Record<string, unknown>)?.headingLevel !== undefined);
    expect(chunkWithMeta).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CsvExtractor
// ---------------------------------------------------------------------------
describe('CsvExtractor', () => {
  const csv = `name,age,city
Alice,30,NYC
Bob,25,LA
Carol,35,Chicago
`;

  it('emits one document node', () => {
    const r = new CsvExtractor('data.csv', csv).extract();
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].kind).toBe('document');
    expect(r.nodes[0].name).toBe('data.csv');
    expect(r.nodes[0].language).toBe('csv');
  });

  it('docstring contains column names', () => {
    const r = new CsvExtractor('data.csv', csv).extract();
    expect(r.nodes[0].docstring).toContain('name');
    expect(r.nodes[0].docstring).toContain('age');
    expect(r.nodes[0].docstring).toContain('city');
  });

  it('produces chunks with row data', () => {
    const r = new CsvExtractor('data.csv', csv).extract();
    expect(r.chunks!.length).toBeGreaterThan(0);
    const chunkBody = r.chunks![0].body;
    expect(chunkBody).toContain('Alice');
  });

  it('chunk metadata includes column names', () => {
    const r = new CsvExtractor('data.csv', csv).extract();
    const meta = r.chunks![0].metadata as Record<string, unknown>;
    expect(Array.isArray(meta.columns)).toBe(true);
    expect(meta.columns).toContain('name');
  });

  it('TSV delimiter auto-detect', () => {
    const tsv = `name\tage\tcity\nAlice\t30\tNYC\n`;
    const r = new CsvExtractor('data.tsv', tsv).extract();
    expect(r.nodes[0].docstring).toContain('name');
    expect(r.nodes[0].docstring).toContain('age');
  });

  it('no edges for CSV', () => {
    const r = new CsvExtractor('data.csv', csv).extract();
    expect(r.edges).toHaveLength(0);
  });

  it('chunk IDs are unique', () => {
    // Generate enough rows to force multiple chunks (>50)
    const header = 'id,value\n';
    const rows = Array.from({ length: 120 }, (_, i) => `${i},v${i}`).join('\n');
    const r = new CsvExtractor('big.csv', header + rows).extract();
    const ids = r.chunks!.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
