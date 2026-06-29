---
title: Your First Graph
description: Build an index and run your first queries against it.
---

Once WitsOS is installed, building and exploring a graph takes a few commands.

## Index a project

```bash
cd your-project
witsos init
```

`witsos init` creates the `.witsos/` directory and builds the full graph in the same step — one command, done. From there a native file watcher keeps the index in sync on every change, so you rarely need to rebuild by hand. When you do want to:

```bash
witsos index          # full re-index
witsos sync           # incremental update of changed files
```

## Check it worked

```bash
witsos status
```

This reports the node/edge/file counts, the active SQLite backend, and the journal mode — a quick health check that the index is ready.

## Run a query

Reach for `witsos explore` first — a natural-language question or a bag of symbol names returns the relevant source plus the call paths between those symbols in a single shot (the same output the `witsos_explore` tool gives your agent):

```bash
witsos explore "how does login work"
```

For narrower, scriptable lookups there are focused commands:

```bash
witsos query UserService          # find symbols by name
witsos callers handleRequest      # what calls a function
witsos callees handleRequest      # what a function calls
witsos impact AuthMiddleware      # what a change would affect
```

These four each accept `--json` for machine-readable output. See the full [CLI reference](/witsos/reference/cli/).

## Hand it to your agent

With a `.witsos/` directory present and an agent configured (see [Installation](/witsos/getting-started/installation/)), your agent uses the [MCP tools](/witsos/reference/mcp-server/) automatically — no extra step.
