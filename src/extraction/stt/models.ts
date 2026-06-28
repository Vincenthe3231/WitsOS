/**
 * STT model management (Phase 6).
 *
 * Models (40 MB–1.5 GB) are never bundled. Resolution order:
 *   1. Explicit `modelPath` in WitsOS.json stt block → use as-is (offline/air-gapped).
 *   2. Size keyword ("base", "small", "medium") → ~/.witsos/models/<keyword>/ or
 *      .witsos/models/<keyword>/ in project root, downloading on first use.
 *   3. Default: "base".
 *
 * Download is HTTPS with SHA-256 checksum verification. Status is surfaced
 * via `witsos status` ("model ready / downloading / missing").
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as crypto from 'crypto';

/** Known keyword → (url, sha256) for the default sherpa-onnx Whisper ONNX exports. */
const MODEL_REGISTRY: Record<string, { url: string; sha256: string; dirName: string }> = {
  // These are example entries; real checksums must be verified against the
  // official sherpa-onnx releases when sherpa-onnx is pinned to a version.
  base: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    sha256: '', // populated at pin time
    dirName: 'sherpa-onnx-whisper-base',
  },
  small: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2',
    sha256: '',
    dirName: 'sherpa-onnx-whisper-small',
  },
  medium: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-medium.tar.bz2',
    sha256: '',
    dirName: 'sherpa-onnx-whisper-medium',
  },
};

export type ModelStatus = 'ready' | 'downloading' | 'missing' | 'unknown-keyword';

export interface ModelInfo {
  status: ModelStatus;
  /** Absolute path to the model directory once resolved / ready. */
  modelDir?: string;
  /** Absolute path to the whisper encoder ONNX (int8 preferred). */
  encoder?: string;
  /** Absolute path to the whisper decoder ONNX (int8 preferred). */
  decoder?: string;
  /** Absolute path to the tokens.txt. */
  tokens?: string;
  /** Human-readable status message. */
  message: string;
}

/**
 * Locate the whisper file triple (encoder, decoder, tokens) inside a resolved
 * model directory. The sherpa-onnx whisper tar bundles BOTH fp32 and int8
 * exports (e.g. `base-encoder.onnx` + `base-encoder.int8.onnx`); we prefer the
 * int8 variant for speed and smaller WASM-heap footprint, falling back to fp32.
 * Returns `null` when a required file is absent.
 */
export function locateWhisperFiles(
  dir: string,
): { encoder: string; decoder: string; tokens: string } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const pick = (kind: 'encoder' | 'decoder'): string | undefined => {
    const matches = entries.filter((f) => f.includes(kind) && f.endsWith('.onnx'));
    const int8 = matches.find((f) => f.includes('.int8.'));
    return int8 ?? matches[0];
  };

  const encoder = pick('encoder');
  const decoder = pick('decoder');
  const tokens = entries.find((f) => f.endsWith('tokens.txt')) ?? entries.find((f) => f === 'tokens.txt');

  if (!encoder || !decoder || !tokens) return null;
  return {
    encoder: path.join(dir, encoder),
    decoder: path.join(dir, decoder),
    tokens: path.join(dir, tokens),
  };
}

/**
 * Resolve the model directory for a given keyword or explicit path.
 * Returns `{ status, modelDir?, message }` — callers surface `message`
 * in `witsos status` and in the AudioExtractor warn path.
 */
export async function resolveModel(
  keywordOrPath: string,
  projectRoot?: string,
): Promise<ModelInfo> {
  // Explicit path: use it directly if it exists.
  if (path.isAbsolute(keywordOrPath) || keywordOrPath.startsWith('.')) {
    const dir = path.resolve(projectRoot ?? process.cwd(), keywordOrPath);
    if (fs.existsSync(dir)) {
      const files = locateWhisperFiles(dir);
      if (!files) {
        return { status: 'missing', message: `Model dir found but no whisper encoder/decoder/tokens in ${dir}` };
      }
      return { status: 'ready', modelDir: dir, ...files, message: `Model at ${dir}` };
    }
    return { status: 'missing', message: `Model path not found: ${dir}` };
  }

  const entry = MODEL_REGISTRY[keywordOrPath];
  if (!entry) {
    return {
      status: 'unknown-keyword',
      message: `Unknown model keyword '${keywordOrPath}'. Valid: ${Object.keys(MODEL_REGISTRY).join(', ')}`,
    };
  }

  // Search: project-local first, then user home cache.
  const candidates = [
    ...(projectRoot ? [path.join(projectRoot, '.witsos', 'models', entry.dirName)] : []),
    path.join(os.homedir(), '.witsos', 'models', entry.dirName),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const files = locateWhisperFiles(dir);
      if (files) {
        return { status: 'ready', modelDir: dir, ...files, message: `Model ready at ${dir}` };
      }
    }
  }

  // Not found — attempt download to home cache.
  const targetDir = path.join(os.homedir(), '.witsos', 'models', entry.dirName);
  const archivePath = targetDir + '.tar.bz2';

  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    await downloadFile(entry.url, archivePath);
    if (entry.sha256) {
      await verifyChecksum(archivePath, entry.sha256);
    }
    await extractTarBz2(archivePath, path.dirname(targetDir));
    fs.unlinkSync(archivePath);

    if (fs.existsSync(targetDir)) {
      const files = locateWhisperFiles(targetDir);
      if (!files) {
        return { status: 'missing', message: `Model downloaded but no whisper encoder/decoder/tokens in ${targetDir}` };
      }
      return { status: 'ready', modelDir: targetDir, ...files, message: `Model downloaded to ${targetDir}` };
    }
    return { status: 'missing', message: `Model archive extracted but directory not found: ${targetDir}` };
  } catch (err) {
    return {
      status: 'missing',
      message: `Failed to download model '${keywordOrPath}': ${err instanceof Error ? err.message : String(err)}. Install manually or set stt.modelPath.`,
    };
  }
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} downloading model`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err);
    });
  });
}

function verifyChecksum(filePath: string, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      if (actual !== expected) {
        reject(new Error(`Checksum mismatch: expected ${expected}, got ${actual}`));
      } else {
        resolve();
      }
    });
    stream.on('error', reject);
  });
}

async function extractTarBz2(archivePath: string, destDir: string): Promise<void> {
  const { spawn } = await import('child_process');
  // Run from the archive's directory and pass only the basename, so GNU tar
  // does not mis-parse a Windows path like `C:\...` as an `rmt` host:path
  // ("Cannot connect to C: resolve failed"). Works for bsdtar too.
  const cwd = path.dirname(archivePath);
  const archiveName = path.basename(archivePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archiveName, '-C', destDir], { stdio: 'inherit', cwd });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
    child.on('error', reject);
  });
}
