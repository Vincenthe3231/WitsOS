---
title: Troubleshooting
description: Fixes for the most common WitsOS issues.
---

## "WitsOS not initialized"

Run `witsos init` in your project directory first.

## Indexing is slow

Check that `node_modules` and other large directories are excluded (they are, if gitignored). Use `--quiet` to reduce output overhead.

## MCP hits `database is locked`

Current builds shouldn't: WitsOS bundles its own Node runtime and uses Node's built-in `node:sqlite` in WAL mode, where concurrent reads never block on a writer. If you still see it:

- **You're on an old (pre-0.9) install.** Reinstall to get the bundled runtime — `curl -fsSL https://raw.githubusercontent.com/colbymchenry/witsos/main/install.sh | sh` (macOS/Linux), `irm https://raw.githubusercontent.com/colbymchenry/witsos/main/install.ps1 | iex` (Windows), or `npm i -g @colbymchenry/witsos@latest`.
- **`witsos status` shows `Journal:` other than `wal`** — WAL couldn't be enabled on this filesystem (common on network shares and WSL2 `/mnt`), so reads can block on writes. Move the project (with its `.witsos/` folder) onto a local disk.

## MCP server not connecting

Your agent starts the server itself, so you don't launch it by hand. Make sure the project is initialized and indexed (`witsos status`) and that the path in your MCP config is correct. If it still won't connect, re-run `witsos install` to rewrite the config.

## Missing symbols

The MCP server auto-syncs on save (wait a couple of seconds). Run `witsos sync` manually if needed. Check that the file's language is [supported](/witsos/reference/languages/) and isn't inside a `.gitignore`d or default-excluded directory (e.g. `node_modules`, `dist`).

## Sharing one checkout between Windows and WSL

Don't point both at the same `.witsos/`: the background-server lock and the SQLite index are tied to the OS that wrote them, and SQLite locking across the WSL2/Windows filesystem boundary is unreliable. Give each side its own index in the same tree by setting `WITSOS_DIR` to a distinct name on one of them — e.g. `WITSOS_DIR=.witsos-win` on Windows, leaving WSL on the default `.witsos`. WitsOS skips any sibling `.witsos-*` directory when indexing and watching, so the two never trip over each other.
