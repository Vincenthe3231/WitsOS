/**
 * Interactive capability opt-in prompt (Phase 6).
 *
 * After a scan finds eligible files (audio for STT, image for OCR), if the
 * capability is unset in WitsOS.json AND process.stdout.isTTY, offer to enable
 * it. The user's choice is persisted so the prompt is one-time per project.
 *
 * Hard gates — NEVER prompts when:
 *   - MCP daemon (`serve --mcp`) / CI / non-TTY / `--no-prompt`
 *   - `WitsOS.json` already has the capability set (either enabled or disabled)
 *   - `prompts: false` in WitsOS.json
 */

import * as readline from 'readline';
import { writeProjectConfig } from '../project-config';

export interface CapabilityPromptContext {
  rootDir: string;
  /** Is the current session a non-interactive context (MCP/CI/piped)? */
  nonInteractive?: boolean;
  /** --no-prompt CLI flag. */
  noPrompt?: boolean;
}

export interface CapabilityStatus {
  /** How many audio files were found (0 = skip the STT prompt). */
  audioFileCount: number;
  /** How many image files were found (0 = skip the OCR prompt). */
  imageFileCount: number;
  /** Whether `stt.enabled` is already set in WitsOS.json (true OR false). */
  sttAlreadySet: boolean;
  /** Whether `ocr.enabled` is already set in WitsOS.json (true OR false). */
  ocrAlreadySet: boolean;
}

/**
 * Check whether to prompt, and if so, ask the user about each unset capability.
 * Returns true if any capability was enabled (so the caller can re-index).
 */
export async function maybePromptCapabilities(
  status: CapabilityStatus,
  ctx: CapabilityPromptContext,
): Promise<boolean> {
  if (ctx.nonInteractive || ctx.noPrompt) return false;
  if (!process.stdout.isTTY) return false;

  let anyEnabled = false;

  if (status.audioFileCount > 0 && !status.sttAlreadySet) {
    const enabled = await promptCapability({
      name: 'speech-to-text',
      count: status.audioFileCount,
      unit: 'audio file',
      deps: 'sherpa-onnx + ffmpeg-static (~80 MB) + model (~150 MB)',
      benefit: 'Transcripts become searchable in your knowledge base.',
      installCmd: 'pnpm add sherpa-onnx ffmpeg-static',
    });
    writeProjectConfig(ctx.rootDir, { stt: { enabled } } as any);
    if (enabled) anyEnabled = true;
  }

  if (status.imageFileCount > 0 && !status.ocrAlreadySet) {
    const enabled = await promptCapability({
      name: 'OCR (image text recognition)',
      count: status.imageFileCount,
      unit: 'image file',
      deps: '@gutenye/ocr-node (~40 MB)',
      benefit: 'Recognized text becomes searchable in your knowledge base.',
      installCmd: 'pnpm add @gutenye/ocr-node',
    });
    writeProjectConfig(ctx.rootDir, { ocr: { enabled } } as any);
    if (enabled) anyEnabled = true;
  }

  return anyEnabled;
}

interface PromptOpts {
  name: string;
  count: number;
  unit: string;
  deps: string;
  benefit: string;
  installCmd: string;
}

async function promptCapability(opts: PromptOpts): Promise<boolean> {
  const unit = opts.count === 1 ? opts.unit : opts.unit + 's';
  process.stdout.write(
    `\nFound ${opts.count} ${unit}. Enable ${opts.name}?\n` +
    `  This installs ${opts.deps}.\n` +
    `  ${opts.benefit}\n` +
    `  [y/N] `,
  );

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once('line', (line) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        process.stdout.write(
          `\nEnabled! Run: ${opts.installCmd}\n` +
          `(If already installed, re-run witsos index to process these files.)\n`,
        );
        resolve(true);
      } else {
        process.stdout.write('\nSkipped. Setting remembered — you won\'t be asked again.\n');
        resolve(false);
      }
    });
    // Handle Ctrl-D / stream end → default No.
    rl.once('close', () => resolve(false));
  });
}
