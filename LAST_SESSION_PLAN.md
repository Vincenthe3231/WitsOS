# Phase 6c (Video) — Engineering Design Review

> **Deliverable type:** architecture design document (NOT an implementation).
> **Objective:** decide whether Phase 6c is mature enough to build now, and whether it should land
> **before**, **after**, or **split around** Phase 7 (Embeddings).
> **Method:** evidence gathered live from the WitsOS CodeGraph index (323 files, 5137 nodes), cited by `file:line`.
> **Implementation action this plan authorizes:** save this document to `docs/design/phase-6c-video-design-review.md`. No code.

---

## Context — why this review exists

WitsOS (fork of CodeGraph) is becoming a universal local-first knowledge indexer. Phases 0–6b are complete:
text/Office/PDF extraction, image OCR, audio STT, a generalized `JobPool`, and binary-safe adapters. Phase 6c
(video: audio-track STT + embedded subtitles + keyframe extraction) is the last media type before Phase 7
(embeddings). Video was deferred deliberately. The question now is not "how to build video" but **"is the
substrate ready, and where does video sit relative to embeddings?"** The project's own rules force the framing:

- **Refactor first, then add types** (PLAN.md line 14) — so structural debt video would amplify must be paid first.
- **Partial coverage is worse than none** (CLAUDE.md) — a half-built video path that returns junk teaches agents to abandon the tool.
- **Zero-native-build by default** — ffmpeg/ONNX/models are opt-in, never bundled. Video must not change that.
- **Byte-stable code indexing; never regress** — node/edge counts for code files must be identical before/after.

The conclusion (stated up front): **Phase 6c is NOT ready to build as one phase. Split it into 4 sub-phases,
pay 5 architectural preconditions first, and straddle Phase 7 — the text-yielding parts before embeddings, the
visual/keyframe part after.** Detail and evidence below.

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Build 6c now, as specified? | **No.** Decompose + pay preconditions first. |
| Decompose into? | **6c-1** metadata+subtitles · **6c-2** audio-track STT · **6c-3** keyframes+visual · (metadata folds into 6c-1). |
| Sequence vs Phase 7? | **Straddle.** 6c-1 + 6c-2 **before** Phase 7 (they only emit text chunks, which embeddings consume generically). 6c-3 **after/with** Phase 7 (its real payoff is image embeddings; OCR-only keyframes = partial coverage). |
| Phase 7 readiness gate | **GO WITH CONDITIONS** — and Phase 7 does **not** depend on video existing. |

**Why video is mostly wiring, not new capability:** audio-track STT reuses 6b *entirely* (ffmpeg already demuxes;
sherpa already transcribes). Subtitle extraction is pure-JS text parsing — the *cheapest* class, like Office/PDF,
no new native dep. Only keyframe extraction introduces a genuinely new asset class (frame images → thumbnails →
pixels for embeddings), and that asset class has **no storage design and no value without embeddings**.

