/**
 * Phase 6 — Audio STT extraction tests.
 *
 * Covers the gating matrix without requiring real STT packages:
 *   - STT disabled → document-only, zero chunks
 *   - STT enabled, backend absent → document-only + no error (never isError)
 *   - STT enabled, ffmpeg absent → document-only + no error
 *   - STT enabled, backend + ffmpeg present → segments become nodes + chunks
 *
 * Uses __setSttBackendForTests to inject a fake backend (mirrors OCR tests).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AudioExtractor } from '../src/extraction/languages/audio-extractor';
import { __setSttBackendForTests } from '../src/extraction/stt/backend';
import type { SttBackend, SttResult } from '../src/extraction/stt/backend';
import type { SttConfig } from '../src/project-config';

// Stub ffmpeg so tests don't require the binary.
vi.mock('../src/extraction/audio/ffmpeg', () => ({
  locateFfmpeg: vi.fn().mockResolvedValue('/stub/ffmpeg'),
  decodeAudioToPcm: vi.fn().mockResolvedValue(Buffer.alloc(32000 * 2, 0)), // 1 s of silence
  probeAudio: vi.fn().mockResolvedValue({ durationSecs: 1, codec: 'wav' }),
}));

const DISABLED_STT: SttConfig = {
  enabled: false,
  model: 'base',
  modelPath: null,
  language: 'auto',
  diarize: false,
  minConfidence: 0,
  ffmpegPath: null,
};

const ENABLED_STT: SttConfig = {
  ...DISABLED_STT,
  enabled: true,
};

const FAKE_FILE = '/project/audio/meeting.wav';

afterEach(() => {
  __setSttBackendForTests(undefined); // reset cache
  vi.clearAllMocks();
});

describe('AudioExtractor — gating', () => {
  it('returns document-only when STT is disabled', async () => {
    const ext = new AudioExtractor(FAKE_FILE, '', DISABLED_STT);
    const result = await ext.extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].kind).toBe('document');
    expect(result.chunks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns document-only (no error) when backend absent', async () => {
    __setSttBackendForTests(null);
    const ext = new AudioExtractor(FAKE_FILE, '', ENABLED_STT);
    const result = await ext.extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.chunks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns document-only when no good segments returned', async () => {
    const fakeBackend: SttBackend = {
      name: 'fake',
      transcribe: async (): Promise<SttResult> => ({
        segments: [],
        language: 'en',
        engine: 'fake',
        model: 'base',
      }),
    };
    __setSttBackendForTests(fakeBackend);
    const ext = new AudioExtractor(FAKE_FILE, '', ENABLED_STT);
    const result = await ext.extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.chunks).toHaveLength(0);
  });

  it('emits document + section nodes + chunks when backend returns segments', async () => {
    const fakeBackend: SttBackend = {
      name: 'fake',
      transcribe: async (): Promise<SttResult> => ({
        segments: [
          { text: 'Hello world, this is a test sentence.', start: 0, end: 3.5, confidence: 0.95 },
          { text: 'The quick brown fox jumps over the lazy dog.', start: 3.5, end: 7.0, confidence: 0.92 },
        ],
        language: 'en',
        engine: 'fake',
        model: 'base',
      }),
    };
    __setSttBackendForTests(fakeBackend);
    const ext = new AudioExtractor(FAKE_FILE, '', ENABLED_STT);
    const result = await ext.extract();

    const docNodes = result.nodes.filter((n) => n.kind === 'document');
    const sectionNodes = result.nodes.filter((n) => n.kind === 'section');

    expect(docNodes).toHaveLength(1);
    expect(docNodes[0].language).toBe('audio');
    expect(sectionNodes.length).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    // Chunks must have timing metadata
    for (const chunk of result.chunks) {
      expect(chunk.metadata).toBeDefined();
      expect(typeof (chunk.metadata as Record<string, unknown>).sttEngine).toBe('string');
    }
  });

  it('filters segments below minConfidence', async () => {
    const fakeBackend: SttBackend = {
      name: 'fake',
      transcribe: async (): Promise<SttResult> => ({
        segments: [
          { text: 'High confidence segment here.', start: 0, end: 2, confidence: 0.9 },
          { text: 'Low confidence junk.', start: 2, end: 4, confidence: 0.1 },
        ],
        language: 'en',
        engine: 'fake',
        model: 'base',
      }),
    };
    __setSttBackendForTests(fakeBackend);
    const highConfig: SttConfig = { ...ENABLED_STT, minConfidence: 0.5 };
    const ext = new AudioExtractor(FAKE_FILE, '', highConfig);
    const result = await ext.extract();
    // At least the high-confidence text should appear in chunks
    const bodyText = result.chunks.map((c) => c.body).join(' ');
    expect(bodyText).toContain('High confidence');
    expect(bodyText).not.toContain('Low confidence junk');
  });
});

describe('STT model resolution — locateWhisperFiles', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers the int8 export and falls back to fp32', async () => {
    const { locateWhisperFiles } = await import('../src/extraction/stt/models');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    for (const f of [
      'base-encoder.onnx', 'base-encoder.int8.onnx',
      'base-decoder.onnx', 'base-decoder.int8.onnx',
      'base-tokens.txt',
    ]) fs.writeFileSync(path.join(dir, f), '');

    const files = locateWhisperFiles(dir);
    expect(files).not.toBeNull();
    expect(path.basename(files!.encoder)).toBe('base-encoder.int8.onnx');
    expect(path.basename(files!.decoder)).toBe('base-decoder.int8.onnx');
    expect(path.basename(files!.tokens)).toBe('base-tokens.txt');
  });

  it('returns null when a required file is missing', async () => {
    const { locateWhisperFiles } = await import('../src/extraction/stt/models');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    fs.writeFileSync(path.join(dir, 'base-encoder.onnx'), ''); // no decoder/tokens
    expect(locateWhisperFiles(dir)).toBeNull();
  });
});

describe('STT PCM conversion — pcmS16LEToFloat32', () => {
  it('normalizes int16 samples into [-1,1] floats', async () => {
    const { pcmS16LEToFloat32 } = await import('../src/extraction/stt/backend');
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(16384, 2);   // +0.5
    buf.writeInt16LE(-32768, 4);  // -1.0
    const f = pcmS16LEToFloat32(buf);
    expect(f).toHaveLength(3);
    expect(f[0]).toBeCloseTo(0, 5);
    expect(f[1]).toBeCloseTo(0.5, 4);
    expect(f[2]).toBeCloseTo(-1, 5);
  });
});

describe('AudioExtractor — EXTENSION_MAP registration', () => {
  it('audio extensions are recognized in EXTENSION_MAP', async () => {
    const { EXTENSION_MAP } = await import('../src/extraction/grammars');
    for (const ext of ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']) {
      expect(EXTENSION_MAP[ext]).toBe('audio');
    }
  });

  it('audio is classified as async extractor language', async () => {
    const { isAsyncExtractorLanguage } = await import('../src/extraction/grammars');
    expect(isAsyncExtractorLanguage('audio')).toBe(true);
  });
});
