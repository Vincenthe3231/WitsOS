---
title: CLI
description: Every WitsOS command and the flags it accepts.
---

```bash
witsos                         # Run interactive installer
witsos install                 # Run installer (explicit)
witsos uninstall               # Remove WitsOS from your agents (inverse of install)
witsos init [path]             # Initialize a project + build its graph (one step)
witsos uninit [path]           # Remove WitsOS from a project (--force to skip prompt)
witsos index [path]            # Full re-index from scratch (--force, --quiet, --verbose)
witsos sync [path]             # Incremental update (--quiet)
witsos status [path]           # Show statistics (--json)
witsos unlock [path]           # Remove a stale lock file that's blocking indexing
witsos query <search>          # Search symbols (--kind, --limit, --json)
witsos explore <query>         # Relevant symbols' source + call paths in one shot (same output as the witsos_explore MCP tool)
witsos node <symbol|file>      # One symbol's source + callers, or read a file with line numbers (same output as witsos_node)
witsos files [path]            # Show file structure (--format, --filter, --pattern, --max-depth, --json)
witsos callers <symbol>        # Find what calls a function/method (--limit, --json)
witsos callees <symbol>        # Find what a function/method calls (--limit, --json)
witsos impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
witsos affected [files...]     # Find test files affected by changes (see below)
witsos daemon                  # Manage background daemons — pick one to stop (alias: daemons)
witsos telemetry [on|off]      # Show or change anonymous usage telemetry
witsos upgrade [version]       # Update to the latest release (--check, --force)
witsos version                 # Print the installed version (also -v, --version)
witsos help [command]          # Show help, optionally for one command
```

The MCP server (`witsos serve --mcp`) is launched automatically by your agent — you don't run it by hand. See [MCP Server](/witsos/reference/mcp-server/).

## init, index, and sync

`witsos init` creates the local `.witsos/` directory **and** builds the full graph in one step. (The old `-i`/`--index` flag is now a no-op, accepted only so existing scripts don't break.) After that the file watcher keeps the graph current automatically — `index` (a full rebuild from scratch) and `sync` (an incremental update) are only needed when the watcher is disabled or you're scripting against the index outside an agent session.

## Query commands

`query`, `callers`, `callees`, and `impact` all accept `--json` for machine-readable output.

```bash
witsos query UserService --kind class --limit 10
witsos callers handleRequest --json
witsos impact AuthMiddleware --depth 3
```

`explore` and `node` are the CLI faces of the `witsos_explore` and `witsos_node` MCP tools — same output — so subagents and non-MCP harnesses can reach the graph from a shell.

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. See [Affected Tests in CI](/witsos/guides/affected-tests/) for options and a CI example.
