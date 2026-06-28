/**
 * Audio extractor (.mp3/.wav/.m4a/etc.) — Phase 6 (STT).
 *
 * Transcribes opt-in audio and produces:
 *   - 1 `document` node (whole file)
 *   - `section` nodes per transcript segment (sentence / VAD window)
 *   - prose chunks with `{ start, end, speaker?, sttEngine, sttModel }` metadata
 *     so search can deep-link to a timestamp ("jump to 03:12")
 *
 * Gating (mirrors ImageExtractor / no-partial-coverage rule):
 *   - STT disabled → document-only, zero chunks.
 *   - STT enabled but `sherpa-onnx` or ffmpeg missing → document-only + warn.
 *   - STT enabled + backend + ffmpeg → segments become chunks in `chunks_fts`.
 *
 * Binary file: re-read from disk (orchestrator passes UTF-8 which corrupts audio).
 */
import * as path from 'path';
import * as crypto from 'crypto';
import { ExtractionResult, Node, Edge, ChunkRecord } from '../../types';
import { StandaloneExtractor } from '../extractor-registry';
import { chunkText, chunkId } from '../chunker';
import { loadSttBackend } from '../stt/backend';
import { locateFfmpeg, decodeAudioToPcm, probeAudio } from '../audio/ffmpeg';
import { logWarn } from '../../errors';
import type { SttConfig } from '../../project-config';

function makeNodeId(filePath: string, kind: string, name: string, line: number): string {
  return `${kind}:${crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32)}`;
}

export class AudioExtractor implements StandaloneExtractor {
  constructor(
    private readonly filePath: string,
    // source is ignored — binary file decoded via ffmpeg
    _source: string,
    private readonly stt?: SttConfig,
    private readonly rootDir?: string,
  ) {}

  extract(): Promise<ExtractionResult> {
    return this._extract();
  }

  private async _extract(): Promise<ExtractionResult> {
    const start = Date.now();
    const name = path.basename(this.filePath);
    const now = Date.now();

    const docNode: Node = {
      id: makeNodeId(this.filePath, 'document', name, 1),
      kind: 'document',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'audio',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: now,
    };

    const documentOnly = (): ExtractionResult => ({
      nodes: [docNode],
      edges: [],
      unresolvedReferences: [],
      errors: [],
      durationMs: Date.now() - start,
      chunks: [],
    });

    if (!this.stt?.enabled) return documentOnly();

    const backend = await loadSttBackend();
    if (!backend) {
      logWarn(
        'STT is enabled in WitsOS.json but sherpa-onnx is not installed — indexing audio as document-only. Run: pnpm add sherpa-onnx ffmpeg-static',
        { filePath: this.filePath },
      );
      return documentOnly();
    }

    const ffmpegBin = await locateFfmpeg(this.stt.ffmpegPath ?? undefined);
    if (!ffmpegBin) {
      logWarn(
        'STT is enabled but ffmpeg is not available — indexing audio as document-only. Run: pnpm add ffmpeg-static',
        { filePath: this.filePath },
      );
      return documentOnly();
    }

    const absPath = this.rootDir && !path.isAbsolute(this.filePath)
      ? path.join(this.rootDir, this.filePath)
      : this.filePath;

    // Probe for duration so we can scale the STT timeout.
    const probe = await probeAudio(absPath, ffmpegBin);
    const decodeTimeoutMs = Math.max(120_000, (probe.durationSecs || 60) * 2 * 1000);

    let pcm: Buffer;
    try {
      pcm = await decodeAudioToPcm(absPath, ffmpegBin, decodeTimeoutMs);
    } catch (err) {
      logWarn(
        `FFmpeg decode failed for audio — indexing as document-only: ${err instanceof Error ? err.message : String(err)}`,
        { filePath: this.filePath },
      );
      return documentOnly();
    }

    const sttResult = await (async () => {
      try {
        return await backend.transcribe(pcm, {
          language: this.stt!.language ?? 'auto',
          model: this.stt!.model ?? 'base',
          diarize: this.stt!.diarize,
          minConfidence: this.stt!.minConfidence,
          rootDir: this.rootDir,
        });
      } catch (err) {
        logWarn(
          `STT transcription failed — indexing audio as document-only: ${err instanceof Error ? err.message : String(err)}`,
          { filePath: this.filePath },
        );
        return null;
      }
    })();

    if (!sttResult || sttResult.segments.length === 0) return documentOnly();

    const minConf = this.stt!.minConfidence ?? 0;
    const goodSegments = sttResult.segments.filter(
      (s) => s.text.trim() && s.confidence >= minConf,
    );
    if (goodSegments.length === 0) return documentOnly();

    docNode.docstring = `STT (${sttResult.engine} · ${sttResult.model})`;

    const nodes: Node[] = [docNode];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    let chunkOffset = 0;

    // Build one "full transcript" text and chunk it, then attach timing metadata
    // to each chunk by matching chunk boundaries back to segments.
    const fullText = goodSegments.map((s) => s.text.trim()).join('\n');

    for (const c of chunkText(fullText)) {
      // Find which segments overlap this chunk's character range.
      let charPos = 0;
      let segStart = 0;
      let segEnd = 0;
      let speaker: string | undefined;
      for (const seg of goodSegments) {
        const segText = seg.text.trim() + '\n';
        if (charPos + segText.length > c.charStart && charPos <= c.charEnd) {
          if (segStart === 0) segStart = seg.start;
          segEnd = seg.end;
          if (!speaker && seg.speaker) speaker = seg.speaker;
        }
        charPos += segText.length;
      }

      const firstLine = (c.body.split('\n')[0] ?? '').trim();
      const heading = firstLine.length <= 60 ? firstLine : firstLine.slice(0, 57).trimEnd() + '…';
      const timeLabel = `${formatTime(segStart)}–${formatTime(segEnd)}`;

      const sectionNode: Node = {
        id: makeNodeId(this.filePath, 'section', timeLabel, chunkOffset + 1),
        kind: 'section',
        name: timeLabel,
        qualifiedName: `${this.filePath}#${timeLabel}`,
        filePath: this.filePath,
        language: 'audio',
        startLine: chunkOffset + 1,
        endLine: chunkOffset + 1,
        startColumn: 0,
        endColumn: 0,
        docstring: c.body.length > 200 ? c.body.slice(0, 200) + '…' : c.body,
        isExported: false,
        updatedAt: now,
      };

      nodes.push(sectionNode);
      edges.push({ source: docNode.id, target: sectionNode.id, kind: 'contains' });

      chunks.push({
        id: chunkId(this.filePath, chunkOffset++),
        filePath: this.filePath,
        nodeId: sectionNode.id,
        chunkIndex: c.index,
        charStart: c.charStart,
        charEnd: c.charEnd,
        body: heading + '\n' + c.body,
        metadata: {
          title: name,
          start: segStart,
          end: segEnd,
          speaker,
          sttEngine: sttResult.engine,
          sttModel: sttResult.model,
        },
        updatedAt: now,
      });
    }

    return {
      nodes,
      edges,
      unresolvedReferences: [],
      errors: [],
      durationMs: Date.now() - start,
      chunks,
    };
  }
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
