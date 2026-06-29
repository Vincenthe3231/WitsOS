/**
 * Video file extractor (Phase 6c-1 & 6c-2: subtitles + metadata + audio-track STT).
 *
 * Extracts:
 * - Metadata via ffprobe (duration, resolution, codec, streams)
 * - Subtitle tracks (embedded via ffmpeg demux, or sidecar .srt/.vtt files) — 6c-1
 * - Audio track transcription via STT — 6c-2
 * - Document + section nodes with timing metadata and chunk emission
 *
 * Degrades gracefully: no ffprobe → document-only, no subtitles → document-only,
 * no audio or STT disabled → skip audio extraction.
 */

import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { locateFfmpeg } from '../audio/ffmpeg';
import { AudioExtractor } from './audio-extractor';
import { parseSubtitles } from '../subtitles/srt-parser';
import { chunkId } from '../chunker';
import { TempFileMgr } from '../util/tempfiles';
import type { ExtractionResult, Node, Edge, ChunkRecord } from '../../types';
import type { SttConfig } from '../../project-config';
import { logWarn } from '../../errors';

/**
 * Spawn a child process and capture output.
 */
function execAsync(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command exited with code ${code}: ${stderr}`));
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function makeNodeId(filePath: string, kind: string, name: string, line: number): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${filePath}:${hash}`;
}

export class VideoExtractor {
  private filePath: string;

  constructor(
    filePath: string,
    _fileContent: string,
    private readonly stt?: SttConfig,
    private readonly rootDir?: string,
  ) {
    this.filePath = filePath;
  }

