/**
 * STT worker (src/workers/stt-worker.ts)
 *
 * Runs audio transcription in a worker thread so the main thread stays
 * unblocked during heavy STT inference.
 *
 * Message protocol (JobPool-compatible):
 *   request ← { _poolId: number, type: 'stt', filePath, language, sttConfig, rootDir? }
 *   success → { _poolId: number, result: ExtractionResult }
 *   error   → { _poolId: number, error: string }
 */

import { parentPort } from 'worker_threads';
import type { ExtractionResult } from '../types';
import type { SttConfig } from '../project-config';

parentPort!.on('message', async (msg: {
  _poolId: number;
  type: string;
  filePath: string;
  language: string;
  source?: string;
  sttConfig?: SttConfig;
  rootDir?: string;
}) => {
  const { _poolId, filePath, source = '', sttConfig, rootDir } = msg;

  try {
    const { AudioExtractor } = await import('../extraction/languages/audio-extractor');
    const extractor = new AudioExtractor(filePath, source, sttConfig, rootDir);
    const result: ExtractionResult = await extractor.extract();
    parentPort!.postMessage({ _poolId, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ _poolId, error: `STT worker error: ${message}` });
  }
});
