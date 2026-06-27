import { describe, it, expect } from 'vitest';
import { chunkText, chunkId } from '../src/extraction/chunker';

describe('chunkText', () => {
  it('returns empty array for empty string', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('returns single chunk for short text', () => {
    const chunks = chunkText('hello world', 1500, 150);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toBe('hello world');
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(11);
  });

  it('splits long text into multiple chunks', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, 1500, 150);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunk bodies reconstruct most of the text (with overlap)', () => {
    const text = 'word '.repeat(500); // 2500 chars
    const chunks = chunkText(text, 1000, 100);
    // First chunk starts at 0
    expect(chunks[0].charStart).toBe(0);
    // Last chunk ends at text.length
    expect(chunks[chunks.length - 1].charEnd).toBe(text.length);
  });

  it('charStart/charEnd match body length', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(100);
    const chunks = chunkText(text, 200, 20);
    for (const chunk of chunks) {
      expect(chunk.charEnd - chunk.charStart).toBe(chunk.body.length);
    }
  });

  it('prefers paragraph breaks over hard cuts', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, 30, 0);
    // Should not split mid-word
    for (const chunk of chunks) {
      expect(chunk.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('assigns monotonically increasing indices', () => {
    const text = 'x'.repeat(3000);
    const chunks = chunkText(text, 1000, 0);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('skips whitespace-only spans', () => {
    const chunks = chunkText('   \n   \n   ', 1500, 0);
    expect(chunks).toHaveLength(0);
  });
});

describe('chunkId', () => {
  it('is deterministic', () => {
    expect(chunkId('src/foo.md', 3)).toBe('chunk:src/foo.md:3');
  });

  it('produces unique ids for different indices', () => {
    const ids = [0, 1, 2].map((i) => chunkId('file.txt', i));
    expect(new Set(ids).size).toBe(3);
  });
});
