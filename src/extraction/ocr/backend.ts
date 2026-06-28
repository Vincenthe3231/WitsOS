/**
 * OCR backend abstraction (Phase 5).
 *
 * OCR is an OPT-IN, never-bundled capability. The default install ships pure
 * WASM + `node:sqlite` with zero native build; OCR pulls a prebuilt native
 * addon (`onnxruntime-node` via `@gutenye/ocr-node`) only when a project opts
 * in (`WitsOS.json` → `"ocr": { "enabled": true }`) AND the optional package is
 * installed. This module is the swappable seam: a future VLM / cloud backend
 * implements `OcrBackend` and drops in without touching the extraction pipeline.
 *
 * Everything here lazy-loads the engine — importing this file pulls no OCR
 * dependency. `loadOcrBackend()` returns `null` (never throws) when the package
 * is absent, so the caller degrades to a document-only result rather than an
 * error that would teach an agent to abandon the tool.
 */

/** One recognized text line with its confidence (and optional bounding box). */
export interface OcrLine {
  text: string;
  /** Recognition confidence in [0,1]. */
  confidence: number;
  /** Optional bounding box [x0,y0,x1,y1,…] in image pixels. */
  box?: number[];
}

/** Result of recognizing one image (or one rasterized page). */
export interface OcrPage {
  lines: OcrLine[];
  /** Engine identifier, stored in chunk metadata for provenance. */
  engine: string;
}

export interface OcrOptions {
  /** Recognition languages, e.g. ["en"]. */
  languages?: string[];
  /** Cap input megapixels — larger images should be downscaled before recognize. */
  maxImageMP?: number;
  /** Drop lines below this confidence. */
  minConfidence?: number;
}

/** A pluggable OCR engine. */
export interface OcrBackend {
  /** Engine identifier (stored in chunk metadata). */
  readonly name: string;
  /** Recognize text in an image given its file path or raw bytes. */
  recognize(image: string | Buffer, opts?: OcrOptions): Promise<OcrPage>;
}

/**
 * Default backend: PP-OCRv4 ONNX via the optional `@gutenye/ocr-node` package
 * (MIT; deps `onnxruntime-node` prebuilt + `sharp`). The engine instance is
 * cached because model load (det+rec ONNX sessions) is expensive — first call
 * pays it, the rest reuse it.
 */
class GutenyeOcrBackend implements OcrBackend {
  readonly name = 'paddle-ocr-v4-onnx';
  // The @gutenye/ocr-node Ocr instance, created on first recognize().
  private engine: Promise<{ detect(image: string | Buffer): Promise<unknown> }> | null = null;

  private getEngine(): Promise<{ detect(image: string | Buffer): Promise<unknown> }> {
    if (!this.engine) {
      this.engine = (async () => {
        // Optional dependency — resolved at runtime, never bundled.
        const mod: any = await import('@gutenye/ocr-node' as string);
        const Ocr = mod.default ?? mod;
        return Ocr.create();
      })();
    }
    return this.engine;
  }

  async recognize(image: string | Buffer, opts?: OcrOptions): Promise<OcrPage> {
    const engine = await this.getEngine();
    const raw = (await engine.detect(image)) as Array<{
      text?: string;
      score?: number;
      box?: number[];
    }>;
    const min = opts?.minConfidence ?? 0;
    const lines: OcrLine[] = [];
    for (const r of Array.isArray(raw) ? raw : []) {
      const text = (r.text ?? '').trim();
      const confidence = typeof r.score === 'number' ? r.score : 1;
      if (!text || confidence < min) continue;
      lines.push({ text, confidence, box: r.box });
    }
    return { lines, engine: this.name };
  }
}

let cachedBackend: OcrBackend | null | undefined;

/**
 * Resolve the active OCR backend, or `null` if the optional OCR package is not
 * installed. Never throws — a missing package is an expected, recoverable state.
 * The result is cached across calls (including the not-installed `null`), so the
 * import probe runs at most once per process.
 */
export async function loadOcrBackend(): Promise<OcrBackend | null> {
  if (cachedBackend !== undefined) return cachedBackend;
  try {
    // Probe the optional package without instantiating the engine yet.
    await import('@gutenye/ocr-node' as string);
    cachedBackend = new GutenyeOcrBackend();
  } catch {
    cachedBackend = null;
  }
  return cachedBackend;
}

/** Test hook: reset the cached backend (e.g. to inject a fake). */
export function __setOcrBackendForTests(backend: OcrBackend | null | undefined): void {
  cachedBackend = backend;
}
