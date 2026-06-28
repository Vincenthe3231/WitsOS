/**
 * OCR/PDF worker (src/workers/ocr-worker.ts)
 *
 * Runs image OCR and PDF text extraction in a worker thread so the main
 * thread stays unblocked during heavy ONNX inference.
 *
 * Message protocol (JobPool-compatible):
 *   request ← { _poolId: number, type: 'ocr', filePath, language, ocrConfig, rootDir? }
 *   success → { _poolId: number, result: ExtractionResult }
 *   error   → { _poolId: number, error: string }
 */

import { parentPort } from 'worker_threads';
import type { ExtractionResult } from '../types';
import type { OcrConfig } from '../project-config';

parentPort!.on('message', async (msg: {
  _poolId: number;
  type: string;
  filePath: string;
  language: string;
  source?: string;
  ocrConfig?: OcrConfig;
  rootDir?: string;
}) => {
  const { _poolId, filePath, language, source = '', ocrConfig, rootDir } = msg;

  try {
    let result: ExtractionResult;

    if (language === 'image') {
      const { ImageExtractor } = await import('../extraction/languages/image-extractor');
      const extractor = new ImageExtractor(filePath, source, ocrConfig, rootDir);
      result = await extractor.extract();
    } else if (language === 'pdf') {
      const { PdfExtractor } = await import('../extraction/languages/pdf-extractor');
      const extractor = new PdfExtractor(filePath, source);
      result = await extractor.extract();
    } else {
      // Unknown language for this worker — return empty document node
      result = {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `ocr-worker: unsupported language '${language}'`, severity: 'error' }],
        durationMs: 0,
        chunks: [],
      };
    }

    parentPort!.postMessage({ _poolId, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ _poolId, error: `OCR worker error: ${message}` });
  }
});
