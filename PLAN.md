# CodeGraph → Universal Knowledge Indexing Engine — CTO Strategy & Architecture Report

## Context

You asked me to evaluate transforming CodeGraph from a source-code indexer into a universal
document/knowledge indexing engine (Markdown, PDF, Office, images/OCR, audio/video/STT, embeddings,
cross-document search), and to decide between **(A)** extending the existing implementation vs **(B)**
rewriting the engine in Rust.

**The premise had a factual error that changes the entire question, and I verified it against the
CodeGraph index before writing anything.** Your brief repeatedly frames the existing engine as **C++**.
It is not. Evidence (`codegraph_status`): the repo is **264 TypeScript files, 26 JavaScript, 2 YAML —
zero C++, zero Rust, zero native code.** So the real decision is **TypeScript → Rust**, not C++ → Rust.
That inversion matters: the usual "escape C++ pain" motivation for Rust does not apply. The incumbent is
a memory-safe, GC'd, high-velocity TS codebase whose only native-ish dependency is tree-sitter compiled
to **WASM** and SQLite via Node's built-in `node:sqlite` — *already* a zero-native-build install.

Your three decisions (confirmed): **stay TS, Rust only if a hot-path is later proven** · **phase
embeddings in after document ingestion, and also support .txt/.docx/.xlsx/.csv** · **refactor the
architecture first, then add types.** This plan is built around those.

---

## 1. Architecture Report (how the system works today)

Layered pipeline, all wired by the `CodeGraph` class in [src/index.ts](src/index.ts) via
`wireLayers()` ([src/index.ts:173](src/index.ts:173)):

```
files → ExtractionOrchestrator → DB (nodes/edges/files) → ReferenceResolver
      → GraphQueryManager / GraphTraverser → ContextBuilder → (MCP / CLI)
```

- **Ingest / indexing** — `ExtractionOrchestrator` ([src/extraction/index.ts:985](src/extraction/index.ts:985)).
  `indexAll` scans files, reads each as **UTF-8** (`fsp.readFile(fullPath, 'utf-8')`), and parses in a
  **single recycled `parse-worker` thread** (not a pool); results are stored on the **main thread**
  because SQLite is not thread-safe. Worker is recycled every N parses to reclaim WASM linear memory,
  with timeout/crash/retry handling. `sync()` ([src/extraction/index.ts:1867](src/extraction/index.ts:1867))
  does filesystem reconcile via (size, mtime) pre-filter + content hash.
- **Parser dispatch** — `extractFromSource` ([src/extraction/tree-sitter.ts:5609](src/extraction/tree-sitter.ts:5609))
  is a **hard-coded if/else chain**: `svelte → SvelteExtractor`, `vue → VueExtractor`, `astro`, `liquid`,
  `razor`, `xml → MyBatisExtractor`, `pascal+.dfm → DfmExtractor`, else `TreeSitterExtractor`. Language is
  chosen by extension via `EXTENSION_MAP` ([src/extraction/grammars.ts:47](src/extraction/grammars.ts:47)).
- **The universal contract already exists**: every extractor returns `ExtractionResult`
  ([src/types.ts:243](src/types.ts:243)) = `{ nodes, edges, unresolvedReferences, errors, durationMs }`,
  and tree-sitter languages plug in via the `LanguageExtractor` config interface
  ([src/extraction/tree-sitter-types.ts](src/extraction/tree-sitter-types.ts)). This is the seam your
  "every document type implements the same interface" vision needs — it is already here, just dispatched
  rigidly.
- **Storage** — [src/db/schema.sql](src/db/schema.sql): `nodes` (code-shaped: line/column, visibility,
  is_async/static/abstract, return_type, decorators), `edges` (fixed `EdgeKind`), `files`,
  `unresolved_refs`. **FTS5 (`nodes_fts`) indexes only `name, qualified_name, docstring, signature` — there
  is no body/content column.** Symbol bodies are re-read from disk at query time, not stored.
- **Search** — `searchNodes` ([src/db/queries.ts:775](src/db/queries.ts:775)) = FTS5 prefix → LIKE
  substring → Levenshtein fuzzy → multi-signal scoring. **Purely lexical.**
- **Graph / resolution / context** — `ReferenceResolver` (imports, name-matching, framework resolvers
  under `src/resolution/frameworks/`), `GraphTraverser`/`GraphQueryManager`, `ContextBuilder`. Surfaced to
  agents through the MCP server (`src/mcp/`, guidance in `server-instructions.ts`) and the commander CLI
  ([src/bin/codegraph.ts](src/bin/codegraph.ts)).

### The five structural facts that decide the whole strategy

1. **The pipeline assumes UTF-8 text end-to-end.** `indexAll` reads `utf-8`; every extractor takes
   `source: string`. PDF/image/audio/video are **binary** and do not fit `(filePath, source) →
   ExtractionResult`. **There is no document-adapter / binary→text stage. This is the single biggest gap.**
2. **Dispatch is a god-`if/else`, not a registry.** Adding a type today = editing
   `extractFromSource` + `EXTENSION_MAP`. Does not scale to a plugin vision.
