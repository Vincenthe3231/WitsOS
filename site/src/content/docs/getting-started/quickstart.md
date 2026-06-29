---
title: Get Started
description: Get up and running with WitsOS in seconds.
---

Get up and running with WitsOS in seconds.

## 1. Install the CLI

No Node.js required — one command grabs the right build for your OS:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/witsos/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/witsos/main/install.ps1 | iex
```

Already have Node? `npm i -g @colbymchenry/witsos` works on any version. WitsOS bundles its own runtime — nothing to compile, no native build, works the same everywhere. The installer puts `witsos` on your `PATH` but doesn't change your current shell — open a new terminal before the next step.

## 2. Wire up your agent(s)

```bash
witsos install
```

Auto-detects and configures Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, and Kiro — wiring the WitsOS MCP server into each. This step connects your agents only; it does **not** index any code. (Shortcut: `npx @colbymchenry/witsos` downloads and runs the installer in one go.)

## 3. Initialize each project

```bash
cd your-project
witsos init
```

`witsos init` creates the local `.witsos/` directory and builds the full graph in the same step — one command, done. Your agent will use WitsOS tools automatically when a `.witsos/` directory exists.

Next: build [Your First Graph](/witsos/getting-started/your-first-graph/), or see the full [Installation](/witsos/getting-started/installation/) options.
