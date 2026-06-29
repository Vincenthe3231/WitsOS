/**
 * Phase 6c — Video extraction tests.
 *
 * Covers without requiring real ffmpeg / ffprobe:
 *   - parseSubtitles unit: SRT, VTT, malformed input
 *   - Gating: no ffprobe → document-only, no errors thrown
 *   - Gating: STT disabled → subtitles still run, audio skipped
 *   - Sidecar subtitle loading (.srt/.vtt alongside video file)
 *   - Metadata chunk emitted with correct fields
 *   - Embedded subtitle demux path degrades gracefully when ffmpeg unavailable
 *   - EXTENSION_MAP and media-extractor registry wiring
 *
 * Uses vi.mock for locateFfmpeg and child_process.spawn so tests run in CI
 * without any native binaries.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

// --- helpers ---

/** Build a fake child_process.spawn return value that emits stdout then closes. */
function makeSpawnResult(stdout: string, exitCode = 0) {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setImmediate(() => {
    proc.stdout.emit('data', stdout);
    proc.emit('close', exitCode);
  });
  return proc;
}

/** Build a fake spawn that always fails (non-zero exit). */
function makeSpawnFail(exitCode = 1, stderr = 'error') {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setImmediate(() => {
    proc.stderr.emit('data', stderr);
    proc.emit('close', exitCode);
  });
  return proc;
}

// Fake ffprobe CSV output: stream line + duration line
const FFPROBE_CSV_OK = 'h264,video,1920,1080\n60.000000\n';

// Stub locateFfmpeg/locateFfprobe — default returns null (no ffmpeg installed)
vi.mock('../src/extraction/audio/ffmpeg', () => ({
  locateFfmpeg: vi.fn().mockResolvedValue(null),
  locateFfprobe: vi.fn().mockResolvedValue(null),
  decodeAudioToPcm: vi.fn(),
  probeAudio: vi.fn(),
}));

// Stub child_process — spawn defaults to fail, execFile mocked for ffprobe validation
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => makeSpawnFail()),
    execFile: vi.fn((cmd: string, args?: string[], opts?: any, cb?: any) => {
      // Handle both callback and promisified forms
      const callback = typeof opts === 'function' ? opts : cb;
      if (!callback) return undefined;

      // ffprobe validation probe returns success (handles both 'ffprobe' and '/stub/ffprobe')
      if ((cmd === 'ffprobe' || cmd.endsWith('ffprobe')) && Array.isArray(args) && args.includes('-version')) {
        setImmediate(() => callback(null, 'ffprobe version...', ''));
      } else {
        setImmediate(() => callback(new Error('not found')));
      }
    }),
  };
});

// Mock fs.existsSync for stub paths
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const originalExistSync = actual.existsSync;
  return {
    ...actual,
    existsSync: vi.fn((path) => {
      if (typeof path === 'string' && path.startsWith('/stub/')) return true;
      return originalExistSync(path);
    }),
  };
});

import { VideoExtractor } from '../src/extraction/languages/video-extractor';
import { parseSubtitles } from '../src/extraction/subtitles/srt-parser';
import { locateFfmpeg, locateFfprobe } from '../src/extraction/audio/ffmpeg';
import { spawn, execFile } from 'child_process';
import type { SttConfig } from '../src/project-config';

const locateFfmpegMock = vi.mocked(locateFfmpeg);
const locateFfprobeMock = vi.mocked(locateFfprobe);
const spawnMock = vi.mocked(spawn);
const execFileMock = vi.mocked(execFile);

const DISABLED_STT: SttConfig = {
  enabled: false,
  model: 'base',
  modelPath: null,
  language: 'auto',
  diarize: false,
  minConfidence: 0,
  ffmpegPath: null,
  maxDurationSecs: 1800,
};

const ENABLED_STT: SttConfig = {
  ...DISABLED_STT,
  enabled: true,
};

const FAKE_VIDEO = '/project/video/lecture.mp4';