3. **The schema and `NodeKind`/`EdgeKind` are code-shaped.** No `document`/`page`/`section`/`chunk`
   kinds; no stored body; FTS has no prose/content field.
4. **No embedding/vector subsystem exists.** `embedding` → 0 hits; `vector` → only a stray `VectorError`
   class ([src/errors.ts:144](src/errors.ts:144)), effectively dead. "Semantic search" today is a misnomer
   for lexical FTS.
5. **Concurrency is one parse-worker, not a pool**, and the only heavy compute is WASM tree-sitter.
   OCR/STT/transcode are far heavier and out-of-band.

---

## 2. Rewrite Assessment — recommendation: **stay TypeScript; do NOT rewrite in Rust**

Evidence-driven verdict, optimizing for sustainability, contributor velocity, and migration risk:

- **The premise that motivates Rust (escaping C++) is false** — there is no C++. The incumbent is already
  memory-safe and GC'd.
- **The current hot path is WASM tree-sitter parsing**, which a Rust orchestrator would *still call as
  WASM/native* — rewriting the orchestration glue around it buys little throughput.
- **The genuinely heavy future work is OCR, speech-to-text, and transcode** (PaddleOCR, Whisper, FFmpeg).
  The right pattern for all three is **call the existing native tool/service out-of-process**, not
  reimplement it in Rust. So Rust would orchestrate sidecars — exactly what Node already does well.
- **A rewrite throws away** the mature differentiators: ~40 framework resolvers, dynamic-dispatch
  synthesizers, multi-agent installer, MCP tuning, and a large test suite (~100+ files). CLAUDE.md's own
  law — *"partial coverage is WORSE than none"* — applies doubly to a rewrite: a half-ported engine
  regresses code indexing, the current paying use case.
- **Where Rust could legitimately help later**: a CPU/GPU-bound batch stage (embedding inference, OCR,
  hashing millions of chunks). The correct vehicle is a **narrow, optional sidecar** (NAPI-RS addon or a
  standalone binary spoken to over a socket) for a **profiled, proven** bottleneck — never a core rewrite.
- **Algorithmic/architectural wins dominate raw-language wins** for real-world indexing throughput here
  (worker pool, batched transactions, mtime skip already exists). Reach for those first.

**Decision matrix:** stay C++ → N/A (no C++). Full rewrite → **rejected** (regression + velocity + ecosystem
loss). Rust core alongside → premature. **Rust sidecar for a proven hot-path → kept on the shelf, not now.**

---

## 3. Migration Strategy (architecture-first, incremental — no big bang)

Each phase ships independently, keeps the existing code-indexing path byte-stable, and is validated before
the next. Phases 0–1 are the refactor you chose to do first.

- **Phase 0 — Extractor registry (pure refactor, zero behavior change).** Replace the `extractFromSource`
  if/else with an `ExtractorRegistry` mapping `language → factory`. Each existing standalone extractor
  (Svelte/Vue/Astro/Liquid/Razor/MyBatis/DFM) self-registers. Net behavior identical; verified by the
  existing suite + stable node count on re-index. *This is the highest-leverage change and benefits the
  C++-free present immediately.*
- **Phase 1 — Binary-safe `SourceAdapter` stage + document schema.** Insert an adapter stage
  *before* extraction: `(filePath, bytes) → { text, metadata }`. Code path = identity adapter (UTF-8),
  so nothing regresses. Extend storage with doc-oriented kinds (`document`, `section`, `chunk`) and a
  **new FTS table over chunk body/prose** (the current `nodes_fts` deliberately omits body). Add a
  semantic **chunker** + **metadata extractor** as adapter outputs.
- **Phase 2 — Text documents: `.txt`, `.md`, `.csv`.** Pure text, **no native dependency** — validates the
  whole document path end-to-end on the cheapest inputs. Markdown gets heading→section→chunk structure +
  link edges (cross-doc graph seed).
- **Phase 3 — Office: `.docx`, `.xlsx`, `.pptx`.** These are ZIP+XML; extract text with **pure-JS**
  libraries (no native build) — keeps the zero-native-install promise intact.
- **Phase 4 — PDF.** Text-layer extraction via a JS PDF lib first; scanned/image PDFs fall through to OCR
  in Phase 5.
- **Phase 5 — OCR (images + scanned PDF).** First true heavy native tool. **Optional out-of-process
  sidecar** (PaddleOCR), gated behind an opt-in install so the base package stays lean.
- **Phase 6 — Audio / Video → STT.** FFmpeg (demux/transcode) + Whisper (transcribe) as sidecars; same
  optional-plugin model. Add a **parse-worker pool** here if not already done — these are long jobs.
- **Phase 7 — Embeddings + vector store (semantic layer).** Now that chunk text flows, add embedding
  generation + a vector index (sqlite-vec/extension or sidecar). Local-first model runtime or pluggable
  API. *This is the phase you chose to defer to here — correct, it has the most net-new surface.*
