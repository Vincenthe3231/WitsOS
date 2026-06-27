/**
 * SourceAdapter — binary-safe conversion stage before extraction.
 *
 * Sits between raw file I/O and the extractor registry. Each adapter converts
 * file bytes (or UTF-8 string) into a plain text string plus metadata that
 * document extractors can use (title, page count, MIME type, headings, etc.).
 *
 * Phase 1 ships only the IdentityAdapter (UTF-8 pass-through for all source
 * code). Phase 2+ registers format-specific adapters (Markdown, CSV, Office,
 * PDF) via registerAdapter().
 *
 * Resolution is first-match-wins in registration order — register more
 * specific matchers before broader ones.
 */

/** Result of converting raw file content to indexable text. */
export interface AdapterResult {
  /** Extracted plain text, ready for extraction / chunking. */
  text: string;
  /** Arbitrary per-format metadata (title, page count, MIME, headings, …). */
  metadata: Record<string, unknown>;
}

/** Per-file adapter: converts raw content → AdapterResult. */
export interface SourceAdapter {
  /** Name, for diagnostics / tests. */
  readonly name: string;
  /** True when this adapter handles the given file path. */
  canHandle(filePath: string): boolean;
  /** Convert file content. May be async (e.g. Office unzip, PDF parse). */
  adapt(filePath: string, content: string | Buffer): AdapterResult | Promise<AdapterResult>;
}

const registry: SourceAdapter[] = [];

/**
 * Register a source adapter. Order matters — first match wins.
 * Re-registering the same name replaces in place (idempotent on name).
 */
export function registerAdapter(adapter: SourceAdapter): void {
  const idx = registry.findIndex((a) => a.name === adapter.name);
  if (idx >= 0) {
    registry[idx] = adapter;
    return;
  }
  registry.push(adapter);
}

/**
 * Find the first adapter that handles this file, or undefined (→ IdentityAdapter).
 */
export function resolveAdapter(filePath: string): SourceAdapter | undefined {
  return registry.find((a) => a.canHandle(filePath));
}

/** All registered adapters. For tests / diagnostics. */
export function getAdapterRegistrations(): readonly SourceAdapter[] {
  return registry;
}

/** Remove all adapters. For tests only. */
export function clearAdapterRegistry(): void {
  registry.length = 0;
}

/**
 * Identity adapter — UTF-8 pass-through for all source code files.
 * Used when no format-specific adapter matches. Content must already be a
 * decoded string (as produced by fsp.readFile(path, 'utf-8')).
 */
export const IdentityAdapter: SourceAdapter = {
  name: 'identity',
  canHandle: () => true,
  adapt(_filePath: string, content: string | Buffer): AdapterResult {
    return {
      text: typeof content === 'string' ? content : content.toString('utf-8'),
      metadata: {},
    };
  },
};

/**
 * Adapt a file using the registry, falling back to IdentityAdapter.
 * This is the single call site used by the extraction pipeline.
 */
export async function adaptFile(
  filePath: string,
  content: string | Buffer
): Promise<AdapterResult> {
  const adapter = resolveAdapter(filePath) ?? IdentityAdapter;
  return adapter.adapt(filePath, content);
}
