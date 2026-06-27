/**
 * Text chunker — splits plain text into overlapping fixed-size chunks.
 *
 * Used by document extractors (Markdown, plain text, Office, PDF) to break
 * large prose into indexable units stored in the `chunks` table. Each chunk
 * carries its byte offsets so callers can reconstruct context or display
 * surrounding text.
 *
 * Splitting strategy: split at paragraph boundaries (double-newline) when
 * possible; fall back to whitespace; last resort: hard cut. This keeps
 * sentences intact in the common case.
 */

export interface Chunk {
  /** Zero-based position within the file. */
  index: number;
  /** Inclusive start character offset in the original text. */
  charStart: number;
  /** Exclusive end character offset in the original text. */
  charEnd: number;
  /** The chunk's text content. */
  body: string;
}

const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP = 150;

/**
 * Split `text` into overlapping chunks.
 *
 * @param text         Full text to chunk.
 * @param maxChunkChars Max characters per chunk (default 1500).
 * @param overlap       Characters of overlap between consecutive chunks (default 150).
 */
export function chunkText(
  text: string,
  maxChunkChars = DEFAULT_MAX_CHARS,
  overlap = DEFAULT_OVERLAP
): Chunk[] {
  if (!text) return [];

  const chunks: Chunk[] = [];
  let pos = 0;
  let index = 0;

  while (pos < text.length) {
    const rawEnd = Math.min(pos + maxChunkChars, text.length);

    // Try to split at a paragraph boundary within the window.
    let end = rawEnd;
    if (rawEnd < text.length) {
      const paraBreak = text.lastIndexOf('\n\n', rawEnd);
      if (paraBreak > pos) {
        end = paraBreak + 2; // include the double-newline in the previous chunk
      } else {
        // Fall back to last whitespace boundary.
        const wsBreak = text.lastIndexOf(' ', rawEnd);
        if (wsBreak > pos) {
          end = wsBreak + 1;
        }
        // else: hard cut at rawEnd
      }
    }

    const body = text.slice(pos, end);
    if (body.trim()) {
      chunks.push({ index, charStart: pos, charEnd: end, body });
      index++;
    }

    // If we reached the end of text, stop.
    if (end >= text.length) break;

    // Advance by (chunk size − overlap), but at least 1 to avoid infinite loop.
    const advance = Math.max(1, end - pos - overlap);
    pos += advance;
  }

  return chunks;
}

/**
 * Generate a stable chunk ID from file path + chunk index.
 * Matches the pattern used for node IDs elsewhere in the codebase.
 */
export function chunkId(filePath: string, chunkIndex: number): string {
  // Simple deterministic string — no crypto dep needed here.
  return `chunk:${filePath}:${chunkIndex}`;
}
