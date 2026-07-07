/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG-style on EVERY platform, Windows included — see below) or
 *     `./opencode.jsonc` (local). Falls back to `opencode.json` when a
 *     `.json` file already exists; defaults new installs to `.jsonc`
 *     because that's what opencode itself creates on first run.
 *
 *     opencode resolves its config dir with the `xdg-basedir` package
 *     (sst/opencode `packages/core/src/global.ts`): `XDG_CONFIG_HOME`
 *     if set, else `~/.config` — unconditionally, on all platforms. It
 *     never reads `%APPDATA%`; that layout belonged to the discontinued
 *     Go fork. We previously wrote there on Windows, so opencode never
 *     saw the entry (#535) — install/uninstall now also sweep a stale
 *     WitsOS entry out of the legacy `%APPDATA%/opencode` location.
 *   - Instructions to `~/.config/opencode/AGENTS.md` (global) or
 *     `./AGENTS.md` (local). opencode reads AGENTS.md for agent
 *     instructions — same convention Codex CLI uses.
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "WitsOS": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * The shape differs from Claude/Cursor — opencode uses `mcp.<name>`
 * (not `mcpServers`), takes `command` as a string array combining
 * binary + args, and includes an explicit `enabled` flag.
 *
 * Reads + writes go through `jsonc-parser` so any `//` and `/* *\/`
 * comments the user has added to their `.jsonc` survive idempotent
 * re-runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  jsonDeepEqual,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  WitsOS_SECTION_END,
  WitsOS_SECTION_START,
} from '../instructions-template';

function globalConfigDir(): string {
  // XDG_CONFIG_HOME if set, else ~/.config — on every platform, matching
  // opencode's own `xdg-basedir` resolution (no Windows special case; #535).
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
}

/**
 * Pre-#535 installs wrote the global entry to `%APPDATA%/opencode` — a dir
 * today's opencode never reads. Returns that legacy dir when it could hold
 * stale state (APPDATA set and resolving somewhere other than the real config
 * dir). Gated on the env var rather than `process.platform` so the cleanup
 * logic runs under the cross-platform test suite; on POSIX, APPDATA is unset
 * in real life and this is a no-op.
 */
function legacyWindowsConfigDir(): string | null {
  const appData = process.env.APPDATA;
  if (!appData || !appData.trim()) return null;
  const legacy = path.join(appData, 'opencode');
  return path.resolve(legacy) === path.resolve(globalConfigDir()) ? null : legacy;
}

function configBaseDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : process.cwd();
}

// Pick existing .jsonc, then .json, default to .jsonc for new files.
// opencode auto-creates .jsonc on first run, so that's the dominant
// real-world case and the sensible default for greenfield installs.
function configPath(loc: Location): string {
  const dir = configBaseDir(loc);
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc;
}

function instructionsPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: any[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, any>;
}

function getOpencodeServerEntry(): { type: string; command: string[]; enabled: boolean } {
  return {
    type: 'local',
    command: ['witsos', 'serve', '--mcp'],
    enabled: true,
  };
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly docsUrl = 'https://opencode.ai/docs/config';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.witsos || !!config.mcp?.WitsOS;
    // Global: the XDG dir is what current opencode creates on first run; the
    // legacy %APPDATA% dir still counts as "opencode present" so a re-install
    // can sweep the stale pre-#535 entry out of it.
    const legacy = legacyWindowsConfigDir();
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir()) || (!!legacy && fs.existsSync(legacy))
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // Clean up old capital-WitsOS entries (pre-casing-fix installs).
    const capitalCleanup = cleanupLegacyCapitalWitsOS(loc);
    if (capitalCleanup.action === 'removed') files.push(capitalCleanup);

    // AGENTS.md gets the short marker-fenced WitsOS block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    // Self-heal a pre-#535 install that wrote to %APPDATA%/opencode —
    // opencode never reads it, so anything of ours there is stale.
    if (loc === 'global') files.push(...cleanupLegacyWindowsState());

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(removeMcpEntryAt(configPath(loc)));
    files.push(removeInstructionsEntry(loc));
    if (loc === 'global') files.push(...cleanupLegacyWindowsState());
    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { witsos: getOpencodeServerEntry() },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);

  // Seed a minimal opencode config when the file is brand-new so
  // the result is a complete, schema-tagged file (not just a bare
  // `{ "mcp": {...} }`).
  if (!text.trim()) {
    text = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }

  const config = parseConfig(text);
  const before = config.mcp?.witsos;
  const after = getOpencodeServerEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // Add $schema if the user's existing file is missing it.
  if (!config.$schema) {
    const schemaEdits = modify(text, ['$schema'], 'https://opencode.ai/config.json', {
      formattingOptions: FORMATTING,
    });
    text = applyEdits(text, schemaEdits);
  }

  // Clean up old capital-WitsOS entry if present (migration on upgrade)
  if (config.mcp?.WitsOS) {
    const deleteEdits = modify(text, ['mcp', 'WitsOS'], undefined, {
      formattingOptions: FORMATTING,
    });
    text = applyEdits(text, deleteEdits);
  }

  // Surgical edit — preserves comments, formatting, and order of
  // every key we don't touch.
  const edits = modify(text, ['mcp', 'witsos'], after, {
    formattingOptions: FORMATTING,
  });
  const updated = applyEdits(text, edits);
  atomicWriteFileSync(file, updated);

  return { path: file, action: existed ? 'updated' : 'created' };
}

