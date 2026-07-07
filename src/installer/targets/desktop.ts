/**
 * Claude Desktop target. Writes:
 *
 *   - MCP server entry to `claude_desktop_config.json` under the
 *     standard `mcpServers.witsos` key. Same shape as Claude Code /
 *     Cursor / Gemini, except for the command/args — see below.
 *
 * Desktop has no per-project config (global only), no `settings.json`
 * permissions concept, and no `CLAUDE.md`-equivalent instructions file
 * — so unlike `claude.ts` this target only ever touches one file.
 *
 * Why this target exists: Claude Cowork's sandbox can't spawn a local
 * process itself (no Windows PATH, no cmd.exe/powershell.exe access),
 * so it can never run `witsos serve --mcp` directly. Claude Desktop's
 * SDK layer bridges its own locally-configured MCP servers into a
 * Cowork session automatically — Desktop runs with the user's full
 * PATH, so registering WitsOS here is what makes it reachable from
 * Cowork at all.
 *
 * ## Windows config path: classic vs Microsoft Store
 *
 * The Microsoft Store (MSIX-packaged) build of Claude Desktop reads its
 * config from a per-install, machine-specific path —
 * `%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\
 * claude_desktop_config.json` — instead of the classic
 * `%APPDATA%\Claude\claude_desktop_config.json`. The `<hash>` suffix
 * differs per machine, so we glob `Packages\Claude_*` for the folder
 * that actually has a `LocalCache\Roaming\Claude` directory. We prefer
 * whichever location already has a config file (self-heals a prior
 * install that guessed wrong), falling back to "Store dir exists but
 * empty" then classic — see `configDir()`.
 *
 * ## Command: absolute node + script path, not bare `witsos`
 *
 * Every other installer target can leave `command: 'witsos'` bare
 * because the consuming app (Claude Code CLI, Cursor, VS Code, a
 * terminal) inherits a real shell PATH where Volta/nvm resolve it to a
 * compatible node. Claude Desktop is a GUI app — it does NOT inherit
 * that PATH, so a bare `witsos` resolves against whatever system-wide
 * Node the OS has registered, which may be a version WitsOS's own
 * `node-version-check.ts` refuses to run (e.g. Node 25+). By the time
 * this code runs, that same check has already passed for the CURRENTLY
 * RUNNING node (`process.execPath`) — so we embed that exact binary,
 * plus the resolved absolute path to the CLI entry script, instead of
 * relying on Desktop's own PATH lookup. This also fixes the identical
 * problem on macOS (LaunchServices-launched apps get a stripped PATH
 * too) with no OS branching needed for this part.
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
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function classicConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  }
  // Linux — Desktop's support there is less standardized; Electron's XDG
  // default is the best-effort guess.
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'Claude');
}

/**
 * Find the Microsoft Store (MSIX) build's config directory, if present.
 * The `Claude_<hash>` package folder name is per-install and can't be
 * hardcoded, so we glob `Packages\Claude_*` and return the first entry
 * whose `LocalCache\Roaming\Claude` subdirectory exists. Windows-only;
 * returns `null` on any other platform or if nothing is found.
 */
function findWindowsStoreConfigDir(): string | null {
  if (process.platform !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const packagesDir = path.join(localAppData, 'Packages');
  let entries: string[];
  try {
    entries = fs.readdirSync(packagesDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^Claude_/i.test(entry)) continue;
    const candidate = path.join(packagesDir, entry, 'LocalCache', 'Roaming', 'Claude');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the config directory to write to. Prefers whichever location
 * already has a config file (self-heals a prior install that guessed
 * wrong), then an existing-but-empty Store dir (fresh Store install),
 * then falls back to the classic path. Non-Windows platforms are
 * unaffected by the Store-vs-classic distinction.
 */
function configDir(): string {
  if (process.platform !== 'win32') return classicConfigDir();

  const classic = classicConfigDir();
  const store = findWindowsStoreConfigDir();

  const classicHasConfig = fs.existsSync(path.join(classic, 'claude_desktop_config.json'));
  const storeHasConfig = !!store && fs.existsSync(path.join(store, 'claude_desktop_config.json'));

  if (storeHasConfig) return store!;
  if (classicHasConfig) return classic;
  if (store) return store;
  return classic;
}

/**
 * The Windows config location NOT currently preferred by `configDir()`
 * — classic when Store is preferred, Store when classic is preferred.
 * Used by `uninstall()` to sweep a stray entry left behind when the
 * preferred location changed between install and uninstall (e.g. the
 * Store package folder was recreated, or the user switched builds).
 * Returns `null` off Windows or when there's no "other" candidate.
 */
function otherWindowsConfigDir(): string | null {
  if (process.platform !== 'win32') return null;
  const preferred = configDir();
  const classic = classicConfigDir();
  const store = findWindowsStoreConfigDir();
  if (preferred === classic) return store;
  return classic;
}

function mcpJsonPath(dir: string = configDir()): string {
  return path.join(dir, 'claude_desktop_config.json');
}

/**
 * Resolve the absolute path to the currently-running CLI entry script.
 * `process.argv[1]` is the entry `package.json`'s `"bin"` field points
 * at (`dist/bin/witsos.js`) — every generated shim (pnpm, npm) execs
 * node directly against that file, so `argv[1]` inside the running
 * process is already the real absolute `.js` path, never a `.cmd`/shell
 * wrapper. `require.main?.filename` is a defensive fallback for the
 * same value under an unusual invocation.
 */
function resolveEntryScriptPath(): string {
  const entry = process.argv[1] ?? require.main?.filename;
  if (!entry) {
    throw new Error('Could not resolve the WitsOS CLI entry script path for the Claude Desktop MCP entry.');
  }
  return path.resolve(entry);
}

/**
 * Build the WitsOS MCP-server entry for Claude Desktop. Distinct from
 * `shared.ts`'s `getMcpServerConfig()` (used unparameterized by 8 other
 * targets) because Desktop needs an absolute node + script path — see
 * file header.
 */
function getDesktopMcpServerConfig(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [resolveEntryScriptPath(), 'serve', '--mcp'],
  };
}

class ClaudeDesktopTarget implements AgentTarget {
  readonly id = 'desktop' as const;
  readonly displayName = 'Claude Desktop';
  readonly docsUrl = 'https://modelcontextprotocol.io/quickstart/user';

  supportsLocation(loc: Location): boolean {
    // Desktop's config is a single machine-wide file — no project scope.
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = mcpJsonPath();
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.witsos;
    const installed = fs.existsSync(configDir()) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Claude Desktop has no project-local config — re-run with --location=global to install.'],
      };
    }
    return { files: [writeMcpEntry()] };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };

    const files: WriteResult['files'] = [];
    files.push(removeWitsOSFromFile(mcpJsonPath()));

    // Sweep the non-preferred Windows location too, in case the
    // preferred one changed between install and uninstall (Store
    // package folder recreated, or the user switched builds).
    const other = otherWindowsConfigDir();
    if (other) {
      const otherResult = removeWitsOSFromFile(mcpJsonPath(other));
      if (otherResult.action === 'removed') files.push(otherResult);
    }

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Claude Desktop has no project-local config — use --location=global.\n';
    }
    const snippet = JSON.stringify({ mcpServers: { witsos: getDesktopMcpServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [mcpJsonPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.witsos;
  const after = getDesktopMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.witsos = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function removeWitsOSFromFile(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const config = readJsonFile(file);
  if (!config.mcpServers?.witsos) return { path: file, action: 'not-found' };
  delete config.mcpServers.witsos;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const desktopTarget: AgentTarget = new ClaudeDesktopTarget();