**The five preconditions** (each amplified by video, each already latent debt):
1. Generalize async/binary extractor dispatch (kill the `isAsyncExtractorLanguage` god-branch).
2. Decide/fix `JobPool` per-lane concurrency (it is silently ignored today) and pipeline async media (stop `await`-ing each file serially).
3. Add a temp-file manager with guaranteed cleanup (none exists; keyframes can't live in memory).
4. Bound media memory (STT buffers whole PCM → OOM on hour-long tracks).
5. Kind-gate the MCP flow tools (`callers`/`callees`/`impact`) so document/section nodes stop polluting code answers.

---

## 2. Repository findings (via CodeGraph)

All paths verified against the live index.

### 2.1 The extraction pipeline has TWO dispatch mechanisms (hidden coupling)

```
                         detectLanguage(grammars.ts:315)
                                   │
              ┌────────────────────┴─────────────────────┐
              │                                            │
   isAsyncExtractorLanguage()?                    (everything else)
   pdf | image | audio (grammars.ts:378)                   │
              │ YES                                          ▼
              ▼                                  requestParse → JobPool 'parse' lane
   indexAll hardcoded branch (index.ts:1335-1362)   → extractFromSource(tree-sitter.ts:5669)
   ├─ audio → pool.submit('stt')                          → resolveExtractor(ExtractorRegistry)
   ├─ image/pdf → pool.submit('ocr')                      → first-match-wins registration
   └─ fallback → runAsyncExtractor(index.ts:1741)            (svelte/vue/dfm/mybatis/...)
        if/else: image→ImageExtractor, audio→AudioExtractor, else PDF
```

**Finding:** the `ExtractorRegistry` ([extractor-registry.ts:53](src/extraction/extractor-registry.ts)) advertises
"a new type = one `registerExtractor` call." That is **only true for synchronous, string-source extractors.**
Binary/async media (the path video must join) is dispatched by a **hardcoded language enum + a hardcoded if/else +
a hardcoded lane switch**. The registry's `create(filePath, source: string)` signature can't even express a
binary extractor (no Buffer, no async lane hint). Adding video today means editing **all of**:
`LANGUAGES`/`EXTENSION_MAP` (grammars.ts), `isAsyncExtractorLanguage`, the `indexAll` lane switch,
`runAsyncExtractor`, and a new worker — five sites, not one. **This is the single biggest structural debt video exposes.**

### 2.2 Async media is processed SEQUENTIALLY

In `indexAll` the media branch is `asyncResult = await pool.submit('stt'|'ocr', …)` **inside the per-file loop**
([index.ts:1347, 1355](src/extraction/index.ts)). Each media file fully completes before the next starts. Code
files get a worker thread but the loop still `await`s media one at a time. For a repo with many/large videos this
serializes the heaviest workload in the system. (Code parsing is also awaited per-file, but tree-sitter is ~10–100×
cheaper, so it doesn't bite the way media will.)

### 2.3 JobPool accepts `concurrency` but runs ONE worker per lane

`LaneState.worker` is a single `WorkerType | null`; `_ensureWorker` returns the lone `lane.worker`
([job-pool.ts:51, 206](src/workers/job-pool.ts)). `registerLane` stores `concurrency` ([job-pool.ts:71](src/workers/job-pool.ts))
but nothing ever spawns a second worker. The ocr/stt lanes register `concurrency: 1` anyway
([index.ts:1198, 1212](src/extraction/index.ts)), so it's currently moot — but the option is a **latent lie**: any
future "set stt concurrency: 4" silently does nothing. Video's parallelism story can't rest on this until it's real.
(Contrast: `src/mcp/query-pool.ts` is a *separate* true multi-worker pool for MCP queries — the two pools should not be confused.)

### 2.4 STT buffers the entire decoded PCM in memory

`decodeAudioToPcm` concatenates ffmpeg stdout into one Buffer ([ffmpeg.ts:86-103](src/extraction/audio/ffmpeg.ts)),
then `transcribe` views it as one Float32Array ([backend.ts:160](src/extraction/stt/backend.ts)). At 16 kHz mono
f32, **1 hour ≈ 230 MB resident per file**; a 3-hour lecture ≈ 690 MB. Video audio tracks are routinely hours long.
The timeout already scales with duration ([audio-extractor.ts:103](src/extraction/languages/audio-extractor.ts)),
but memory does not. This is a pre-existing 6b risk that video makes routine.

### 2.5 No temp-file manager

The audio path never touches disk for intermediates — it streams ffmpeg → memory. There is no module that owns a
scratch directory, no cleanup-on-crash/cancel/timeout. Keyframe extraction *must* write frame images somewhere;
without a managed temp lifecycle, a killed/timed-out worker leaks PNGs.

### 2.6 Graceful degradation is the established, correct pattern

`AudioExtractor._extract` degrades to **document-only** on every failure: STT disabled, sherpa missing, ffmpeg
missing, decode fail, transcribe fail, zero segments ([audio-extractor.ts:77-140](src/extraction/languages/audio-extractor.ts)).
`loadSttBackend`/`loadOcrBackend` return `null` (never throw) when the optional package is absent. Video must
preserve this discipline exactly (subtitle-missing, codec-unsupported, no-video-stream → degrade, never error).

### 2.7 Storage is chunk-centric and already flexible

`schema.sql`: `chunks(id, file_path FK→files ON DELETE CASCADE, node_id, chunk_index, char_start/end, body,
metadata TEXT, updated_at)` + `chunks_fts(id, file_path, body, metadata)` triggers. `ChunkRecord.metadata` is
`Record<string, unknown>` ([types.ts:256](src/types.ts)). Audio already stuffs `{start, end, speaker, sttEngine,
sttModel}` into it ([audio-extractor.ts:200](src/extraction/languages/audio-extractor.ts)). **No `embedding_status`
column, no vector table, no asset/keyframe/blob table.** `NodeKind` already has `document` + `section`
([types.ts:39-42](src/types.ts)); `Language` is a const array with no `video`.

### 2.8 Search already covers any text we emit as chunks

`searchChunks` runs BM25 over `chunks_fts` ([queries.ts:1902](src/db/queries.ts)); `witsos query` surfaces
`nodes_fts` + `chunks_fts` in two sections. **Any subtitle/STT/OCR text emitted as a chunk is searchable for free.**
No vector search yet (that is Phase 7).

### 2.9 MCP flow tools are not kind-gated

`callers`/`callees`/`impact` in `src/mcp/tools.ts` operate on any node; nothing excludes `document`/`section`
(no gating found — PLAN.md §6 lists this as still-open). Code-flow answers can already be polluted by doc nodes;
video adds many more.

### 2.10 Runtime/version mismatch (the "annoying error")

`MIN_NODE_MAJOR = 20` and `engines: >=20 <25` ([node-version-check.ts:48](src/bin/node-version-check.ts)), but
`node:sqlite` requires **22.5** ([sqlite-adapter.ts:10](src/db/sqlite-adapter.ts)). Bundled-runtime installs ship a
compatible Node, but "run from source" on Node 20/21 fails the SQLite open with a confusing message; Node 25 is
hard-blocked (V8 turboshaft WASM OOM). The floor advertised (20) is below the floor actually required (22.5).

---

## 3. Current architecture diagram

```
                                  witsos index
                                        │
                          ExtractionOrchestrator.indexAll (index.ts:1077)
                                        │
                 scanDirectoryAsync → detectFrameworks → JobPool setup
                                        │
                 ┌──────────────────────┼───────────────────────┐
            register 'parse'      register 'ocr' (if .js)   register 'stt' (if .js)
            warm() grammars        concurrency:1              concurrency:1
                                        │
                       per-file loop (FILE_IO_BATCH_SIZE parallel READS)
                                        │
                 ┌──────────────────────┴───────────────────────┐
        isAsyncExtractorLanguage?                          (code/text)
          (pdf|image|audio)                                     │
                 │ YES (await, serial)                          ▼
     ┌───────────┼────────────┐                       requestParse → 'parse' worker
   audio        image/pdf    fallback                  → extractFromSource
   'stt' lane   'ocr' lane   runAsyncExtractor           → ExtractorRegistry / TreeSitter
     │            │            │
  stt-worker   ocr-worker   (in-process)
  AudioExtractor ImageExtractor/PdfExtractor
     │            │            │
  ffmpeg decode  ONNX OCR      ...
  sherpa STT
     │            │            │
     └────────────┴────────────┴──────► ExtractionResult {nodes, edges, chunks}
                                        │
                       storeExtractionResult (MAIN THREAD, serialized)
                       deleteFile → insertNodes/Edges/Refs → upsertFile → insertChunks
                                        │
                       SQLite (WAL): nodes/edges/files/chunks + *_fts triggers
```

---

## 4. Proposed architecture diagram (post-precondition, video-ready)

Changes vs current are marked `★`.

```
                          ExtractionOrchestrator.indexAll
                                        │
              ★ MediaExtractorRegistry (async/binary registrations:
                {match, lane, createAsync(filePath, bytesOrPath, cfg, tmp)})
                                        │
              register lanes from registry  ★ + 'video' lane  ★ + 'embed' lane (P7)
                                        │
                       per-file loop  ★ media SUBMITTED not awaited
                                     ★ bounded in-flight window (back-pressure)
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
   code 'parse'                     media lanes (★ true concurrency)   ★ embed (P7)
        │                ┌──────────┬──────────┬──────────┐
        │              'stt'      'ocr'      'video' ★
        │                │          │          │
        │           AudioExtractor ImageEx.  VideoExtractor ★
        │                │          │          │  ├─ ffprobe metadata (6c-1)
        │                │          │          │  ├─ subtitle demux/sidecar (6c-1) → chunks
        │                │          │          │  ├─ audio track → reuse STT path (6c-2) → chunks
        │                │          │          │  └─ keyframes → ★TempFileMgr → OCR/embed (6c-3)
        │                │          │          │
        └────────────────┴──────────┴──────────┴──────► ExtractionResult {nodes, edges, chunks ★+assets?}
                                        │
                       storeExtractionResult (MAIN THREAD, serialized — unchanged)
                       ★ + embedding_status on files; ★ assets (only if keyframes persisted)
                                        │
                       SQLite (WAL)  ★ + vec table (P7)  ★ + status two-dimension
```

---

## 5. Dependency graph (what 6c touches)

```
Phase 6c (video)
├── grammars.ts            EXTENSION_MAP (+.mp4/.mkv/.mov/.webm/.avi), Language (+'video'),
│                          isAsyncExtractorLanguage, isLanguageSupported          [EDIT]
├── extractor dispatch     ★ generalize before edit (precondition #1)
│   ├── index.ts           indexAll lane switch, runAsyncExtractor                [EDIT → refactor]
│   └── extractor-registry / NEW MediaExtractorRegistry                           [NEW]
├── workers/
│   ├── job-pool.ts        concurrency fix / pipelining (precondition #2)         [EDIT]
│   └── video-worker.ts    NEW entrypoint (mirrors stt/ocr-worker)               [NEW]
├── extraction/languages/
│   └── video-extractor.ts NEW orchestrator (metadata+subs+audio+keyframes)      [NEW]
├── extraction/
│   ├── audio/ffmpeg.ts    add demux-audio-track + extract-subtitle + keyframe ops [EDIT]
│   ├── stt/*              REUSED unchanged (audio-track path)                     [REUSE]
│   ├── ocr/*              REUSED unchanged (keyframe path)                        [REUSE]
│   ├── subtitles/*        NEW pure-JS SRT/VTT/ASS parser                         [NEW]
│   └── util/tempfiles.ts  NEW temp-file manager (precondition #3)                [NEW]
├── project-config.ts      ProjectConfig.video block, scaffoldProjectConfig,
│                          workers.{video}, loadVideoConfig                        [EDIT]
├── db/                    NO schema change for 6c-1/6c-2; assets table only if
│                          6c-3 persists thumbnails                                [MAYBE]
├── mcp/tools.ts           kind-gating callers/callees/impact (precondition #5)    [EDIT]
└── tests/                 video-extractor, subtitle parser, gating matrix,
                           node-count parity canary, install-size guard            [NEW]
```

---

## 6. Worker interaction diagram

```
 main thread (orchestrator)                worker threads (1 per lane today)
 ─────────────────────────                 ──────────────────────────────────
 JobPool.submit('video', {filePath,        video-worker.ts
   videoConfig, rootDir, tmpDir})  ───────► VideoExtractor.extract()
                                              │ ffprobe (streams, subs, duration, codec)
                                              │ subtitle present? ── yes ─► parse → chunks  (cheap)
                                              │                   └─ no ──► demux audio track
                                              │                              → reuse STT (sherpa)  (heavy)
                                              │ keyframes? ─► ffmpeg scene-detect → TempFileMgr
                                              │               → OCR each frame (reuse ONNX)  (heavy)
                                              ▼
                                            postMessage({_poolId, result})  OR  {error}
   ◄──────────────────────────────────────────┘
 timeout(300s+)/AbortSignal/crash → reject + terminate + ★ TempFileMgr.cleanup(jobId)
 storeExtractionResult (serialized DB write)
```

**Critical:** today a single lane = a single worker, and the orchestrator `await`s each media job. With many
videos the lane is a queue of one. Precondition #2 is what turns this diagram from "serial" into "pipelined."

---

## 7. Data flow diagram (one video file)

```
foo.mp4 (bytes on disk; NOT read into the string-source path — async/binary)
   │
   ├─(6c-1) ffprobe ─► {duration, container, vstreams[res,fps,codec], astreams[lang], subs[lang,format]}
   │            └─► document node (kind:document, language:'video', metadata) + metadata chunk
   │
   ├─(6c-1) subtitle track(s) present?
   │            ├─ embedded → ffmpeg -map s:0 ─► .vtt (TempFileMgr) ─► SRT/VTT/ASS parser
   │            ├─ sidecar  → foo.srt/.vtt next to foo.mp4 ─► parser
   │            └─► section nodes (per cue-group) + chunks {body, metadata:{start,end,track,source:'subtitle'}}
   │
   ├─(6c-2) NO usable subtitle → demux audio (ffmpeg -map a:0 -f f32le) ─► reuse AudioExtractor/STT
   │            └─► section nodes + chunks {metadata:{start,end,sttEngine,source:'stt'}}
   │
   └─(6c-3) keyframes (scene-change or interval) ─► ffmpeg -vf select ─► PNG/JPEG (TempFileMgr)
                ├─ OCR text? ─► chunks {body, metadata:{frameTime, source:'ocr-frame'}}
                └─ pixels ─► (Phase 7b) image embedding ─► vec rows
   │
   ▼
ExtractionResult{ nodes:[document, section…], edges:[contains…], chunks:[…] }  (+ assets? only if thumbnails kept)
   ▼
storeExtractionResult → chunks_fts (searchable now) ; vec (Phase 7)
```

---

## 8. Storage impact

| Need | Verdict | Justification |
|---|---|---|
| Video file metadata (codec, duration, resolution, fps) | **No schema change** | Ride `chunks.metadata` JSON + the `document` node's docstring/qualifiedName, exactly as audio rides `{start,end,speaker,...}` ([audio-extractor.ts:200](src/extraction/languages/audio-extractor.ts)). |
| Subtitle tracks / cues | **No schema change** | Each cue-group → a `section` node + a chunk; timing in `chunk.metadata`. |
| STT segments | **No schema change** | Identical to 6b audio. |
| Frame timestamps / OCR provenance | **No schema change** | `chunk.metadata.frameTime` + `metadata.source`. |
| Thumbnail / keyframe **images** (binary) | **New storage IF persisted** | SQLite is the wrong place for blobs. Recommend: **don't persist pixels** for 6c-3 OCR-only value — OCR the frame, emit text chunk, discard image. If Phase 7b needs pixels, store thumbnails as files under `.witsos/assets/<sha>/` referenced by `chunk.metadata.assetPath`, with an optional `assets(id, file_path, sha, kind, rel_path, meta)` table — **defer this to Phase 7b, not 6c.** |
| `embedding_status` on `files` | **New column — but a Phase 7 prereq, not a 6c need** | Already listed PLAN.md §5. Add when the embed lane lands. |
| Vector table | **Phase 7** | sqlite-vec or sidecar. Out of 6c scope. |

**Bottom line:** 6c-1 and 6c-2 require **zero schema migration** — they emit chunks, which the existing
`chunks`/`chunks_fts` tables already store and search. Only 6c-3 *might* need an `assets` table, and only if it
persists thumbnails — which it should not, until Phase 7b.

---

## 9. Performance analysis

Relative cost per stage (order-of-magnitude; CPU-bound, no GPU assumed):

| Stage | CPU | Memory | Disk/Temp | Bottleneck |
|---|---|---|---|---|
| Metadata (ffprobe) | trivial | trivial | none | process spawn |
| Subtitle extract+parse | low | low | small temp (.vtt) | none — pure JS |
| Audio demux (ffmpeg) | low–med | streams | none if streamed | ffmpeg decode |
| STT (sherpa) | **very high** | **230 MB/hr (whole PCM)** | none | inference, single-thread |
| Keyframe sampling (ffmpeg) | med (scene-detect = full decode) | streams | **N × frame PNG** | full video decode |
| OCR per frame (ONNX) | **high** | per-frame | per-frame | inference × frame count |
| Thumbnail gen | low | low | per-frame | encode |
| Chunk generation | trivial | low | none | none |

**System-level reality:**
- **Throughput is gated by the single-worker lanes + serial `await` loop** (§2.2, §2.3), not raw inference. Ten 1-hour videos today = ten sequential STT runs.
- **Cold cache:** first STT/OCR pays model download (whisper to `~/.witsos/models`) + model load (cached per-process after, [backend.ts:116](src/extraction/stt/backend.ts)). Video doesn't change this — it *reuses* the cached recognizers/engines.
- **Warm cache:** model reuse across files is already in place (recognizer Map keyed by model). Good.
- **Incremental indexing:** binary files are force-deleted before re-extraction ([index.ts:1341](src/extraction/index.ts)) because their content hash is stable across config changes — so **every `sync` re-transcribes/re-OCRs every video unless guarded.** This is a real cost cliff for video. Recommend: a content-hash + config-hash guard so unchanged videos with unchanged config skip re-processing (see Risk R7).
- **4K / hour-long:** keyframe scene-detect forces a full decode of a 4K stream — minutes of CPU per file. Subtitle-first (6c-1) avoids this entirely when captions exist.
- **Many videos:** the dominant scenario; needs pipelining (precondition #2) or it is unusable.

**Latency invariant to preserve:** FTS pre-index and code indexing must stay fast and must not wait on media
(PLAN.md §2). Media is post-processing-shaped; it must never block `witsos index` completion for the code graph.

---

## 10. Stability trade-offs (with recommended defaults)

| Trade-off | Recommendation | Why |
|---|---|---|
| Subtitles vs STT | **Subtitle-first, STT-fallback** | Subtitles are authored text — cheaper, more accurate, no inference. Only transcribe when no usable subtitle track exists. Massive compute saving. |
| Prefer embedded vs sidecar subs | **Sidecar (`foo.srt`) first, then embedded** | Sidecar is free (no demux); embedded needs an ffmpeg map. |
| Trust subtitle timing | **Yes, store as-is** | Cue timestamps are reliable; carry in `metadata.start/end`. |
| OCR every frame vs keyframes | **Keyframes only (scene-change)** | Per-frame OCR is unbounded cost; scene-change frames capture slide/screen transitions. |
| Frame interval | **Scene-detect with a min-interval floor (e.g. ≥2 s)** | Avoids thousands of near-duplicate frames on high-motion video. |
| Frame dedup | **Yes (perceptual/again-scene-threshold)** | Don't OCR/embed near-identical frames. |
| Persist temp images | **No for 6c-3 (OCR then discard)**; files-on-disk only when Phase 7b needs pixels | Avoids blob storage + asset schema until embeddings justify it. |
| Streaming decode | **Stream audio; temp-file keyframes** | Audio already streams; frames can't be all-in-memory. |
| Caching / re-index | **Hash content + config; skip unchanged** | Defeats the force-delete re-process cliff (§9, R7). |
| Early termination | **Cap keyframes/duration per file via config** | Bound worst case on pathological inputs. |
| Retry policy | **No auto-retry of media inference** | Inference failures are deterministic; retry wastes minutes. Degrade to partial. |
| Timeouts | **Scale by duration (as 6b does)**, separate per stage | A stuck ffmpeg must not hang the lane. |
| Partial success | **Yes — emit what succeeded, degrade the rest** | Subtitle ok but keyframe OCR failed → still index subtitles. |

---

## 11. Failure mode analysis

| Failure | Handling |
|---|---|
| Broken/truncated container | ffprobe fails → degrade to document-only node; warn. |
| Unsupported codec | ffmpeg decode error → document-only; warn (never `isError`). |
| No audio stream | Skip STT stage; still do subtitles/metadata. |
| No video stream (audio-in-mp4) | Route as audio (reuse STT); no keyframes. |
| Encrypted/DRM | Decode fails → document-only. |
| Corrupted subtitles | Parser try/catch → skip subs, fall through to STT. |
| Huge file (hours, 4K) | Duration-scaled timeout + memory bound (#4) + keyframe cap. |
| OOM (whole-PCM) | **Precondition #4** — decode to temp file + windowed streaming for long media. |
| Worker crash | JobPool `exit`/`error` reject pending + respawn ([job-pool.ts:228-242](src/workers/job-pool.ts)); **+ TempFileMgr.cleanup(jobId)**. |
| ffmpeg hang/timeout | per-stage timeout → SIGKILL child ([ffmpeg.ts:92](src/extraction/audio/ffmpeg.ts)); reject job. |
| Model missing | `loadSttBackend`/`loadOcrBackend` → null → document-only + install hint ([audio-extractor.ts:80-95](src/extraction/languages/audio-extractor.ts)). |
| Disk full (temp/keyframes) | TempFileMgr write fails → skip keyframe stage, keep text stages; warn. |
| Cancellation (AbortSignal) | submit rejects ([job-pool.ts:133](src/workers/job-pool.ts)); **+ temp cleanup**; partial results already stored are valid. |
| Shutdown mid-index | `pool.shutdown()` rejects pending ([job-pool.ts:192](src/workers/job-pool.ts)); next `sync` resumes (file-level, see R7). |
| Partial DB write | Single-file `storeExtractionResult` is one transaction path; a crash mid-file leaves that file un-upserted → re-processed next run (acceptable). |
| Duplicate chunks | Chunk ids are `chunkId(filePath, index)`; `deleteFile` cascades before insert — no dupes. |
| Hash mismatch / re-index | Force-delete (§9) currently re-processes; add config+content hash guard (R7). |

---

## 12. Risk register

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Async-dispatch god-branch makes video a 5-site edit; future media worse | **High** | Precondition #1: `MediaExtractorRegistry` (async/binary registrations). |
| R2 | Single-worker lanes + serial `await` → unusable on many/large videos | **High** | Precondition #2: real per-lane concurrency + pipelined submit/back-pressure. |
| R3 | Whole-PCM (and large frames) OOM on long media | **High** | Precondition #4: temp-file decode + windowed streaming; keyframe caps. |
| R4 | Keyframe temp images leak on crash/cancel | **Med** | Precondition #3: TempFileMgr with cleanup hooks. |
| R5 | document/section nodes pollute code-flow MCP answers | **Med** | Precondition #5: kind-gate callers/callees/impact (success-shaped "n/a"). |
| R6 | Partial coverage (keyframes w/o embeddings) trains agents to abandon | **High** | Sequence 6c-3 **after** Phase 7; ship subtitle/STT (full value) first. |
| R7 | Every `sync` re-transcribes/re-OCRs all media (force-delete) | **Med** | Content+config hash guard before re-processing binary media. |
| R8 | Install-size / native-build creep (ffmpeg/onnx) | **Med** | Keep all heavy deps opt-in, never bundled; install-size guard test (PLAN §8). |
| R9 | Cross-platform ffmpeg/ffprobe path (Windows `.exe`, ARM) | **Med** | Reuse `locateFfmpeg`; validate on the Parallels Windows VM + Docker Linux. |
| R10 | Version floor mismatch (engines 20 vs node:sqlite 22.5) | **Low–Med** | Raise `engines` floor to `>=22.5 <25`; align `MIN_NODE_MAJOR`. |
| R11 | Naming drift: "CodeGraph"/`codegraph_*` increasingly misnames a media engine | **Low** | Cosmetic; binary already `witsos`. Defer a rename pass. |

---

## 13. Refactoring recommendations (with timing)

| Refactor | When | Rationale |
|---|---|---|
| **Async/binary `MediaExtractorRegistry`** (kill `isAsyncExtractorLanguage` + `runAsyncExtractor` if/else) | **Before 6c** | Video is the 4th async type; the god-branch is now clearly the wrong shape. Follows "refactor first, then add types." |
| **JobPool concurrency: implement or document; pipeline media submit** | **Before 6c** | R2; the heaviest workload must be parallelizable. |
| **TempFileMgr** (scratch dir + cleanup on done/crash/cancel) | **Before 6c-3** (not needed for 6c-1/6c-2) | Keyframes write to disk; nothing owns cleanup. |
| **Media memory bound** (decode-to-temp + windowed streaming) | **Before 6c-2** (also fixes 6b) | R3 — long audio tracks already at risk. |
| **MCP kind-gating** (callers/callees/impact) | **Before/with 6c** | R5; already overdue (PLAN §6). |
| **embedding_status column + two-dimension `witsos status`** | **Before Phase 7** | PLAN §5; not a 6c need but gates 6c-3 (which rides embeddings). |
| **Re-process guard** (content+config hash for binary media) | **During 6c** | R7; otherwise sync cost is unbounded. |
| **Raise Node floor to 22.5** | **Independent, anytime** | R10; removes the recurring confusing error. |
| **`assets` table + thumbnail storage** | **Phase 7b only** | Don't build blob storage until embeddings need pixels. |
| **Rename CodeGraph→WitsOS in tool/type names** | **After Phase 7** | Cosmetic; avoid churn mid-feature. |

---

## 14. Preconditions checklist (must be true before 6c starts)

- [ ] **P1 — Generalized async/binary dispatch.** A registry expresses `{match, lane, createAsync(filePath, bytesOrPath, cfg, tmp)}`; `indexAll` drives media from it; `isAsyncExtractorLanguage`/`runAsyncExtractor` collapse into it. *Why: video must be one registration + one worker, not a 5-site edit.*
- [ ] **P2 — Lane concurrency decided + media pipelined.** Either implement multi-worker lanes or remove the `concurrency` option; orchestrator submits media without per-file `await` serialization, with a bounded in-flight window. *Why: R2 — usability on many/large videos.*
- [ ] **P3 — TempFileMgr** with guaranteed cleanup on success/crash/cancel/timeout. *Why: keyframes write to disk (only blocks 6c-3).* 
- [ ] **P4 — Media memory bound.** Long-media decode goes to temp + windowed streaming; per-file caps. *Why: R3, also fixes latent 6b OOM.*
- [ ] **P5 — MCP kind-gating** for callers/callees/impact (success-shaped "not applicable" for document/section). *Why: R5, partial-coverage discipline.*
- [ ] **P6 — Re-process guard** (content+config hash) so `sync` skips unchanged media. *Why: R7.*
- [ ] **P7 (for 6c-3 only) — Phase 7 embed lane + `embedding_status` exist.** *Why: keyframe value is image embeddings; OCR-only = partial coverage (R6).*

---

## 15. Postconditions checklist (must be true after 6c succeeds)

- [ ] **No code regression** — `codegraph_status` node/edge totals for code files byte-identical before/after (PLAN §8).
- [ ] **Worker stability** — crash/timeout/cancel respawn cleanly; no orphaned ffmpeg children; no leaked temp files.
- [ ] **Memory bounded** — hour-long + 4K media index without OOM.
- [ ] **Search works** — subtitle/STT/OCR text discoverable via `witsos query` (chunks_fts) with timing metadata.
- [ ] **Chunks generated** — `document` + `section` nodes + chunks per video, with `metadata.source` provenance.
- [ ] **Partial failures recover** — subtitle-ok/keyframe-failed still indexes subtitles; all failures degrade, none `isError`.
- [ ] **Status reporting** — `witsos status` shows media progress distinctly (and embedding% once Phase 7 lands).
- [ ] **Cancellation** — AbortSignal drains workers + cleans temp; stored partials remain valid.
- [ ] **Tests + benchmarks** — video-extractor, subtitle parser, gating matrix, node-count parity canary, install-size guard; throughput numbers recorded.
- [ ] **Install size unchanged** — `pnpm pack` size flat; ffmpeg/onnx/models still opt-in, never bundled.
- [ ] **Cross-platform** — validated on macOS (dev), Linux (Docker `--init`), Windows (Parallels VM); ffmpeg `.exe`/ARM path resolution confirmed.
- [ ] **Incremental** — re-`sync` of unchanged videos is a no-op (P6).

---

## 16. Phase 7 readiness report

**Verdict: GO WITH CONDITIONS.**

**Key insight: Phase 7 does NOT depend on Phase 6c.** Embeddings consume `chunks` — a media-agnostic abstraction
(`ChunkRecord`) that *already exists* and is *already populated* by code/docs/PDF/OCR/STT. The embed lane is
reserved in `JobKind` (`'embed'`, [job-pool.ts:24](src/workers/job-pool.ts)) and unused. Therefore embeddings can
proceed in parallel with — or before — most of video.

**Conditions to start Phase 7 (independent of video):**
1. `embedding_status` column on `files` + two-dimension `witsos status` (FTS% / embed%) — PLAN §5.
2. Embeddings stay **media-agnostic**: embed `chunks`, never branch on `language === 'video'`. (Answers Step 10: embeddings should NOT know video exists; subtitle/STT/OCR/metadata all normalize to chunks upstream.)
3. The **image/keyframe** cross-modal case is explicitly a separate **Phase 7b** (image embeddings + optional `assets` storage) — do not smuggle pixels into the text-chunk path.
4. Decide local model strategy (privacy/size) before the embed lane ships — PLAN §7 risk.
5. P1/P2 (dispatch + lane concurrency) benefit Phase 7's embed lane too; doing them first de-risks both.

**Why not unconditional GO:** without the `embedding_status`/status work and the media-agnostic contract, the embed
lane would either block `index` completion or produce a silent "is semantic search ready?" gap — the same
partial-coverage failure the project forbids.

**Why not NO GO:** there is no hard technical blocker — chunks, the worker pool, and the lane reservation all exist.

---

## 17. Concrete recommendations, ordered by implementation priority

1. **Pay P1 (generalized async/binary dispatch).** Highest-leverage refactor; everything else rides it. *(before 6c)*
2. **Pay P2 (lane concurrency + pipelined media submit).** Makes media throughput viable. *(before 6c)*
3. **Pay P4 (media memory bound) + P3 (TempFileMgr).** Removes the OOM/leak class. *(before 6c-2/6c-3)*
4. **Pay P5 (MCP kind-gating) + P6 (re-process guard).** Cheap, overdue, protects answers and sync cost. *(with 6c)*
5. **Ship 6c-1 (metadata + subtitles).** Cheapest, highest value/cost ratio, pure-JS, no schema change, no new native dep. *(before Phase 7)*
6. **Ship 6c-2 (audio-track STT, subtitle-fallback).** Reuses 6b entirely. *(before Phase 7)*
7. **Start Phase 7 (embeddings over chunks)** once its conditions (§16) are met — in parallel with the above; it does not wait on keyframes.
8. **Ship 6c-3 (keyframes + visual)** *after* Phase 7's embed lane exists, as keyframe-OCR + image-embedding together (full coverage), with `assets` storage decided as **Phase 7b**. *(after/with Phase 7)*
9. **Raise the Node floor to 22.5** to kill the recurring version error. *(independent)*
10. **Defer the CodeGraph→WitsOS naming pass** to after Phase 7. *(cosmetic)*

---

## Verification protocol for this design (when 6c is later built)

Per PLAN.md §8 + ConRADL validation methodology:
1. **Suite green** — `pnpm test` (esp. `extraction.test.ts`, `audio-stt.test.ts`, installer contract suite).
2. **Node-count parity** — re-index this repo before/after; `codegraph_status` code node/edge totals unchanged.
3. **New-type smoke** — fixture `.mp4` (with sidecar `.srt`) → `witsos index` → confirm `document`+`section` nodes appear → `witsos query <caption phrase>` finds the chunk with timing metadata.
4. **Degradation matrix** — no ffmpeg / no sherpa / no subtitle / unsupported codec each → document-only, never `isError`.
5. **Probe scripts** — `scripts/agent-eval/probe-*.mjs` against built `dist/`; code-flow explore still connects end-to-end (no media pollution).
6. **Install-size guard** — `pnpm pack` size flat; media deps remain optional packages.
7. **Cross-platform** — Docker Linux (`--init`) + Parallels Windows VM ffmpeg path resolution.