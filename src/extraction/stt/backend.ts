/**
 * STT backend abstraction (Phase 6).
 *
 * STT is an OPT-IN, never-bundled capability. The default install ships pure
 * WASM + `node:sqlite` with zero native build; STT pulls a prebuilt native
 * addon (`sherpa-onnx`) only when a project opts in (`WitsOS.json` →
 * `"stt": { "enabled": true }`) AND the optional package is installed.
 *
 * This module is the swappable seam: a future cloud/VLM backend implements
 * `SttBackend` and drops in without touching the extraction pipeline.
 * `loadSttBackend()` returns `null` (never throws) when the package is absent.
 */

/** One transcript segment (sentence / paragraph boundary or VAD window). */
export interface SttSegment {
  text: string;
  /** Start time in seconds from the beginning of the audio. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Speaker id when diarization is enabled. */
  speaker?: string;
  /** Recognition confidence in [0,1]. */
  confidence: number;
}

/** Full transcription result for one audio file. */
export interface SttResult {
  segments: SttSegment[];
  /** BCP-47 language code detected or specified (e.g. "en"). */
  language: string;
  /** Engine identifier stored in chunk metadata for provenance. */
  engine: string;
  /** Model id stored in chunk metadata (for re-transcribe invalidation). */
  model: string;
}

export interface SttOptions {
  /** BCP-47 language code, or "auto" for language detection. */
  language?: string;
  /** Model size keyword ("base", "small", "medium") or absolute path. */
  model?: string;
  /** Whether to run diarization (speaker segmentation). */
  diarize?: boolean;
  /** Drop segments below this confidence [0,1]. Default 0.0. */
  minConfidence?: number;
  /** Project root — so a project-local `.witsos/models/` is found before the home cache. */
  rootDir?: string;
}

/** A pluggable speech-to-text engine. */
export interface SttBackend {
  readonly name: string;
  /**
   * Transcribe 16 kHz mono PCM audio (raw Buffer or file path).
   * The caller is responsible for decoding any compressed format to PCM first.
   */
  transcribe(audio: Buffer | string, opts?: SttOptions): Promise<SttResult>;
}

/** Sample rate the offline whisper recognizer expects (16 kHz mono). */
const SAMPLE_RATE = 16000;
/**
 * Fixed transcription window in seconds. Whisper's native receptive field is
 * 30 s; we use ~28 s windows so each `createStream`/`decode` stays within one
 * whisper window and yields a real `{start,end}` without needing a separate
 * VAD model. (VAD-based segmentation is a future refinement.)
 */
const WINDOW_SECS = 28;

/**
 * Convert raw 16-bit signed little-endian mono PCM into a Float32Array in the
 * [-1, 1] range sherpa-onnx wants. Used only if ffmpeg emits s16le; the
 * extractor now decodes directly to f32le, so this is a safety fallback.
 */
export function pcmS16LEToFloat32(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/** View an f32le PCM Buffer as a Float32Array (zero-copy when aligned). */
function f32leToFloat32(buf: Buffer): Float32Array {
  if (buf.byteOffset % 4 === 0 && buf.byteLength % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  // Misaligned slice — copy into an aligned buffer.
  const aligned = Buffer.from(buf);
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

/** Minimal shape of the sherpa-onnx offline recognizer we rely on. */
interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text?: string };
}
interface OfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free?(): void;
}

/**
 * Default backend: sherpa-onnx (Apache-2.0). The installed package is the
 * WASM build (`sherpa-onnx-wasm-nodejs`), so STT runs on the WASM runtime —
 * consistent with WitsOS's zero-native-build default. It runs Whisper as ONNX
 * via `createOfflineRecognizer`. The recognizer is cached per model id because
 * model load is expensive — first call pays it, the rest reuse it.
 */
class SherpaOnnxSttBackend implements SttBackend {
  readonly name = 'sherpa-onnx';
  /** Cached recognizer keyed by resolved model id. */
  private recognizers = new Map<string, Promise<OfflineRecognizer>>();

  private getRecognizer(opts?: SttOptions): Promise<OfflineRecognizer> {
    const modelKey = opts?.model ?? 'base';
    let rec = this.recognizers.get(modelKey);
    if (!rec) {
      rec = (async () => {
        // Optional dependency — resolved at runtime, never bundled.
        const sherpa: any = await import('sherpa-onnx' as string);
        const { resolveModel } = await import('./models');
        const info = await resolveModel(modelKey, opts?.rootDir);
        if (info.status !== 'ready' || !info.encoder || !info.decoder || !info.tokens) {
          throw new Error(`STT model not ready: ${info.message}`);
        }
        const os = await import('os');
        const numThreads = Math.max(1, Math.min(4, os.cpus().length));
        return sherpa.createOfflineRecognizer({
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            whisper: {
              encoder: info.encoder,
              decoder: info.decoder,
              language: opts?.language && opts.language !== 'auto' ? opts.language : '',
              task: 'transcribe',
              tailPaddings: -1,
            },
            tokens: info.tokens,
            numThreads,
            provider: 'cpu',
            debug: 0,
            modelType: 'whisper',
          },
        }) as OfflineRecognizer;
      })();
      this.recognizers.set(modelKey, rec);
    }
    return rec;
  }

  async transcribe(audio: Buffer | string, opts?: SttOptions): Promise<SttResult> {
    if (typeof audio === 'string') {
      throw new Error('SherpaOnnxSttBackend.transcribe expects decoded PCM, not a file path');
    }
    const rec = await this.getRecognizer(opts);
    const samples = f32leToFloat32(audio);

    const windowSize = WINDOW_SECS * SAMPLE_RATE;
    const segments: SttSegment[] = [];
    for (let offset = 0; offset < samples.length; offset += windowSize) {
      const slice = samples.subarray(offset, Math.min(offset + windowSize, samples.length));
      if (slice.length < SAMPLE_RATE * 0.1) break; // <100ms tail — skip
      const stream = rec.createStream();
      stream.acceptWaveform(SAMPLE_RATE, slice);
      rec.decode(stream);
      const text = (rec.getResult(stream).text ?? '').trim();
      stream.free?.();
      if (text) {
        segments.push({
          text,
          start: offset / SAMPLE_RATE,
          end: Math.min(offset + windowSize, samples.length) / SAMPLE_RATE,
          confidence: 1,
        });
      }
    }

    return {
      segments,
      language: opts?.language && opts.language !== 'auto' ? opts.language : 'en',
      engine: this.name,
      model: opts?.model ?? 'base',
    };
  }
}

let cachedBackend: SttBackend | null | undefined;

/**
 * Resolve the active STT backend, or `null` if `sherpa-onnx` is not
 * installed. Never throws — a missing package is an expected, recoverable
 * state. Result cached across calls (including the not-installed `null`).
 */
export async function loadSttBackend(): Promise<SttBackend | null> {
  if (cachedBackend !== undefined) return cachedBackend;
  try {
    await import('sherpa-onnx' as string);
    cachedBackend = new SherpaOnnxSttBackend();
  } catch {
    cachedBackend = null;
  }
  return cachedBackend;
}

/** Test hook: reset the cached backend (e.g. to inject a fake). */
export function __setSttBackendForTests(backend: SttBackend | null | undefined): void {
  cachedBackend = backend;
}
