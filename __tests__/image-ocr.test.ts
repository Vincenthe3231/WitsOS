/**
 * Phase 5: Image OCR extractor tests — ImageExtractor + classification + the
 * pluggable OcrBackend seam.
 *
 * The optional OCR engine (@gutenye/ocr-node) is NOT a dependency of the test
 * suite, so these tests cover the two byte-stable paths plus a fake backend:
 *   - classification: image extensions map to the `image` language and count as
 *     source files;
 *   - OCR off / not installed → document-only, zero chunks (no partial junk);
 *   - OCR on with an injected fake backend → recognized text becomes chunks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ImageExtractor } from '../src/extraction/languages/image-extractor';
import { __setOcrBackendForTests, type OcrBackend } from '../src/extraction/ocr/backend';
import { detectLanguage, isSourceFile, isLanguageSupported } from '../src/extraction/grammars';
import { resolveMediaExtractor } from '../src/extraction/media-extractor-registry';
import type { OcrConfig } from '../src/project-config';

const ENABLED: OcrConfig = { enabled: true, languages: ['en'], maxImageMP: 25, minConfidence: 0.5 };
const DISABLED: OcrConfig = { enabled: false, languages: ['en'], maxImageMP: 25, minConfidence: 0.5 };

function writeTmp(name: string, bytes: Buffer): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsos-ocr-test-'));
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

const tmpFiles: string[] = [];
function track(p: string): string { tmpFiles.push(p); return p; }

afterEach(() => {
  for (const p of tmpFiles) {
    try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
  __setOcrBackendForTests(undefined); // reset the backend cache between tests
});

// A 1x1 PNG (enough bytes to pass the >4 byte guard).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('image classification', () => {
  it('maps image extensions to the image language', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp']) {
      expect(detectLanguage(`pic${ext}`, '')).toBe('image');
      expect(isSourceFile(`pic${ext}`)).toBe(true);
    }
  });

  it('treats image as a supported language with a media extractor', () => {
    expect(isLanguageSupported('image')).toBe(true);
    const extractor = resolveMediaExtractor('image', '.png');
    expect(extractor).toBeDefined();
    expect(extractor?.lane).toBe('ocr');
  });

  it('does not classify .gif as image', () => {
    expect(detectLanguage('anim.gif', '')).not.toBe('image');
  });
});

describe('ImageExtractor — OCR off / not installed', () => {
  it('emits a document node and zero chunks when OCR is disabled', async () => {
    const file = track(writeTmp('a.png', PNG_1x1));
    const result = await new ImageExtractor(file, '', DISABLED).extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.kind).toBe('document');
    expect(result.nodes[0]!.language).toBe('image');
    expect(result.chunks ?? []).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('emits document-only when OCR enabled but package absent', async () => {
    __setOcrBackendForTests(null); // simulate "package not installed"
    const file = track(writeTmp('b.png', PNG_1x1));
    const result = await new ImageExtractor(file, '', ENABLED).extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.chunks ?? []).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe('ImageExtractor — OCR on with a backend', () => {
  it('turns recognized text into chunks', async () => {
    const fake: OcrBackend = {
      name: 'fake-ocr',
      async recognize() {
        return {
          engine: 'fake-ocr',
          lines: [
            { text: 'Hello world', confidence: 0.99 },
            { text: 'second line', confidence: 0.9 },
          ],
        };
      },
    };
    __setOcrBackendForTests(fake);

    const file = track(writeTmp('c.png', PNG_1x1));
    const result = await new ImageExtractor(file, '', ENABLED).extract();

    expect(result.nodes).toHaveLength(1);
    const chunks = result.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.body).toContain('Hello world');
    expect(chunks[0]!.metadata?.ocrEngine).toBe('fake-ocr');
    expect(typeof chunks[0]!.metadata?.ocrConfidence).toBe('number');
  });

  it('falls back to document-only when the backend yields no text', async () => {
    const empty: OcrBackend = {
      name: 'empty-ocr',
      async recognize() { return { engine: 'empty-ocr', lines: [] }; },
    };
    __setOcrBackendForTests(empty);

    const file = track(writeTmp('d.png', PNG_1x1));
    const result = await new ImageExtractor(file, '', ENABLED).extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.chunks ?? []).toHaveLength(0);
  });
});
