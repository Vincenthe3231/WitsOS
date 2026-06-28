# WitsOS → Universal Knowledge Indexing Engine — Architecture & Roadmap

## Context

WitsOS is a fork of CodeGraph — a local-first code intelligence library + CLI + MCP server. Goal: extend
it into a **universal document/knowledge indexing engine** (Markdown, PDF, Office, images/OCR,
audio/video/STT, embeddings, cross-document search) while keeping the code-indexing path byte-stable.

**Stack is TypeScript end-to-end** (264 TS files, 26 JS, 2 YAML — zero C++, zero Rust, zero native code).
Only native-ish dependencies: tree-sitter compiled to WASM and SQLite via Node's built-in `node:sqlite`.
Zero-native-build install is a headline feature — every phase must preserve it, or gate behind opt-in.

**Three confirmed decisions:** stay TS (Rust sidecar only if a hot-path is proven) · phase embeddings
in after document ingestion · refactor architecture first, then add types.

---

## 1. Architecture — current state

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files/chunks)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

### Storage (post-Phase 2)

- `nodes` — code-shaped: line/column, visibility, is_async/static/abstract, return_type, decorators
- `edges` — fixed `EdgeKind`
- `files` — file-level metadata
- `chunks` — doc-oriented: body text, heading, chunk_index, char_start/end
- `nodes_fts` — FTS5 over `name, qualified_name, docstring, signature` (code symbols)
- `chunks_fts` — FTS5 over `heading, body` (prose/doc content) ← added Phase 1

### Concurrency model (current)

- File I/O: `Promise.all` over `FILE_IO_BATCH_SIZE` files (parallel reads)
- Parsing: **single recycled parse-worker thread** (WASM tree-sitter; not thread-safe)
- DB writes: **main thread only** (`node:sqlite` not thread-safe)

---

## 2. Target Pipeline (Phase 7+)

All files flow through two-stage async pipeline:

```
files
  │
  ▼
FTS5 lexical pre-index  ← immediate; metadata + extractable text strings
  │
  ▼
Classifier (async, per-file)
  │
  ├── code   → existing tree-sitter extractor (already classified by EXTENSION_MAP)
  │
  ├── docs   → embedder (text chunks from chunks_fts already exist)
  │
  ├── image  → OCR worker (ONNX, opt-in) → text → embedder
  │
  └── other  → Handler + specialized indexing model
                   │
                   ▼
              SQLite DB (writes serialize to main thread — WAL for concurrent reads)
```

**Key invariants:**
- FTS5 pre-index is synchronous and completes first → users can search immediately
- Classifier and all specialist handlers are async → code/docs/image/other all parallel, no head-of-line blocking
- DB writes always serialize to main thread regardless of how many parallel workers are running
- Embedding is post-processing — does not block `witsos index` completion
- `witsos status` must surface two progress dimensions: FTS done % / embeddings done %

---

## 3. Phase Status

| Phase | Description | Status |
|-------|------------|--------|
| 0 | ExtractorRegistry — replace `extractFromSource` if/else with registry | ✅ done |
| 1 | Binary-safe `SourceAdapter` + `chunks` table + `chunks_fts` + text chunker | ✅ done |
| 2 | Text docs: `.txt`, `.md`, `.csv` extractors + chunk storage wired in | ✅ done |
| 3 | Office: `.docx`, `.xlsx`, `.pptx` — ZIP+XML, pure-JS, no native build | ✅ done |
| 4 | PDF — text-layer extraction via JS PDF lib; scanned falls to Phase 5 | ✅ done |
| 5 | OCR — images via opt-in ONNX OCR (PP-OCRv4 via onnxruntime-node; no Python). OCR worker thread delivered in Phase 6. Open spike: scanned-PDF rasterizer | ✅ done (OCR worker = Phase 6) |
| 6a | **Generalized worker pool** (`src/workers/JobPool`) — parse/ocr/stt lanes off main thread, recycle, crash-respawn, AbortSignal, graceful shutdown | ✅ done |
| 6b | **Audio STT** — `sherpa-onnx` backend seam, FFmpeg decode wrapper, `AudioExtractor`, 8 audio extensions, `stt` + `workers` config blocks, interactive opt-in prompt | ✅ done |
| 6c | Video (audio-track STT + embedded subtitles + keyframe extraction) | ⬜ deferred |
| 7 | Embeddings + vector store — sqlite-vec or sidecar; local-first model | ⬜ |
| 8 | Cross-document graph + unified search (FTS + vector + graph blended) | ⬜ |

---

## 4. Feature Roadmap (priority order)

Cheapest-first: front-load pure-JS/no-native types to validate the document path before heavy tooling.

1. **Office .docx/.xlsx/.pptx** (Phase 3) — ZIP+XML, pure JS, no sidecar
2. **PDF text layer** (Phase 4) — JS PDF lib, covers most PDFs
3. **OCR / images** (Phase 5) — opt-in in-process ONNX OCR (PP-OCRv4 via onnxruntime-node; no Python sidecar)
4. **Audio** (Phase 6a) — FFmpeg + Whisper opt-in
5. **Video** (Phase 6b) — same sidecar model
6. **Embeddings + vector search** (Phase 7) — requires chunks to exist (done)
7. **Cross-document graph + unified search** (Phase 8)

