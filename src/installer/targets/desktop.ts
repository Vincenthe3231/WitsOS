/**
 * Claude Desktop target. Writes:
 *
 *   - MCP server entry to `claude_desktop_config.json` under the
 *     standard `mcpServers.witsos` key. Same shape as Claude Code /
 *     Cursor / Gemini.
 *
 * Desktop has no per-project config (global only), no `settings.json`
 * permissions concept, and no CLAUDE.md-equivalent instructions file
 * — so unlike `claude.ts` this target only ever touches one file.
 *
 * Why this target exists: Claude Cowork's sandbox can't spawn a local
 * process itself (no Windows PATH, no cmd.exe/powershell.exe access),
 * so it can never run `witsos serve --mcp` directly. Claude Desktop's
 * SDK layer bridges its own locally-configured MCP servers into a
 * Cowork session automatically — Desktop runs with the user's full
 * PATH (a normal GUI app launch), so registering WitsOS here is what
 * makes it reachable from Cowork at all.
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
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function configDir(): string {
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
function mcpJsonPath(): string {
  return path.join(configDir(), 'claude_desktop_config.json');
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

    const file = mcpJsonPath();
    const config = readJsonFile(file);
    if (config.mcpServers?.witsos) {
      delete config.mcpServers.witsos;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(file, config);
      return { files: [{ path: file, action: 'removed' }] };
    }
    return { files: [{ path: file, action: 'not-found' }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Claude Desktop has no project-local config — use --location=global.\n';
    }
    const snippet = JSON.stringify({ mcpServers: { witsos: getMcpServerConfig() } }, null, 2);
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
  const after = getMcpServerConfig();

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

export const desktopTarget: AgentTarget = new ClaudeDesktopTarget();
