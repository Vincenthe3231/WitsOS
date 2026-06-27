/**
 * Extractor registry — the dispatch seam for per-language / per-format extractors.
 *
 * Historically `extractFromSource` (tree-sitter.ts) chose a custom extractor via a
 * hard-coded if/else chain. That made adding a new file type an edit to a growing
 * god-function. This registry replaces the chain with ordered registrations:
 * each one carries a `match` predicate (over the detected language + file extension)
 * and a `create` factory returning something with an `extract()` method.
 *
 * Resolution is **first-match-wins, in registration order** — so registrations must
 * be added in the same order the old if/else evaluated them. Anything that matches
 * no registration falls through to the default `TreeSitterExtractor` (kept in
 * tree-sitter.ts to avoid a circular import — this module is pure mechanism and
 * deliberately imports no concrete extractor).
 *
 * This is the extension point the universal-document-indexing work builds on: a new
 * document type (Markdown, PDF text, Office, …) becomes one `registerExtractor` call
 * plus an `EXTENSION_MAP` entry, never another branch here.
 */
import type { ExtractionResult, Language } from '../types';

/** Anything the dispatch can drive: produce an ExtractionResult for one file. */
export interface StandaloneExtractor {
  extract(): ExtractionResult;
}

/** Inputs a registration matches against. */
export interface ExtractorMatchContext {
  /** Detected language for the file (from detectLanguage). */
  language: Language;
  /** Lower-cased file extension including the dot (e.g. `.dfm`), or '' if none. */
  fileExtension: string;
}

/** A single registered extractor: a predicate plus a factory. */
export interface ExtractorRegistration {
  /** Stable identifier, for tests/diagnostics (e.g. 'svelte', 'mybatis-xml'). */
  name: string;
  /** True when this registration should handle the file. */
  match: (ctx: ExtractorMatchContext) => boolean;
  /** Build the extractor for the matched file. */
  create: (filePath: string, source: string) => StandaloneExtractor;
}

const registry: ExtractorRegistration[] = [];

/**
 * Register a custom extractor. Order matters — registrations are evaluated
 * first-match-wins, so register more specific matchers before broader ones.
 * Idempotent on `name`: re-registering the same name replaces the prior entry
 * in place (keeps its position), so a hot-reload / double-import can't duplicate.
 */
export function registerExtractor(registration: ExtractorRegistration): void {
  const existing = registry.findIndex((r) => r.name === registration.name);
  if (existing >= 0) {
    registry[existing] = registration;
    return;
  }
  registry.push(registration);
}

/**
 * Find the first registration matching this language/extension, or undefined to
 * signal "use the default tree-sitter extractor."
 */
export function resolveExtractor(
  language: Language,
  fileExtension: string
): ExtractorRegistration | undefined {
  return registry.find((r) => r.match({ language, fileExtension }));
}

/** All registrations in order. For tests / diagnostics. */
export function getExtractorRegistrations(): readonly ExtractorRegistration[] {
  return registry;
}

/** Remove all registrations. For tests only. */
export function clearExtractorRegistry(): void {
  registry.length = 0;
}