beforeEach(() => {
  locateFfmpegMock.mockResolvedValue(null);
  locateFfprobeMock.mockResolvedValue(null);
  spawnMock.mockImplementation(() => makeSpawnFail() as any);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseSubtitles — pure unit tests
// ---------------------------------------------------------------------------

describe('parseSubtitles', () => {
  it('parses SRT format with sequence numbers', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
Second subtitle
`;
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe('Hello world');
    expect(cues[0]!.start).toBeCloseTo(1);
    expect(cues[0]!.end).toBeCloseTo(3.5);
    expect(cues[1]!.text).toBe('Second subtitle');
  });

  it('parses VTT format without sequence numbers', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
First cue

00:00:03.000 --> 00:00:05.500
Second cue
`;
    const cues = parseSubtitles(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe('First cue');
    expect(cues[1]!.start).toBeCloseTo(3);
    expect(cues[1]!.end).toBeCloseTo(5.5);
  });

  it('returns empty array for empty string', () => {
    expect(parseSubtitles('')).toHaveLength(0);
  });

  it('returns empty array for malformed timing lines', () => {
    const bad = `1
not a timing line
Some text
`;
    expect(parseSubtitles(bad)).toHaveLength(0);
  });

  it('skips cues with no text', () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000

2
00:00:03,000 --> 00:00:04,000
Real subtitle
`;
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('Real subtitle');
  });

  it('handles multi-line cue text', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Line one
Line two
`;
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toContain('Line one');
    expect(cues[0]!.text).toContain('Line two');
  });
});

// ---------------------------------------------------------------------------
// VideoExtractor — gating matrix (no ffmpeg)
// ---------------------------------------------------------------------------

describe('VideoExtractor — gating (no ffmpeg)', () => {
  it('returns document-only when locateFfmpeg returns null', async () => {
    locateFfmpegMock.mockResolvedValue(null);
    const ext = new VideoExtractor(FAKE_VIDEO, '', DISABLED_STT);
    const result = await ext.extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.kind).toBe('document');
    expect(result.chunks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns document-only when ffprobe exits non-zero', async () => {
    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock.mockImplementation(() => makeSpawnFail() as any);
    const ext = new VideoExtractor(FAKE_VIDEO, '', DISABLED_STT);
    const result = await ext.extract();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.kind).toBe('document');
    expect(result.errors).toHaveLength(0);
  });

  it('emits document node with language "video"', async () => {
    locateFfmpegMock.mockResolvedValue(null);
    locateFfprobeMock.mockResolvedValue(null);
    const ext = new VideoExtractor(FAKE_VIDEO, '', DISABLED_STT);
    const result = await ext.extract();
    expect(result.nodes[0]!.language).toBe('video');
    expect(result.nodes[0]!.name).toBe('lecture.mp4');
  });

  it('never throws even when all extraction paths fail', async () => {
    locateFfmpegMock.mockRejectedValue(new Error('ffmpeg exploded'));
    locateFfprobeMock.mockRejectedValue(new Error('ffprobe exploded'));
    const ext = new VideoExtractor(FAKE_VIDEO, '', DISABLED_STT);
    await expect(ext.extract()).resolves.toBeDefined();
    const result = await ext.extract();
    expect(result.nodes[0]!.kind).toBe('document');
  });
});

// ---------------------------------------------------------------------------
// VideoExtractor — metadata extraction
// ---------------------------------------------------------------------------

