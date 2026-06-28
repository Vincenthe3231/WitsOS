/**
 * Default media extractor registrations.
 *
 * Called during ExtractionOrchestrator initialization to wire up the standard
 * PDF, image, and audio extractors. Video extractor (6c) registers separately
 * when its module loads.
 *
 * NOTE: The createAsync function is RESERVED for future use when video extraction
 * can be worker-threaded. Currently, PDF/image/audio submission to workers still
 * happens through the old hardcoded payload paths in ExtractionOrchestrator.indexAll().
 * The registry currently serves as a dispatch mechanism only.
 */
import { registerMediaExtractor } from './media-extractor-registry';

/** Register the built-in media extractors. Call once during orchestrator setup. */
export function registerDefaultMediaExtractors(): void {
  // PDF text-layer extraction (Phase 4)
  registerMediaExtractor({
    name: 'pdf',
    match: ({ language }) => language === 'pdf',
    lane: 'ocr', // PDF runs on OCR lane (same worker thread)
    createAsync: (filePath, bytesOrPath) => {
      // Lazy-import to avoid requiring pdf-extractor unless actually used
      const { PdfExtractor } = require('./languages/pdf-extractor') as typeof import('./languages/pdf-extractor');
      const source = typeof bytesOrPath === 'string' ? bytesOrPath : bytesOrPath.toString('utf-8');
      return new PdfExtractor(filePath, source);
    },
  });

  // Image OCR (Phase 5)
  registerMediaExtractor({
    name: 'image',
    match: ({ language }) => language === 'image',
    lane: 'ocr',
    createAsync: (filePath, bytesOrPath, config) => {
      const { ImageExtractor } = require('./languages/image-extractor') as typeof import('./languages/image-extractor');
      const source = typeof bytesOrPath === 'string' ? bytesOrPath : bytesOrPath.toString('binary');
      // Config is passed through but not used in this direct sync path (worker path uses it)
      return new ImageExtractor(filePath, source, config as any, '');
    },
  });

  // Audio STT (Phase 6)
  registerMediaExtractor({
    name: 'audio',
    match: ({ language }) => language === 'audio',
    lane: 'stt',
    createAsync: (filePath, bytesOrPath, config) => {
      const { AudioExtractor } = require('./languages/audio-extractor') as typeof import('./languages/audio-extractor');
      const source = typeof bytesOrPath === 'string' ? bytesOrPath : bytesOrPath.toString('binary');
      // Config is passed through but not used in this direct sync path (worker path uses it)
      return new AudioExtractor(filePath, source, config as any, '');
    },
  });
}
