---
title: API
description: Use WitsOS as a TypeScript library.
---

WitsOS ships a TypeScript API. The public surface is the `WitsOS` class.

```typescript
import WitsOS from '@colbymchenry/witsos';

const cg = await WitsOS.init('/path/to/project');
// Or open an existing index:
// const cg = await WitsOS.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`),
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', {
  maxNodes: 20,
  includeCode: true,
  format: 'markdown',
});
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // auto-sync on file changes
cg.unwatch(); // stop watching
cg.close();
```

## Key methods

| Method | Purpose |
|---|---|
| `WitsOS.init(path)` / `WitsOS.open(path)` | Create or open a project index |
| `indexAll(opts)` | Full index, with progress callback |
| `sync()` | Incremental update |
| `searchNodes(query)` | Full-text symbol search |
| `getCallers(id)` / `getCallees(id)` | Walk the call graph |
| `getImpactRadius(id, depth)` | Transitive impact of a change |
| `buildContext(task, opts)` | Markdown / JSON context for AI |
| `watch()` / `unwatch()` | Start / stop the file watcher |
| `close()` | Close the database connection |

CommonJS works too — `const { WitsOS } = require('@colbymchenry/witsos');`.

## Lower-level building blocks

The same entry point exports primitives for callers that drive the graph directly rather than through the `WitsOS` facade: `DatabaseConnection`, `QueryBuilder`, `getDatabasePath`, `initGrammars` / `loadGrammarsForLanguages`, and `FileLock`.

```typescript
import {
  WitsOS,
  DatabaseConnection,
  QueryBuilder,
  getDatabasePath,
  initGrammars,
  loadGrammarsForLanguages,
  FileLock,
} from '@colbymchenry/witsos';
```

## Embedding requirements

- **Install from npm** (`npm i @colbymchenry/witsos`) so the matching per-platform package — which carries the compiled library — is fetched alongside the shim.
- The API runs on **your** runtime, so it needs **Node 22.5+** for the built-in `node:sqlite` module (an Electron main process qualifies when its bundled Node is 22.5+). The CLI and MCP server are unaffected — they ship with a self-contained bundled runtime and need no Node at all.
- TypeScript types ship with the package. Keep `@types/node` available and `skipLibCheck: true` (the common default).