describe('VideoExtractor — metadata extraction', () => {
  it('emits metadata chunk when ffprobe succeeds', async () => {
    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    // First spawn call = ffprobe (probeMetadata)
    // Second spawn call = ffmpeg embedded subtitle demux → fail (none present)
    spawnMock
      .mockImplementationOnce(() => makeSpawnResult(FFPROBE_CSV_OK) as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const ext = new VideoExtractor(FAKE_VIDEO, '', DISABLED_STT);
    const result = await ext.extract();

    expect(result.nodes[0]!.kind).toBe('document');
    expect(result.nodes[0]!.docstring).toContain('1920×1080');
    expect(result.nodes[0]!.docstring).toContain('h264');

    const metaChunk = result.chunks.find(
      (c) => (c.metadata as Record<string, unknown>)?.source === 'metadata'
    );
    expect(metaChunk).toBeDefined();
    expect(metaChunk!.body).toContain('Duration: 60s');
    expect(metaChunk!.body).toContain('1920×1080');
    expect(metaChunk!.body).toContain('h264');
  });

  it('metadata chunk carries correct metadata fields', async () => {
    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock
      .mockImplementationOnce(() => makeSpawnResult(FFPROBE_CSV_OK) as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const ext = new VideoExtractor(FAKE_VIDEO, '', DISABLED_STT);
    const result = await ext.extract();

    const metaChunk = result.chunks.find(
      (c) => (c.metadata as Record<string, unknown>)?.source === 'metadata'
    );
    const meta = metaChunk!.metadata as Record<string, unknown>;
    expect(meta.duration).toBeCloseTo(60);
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
    expect(meta.codec).toBe('h264');
  });
});

// ---------------------------------------------------------------------------
// VideoExtractor — sidecar subtitle loading
// ---------------------------------------------------------------------------

describe('VideoExtractor — sidecar subtitles', () => {
  let tmpDir: string;
  let videoPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsos-video-test-'));
    videoPath = path.join(tmpDir, 'lecture.mp4');
    fs.writeFileSync(videoPath, ''); // placeholder
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads .srt sidecar and emits section nodes + chunks', async () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Hello from sidecar

2
00:00:04,000 --> 00:00:06,000
Second cue
`;
    fs.writeFileSync(path.join(tmpDir, 'lecture.srt'), srt);

    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock
      .mockReturnValueOnce(makeSpawnResult(FFPROBE_CSV_OK) as any) // probeMetadata
      .mockImplementation(() => makeSpawnFail() as any); // embedded subtitle demux → not present

    const ext = new VideoExtractor(videoPath, '', DISABLED_STT, tmpDir);
    const result = await ext.extract();

    const sectionNodes = result.nodes.filter((n) => n.kind === 'section');
    expect(sectionNodes).toHaveLength(2);

    const subtitleChunks = result.chunks.filter(
      (c) => (c.metadata as Record<string, unknown>)?.source === 'sidecar'
    );
    expect(subtitleChunks).toHaveLength(2);
    expect(subtitleChunks[0]!.body).toBe('Hello from sidecar');
    expect(subtitleChunks[1]!.body).toBe('Second cue');
  });

  it('loads .vtt sidecar when no .srt present', async () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
VTT subtitle line
`;
    fs.writeFileSync(path.join(tmpDir, 'lecture.vtt'), vtt);

    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock
      .mockImplementationOnce(() => makeSpawnResult(FFPROBE_CSV_OK) as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const ext = new VideoExtractor(videoPath, '', DISABLED_STT, tmpDir);
    const result = await ext.extract();

    const subtitleChunks = result.chunks.filter(
      (c) => (c.metadata as Record<string, unknown>)?.source === 'sidecar'
    );
    expect(subtitleChunks).toHaveLength(1);
    expect(subtitleChunks[0]!.body).toBe('VTT subtitle line');
  });

  it('prefers .srt sidecar over .vtt when both exist', async () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
From SRT
`;
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
From VTT
`;
    fs.writeFileSync(path.join(tmpDir, 'lecture.srt'), srt);
    fs.writeFileSync(path.join(tmpDir, 'lecture.vtt'), vtt);

    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock
      .mockImplementationOnce(() => makeSpawnResult(FFPROBE_CSV_OK) as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const ext = new VideoExtractor(videoPath, '', DISABLED_STT, tmpDir);
    const result = await ext.extract();

    const subtitleChunks = result.chunks.filter(
      (c) => (c.metadata as Record<string, unknown>)?.source === 'sidecar'
    );
    expect(subtitleChunks).toHaveLength(1);
    expect(subtitleChunks[0]!.body).toBe('From SRT');
  });

  it('subtitle section nodes carry timing metadata', async () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
Timed subtitle
`;
    fs.writeFileSync(path.join(tmpDir, 'lecture.srt'), srt);

    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock
      .mockImplementationOnce(() => makeSpawnResult(FFPROBE_CSV_OK) as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const ext = new VideoExtractor(videoPath, '', DISABLED_STT, tmpDir);
    const result = await ext.extract();

    const subtitleChunk = result.chunks.find(
      (c) => (c.metadata as Record<string, unknown>)?.source === 'sidecar'
    );
    const meta = subtitleChunk!.metadata as Record<string, unknown>;
    expect(meta.start).toBeCloseTo(1);
    expect(meta.end).toBeCloseTo(3.5);
  });

  it('section nodes link back to document via contains edges', async () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
Edge test
`;
    fs.writeFileSync(path.join(tmpDir, 'lecture.srt'), srt);

    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock
      .mockImplementationOnce(() => makeSpawnResult(FFPROBE_CSV_OK) as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const ext = new VideoExtractor(videoPath, '', DISABLED_STT, tmpDir);
    const result = await ext.extract();

    const docNode = result.nodes.find((n) => n.kind === 'document')!;
    const containsEdges = result.edges.filter(
      (e) => e.source === docNode.id && e.kind === 'contains'
    );
    expect(containsEdges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VideoExtractor — STT gating
// ---------------------------------------------------------------------------

describe('VideoExtractor — STT gating', () => {
  it('skips audio extraction when STT disabled', async () => {
    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    locateFfprobeMock.mockResolvedValue('/stub/ffprobe');
    spawnMock
      .mockImplementationOnce(() => makeSpawnResult(FFPROBE_CSV_OK) as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const ext = new VideoExtractor(FAKE_VIDEO, '', DISABLED_STT);
    const result = await ext.extract();

    // With STT disabled: only metadata chunk (no transcript chunks)
    const transcriptChunks = result.chunks.filter(
      (c) => (c.metadata as Record<string, unknown>)?.source === 'stt'
        || (c.metadata as Record<string, unknown>)?.sttEngine !== undefined
    );
    expect(transcriptChunks).toHaveLength(0);
  });

  it('skips audio extraction when video exceeds maxDurationSecs', async () => {
    locateFfmpegMock.mockResolvedValue('/stub/ffmpeg');
    // ffprobe returns 7200s (2 hours)
    spawnMock
      .mockReturnValueOnce(makeSpawnResult('h264,video,1920,1080\n7200.000000\n') as any)
      .mockImplementation(() => makeSpawnFail() as any);

    const shortCapStt: SttConfig = { ...ENABLED_STT, maxDurationSecs: 3600 };
    const ext = new VideoExtractor(FAKE_VIDEO, '', shortCapStt);
    const result = await ext.extract();

    // Document node present, no audio extraction attempted
    expect(result.nodes[0]!.kind).toBe('document');
    // spawn called: once for ffprobe, once for embedded subtitle demux — NOT a third time for audio demux
    // (audio demux would call spawn with -map a:0 args)
    const spawnCalls = spawnMock.mock.calls;
    const audioDemuxCalls = spawnCalls.filter((args) =>
      Array.isArray(args[1]) && args[1].includes('-map') && (args[1] as string[]).includes('a:0')
    );
    expect(audioDemuxCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EXTENSION_MAP + media registry wiring
// ---------------------------------------------------------------------------

describe('VideoExtractor — registry wiring', () => {
  it('video extensions are in EXTENSION_MAP', async () => {
    const { EXTENSION_MAP } = await import('../src/extraction/grammars');
    for (const ext of ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg']) {
      expect(EXTENSION_MAP[ext]).toBe('video');
    }
  });

  it('video is registered as a media extractor on the video lane', async () => {
    // Trigger registration
    const { registerDefaultMediaExtractors } = await import('../src/extraction/media-extractors-register');
    const { clearMediaExtractorRegistry, resolveMediaExtractor } = await import('../src/extraction/media-extractor-registry');
    clearMediaExtractorRegistry();
    registerDefaultMediaExtractors();

    const reg = resolveMediaExtractor('video', '.mp4');
    expect(reg).toBeDefined();
    expect(reg?.name).toBe('video');
    expect(reg?.lane).toBe('video');
  });
});