  async extract(): Promise<ExtractionResult> {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    const errors: any[] = [];
    const now = Date.now();
    let chunkOffset = 0;

    try {
      // Probe video metadata
      const metadata = await this.probeMetadata();
      if (!metadata) {
        // ffprobe failed; degrade to document-only
        const docNode = this.makeDocumentNode();
        nodes.push(docNode);
        return { nodes, edges, chunks, unresolvedReferences: [], durationMs: 0, errors };
      }

      // Create document node
      const docNode = this.makeDocumentNode(metadata);
      nodes.push(docNode);

      // Emit metadata chunk
      const metaBody = this.formatMetadata(metadata);
      chunks.push({
        id: chunkId(this.filePath, chunkOffset++),
        filePath: this.filePath,
        nodeId: docNode.id,
        chunkIndex: 0,
        charStart: 0,
        charEnd: metaBody.length,
        body: metaBody,
        metadata: {
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          codec: metadata.videoCodec,
          source: 'metadata',
        },
        updatedAt: now,
      });

      // Try to extract subtitles (6c-1)
      const subtitleResult = await this.extractSubtitles(chunkOffset);
      if (subtitleResult) {
        nodes.push(...subtitleResult.nodes);
        edges.push(...subtitleResult.edges);
        chunks.push(...subtitleResult.chunks);
        chunkOffset = subtitleResult.nextChunkOffset;
      }

      // Try to extract audio track for STT (6c-2)
      const audioResult = await this.extractAudio(chunkOffset, metadata);
      if (audioResult) {
        nodes.push(...audioResult.nodes);
        edges.push(...audioResult.edges);
        chunks.push(...audioResult.chunks);
        chunkOffset = audioResult.nextChunkOffset;
      }

      return { nodes, edges, chunks, unresolvedReferences: [], durationMs: 0, errors };
    } catch (err) {
      logWarn(`VideoExtractor.extract failed`, {
        filePath: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return document-only on error
      const docNode = this.makeDocumentNode();
      nodes.push(docNode);
      return { nodes, edges, chunks, unresolvedReferences: [], durationMs: 0, errors };
    }
  }

  private async probeMetadata(): Promise<{
    duration: number;
    width: number;
    height: number;
    videoCodec: string;
  } | null> {
    try {
      const ffmpegBin = await locateFfmpeg();
      if (!ffmpegBin) return null;

      // Derive ffprobe path from ffmpeg path.
      // ffmpeg-static only bundles ffmpeg, not ffprobe — fall back to system ffprobe.
      const derivedFfprobe = ffmpegBin === 'ffmpeg'
        ? 'ffprobe'
        : ffmpegBin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      const ffprobeExists = await import('fs').then(({ existsSync }) =>
        derivedFfprobe === 'ffprobe' || existsSync(derivedFfprobe)
      );
      const ffprobeBin = ffprobeExists ? derivedFfprobe : 'ffprobe';

      const output = await execAsync(ffprobeBin, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=width,height,codec_name,codec_type',
        '-of', 'csv=p=0',
        this.filePath,
      ], 10_000);

      const lines = output.trim().split('\n');
      if (lines.length === 0) return null;

      const duration = parseFloat(lines[0]!) || 0;
      if (duration <= 0) return null;

      let width = 0, height = 0, videoCodec = 'unknown';
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i]!.split(',');
        if (parts.length >= 4) {
          const w = parseInt(parts[0]!, 10);
          const h = parseInt(parts[1]!, 10);
          const codec = parts[2]!.trim();
          const type = parts[3]!.trim();

          if (type === 'video' && w > 0 && h > 0) {
            width = w;
            height = h;
            videoCodec = codec;
            break;
          }
        }
      }

      return { duration, width, height, videoCodec };
    } catch (err) {
      logWarn(`VideoExtractor.probeMetadata failed`, {
        filePath: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async extractSubtitles(
    startChunkOffset: number
  ): Promise<{ nodes: Node[]; edges: Edge[]; chunks: ChunkRecord[]; nextChunkOffset: number } | null> {
    // Try sidecar first
    const sidecarResult = await this.tryLoadSidecarSubtitles(startChunkOffset);
    if (sidecarResult) return sidecarResult;

    // Try embedded
    const embeddedResult = await this.tryDemuxEmbeddedSubtitles(startChunkOffset);
    if (embeddedResult) return embeddedResult;

    return null;
  }

  private async tryLoadSidecarSubtitles(
    startChunkOffset: number
  ): Promise<{ nodes: Node[]; edges: Edge[]; chunks: ChunkRecord[]; nextChunkOffset: number } | null> {
    const dir = path.dirname(this.filePath);
    const basename = path.basename(this.filePath, path.extname(this.filePath));

    for (const name of [`${basename}.srt`, `${basename}.vtt`]) {
      const sidecarPath = path.join(dir, name);
      try {
        if (!fs.existsSync(sidecarPath)) continue;
        const content = await fsp.readFile(sidecarPath, 'utf-8');
        const cues = parseSubtitles(content);
        if (cues.length === 0) continue;

        return this.makeSectionNodesAndChunks(cues, name, 'sidecar', startChunkOffset);
      } catch {
        continue;
      }
    }
    return null;
  }

  private async tryDemuxEmbeddedSubtitles(
    startChunkOffset: number
  ): Promise<{ nodes: Node[]; edges: Edge[]; chunks: ChunkRecord[]; nextChunkOffset: number } | null> {
    try {
      const ffmpegBin = await locateFfmpeg();
      if (!ffmpegBin) return null;

      const vttContent = await execAsync(ffmpegBin, [
        '-v', 'error',
        '-i', this.filePath,
        '-map', 's:0',
        '-f', 'webvtt',
        'pipe:1',
      ], 30_000);

      if (!vttContent || vttContent.trim().length === 0) return null;

      const cues = parseSubtitles(vttContent);
      if (cues.length === 0) return null;

      return this.makeSectionNodesAndChunks(cues, 'embedded', 'subtitle', startChunkOffset);
    } catch {
      return null;
    }
  }

  private makeSectionNodesAndChunks(
    cues: ReturnType<typeof parseSubtitles>,
    source: string,
    sourceType: 'sidecar' | 'subtitle',
    startChunkOffset: number
  ): { nodes: Node[]; edges: Edge[]; chunks: ChunkRecord[]; nextChunkOffset: number } {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const chunks: ChunkRecord[] = [];
    const now = Date.now();

    const docId = makeNodeId(this.filePath, 'document', path.basename(this.filePath), 1);
    let chunkOffset = startChunkOffset;

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i]!;
      const sectionId = makeNodeId(this.filePath, 'section', `${i}`, i + 1);

      const sectionNode: Node = {
        id: sectionId,
        name: cue.id || `cue-${i}`,
        kind: 'section',
        language: 'plaintext',
        filePath: this.filePath,
        qualifiedName: `${path.basename(this.filePath)}#${cue.id || i}`,
        signature: '',
        docstring: cue.text,
        startLine: i,
        endLine: i,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: now,
      };
      nodes.push(sectionNode);

      edges.push({
        source: docId,
        target: sectionId,
        kind: 'contains',
        provenance: 'heuristic',
      });

      chunks.push({
        id: chunkId(this.filePath, chunkOffset++),
        filePath: this.filePath,
        nodeId: sectionId,
        chunkIndex: i,
        charStart: 0,
        charEnd: cue.text.length,
        body: cue.text,
        metadata: {
          start: cue.start,
          end: cue.end,
          track: path.basename(source),
          source: sourceType,
        },
        updatedAt: now,
      });
    }

    return { nodes, edges, chunks, nextChunkOffset: chunkOffset };
  }

  private makeDocumentNode(metadata?: any): Node {
    const name = path.basename(this.filePath);
    const docstring = metadata
      ? `Video: ${metadata.width}×${metadata.height} ${metadata.videoCodec} (${Math.round(metadata.duration)}s)`
      : 'Video file';

    return {
      id: makeNodeId(this.filePath, 'document', name, 1),
      name,
      kind: 'document',
      language: 'video',
      filePath: this.filePath,
      qualifiedName: this.filePath,
      signature: '',
      docstring,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: Date.now(),
    };
  }

  private formatMetadata(metadata: any): string {
    return [
      `Duration: ${Math.round(metadata.duration)}s`,
      `Resolution: ${metadata.width}×${metadata.height}`,
      `Video Codec: ${metadata.videoCodec}`,
    ].join('\n');
  }

  private async extractAudio(
    startChunkOffset: number,
    metadata: { duration: number; width: number; height: number; videoCodec: string },
  ): Promise<{ nodes: Node[]; edges: Edge[]; chunks: ChunkRecord[]; nextChunkOffset: number } | null> {
    // Skip if STT is disabled
    if (!this.stt?.enabled) return null;

    // Skip if video exceeds max duration cap
    if (metadata.duration > this.stt.maxDurationSecs) {
      logWarn(`VideoExtractor: video duration ${Math.round(metadata.duration)}s exceeds maxDurationSecs ${this.stt.maxDurationSecs}s, skipping audio transcription`, {
        filePath: this.filePath,
      });
      return null;
    }

    const jobId = `video-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      // Demux audio to temp WAV file
      const tempWav = await this.demuxAudio(jobId);
      if (!tempWav) return null;

      try {
        // Delegate to AudioExtractor
        const audioExtractor = new AudioExtractor(tempWav, '', this.stt, this.rootDir);
        const audioResult = await audioExtractor.extract();

        // Rewrite result nodes/chunks to reference original video file, not temp WAV
        // Skip document node (already emitted for video), keep only section nodes
        const audioSections = audioResult.nodes?.filter((n) => n.kind === 'section') ?? [];
        const audioSectionIds = new Set(audioSections.map((n) => n.id));

        const rewrittenNodes = audioSections.map((node) => ({
          ...node,
          filePath: this.filePath,
        }));
        const rewrittenEdges = (audioResult.edges ?? []).filter((e) => audioSectionIds.has(e.target));
        const rewrittenChunks = (audioResult.chunks ?? []).map((chunk) => ({
          ...chunk,
          filePath: this.filePath,
        }));

        if (rewrittenNodes.length === 0) return null;

        return {
          nodes: rewrittenNodes,
          edges: rewrittenEdges,
          chunks: rewrittenChunks,
          nextChunkOffset: startChunkOffset + rewrittenChunks.length,
        };
      } finally {
        // Clean up temp WAV
        TempFileMgr.cleanup(jobId);
      }
    } catch (err) {
      logWarn(`VideoExtractor.extractAudio failed`, {
        filePath: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async demuxAudio(jobId: string): Promise<string | null> {
    try {
      const ffmpegBin = await locateFfmpeg(this.stt?.ffmpegPath ?? undefined);
      if (!ffmpegBin) return null;

      // Allocate temp directory
      const tempDir = TempFileMgr.allocateJobDir(jobId, this.rootDir || process.cwd());
      const outputWav = path.join(tempDir, 'audio.wav');

      // Demux first audio stream to WAV (16 kHz mono, format expected by AudioExtractor)
      await execAsync(ffmpegBin, [
        '-v', 'error',
        '-i', this.filePath,
        '-map', 'a:0',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        outputWav,
      ], 60_000);

      // Verify output file exists and has content
      if (!fs.existsSync(outputWav)) return null;
      const stats = fs.statSync(outputWav);
      if (stats.size < 44) return null; // WAV header is 44 bytes; must have some audio

      return outputWav;
    } catch (err) {
      logWarn(`VideoExtractor.demuxAudio failed`, {
        filePath: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
