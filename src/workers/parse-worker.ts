/**
 * Parse Worker (src/workers/parse-worker.ts)
 *
 * Runs tree-sitter parsing in a separate thread so the main thread
 * stays unblocked and the UI animation renders smoothly.
 *
 * Message protocol (JobPool-compatible):
 *   init request  ← { type: 'load-grammars', languages: Language[] }
 *   init ack      → { type: 'grammars-loaded' }
 *   parse request ← { _poolId: number, type: 'parse', filePath, content, frameworkNames, language }
 *   parse success → { _poolId: number, result: ExtractionResult }
 *   parse error   → { _poolId: number, error: string }
 *   (WASM OOM)    → process.exit(1)   — pool catches via 'exit' event
 */

import { parentPort } from 'worker_threads';
import { extractFromSource } from '../extraction/tree-sitter';
import { detectLanguage, loadGrammarsForLanguages, resetParser } from '../extraction/grammars';
import type { Language, ExtractionResult } from '../types';

// Filter Emscripten abort noise from worker stderr so it doesn't
// surface as user-visible output. Real diagnostics go through console.*
// or parentPort and are unaffected.
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (
      s.startsWith('Aborted(') ||
      s.includes('Build with -sASSERTIONS for more info')
    ) {
      if (typeof encoding === 'function') encoding();
      else if (cb) cb();
      return true;
    }
    return realWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;
}

const PARSER_RESET_INTERVAL = 5000;
const parseCounts = new Map<Language, number>();

parentPort!.on('message', async (msg: {
  type: string;
  _poolId?: number;
  filePath?: string;
  content?: string;
  languages?: Language[];
  frameworkNames?: string[];
  language?: Language;
}) => {
  if (msg.type === 'load-grammars') {
    await loadGrammarsForLanguages(msg.languages!);
    parentPort!.postMessage({ type: 'grammars-loaded' });

  } else if (msg.type === 'parse') {
    const { _poolId, filePath, content, frameworkNames } = msg;
    try {
      const language = msg.language ?? detectLanguage(filePath!, content);
      const result: ExtractionResult = extractFromSource(filePath!, content!, language, frameworkNames);

      // Periodic parser reset to reclaim WASM heap memory
      const count = (parseCounts.get(language) ?? 0) + 1;
      parseCounts.set(language, count);
      if (count % PARSER_RESET_INTERVAL === 0) {
        resetParser(language);
      }

      parentPort!.postMessage({ _poolId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // WASM memory errors leave the module in a corrupted state — crash the
      // worker so the pool spawns a fresh one with a clean heap.
      if (message.includes('memory access out of bounds') || message.includes('out of memory')) {
        process.exit(1);
      }

      parentPort!.postMessage({
        _poolId,
        error: `Parse worker error: ${message}`,
      });
    }

  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' });
  }
});
