/**
 * Cursor target.
 *
 *   - MCP server entry to `~/.cursor/mcp.json` (global) or
 *     `./.cursor/mcp.json` (local). Same `{mcpServers: {...}}` shape
 *     as Claude.
 *   - Instructions to `./.cursor/rules/WitsOS.mdc` (project-local
 *     ONLY). Cursor's rules system is a project-scoped surface;
 *     global cursor rules aren't a stable convention as of 2026-05.
 *     For `--location=global`, only mcp.json is written.
 *
 * ## Why we hardcode `--path` for Cursor
 *
 * Cursor launches MCP-server subprocesses with a working directory
 * that ISN'T the workspace root AND doesn't pass `rootUri` /
 * `workspaceFolders` in the MCP initialize call. The WitsOS MCP
 * server's `process.cwd()` fallback therefore misses the workspace's
 * `.WitsOS/` and reports "not initialized" on every tool call.
 *
 * So we inject `--path` into the args ourselves:
 *
 *   - `local`  install: absolute path (we know it at install time).
 *   - `global` install: `${workspaceFolder}` — Cursor expands this to
 *     the open workspace's root, giving us per-workspace behavior
 *     from a single global config.
 *
 * Codex and Claude do not need this — they launch MCP servers with
 * `cwd = workspace` and pass `rootUri`, respectively.
 *
 * No permissions concept — Cursor doesn't have an auto-allow list
 * the installer can populate. `autoAllow` is silently ignored.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';
import {
  WitsOS_SECTION_END,
  WitsOS_SECTION_START,
} from '../instructions-template';

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : path.join(process.cwd(), '.cursor', 'mcp.json');
}
/**
 * Cursor "rules" file. Only meaningful for the project-local
 * location — Cursor reads `.cursor/rules/*.mdc` from the workspace
 * root. There is no global equivalent.
 */
function rulesPath(): string {
  return path.join(process.cwd(), '.cursor', 'rules', 'witsos.mdc');
}

/**
 * Cursor `.mdc` rules use YAML-ish frontmatter. `alwaysApply: true`
 * makes the rule load on every conversation regardless of file
 * patterns — appropriate for a tool-usage guide that's relevant
 * whenever the user is asking the agent to navigate code.
 */