---

## 5. Prerequisite Work for Phase 7

Before embeddings land, these gaps must close:

| Gap | Problem | Fix |
|-----|---------|-----|
| ~~Single parse-worker~~ | ~~OCR/STT/embedding are 10–100× heavier than tree-sitter~~ | ✅ `JobPool` delivered in Phase 6 — parse/ocr/stt lanes |
| No `embedding_status` column | Users can't tell if semantic search is ready | Add to `files` table |
| `witsos status` shows one metric | Embeddings complete asynchronously | Surface FTS% and embedding% separately |
| Classifier is implicit | Extension-based dispatch fine for code, ambiguous for other MIME | Explicit classifier for non-code types only |

---

## 6. Refactoring Opportunities (ongoing)

- ~~**Parse-worker pool**~~ — ✅ delivered: `JobPool` in `src/workers/` generalizes parse + adds ocr/stt lanes; reuse in Phase 7 for embed lane
- **Batched SQLite writes** — confirm `storeExtractionResult` wraps per-file inserts in a transaction; serial main-thread writes bottleneck on large repos
- **Kind-aware MCP tools** — `callers`/`callees`/`impact` meaningless on `chunk`; gate by node kind so doc nodes don't pollute code-flow answers (`src/mcp/tools.ts`, `server-instructions.ts`)
- **`chunks_fts` exposed in search** — `searchNodes` currently queries only `nodes_fts`; add a parallel `searchChunks` path and unify results

---

## 7. Risks

- **Distribution / maintenance (highest):** zero-native-build is a headline promise. OCR/STT/FFmpeg break it. Mitigation: optional opt-in sidecar plugins, never bundled.
- **Partial-coverage debt:** CLAUDE.md principle — half-built doc path that returns junk teaches agents to abandon the tool. Ship each type fully or not at all.
- **Schema/kind coupling:** `NodeKind`/`EdgeKind` and MCP tool semantics assume code. Doc nodes need kind-aware gating before they pollute code-flow answers.
- **Embeddings — privacy & cost:** vector layer needs model runtime; an API breaks local-first promise; local runtime adds size/compute. Decide model strategy before Phase 7.
- **SQLite write contention:** parallel workers must never write directly to DB. All results queue to main thread for serialized writes. Already enforced; must not regress.
- **Regression canary:** re-index node-count parity before/after every phase. `witsos status` total nodes/edges must be unchanged for code files.

---

## 8. Verification Protocol (per phase)

1. **Suite stays green** — `pnpm test`, especially `extraction.test.ts`, `frameworks-integration.test.ts`, installer contract suite
2. **Node-count parity** — re-index repo before/after; `codegraph_status` total nodes/edges unchanged for code files
3. **New-type smoke** — fixture file → `witsos index` → confirm `chunk` node appears → `witsos query` finds prose
4. **Probe scripts** — `scripts/agent-eval/probe-*.mjs` against built `dist/`; explore still connects code flows end-to-end
5. **Install-size guard** — `pnpm pack` size must not grow from heavy deps; OCR/STT land as separate optional packages

---

## Bottom Line

**Phases 0–6b complete.**

- 0–4: ExtractorRegistry, binary-safe adapters, chunks/FTS5, text/Office/PDF extraction.
- Phase 5: Image OCR wired — pluggable `OcrBackend` (PP-OCRv4 via onnxruntime-node, no Python), `ImageExtractor`, `WitsOS.json` `ocr` block. Open spike: scanned-PDF rasterizer.
- Phase 6a: Generalized `JobPool` (`src/workers/`) — parse/ocr/stt lanes, recycle-after-N, timeout, crash-respawn, AbortSignal cancel, graceful shutdown. OCR moved off main thread (`ocr-worker.ts`).
- Phase 6b: Audio STT — **fully implemented**. `SttBackend` seam wired to real WASM `sherpa-onnx` API (`createOfflineRecognizer` + `createStream`/`acceptWaveform`/`decode`/`getResult`). Model resolver via `resolveModel` (downloads whisper-base/-small/-medium to `~/.witsos/models/`, prefers int8 export for speed). FFmpeg decode (`f32le` PCM → Float32Array). `AudioExtractor` emits document + section nodes per 28s window (timestamps in chunk metadata). 8 audio extensions in `EXTENSION_MAP`. `stt`/`workers` config blocks in `WitsOS.json`. Interactive TTY opt-in prompt. Tests: 10/10 pass (gating matrix, model resolution, PCM conversion). Verified: smoke test = real transcription (3 segments, text match, 35s for 60s audio int8 WASM).
- Phase 6c (video) deferred — audio-track STT + embedded subtitle extraction + keyframes are their own phase.

Default install still pure WASM + `node:sqlite`. STT/FFmpeg/sherpa-onnx/models all opt-in, never bundled. Rust stays on shelf. Next: Phase 7 (embeddings) reuses `JobPool` `embed` lane.
