/**
 * FFmpeg wrapper for audio decode (Phase 6).
 *
 * Converts arbitrary audio (mp3/m4a/aac/flac/ogg/opus/wav/wma) to
 * 16 kHz mono PCM (f32le, samples in [-1,1]) — the format sherpa-onnx's
 * offline recognizer accepts directly via a Float32Array view (no per-sample
 * conversion).
 *
 * FFmpeg binary resolution order:
 *   1. `ffmpegPath` override from WitsOS.json stt block.
 *   2. `ffmpeg-static` optional package (user-pulled, GPL-3.0, never bundled).
 *   3. System `ffmpeg` on PATH.
 *   Returns `null` when no binary is found.
 *
 * Security flags: `-nostdin`, `-protocol_whitelist file`, no network,
 * per-file timeout, killable child process.
 */

import { spawn } from 'child_process';

/** Probe result from ffprobe. */
export interface AudioProbe {
  /** Duration in seconds, or 0 if unknown. */
  durationSecs: number;
  /** Detected codec name (e.g. "mp3", "aac"). */
  codec: string;
}

/**
 * Locate an ffmpeg binary. Returns the path or `null` when absent.
 * `ffmpegPathOverride` comes from `stt.ffmpegPath` in WitsOS.json.
 */
export async function locateFfmpeg(ffmpegPathOverride?: string): Promise<string | null> {
  if (ffmpegPathOverride) {
    const fs = await import('fs');
    if (fs.existsSync(ffmpegPathOverride)) return ffmpegPathOverride;
    return null;
  }

  // Try ffmpeg-static (optional, user-pulled, GPL-3.0).
  try {
    const mod: any = await import('ffmpeg-static' as string);
    const p = mod.default ?? mod;
    if (p && typeof p === 'string') {
      // pnpm store symlinks are not resolvable by spawn() on Windows — resolve to real path.
      const { realpathSync } = await import('fs');
      try { return realpathSync(p); } catch { return p; }
    }
  } catch { /* not installed */ }

  // Fall back to system ffmpeg on PATH.
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    await promisify(execFile)('ffmpeg', ['-version'], { timeout: 3000 });
    return 'ffmpeg';
  } catch { /* not found */ }

  return null;
}

/**
 * Decode an audio file to 16 kHz mono PCM (f32le) using FFmpeg.
 * Returns a Buffer of raw 32-bit float samples, or throws on decode failure.
 *
 * @param filePath  Absolute path to the audio file.
 * @param ffmpegBin Resolved FFmpeg binary path.
 * @param timeoutMs Per-file decode timeout in ms. Default 120_000.
 */
export function decodeAudioToPcm(
  filePath: string,
  ffmpegBin: string,
  timeoutMs = 120_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin',
      '-protocol_whitelist', 'file',
      '-i', filePath,
      '-ar', '16000',   // 16 kHz
      '-ac', '1',       // mono
      '-f', 'f32le',    // 32-bit float little-endian PCM, samples in [-1,1]
      '-',              // pipe to stdout
    ];

    const child = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`FFmpeg timed out after ${timeoutMs}ms decoding ${filePath}`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`FFmpeg exited ${code} decoding ${filePath}: ${stderr.slice(-200)}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

/**
 * Probe an audio file for duration and codec via ffprobe.
 * Falls back gracefully — returns `{ durationSecs: 0, codec: '' }` on failure.
 */
export async function probeAudio(filePath: string, ffmpegBin: string): Promise<AudioProbe> {
  const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { stdout } = await promisify(execFile)(
      ffprobeBin,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { timeout: 10_000 },
    );

    const info = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_name?: string; codec_type?: string }>;
    };

    const durationSecs = parseFloat(info.format?.duration ?? '0') || 0;
    const audioStream = info.streams?.find((s) => s.codec_type === 'audio');
    const codec = audioStream?.codec_name ?? '';

    return { durationSecs, codec };
  } catch {
    return { durationSecs: 0, codec: '' };
  }
}