- **Phase 8 — Cross-document graph + unified search.** Entity/citation/link edges across all types; a
  single search blending lexical FTS + vector + graph.

---

## 4. Feature Roadmap (priority order, adjusted from your list)

Reordered to **front-load cheap, pure-JS, no-native-dependency types** so the architecture is proven
before heavy tooling is pulled in (cheapest validation first, biggest install/maintenance cost last):

1. **Extractor registry refactor** (Phase 0)
2. **SourceAdapter + document schema/chunker** (Phase 1)
3. **Markdown + .txt + .csv** (Phase 2)
4. **Office .docx/.xlsx/.pptx** (Phase 3)
5. **PDF (text layer)** (Phase 4)
6. **OCR / images** (Phase 5)
7. **Audio** (Phase 6a)
8. **Video** (Phase 6b)
9. **Embeddings + vector search** (Phase 7)
10. **Cross-document graph + unified search** (Phase 8)

Rationale for moving Office/CSV ahead of OCR/audio: they're high-value for "document intelligence," need
**no native binaries**, and exercise the binary→text adapter (ZIP/XML) without the install burden of
PaddleOCR/Whisper/FFmpeg.

---

## 5. Refactoring Opportunities (benefit the present codebase regardless of the vision)

- **`ExtractorRegistry`** replacing the `extractFromSource` if/else
  ([src/extraction/tree-sitter.ts:5609](src/extraction/tree-sitter.ts:5609)) — decouples type-add from a
  god-function; makes the "plugin" model real.
- **`SourceAdapter` seam** before extraction — the missing binary→text layer; identity adapter for code.
- **Parse-worker pool** (size ≈ CPU count) instead of the single recycled worker in `indexAll`
  ([src/extraction/index.ts:985](src/extraction/index.ts:985)) — throughput win now, prerequisite for heavy
  doc adapters later.
- **Batched SQLite writes** — confirm `storeExtractionResult` wraps per-file inserts in a transaction;
  main-thread serial writes are a known bottleneck on large repos.
- **Keep `ExtractionResult` as the universal interface** — it already is the right abstraction; do not
  invent a parallel one.
- **Kind-aware MCP tools** — `callers`/`callees`/`impact` are meaningless on a `chunk`; gate or branch
  tool behavior by node kind so doc nodes don't pollute code-flow answers
  (`src/mcp/tools.ts`, `server-instructions.ts`).

---

## 6. Risks

- **Maintenance / distribution (highest):** today's headline feature is a **zero-native-build npm install**
  (tree-sitter WASM + `node:sqlite`). OCR/STT/FFmpeg are heavy native deps that break that promise. Mitigation:
  **optional, opt-in sidecar plugins**, never bundled into the base package.
- **Partial-coverage debt:** CLAUDE.md's own principle — a half-built doc path that returns junk teaches
  agents (and users) to abandon the tool. **Ship each document type fully or not at all.**
- **Schema/kind coupling:** `NodeKind`/`EdgeKind` and the MCP tool semantics assume code. Doc nodes risk
  polluting code-centric tools; needs kind-aware gating (see §5).
- **Compatibility / regression:** CodeGraph is a published npm package with live code-indexing users. Every
  phase must keep code indexing byte-stable (re-index node-count parity is the canary).
- **Embeddings — privacy & cost:** a vector layer needs a model runtime; an API breaks the **local-first**
  promise, a local runtime adds size/compute. Decide before Phase 7.
- **Migration risk is LOW if you stay TS** and HIGH the moment a Rust rewrite is attempted — the single
  biggest risk lever is the rewrite itself, which this plan declines.

---

## Verification

The Phase 0/1 refactors are the only near-term code changes; validate them by:

1. **Existing suite stays green** — `pnpm test`, especially `__tests__/extraction.test.ts`,
   `frameworks.test.ts`, `frameworks-integration.test.ts`, and the installer contract suite. No code-path
   regression is the bar.
2. **Node-count parity** — re-index this repo before/after the registry refactor; `codegraph_status` total
   nodes/edges must be unchanged (the registry is behavior-preserving).
3. **New-type smoke** — add a `.txt`/`.md` fixture under a temp project, `codegraph index`, confirm a
   `document`/`chunk` node appears and `codegraph_search` finds prose from it (Phase 2).
4. **Probe scripts** — reuse `scripts/agent-eval/probe-*.mjs` against the built `dist/` to confirm explore
   still connects code flows end-to-end after the refactor.
5. **Install-size guard** — base `pnpm pack` size must not grow from heavy deps; OCR/STT land as separate
   optional packages.

---

### Bottom line

No C++ exists — the Rust question dissolves. **Stay TypeScript.** The work that unlocks your universal-engine
vision is **architectural, not language**: a binary-safe `SourceAdapter` stage and an `ExtractorRegistry`,
then doc-shaped storage + a prose FTS table, then types cheapest-first, with embeddings and heavy OCR/STT as
later, optional, sidecar-isolated phases. Rust stays on the shelf for a single proven hot-path, never a core
rewrite.