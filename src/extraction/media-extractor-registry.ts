/**
 * Media Extractor Registry — dispatch for async/binary extractors (audio, image, PDF, video).
 *
 * Complements ExtractorRegistry (synchronous string-source extractors). Media extractors
 * are fundamentally async (worker-threaded inference, ffmpeg decode) and accept binary
 * content or file paths. This registry unifies the dispatch, replacing the hardcoded
 * `isAsyncExtractorLanguage` if/else branches.
 *
 * Registration pattern mirrors ExtractorRegistry: first-match-wins, order-sensitive.
 * Used exclusively by `ExtractionOrchestrator.indexAll()` to route binary files through
 * named worker lanes (JobPool: 'stt', 'ocr', 'video', etc).
 */
import type { ExtractionResult, Language } from '../types';

/** Anything the media dispatch can drive: produce an ExtractionResult for one file (async). */
export interface AsyncExtractor {
  extract(): Promise<ExtractionResult>;
}

/** Inputs a media registration matches against. */
export interface MediaExtractorMatchContext {
  /** Detected language for the file (from detectLanguage). */
  language: Language;
  /** Lower-cased file extension including the dot (e.g. `.mp4`), or '' if none. */
  fileExtension: string;
}

/** A single registered media extractor: a predicate, a lane name, and an async factory. */
export interface MediaExtractorRegistration {
  /** Stable identifier, for tests/diagnostics (e.g. 'audio', 'image', 'pdf', 'video'). */
  name: string;
  /** True when this registration should handle the file. */
  match: (ctx: MediaExtractorMatchContext) => boolean;
  /** JobPool lane name this extractor runs on (e.g. 'stt', 'ocr', 'video'). */
  lane: string;
  /**
   * Build the extractor for the matched file. Returns AsyncExtractor synchronously
   * (the extractor's extract() method is async).
   * @param filePath Absolute path to the file
   * @param bytesOrPath Either the file content as Buffer, or a string path (for large/binary files)
   * @param config Relevant config from WitsOS.json (STT config, OCR config, etc.)
   * @param tmpDir Temp directory for intermediate files (keyed by jobId for cleanup)
   */
  createAsync: (
    filePath: string,
    bytesOrPath: Buffer | string,
    config: unknown,
    tmpDir: string
  ) => AsyncExtractor | Promise<AsyncExtractor>;
}

const registry: MediaExtractorRegistration[] = [];

/**
 * Register a media extractor. Order matters — registrations are evaluated
 * first-match-wins, so register more specific matchers before broader ones.
 * Idempotent on `name`: re-registering the same name replaces the prior entry
 * in place (keeps its position), so a hot-reload / double-import can't duplicate.
 */
export function registerMediaExtractor(registration: MediaExtractorRegistration): void {
  const existing = registry.findIndex((r) => r.name === registration.name);
  if (existing >= 0) {
    registry[existing] = registration;
    return;
  }
  registry.push(registration);
}

/**
 * Find the first registration matching this language/extension, or undefined to
 * signal "use the synchronous extraction path (tree-sitter)."
 */
export function resolveMediaExtractor(
  language: Language,
  fileExtension: string
): MediaExtractorRegistration | undefined {
  return registry.find((r) => r.match({ language, fileExtension }));
}

/** All media registrations in order. For tests / diagnostics. */
export function getMediaExtractorRegistrations(): readonly MediaExtractorRegistration[] {
  return registry;
}

/** Remove all media registrations. For tests only. */
export function clearMediaExtractorRegistry(): void {
  registry.length = 0;
}
