---
title: MCP Server
description: The tools WitsOS exposes to AI agents over MCP.
---

WitsOS runs as a [Model Context Protocol](https://modelcontextprotocol.io/) server. Agents configured by the installer launch it automatically — you don't start it by hand:

```bash
witsos serve --mcp
```

When a `.witsos/` index exists, the agent gets the tool below. In a workspace with **no** index, the server announces itself inactive and lists **no** tools — the agent works normally with its built-in tools, and indexing stays your decision.

## One tool by default: `witsos_explore`

By default the server exposes a **single tool**, `witsos_explore`. It's Read-equivalent: give it a natural-language question or a bag of symbol and file names, and it returns the **verbatim, line-numbered source** of the relevant symbols grouped by file — the same shape the `Read` tool gives you — plus the call paths between them (including dynamic-dispatch hops like callbacks, React re-render, and JSX children that grep can't follow) and a blast-radius summary of what depends on them. One call usually answers the whole question.

Exposing a single strong tool is deliberate. Measured agent behavior showed that one well-aimed tool steers agents to a direct answer better than a menu of narrower ones — fewer mis-picks — and agents reach for it both when answering questions and while editing code.

## The other tools

Seven more tools exist and stay fully functional, but are **unlisted by default** — everything they return already arrives inline on a `witsos_explore` response (its blast-radius section, the relationship map, a symbol's body and its callee list):

| Tool | Purpose |
|---|---|
| `witsos_node` | One symbol's source + caller/callee trail, or a whole file read with line numbers (Read-parity). Returns every overload's body for an ambiguous name. |
| `witsos_search` | Find symbols by name across the codebase (locations only) |
| `witsos_callers` | Find what calls a function |
| `witsos_callees` | Find what a function calls |
| `witsos_impact` | Analyze what code is affected by changing a symbol |
| `witsos_files` | Get the indexed file structure (faster than filesystem scanning) |
| `witsos_status` | Check index health and statistics |

Re-enable any of them with the `WITSOS_MCP_TOOLS` environment variable — a comma-separated allowlist of short names that replaces the default:

```bash
WITSOS_MCP_TOOLS=explore,node,search,callers
```

Each also has a CLI equivalent (`witsos node` / `query` / `callers` / `callees` / `impact` / `files` / `status`) for scripts and non-MCP harnesses.

## How agents should use it

WitsOS *is* the pre-built search index. For "how does X work?", architecture, a flow ("how does X reach Y"), or where-is-X questions — and while editing code — an agent should answer with `witsos_explore` and stop, typically with **zero file reads**, rather than re-deriving the answer with `grep` + `Read`. A direct WitsOS answer is one to a few calls; a grep/read exploration is dozens.

The MCP server delivers this guidance to the main agent automatically, in the MCP `initialize` response. Because subagents and non-MCP harnesses never see that response, the installer also writes a short marker-fenced section into each agent's instructions file pointing at the `witsos explore` CLI equivalent.
