---
title: Integrations
description: Supported agents, and manual MCP setup.
---

The interactive installer auto-detects and configures each supported agent — wiring the WitsOS MCP server into each. For the agents that use an instructions file, it also writes a short marker-fenced WitsOS section (`CLAUDE.md`, `AGENTS.md`, or `GEMINI.md`) so subagents and non-MCP harnesses learn the `witsos explore` command; `witsos uninstall` removes it.

## Supported agents

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**

Run `npx @colbymchenry/witsos` and pick your agent(s); see [Installation](/witsos/getting-started/installation/) for the non-interactive flags.

## Manual setup

If you'd rather wire it up yourself, install globally:

```bash
npm install -g @colbymchenry/witsos
```

Add the MCP server to `~/.claude.json`:

```json
{
  "mcpServers": {
    "witsos": {
      "type": "stdio",
      "command": "witsos",
      "args": ["serve", "--mcp"]
    }
  }
}
```

Optionally auto-allow WitsOS's tools in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__witsos__*"
    ]
  }
}
```

One wildcard auto-approves every WitsOS tool. The server lists a single tool by default — `witsos_explore` — but if you re-enable others via the `WITSOS_MCP_TOOLS` environment variable, they're already permitted with no prompt.

:::tip
Cursor launches MCP subprocesses with the wrong working directory. The installer handles this for you by injecting a `--path` argument; if you wire Cursor up by hand, pass the project path explicitly.
:::
