# Add a Claude Desktop installer target (bridges WitsOS into Cowork)

## Context

Original question: Claude Cowork's Bash tool runs in an isolated sandbox with no Windows PATH and no CMD/PowerShell — can it reach WitsOS's already-working MCP server at all, and does that require routing through Claude Desktop?

First pass investigated a **remote HTTP transport** (Cowork's own "custom connectors" feature is cloud-routed and needs a publicly-reachable server). Rejected: needs a public tunnel, an auth story, and is a much bigger surface than the problem warrants.

Redirected to the actual answer, confirmed by a third-party field report ("How We Got Local MCP Servers Working in Claude Cowork," dev.to) describing exactly this scenario: **Claude Desktop's SDK layer automatically bridges MCP servers from its own local config (`claude_desktop_config.json`) into a Cowork VM session**, appearing there as a `"type": "sdk"` connection — no tunnel, no public exposure, no new server code. This is the "connecting to Claude Desktop as the connector" idea from the original ask, and it's the right one.

**The actual gap, confirmed by reading the installer code directly:** this repo's installer has zero support for Claude Desktop. The existing `'claude'` target ([claude.ts:44](src/installer/targets/claude.ts:44), `configDir()`) writes to `~/.claude` — that's **Claude Code CLI's** config directory, a completely different app from Desktop with a different config file (`claude_desktop_config.json`, JSON but different location/lifecycle, no per-project scoping, no `settings.json`/`CLAUDE.md` equivalents). A repo-wide grep for `claude_desktop_config`/"Claude Desktop" turns up nothing. So Desktop was simply never wired up as a target — everything else (the MCP server, the `getMcpServerConfig()` shape, the JSON read/write helpers) already exists and needs no changes.

This is exactly the extension seam the installer already documents for itself: *"Adding a new agent = one new file in `targets/` + one entry in `registry.ts`"* ([types.ts:7](src/installer/targets/types.ts:7)). No new abstraction — this is the abstraction already built for this exact situation.

## What ships

### `src/installer/targets/desktop.ts` (new)
Modeled directly on `claude.ts`'s MCP-entry handling (same JSON shape, same `readJsonFile`/`writeJsonFile`/`jsonDeepEqual` helpers from `shared.ts` — no duplication), but **leaner**: Desktop has no per-project config, no `settings.json` permissions concept, and no `CLAUDE.md`-equivalent instructions file, so this target only ever touches one file.

- `id: 'desktop'`, `displayName: 'Claude Desktop'`.
- `supportsLocation(loc)`: `loc === 'global'` only — Desktop's config is a single machine-wide file, not project-scoped (same documented pattern Codex already uses for its `~/.codex`-only, no-local-config case).
- Config path, branched by `process.platform` (mirrors the existing `process.env.APPDATA` branching already in [opencode.ts:77](src/installer/targets/opencode.ts:77) for its legacy-Windows-path sweep — same style, new primary path):
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json` (Electron default; best-effort, Desktop's Linux support is less standardized)
- `detect`: `alreadyConfigured = !!config.mcpServers?.WitsOS`; `installed` = config dir exists.
- `install`: write `mcpServers.WitsOS = getMcpServerConfig()` — the exact same `{ type: 'stdio', command: 'WitsOS', args: ['serve', '--mcp'] }` shape `claude.ts`/`cursor.ts`/`gemini.ts` already write ([shared.ts:24](src/installer/targets/shared.ts:24)). This is safe to reuse verbatim: Desktop is a normal Windows GUI app launched from the Start Menu with the user's full PATH, so — unlike Cowork's sandbox — `witsos` on PATH resolves fine here. That's the whole point of the bridge: Desktop does the PATH-dependent local spawn Cowork can't, and Desktop's SDK layer forwards the resulting MCP session into Cowork.
- `uninstall`: mirror `claude.ts`'s MCP-entry removal (delete `mcpServers.WitsOS`, drop the wrapper if empty).
- `printConfig`/`describePaths`: mirror `claude.ts`'s one-liners.

### `src/installer/targets/types.ts` (edit, 1 line)
Add `'desktop'` to the `TargetId` union ([types.ts:22](src/installer/targets/types.ts:22)).

### `src/installer/targets/registry.ts` (edit, 2 lines)
Import `desktopTarget` and add it to the `ALL_TARGETS` array ([registry.ts:20](src/installer/targets/registry.ts:20)) — this alone pulls the new target into the ~47 existing parameterized contract tests in `__tests__/installer-targets.test.ts`, which iterate `ALL_TARGETS`.

### `__tests__/installer-targets.test.ts` (edit)
The generic parameterized suite (install/uninstall idempotency, byte-equal re-runs, sibling-server preservation) covers the new target automatically once it's in `ALL_TARGETS`. Add target-specific cases for the one thing that's actually new: the platform-branched config path — gated per the CLAUDE.md convention (`it.runIf(process.platform === 'win32')` for the `%APPDATA%` path, `it.runIf(process.platform !== 'win32')` for the macOS/Linux path), plus a check that `supportsLocation('local')` is `false`.

### `CHANGELOG.md` (edit)
Under `[Unreleased]` → `### New Features`, one user-facing sentence: WitsOS can now be installed into Claude Desktop (`witsos install --target desktop`), which lets Claude Cowork sessions reach an indexed codebase's search tools through Desktop's local MCP bridge.

## Explicitly not doing

- No `src/mcp/` changes — the MCP server, transports, and tool gating are already correct and untouched. This is purely an installer/config addition.
- No new "search everything under `C:/projects`" tool — every existing tool already takes an optional `projectPath` and opens/caches any indexed project on demand ([tools.ts:722](src/mcp/tools.ts:722)). Point Cowork/Desktop at whichever project's `.witsos/` you want per call; nothing new required for multi-project reach.
- No change to which tools are exposed — `DEFAULT_MCP_TOOLS = new Set(['explore'])` ([tools.ts:714](src/mcp/tools.ts:714)) is already the minimal default; `explore`, `search`, `node`, `files` cover search/symbol/file lookup, expandable via the existing `WitsOS_MCP_TOOLS` env var — no new gating logic needed.
- No Bash-permission workaround for `witsos --help` on the Cowork side — once this bridge is live, Cowork gets `mcp__witsos__*` tools directly through the protocol (same as this session already has `mcp__codegraph__*`); it never needs to shell out to the CLI at all.
- No remote HTTP/tunnel/auth work — rejected earlier for being bigger than needed once the Desktop-bridge path was confirmed.

## Verification

1. `CI=true pnpm run build:fast`, `pnpm link . --global` (or rely on the existing symlink).
2. `witsos install --target desktop` — confirm it writes `mcpServers.WitsOS` into `claude_desktop_config.json` at the platform-correct path, and that a second run reports `unchanged`.
3. `witsos install --print-config desktop` — confirm the snippet is well-formed and matches what step 2 wrote.
4. `witsos uninstall --target desktop` — confirm it removes the `WitsOS` entry, preserves any sibling `mcpServers` entries, and is a no-op (`not-found`) on a second run.
5. Restart Claude Desktop; confirm it shows WitsOS as a connected MCP server (its own MCP status UI).
6. **The pivotal, currently-unverified claim**: open a Claude Cowork session on this machine and check whether `mcp__witsos__*` tools appear automatically as a bridged `sdk`-type connection (per the dev.to field report — third-party, not official Anthropic docs, so confirm it empirically rather than trusting the blog post). If it does *not* bridge automatically, the fallback is the blog's "Layer 2" — wrapping `witsos serve --mcp` with the separate `supergateway` tool locally and pointing Cowork's `.mcp.json` at `http://localhost:PORT/mcp` — which is a config/docs change only, not new WitsOS code, and can be scoped separately if step 6 fails.
7. `pnpx vitest run __tests__/installer-targets.test.ts` — full parameterized suite green, including the new Windows/macOS-gated path assertions.