/**
 * Surgically drop `mcp.witsos` from one config file (or capital-WitsOS for migration).
 * Leaves sibling servers, comments, and formatting untouched; drops an emptied `mcp`
 * wrapper too. Shared by uninstall and the legacy-%APPDATA% sweep.
 */
function removeMcpEntryAt(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const text = readConfigText(file);
  const config = parseConfig(text);
  if (!config.mcp?.witsos && !config.mcp?.WitsOS) return { path: file, action: 'not-found' };

  let updated = text;

  // Remove both the new lowercase and legacy capital keys
  if (config.mcp?.witsos) {
    const edits = modify(text, ['mcp', 'witsos'], undefined, {
      formattingOptions: FORMATTING,
    });
    updated = applyEdits(text, edits);
  }

  if (config.mcp?.WitsOS) {
    const edits = modify(updated, ['mcp', 'WitsOS'], undefined, {
      formattingOptions: FORMATTING,
    });
    updated = applyEdits(updated, edits);
  }

  // If `mcp` is now an empty object, drop the wrapper too.
  const afterParsed = parseConfig(updated);
  if (afterParsed.mcp && typeof afterParsed.mcp === 'object' &&
      Object.keys(afterParsed.mcp).length === 0) {
    const edits = modify(updated, ['mcp'], undefined, { formattingOptions: FORMATTING });
    updated = applyEdits(updated, edits);
  }

  atomicWriteFileSync(file, updated);
  return { path: file, action: 'removed' };
}

/**
 * Remove capital-WitsOS MCP entry from the current config (if present) when
 * migrating from pre-casing-fix installs. This cleans up the stale entry
 * so users don't end up with both WitsOS and witsos after upgrading.
 */
function cleanupLegacyCapitalWitsOS(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'unchanged' };
  const text = readConfigText(file);
  const config = parseConfig(text);
  if (!config.mcp?.WitsOS) {
    return { path: file, action: 'unchanged' };
  }

  const edits = modify(text, ['mcp', 'WitsOS'], undefined, {
    formattingOptions: FORMATTING,
  });
  const updated = applyEdits(text, edits);

  atomicWriteFileSync(file, updated);
  return { path: file, action: 'removed' };
}

/**
 * Remove whatever a pre-#535 install left in `%APPDATA%/opencode` — an MCP
 * entry opencode never reads, plus our marker-fenced AGENTS.md block. Returns
 * only files actually changed, so install output stays quiet when there is
 * nothing to heal. Never touches anything else in the legacy dir: a user may
 * genuinely keep other tools' state under %APPDATA%.
 */
function cleanupLegacyWindowsState(): WriteResult['files'] {
  const dir = legacyWindowsConfigDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const out: WriteResult['files'] = [];
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const res = removeMcpEntryAt(path.join(dir, name));
    if (res.action === 'removed') out.push(res);
  }
  const agents = path.join(dir, 'AGENTS.md');
  const legacyStart = '<!-- WITSOS_START -->';
  const legacyEnd = '<!-- WITSOS_END -->';

  // Try removing with current markers first
  let action = removeMarkedSection(agents, WitsOS_SECTION_START, WitsOS_SECTION_END);

  // If not found, try legacy markers
  if (action === 'not-found' && fs.existsSync(agents)) {
    action = removeMarkedSection(agents, legacyStart, legacyEnd);
  }

  if (action === 'removed') out.push({ path: agents, action });
  return out;
}

/**
 * Strip the marker-delimited WitsOS block from AGENTS.md if a prior
 * install wrote one. Used by both install (self-heal on upgrade) and
 * uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const legacyStart = '<!-- WITSOS_START -->';
  const legacyEnd = '<!-- WITSOS_END -->';

  // Try removing with current markers first
  let action = removeMarkedSection(file, WitsOS_SECTION_START, WitsOS_SECTION_END);

  // If not found, try legacy markers
  if (action === 'not-found' && fs.existsSync(file)) {
    action = removeMarkedSection(file, legacyStart, legacyEnd);
  }

  return { path: file, action };
}

export const opencodeTarget: AgentTarget = new OpencodeTarget();