const MDC_FRONTMATTER = [
  '---',
  'description: WitsOS MCP usage guide — when to use which tool',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

class CursorTarget implements AgentTarget {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly docsUrl = 'https://docs.cursor.com/context/model-context-protocol';

  supportsLocation(_loc: Location): boolean {
    // Both supported, but `local` writes more files (mcp.json + rules);
    // `global` writes only mcp.json. The orchestrator surfaces the
    // difference via describePaths.
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.witsos || !!config.mcpServers?.WitsOS;
    // "Installed" heuristic: does ~/.cursor exist (global) or has the
    // user opted into a project-local cursor config dir?
    const installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.cursor'))
      : fs.existsSync(path.join(process.cwd(), '.cursor'));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // Clean up old capital-WitsOS entries (pre-casing-fix installs).
    const capitalCleanup = cleanupLegacyCapitalWitsOS(loc);
    if (capitalCleanup.action === 'removed') files.push(capitalCleanup);

    // We no longer write `.cursor/rules/witsos.mdc` — the WitsOS
    // usage guidance ships in the MCP server's `initialize` response,
    // the single source of truth (issue #529). Strip a rules file a
    // previous install created so an upgrade self-heals. Also clean
    // up any legacy `WitsOS.mdc` from pre-casing-fix installs.
    if (loc === 'local') {
      const rulesCleanup = removeRulesEntry();
      if (rulesCleanup.action === 'removed') files.push(rulesCleanup);
      const legacyCleanup = removeLegacyRulesEntry();
      if (legacyCleanup.action === 'removed') files.push(legacyCleanup);
    }

    return {
      files,
      notes: ['Restart Cursor for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    let removed = false;
    if (config.mcpServers?.witsos) {
      delete config.mcpServers.witsos;
      removed = true;
    }
    if (config.mcpServers?.WitsOS) {
      delete config.mcpServers.WitsOS;
      removed = true;
    }
    if (removed) {
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    if (loc === 'local') {
      files.push(removeRulesEntry());
      const legacyCleanup = removeLegacyRulesEntry();
      if (legacyCleanup.action === 'removed') files.push(legacyCleanup);
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { witsos: buildCursorMcpConfig(loc) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'local'
      ? [mcpJsonPath(loc), rulesPath()]
      : [mcpJsonPath(loc)];
  }
}

/**
 * Build the WitsOS MCP-server config for Cursor at the given
 * location. Inherits the shared shape ({type, command, args}) and
 * appends `--path` so the spawned MCP server resolves the workspace
 * correctly regardless of Cursor's launch cwd. See file header for
 * the full rationale.
 */
function buildCursorMcpConfig(loc: Location): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  const pathArg = loc === 'local' ? process.cwd() : '${workspaceFolder}';
  return { ...base, args: [...base.args, '--path', pathArg] };
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.witsos;
  const after = buildCursorMcpConfig(loc);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.witsos = after;
  // Clean up old capital-WitsOS entry if present (migration on upgrade)
  if (existing.mcpServers.WitsOS) {
    delete existing.mcpServers.WitsOS;
  }
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Remove capital-WitsOS MCP entry from .cursor/mcp.json (if present) when
 * migrating from pre-casing-fix installs. This cleans up the stale entry
 * so users don't end up with both WitsOS and witsos after upgrading.
 */
function cleanupLegacyCapitalWitsOS(loc: Location): WriteResult['files'][number] {
  const mcpPath = mcpJsonPath(loc);
  const config = readJsonFile(mcpPath);
  if (!config.mcpServers?.WitsOS) {
    return { path: mcpPath, action: 'unchanged' };
  }
  delete config.mcpServers.WitsOS;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(mcpPath, config);
  return { path: mcpPath, action: 'removed' };
}

/**
 * Remove the Cursor rules file on uninstall (and as a self-heal on
 * install — see issue #529).
 *
 * Unlike the shared CLAUDE.md / AGENTS.md files (where WitsOS owns
 * only a marker-delimited section), `.cursor/rules/witsos.mdc` is a
 * file we create OUTRIGHT — the frontmatter is ours too. So a plain
 * `removeMarkedSection` is wrong here: it would strip our instruction
 * block but leave the orphaned `description: WitsOS ...` frontmatter
 * behind, so the file lingers and still "mentions" WitsOS.
 *
 * Instead: strip our block, and if nothing but our own frontmatter
 * remains, delete the whole file. Only when the user has added their
 * own content outside our markers do we keep the file (minus our block).
 */
function removeRulesEntry(): WriteResult['files'][number] {
  const file = rulesPath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return { path: file, action: 'not-found' };
  }

  const ourFrontmatter = MDC_FRONTMATTER.trim();
  const legacyStartMarker = '<!-- WITSOS_START -->';
  const legacyEndMarker = '<!-- WITSOS_END -->';

  // Check for current markers first
  let startIdx = content.indexOf(WitsOS_SECTION_START);
  let endIdx = content.indexOf(WitsOS_SECTION_END);
  let endMarker = WitsOS_SECTION_END;

  // If not found, check for legacy markers
  if (startIdx === -1) {
    startIdx = content.indexOf(legacyStartMarker);
    endMarker = legacyEndMarker;
    if (startIdx !== -1) {
      endIdx = content.indexOf(legacyEndMarker);
    }
  }

  // Our marked block is present — strip it, then decide what's left.
  if (startIdx !== -1 && endIdx > startIdx) {
    const before = content.substring(0, startIdx).trimEnd();
    const after = content.substring(endIdx + endMarker.length).trimStart();
    const remainder = (before + (before && after ? '\n\n' : '') + after).trim();
    const shouldDelete = remainder === '' || remainder === ourFrontmatter;
    if (shouldDelete) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    } else {
      atomicWriteFileSync(file, remainder + '\n');
    }
    return { path: file, action: 'removed' };
  }

  // No block, but the file is still our pristine frontmatter-only file
  // — it's ours, so remove it.
  if (content.trim() === ourFrontmatter) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    return { path: file, action: 'removed' };
  }

  // Foreign content we don't recognize — leave it alone.
  return { path: file, action: 'not-found' };
}

/**
 * Delete the legacy `WitsOS.mdc` rules file (from pre-casing-fix installs)
 * as a migration cleanup step.
 *
 * On a case-insensitive filesystem (Windows, default macOS) this path is
 * the SAME file as `rulesPath()`'s `witsos.mdc` — `removeRulesEntry()` has
 * already decided whether to delete it or preserve user content added
 * outside our markers. Unconditionally unlinking here would blow away
 * that decision, so skip when the two paths collide case-insensitively.
 */
function removeLegacyRulesEntry(): WriteResult['files'][number] {
  const file = path.join(process.cwd(), '.cursor', 'rules', 'WitsOS.mdc');
  if (file.toLowerCase() === rulesPath().toLowerCase()) {
    return { path: file, action: 'not-found' };
  }
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return { path: file, action: 'removed' };
}

export const cursorTarget: AgentTarget = new CursorTarget();
