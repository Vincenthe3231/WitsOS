# Phase 6 — Audio Ingestion, Speech-to-Text & Generalized Worker Pool

> Design document **and** implementation plan. Phase 6 is both a feature phase (audio → searchable
> transcripts in the knowledge base) and an architectural milestone (the reusable worker pool that
> OCR, STT, and embeddings all inherit). Per the maintainer's decisions: **sherpa-onnx** STT backend
> (ONNX, no Python, prebuilt, opt-in, `pnpm`-installed), a **hand-rolled generalized JobPool**, and
> **video deferred** to a later phase — Phase 6 ships **audio-only**, sized for a common computer user
> and knowledge-base usability under WitsOS's zero-native-build / local-first constraints.

---

## Context — why this change

`PLAN.md` Phase 6 introduces audio/video ingestion **and** the worker pool listed in §5 as a
prerequisite for Phase 7 (embeddings) and a pull-forward of the Phase 5 "dedicated OCR worker thread"
spike. The forcing problem is concrete and already in the tree:

- **Heavy extractors run serially on the main thread today.** `ExtractionOrchestrator.indexAll`
  routes image OCR and PDF through `runAsyncExtractor` ([src/extraction/index.ts:1397](src/extraction/index.ts) and
  [:1790](src/extraction/index.ts)), which `await`s each file inline in the batch loop. OCR/STT/embedding
  are 10–100× heavier than tree-sitter; running them on the main thread blocks the whole index and
  starves the MCP socket/watchdog.
- **The single recycled parse-worker** ([src/extraction/parse-worker.ts](src/extraction/parse-worker.ts), managed by inline
  closures `ensureWorker`/`recycleWorker`/`requestParse` in `indexAll`) is the right idea but is
  hard-wired for one worker and one job kind.

The intended outcome: a **generalized JobPool** that (a) moves every heavy extractor off the main
thread, (b) keeps DB writes serialized on the main thread, and (c) becomes the substrate Phase 7
reuses — delivered alongside the first heavy consumer, **audio STT**, as an opt-in capability that a
normal user can turn on without breaking the pure-WASM default install.

---

## 1. Executive summary

| Decision | Choice | Rationale |
|---|---|---|
| STT runtime | **sherpa-onnx** (the `sherpa-onnx` package, `pnpm add`) behind a pluggable `SttBackend` seam | node-addon-api + onnxruntime, **prebuilt** cross-platform, **no Python**; runs Whisper / Parakeet / Moonshine / SenseVoice as ONNX; ships VAD + diarization. Same onnxruntime family Phase 5 OCR already uses → one runtime story. Model choice stays configurable behind the seam. |
| Concurrency | **Hand-rolled generalized `JobPool`** (`src/workers/`) | Generalizes the existing single-worker manager; zero new deps; the only design that models the WASM-recycle-every-250 invariant Tinypool/Piscina don't. Per-kind concurrency caps, bounded queue, priority lanes, AbortSignal cancel, graceful shutdown. |
| Media decode | **FFmpeg** via `ffmpeg-static` (optional, user-pulled), child-process sidecar | Normalizes any audio (`mp3/m4a/flac/ogg/opus/wav`) → 16 kHz mono PCM that STT wants. GPL-3.0 binary kept at arm's length from WitsOS's package (never bundled). |
| Scope | **Audio STT (6a) + worker pool.** Video deferred. | Per maintainer. Ships one capability fully (transcripts with timestamps, status, search) rather than half-shipping video — honors PLAN's no-partial-coverage rule. |
| Default install | **Unchanged** — pure WASM + `node:sqlite` | STT/FFmpeg/models are opt-in (`WitsOS.json` `"stt": { "enabled": true }`) + optional packages, gated exactly like OCR. |

Everything heavyweight is opt-in and lazy-loaded, returning `null`-not-throw when absent (the OCR
backend pattern). The code-indexing path stays byte-stable; node/edge counts for code files are a
hard regression canary.

---

## 2. Current architecture analysis

**Pipeline** (`files → ExtractionOrchestrator → DB`), with the relevant seams already in place:

- **File enumeration / classification** — `scanDirectory*` (git-visible or fs walk) → `detectLanguage`
  + `EXTENSION_MAP`. Classification is extension-based; adding a type = one `EXTENSION_MAP` entry.
- **Adapter stage** — `adaptFile` ([src/extraction/source-adapter.ts](src/extraction/source-adapter.ts)): binary-safe `SourceAdapter`
  registry, first-match-wins, `IdentityAdapter` UTF-8 default. The pre-extraction normalization seam.
- **Extractor dispatch** — `resolveExtractor` ([src/extraction/extractor-registry.ts](src/extraction/extractor-registry.ts)):
  `StandaloneExtractor.extract(): ExtractionResult | Promise<ExtractionResult>` — **already async-capable**;
  first-match-wins; falls through to tree-sitter. Adding a type = one `registerExtractor` call.
- **Sync (tree-sitter) path** — `requestParse` → single recycled parse-worker. Recycle @ 250 parses
  (`WORKER_RECYCLE_INTERVAL`, WASM heap never shrinks), per-language reset @ 5000
  (`PARSER_RESET_INTERVAL` in the worker), 10 s + scaled timeout, crash → reject-all + respawn,
  post-pass retry for WASM-OOM files. Reads batched `FILE_IO_BATCH_SIZE = 10` in parallel.
- **Async (heavy) path — the bottleneck** — `isAsyncExtractorLanguage(lang)` (`grammars.ts`) routes
  image/PDF to `runAsyncExtractor`, which runs **inline on the main thread**, one file at a time
  ([src/extraction/index.ts:1401–1428](src/extraction/index.ts)). This is what the pool replaces.
- **Storage (main thread only)** — `storeExtractionResult` ([src/extraction/index.ts:1810](src/extraction/index.ts)):
  hash-skip, `deleteFile` cascade, `insertNodes`/`insertEdges` (FK-filtered), cross-file incoming-edge
  re-resolution (#899), `upsertFile`, `insertChunks` → `chunks_fts`. SQLite (`node:sqlite`) is not
  thread-safe → **all writes serialize here. Invariant; must not regress.**
- **Backend seam reference** — `OcrBackend` ([src/extraction/ocr/backend.ts](src/extraction/ocr/backend.ts)) +
  `ImageExtractor` ([src/extraction/languages/image-extractor.ts](src/extraction/languages/image-extractor.ts)): lazy-load optional
  dep, cache engine, `loadOcrBackend()` returns `null` when absent; extractor degrades to
  document-only (no chunks) when disabled / package missing / recognition fails. `WitsOS.json` `ocr`
  block validated + cached in [src/project-config.ts](src/project-config.ts). **This trio is the exact template for STT.**
- **Force-re-extract for binaries** — binary files have a stable content hash even when config
  changes, so `indexAll` calls `deleteFile` before async extraction (index.ts:1407) to bypass the
  hash-equality skip. STT needs the same when `stt.model` changes.

**Where the pool integrates:** replace the inline worker closures in `indexAll` with a `JobPool`
instance, and reroute *both* `requestParse` and `runAsyncExtractor` through it. Producer (read +
adapt) submits jobs; pool runs them across kind-scoped lanes; main thread drains results into
`storeExtractionResult`.

**Note — schema/kinds have already grown for docs:** `document` and `section` node kinds are in use
(image-extractor), beyond the code-centric `NodeKind` list in CLAUDE.md. Phase 6 adds audio segment
nodes in the same family — they must be gated out of code-flow MCP tools (see §14).

---

## 3. Worker pool architecture — the `JobPool`

New module `src/workers/job-pool.ts`. A typed, kind-routed pool; the existing inline parse-worker
logic generalized — **not** a third-party pool (Tinypool/Piscina can't express the per-250-parse WASM
recycle and would be bent out of shape to do so; the repo's ethos is hand-rolled mechanism, e.g. the
TOML serializer).

```ts
type JobKind = 'parse' | 'ocr' | 'stt' | 'embed';      // 'embed' reserved for Phase 7

interface Job<I, O> {
  kind: JobKind;
  payload: I;                 // e.g. { filePath, content, language, frameworkNames }
  priority?: number;          // lower = sooner; default by kind (parse < ocr < stt)
  signal?: AbortSignal;
  timeoutMs?: number;         // default by kind; STT scales with audio duration
}

class JobPool {
  submit<I, O>(job: Job<I, O>): Promise<O>;   // queues; resolves with worker result
  capacityFor(kind: JobKind): number;          // free slots — producer backpressure
  onDrain(kind: JobKind): Promise<void>;       // resolves when a lane has capacity
  drain(): Promise<void>;                       // await all in-flight + queued
  shutdown(): Promise<void>;                    // terminate all, reject pending
}
```

**Transport — hybrid, by kind (the key design point):**

- `parse`, `ocr`, `stt` recognition → **`worker_threads`** (WASM tree-sitter; ONNX native addons —
  `onnxruntime-node`, `sherpa-onnx` — are addon-safe in worker threads).
- **FFmpeg** decode → **`child_process`** spawned *from inside* the `stt` worker (a separate CLI
  binary, killable, isolated, security-flagged). The stt worker orchestrates: spawn ffmpeg → PCM
  buffer → sherpa-onnx recognize in-thread → return `ExtractionResult`. The pool's lane abstraction
  also leaves room for a future long-lived `child_process` sidecar lane (if a Python engine is ever
  added) without core change.

**Per-kind worker entrypoints:** one script per kind under `src/workers/` (move `parse-worker.ts`
here as `workers/parse-worker.ts`; add `ocr-worker.ts`, `stt-worker.ts`). Each loads only its own
deps (parse → grammars; stt → sherpa-onnx + model). The pool spawns/recycles per kind.

**Concurrency caps (RAM-aware, not just CPU):**

| Kind | Default cap | Why |
|---|---|---|
| parse | ≈ CPU count (clamped) | light (~50–100 MB/worker for grammars); throughput win over today's single worker |
| ocr | 1–2 | ONNX det/rec sessions are memory-heavy |
| stt | 1 (configurable) | model resident in RAM (base ≈ 150–300 MB, small ≈ 0.5–1 GB); realtime-bound, not parallelism-bound |
| embed | (Phase 7) | TBD |

Overridable via `WitsOS.json` `workers` block. Caps are the backpressure ceiling: the producer awaits
`onDrain(kind)` before submitting more, so file contents/audio buffers never accumulate unbounded
(critical on large repos).

**Lifecycle preserved from today, generalized:** timeout per kind → terminate + reject + respawn;
crash (native segfault on bad media / WASM OOM) → reject in-flight on that worker, respawn, mark file
errored, continue; recycle after N jobs (parse keeps 250; stt/ocr recycle by RSS threshold or after
each large job since models dominate). Graceful shutdown rejects pending. **DB writes never move off
the main thread** — workers only return `ExtractionResult`.

---

## 4. Job scheduling design

- **Priority lanes, no head-of-line blocking.** Lanes run concurrently: `parse` drains first so code
  search is ready fast; `ocr`/`stt` run in background lanes and never block code/doc indexing. This
  is the PLAN §2 "classifier → parallel handlers" invariant, realized through the pool.
- **Producer/consumer with bounded in-flight.** The batch loop becomes: read+adapt file → `submit`
  → collect result promise; gate new reads on `capacityFor`/`onDrain`. Replaces today's
  `await requestParse` serial step. Memory bounded by `Σ cap` across lanes, not file count.
- **Resumability (operationally important for STT).** STT over hundreds of files = hours; a `file_jobs`
  table (§9) records per-(file, kind) state so an interrupted run resumes — skip `done`, retry
  `pending`/`errored` — instead of re-transcribing from scratch.
- **Cancellation.** `witsos` Ctrl-C / `AbortSignal` propagates: pending jobs dropped, in-flight
  worker terminated (forceful) or allowed to finish (graceful) per kind.

---

## 5. STT engine comparison & decision

Requirements weighed: **no Python in the default path · prebuilt (no compile) · local/offline ·
cross-platform · diarization + word/segment timestamps · ecosystem maturity · fits the in-process
ONNX pattern already established by Phase 5.**

| Engine | Runtime | Prebuilt Node? | Python? | Diarization | Fit |
|---|---|---|---|---|---|
| **sherpa-onnx** ✅ | onnxruntime (native addon) | **Yes** (`sherpa-onnx` pkg, node-addon-api, multi-thread) | No | **Yes** (segmentation + speaker embeddings) + VAD | **Best.** Runs Whisper/Parakeet/Moonshine/SenseVoice as ONNX → engine-agnostic behind one runtime; same onnxruntime family as OCR; Apache-2.0. |
| whisper.cpp Node (nodejs-whisper, @fugood/whisper.node) | GGML/GGUF C++ | Mostly **build-on-install** (cmake) | No | No (Whisper only) | Breaks zero-native-build even opt-in; no diarization. |
| faster-whisper / WhisperX | CTranslate2 / PyTorch | No | **Yes** | WhisperX: best | Heaviest; Python sidecar packaging burden; furthest from the pattern. |
| OpenAI Whisper (ref) | PyTorch | No | **Yes** | No | Slow, heavy, Python. Reference only. |
| NVIDIA Parakeet / NeMo | NeMo/PyTorch (or **ONNX via sherpa-onnx**) | via sherpa-onnx | (native: yes) | — | Fast + accurate; **consume as an ONNX model through sherpa-onnx**, not the NeMo stack. |
| Moonshine | ONNX | via sherpa-onnx | No | No | Tiny/fast English short-form; **a model choice under sherpa-onnx**. |
| Vosk | Kaldi | Yes (native) | No | limited | Lightweight/streaming but lower accuracy; superseded by sherpa-onnx in the same niche. |
| DeepSpeech | TF | — | — | — | Abandoned. Reject. |
| Cloud (Deepgram/AssemblyAI/OpenAI) | API | — | — | yes | Breaks local-first. **Comparison only.** |

**Decision: `sherpa-onnx` as the backend *runtime*, model configurable.** It turns "which STT
engine?" into "which ONNX model?" (a `WitsOS.json` setting), so Whisper-base for accuracy,
Parakeet/Moonshine for speed, multilingual variants — all swap without code change. VAD + diarization
come built in.

**`SttBackend` seam** (`src/extraction/stt/backend.ts`), mirroring `OcrBackend`:

```ts
interface SttSegment { text: string; start: number; end: number; speaker?: string; confidence: number }
interface SttResult  { segments: SttSegment[]; language: string; engine: string }
interface SttOptions { language?: string; model?: string; diarize?: boolean; minConfidence?: number }
interface SttBackend { readonly name: string; transcribe(audio: Buffer, opts?: SttOptions): Promise<SttResult> }
async function loadSttBackend(): Promise<SttBackend | null>   // lazy import('sherpa-onnx'); null if absent
function __setSttBackendForTests(b: SttBackend | null | undefined): void
```

`SherpaOnnxSttBackend` lazy-loads `sherpa-onnx`, caches the recognizer (model load is expensive),
VAD-segments long audio, optionally diarizes. Engine + model id stored in chunk metadata for
provenance and for re-transcribe invalidation.

**Model management** (`src/extraction/stt/models.ts`): models (40 MB–1.5 GB) are **never bundled** —
resolved from `stt.model` (size keyword or path) → cache dir (`~/.witsos/models/` or
`.witsos/models/`) → downloaded over HTTPS with **checksum verification** on first use, or supplied
via `stt.modelPath` for offline/air-gapped users. Status surfaces "model ready / downloading / missing".

---

## 6. FFmpeg evaluation

STT needs uniform 16 kHz mono PCM; arbitrary audio (`mp3/m4a/aac/flac/ogg/opus/wma`) must be decoded.
A pure-JS demux can't cover the codec spread; FFmpeg is the pragmatic decoder.

- **Distribution:** `ffmpeg-static` ships a prebuilt static binary per platform (mac x64/arm64,
  linux x64/arm64/armhf, win x64) — **no compile** (zero-native-build-compatible *mechanism*), but
  ~70 MB and **GPL-3.0**. Keep it an **optional, user-pulled** dependency (`pnpm add ffmpeg-static`),
  never bundled into WitsOS's MIT package, so GPL stays at arm's length from distribution. Also accept
  a system `ffmpeg` on `PATH` (`stt.ffmpegPath` override) so users who already have it skip the download.
- **Probe:** `ffprobe` (via `ffmpeg-ffprobe-static`) for duration → scales the STT timeout and powers
  status ETAs.
- **Wrapper** `src/extraction/audio/ffmpeg.ts`: locate binary → spawn child to decode → **pipe PCM
  to stdout into a Buffer** (no temp file where possible; scratch dir + cleanup as fallback) → feed
  sherpa-onnx. Security flags (see §12): `-nostdin`, `-protocol_whitelist file`, no network, timeout,
  killable.
- **Alternatives** (`@ffmpeg-installer/ffmpeg`, `@rse/ffmpeg`) are equivalent prebuilt-binary plays;
  no meaningful advantage. WASM `ffmpeg.wasm` is too slow for batch decode. → **FFmpeg stays optional,
  via `ffmpeg-static`/PATH.**

---

## 7. Audio ingestion strategy (video deferred)

`AudioExtractor` (`src/extraction/languages/audio-extractor.ts`) — structural twin of `ImageExtractor`:

1. Re-read file as bytes (binary; orchestrator passes UTF-8). 2. FFmpeg decode → 16 kHz mono PCM
buffer. 3. `SttBackend.transcribe` (VAD-segmented; optional diarization). 4. Emit **1 `document`
node** (whole file) + **`section` nodes per transcript window/segment** + **chunks** in `chunks_fts`,
with **`{ start, end, speaker?, sttEngine, sttModel, confidence }` in chunk metadata** so search can
deep-link to a timestamp ("jump to 03:12") — the core KB-usability win for a common user.

**Gating mirrors OCR exactly** (no-partial-coverage rule): STT disabled → document-only, zero chunks;
enabled but `sherpa-onnx`/`ffmpeg` missing → document-only + one-line warn (never an error result);
music/silence-only or all-sub-`minConfidence` → document-only. Wire-up: `audio` Language +
`EXTENSION_MAP` entries + `isAsyncExtractorLanguage('audio') = true` + `registerExtractor` + route the
async path through the **pool's `stt` lane** (not main thread).

**Video deferred** to its own later phase: audio-track STT, **embedded subtitle/caption extraction**
(`ffmpeg -map 0:s` → SRT/VTT → chunks; cheap, deterministic, no model — likely the first video win),
keyframe/scene extraction (needs VLM/embeddings). Deferring avoids half-shipping video.

---

## 8. Plugin / backend architecture

The three capability seams — `OcrBackend`, `SttBackend`, future `EmbeddingBackend` — are the plugin
system. Each: lazy-loads an **optional** package (`pnpm add …`), **`null`-not-throw** when absent, configured
by a `WitsOS.json` capability block, model/runtime resolved on demand. The repetition is now deliberate
enough to extract a generic helper `loadOptionalBackend<T>(pkg, factory)` (dedupes the
`loadOcrBackend`/`loadSttBackend` probe + cache).

- **Sidecar lifecycle:** FFmpeg = child-process per job (killable, timeout, security-flagged);
  sherpa-onnx = in-thread native addon; a future Python engine = long-lived child-process sidecar over
  stdio — all expressible as pool lanes without touching the core.
- **Discovery / capability negotiation:** on enable, probe package + model presence; surface in
  `witsos status` ("STT: enabled · model base ready" vs "enabled but `sherpa-onnx` not installed —
  `pnpm add sherpa-onnx`").
- **Versioning:** record `{ engine, model }` in chunk metadata + file record → re-transcribe only when
  the model/engine changes (the binary-hash-stable invalidation problem, solved like OCR's
  `deleteFile`-before-extract).
- **Config (`WitsOS.json`):**
  ```jsonc
  {
    "stt": { "enabled": false, "model": "base", "language": "auto",
             "diarize": false, "modelPath": null, "ffmpegPath": null, "minConfidence": 0.0 },
    "workers": { "parse": null, "ocr": 1, "stt": 1 }   // null = auto (≈ CPU for parse)
  }
  ```
  Validated + cached in `project-config.ts` exactly like the `ocr` block (frozen defaults,
  warn-and-skip on malformed, mtime cache).

### 8.1 Interactive opt-in — detect the extension, offer to enable (don't make users hand-edit JSON)

Requiring a user to know about and hand-write `WitsOS.json` `"stt": { "enabled": true }` is poor
discoverability. Instead, **detect eligible files during a CLI run and offer to turn the capability on**
— but gated so it never misbehaves headless. (This applies to OCR too, retrofitting the same flow.)

**Flow (interactive CLI only — `witsos init` / `index`):** after the scan, if eligible files are
present (`audio` for STT, `image` for OCR), the capability is **unset** in `WitsOS.json`, **and**
`process.stdout.isTTY`:

```
Found 23 audio files (.mp3, .m4a). Enable speech-to-text?
  This installs sherpa-onnx + ffmpeg-static (~80 MB) and downloads the "base" model (~150 MB).
  Transcripts become searchable in your knowledge base.  [y/N]
```

- **Yes** → write `stt.enabled: true` (+ chosen model) to `WitsOS.json`; offer to run
  `pnpm add sherpa-onnx ffmpeg-static` (or print it); proceed (this run indexes audio if deps already
  present, else next run).
- **No** → write `stt.enabled: false` so the choice is **remembered** and we never re-prompt; audio
  indexes document-only.

**Hard gates (so the prompt never becomes a liability):**
- **Non-interactive contexts never prompt** — MCP daemon (`serve --mcp`), CI, piped/`--yes`, non-TTY:
  a server that blocks on stdin would wedge, and prompting an agent violates the "errors/prompts teach
  abandonment" rule. There it stays the silent default (off → document-only).
- **Decision persists in `WitsOS.json`** (the shared, VCS-committed config), so it's a **one-time**
  prompt per project, and a team inherits the choice.
- A `--no-prompt` flag and a `WitsOS.json` `"prompts": false` escape hatch both suppress it.

This keeps zero-config-default-off intact for agents/servers while giving a human running `witsos`
a one-keystroke path to enabling the feature — discoverability without breaking local-first or the
never-bundled rule (deps are still opt-in, just offered at the right moment).

---

## 9. Performance & 10. Scalability

- **Cold start:** sherpa-onnx model load 0.5–3 s (paid once, recognizer cached across files); ffmpeg
  spawn ~50 ms/file.
- **Throughput (the dominant reality):** STT is realtime-factor-bound — Whisper-base on CPU ≈ 2–8×
  realtime (10-min clip → ~1.5–5 min); Parakeet/Moonshine faster. A repo with hundreds of audio files
  = **hours**. ⇒ STT **must** be a background lane, never blocking code/doc indexing, and **resumable**
  (`file_jobs`). Parse, by contrast, gets *faster* than today: N parse workers vs one.
- **Memory:** caps are RAM-aware (§3); STT cap 1 by default keeps a single model resident. Pool
  budget respects machine RAM rather than blindly using CPU count.
- **Disk/temp:** prefer ffmpeg PCM piped to a Buffer (no temp file); scratch-dir fallback with cleanup.
- **Incremental:** hash-skip unchanged files; re-transcribe only on model/engine change.
- **DB contention:** unchanged — serialized main-thread writes. The pool can *produce* results faster
  than one worker did, so **confirm `storeExtractionResult` batches per-file inserts in a transaction**
  (PLAN §6 item) to avoid the write path becoming the new bottleneck.
- **Scales to large repos** because heavy lanes are bounded + backgrounded + resumable; code search
  readiness is decoupled from transcript completeness (two progress dimensions, §below).

---

## 11. Failure recovery

| Failure | Handling |
|---|---|
| ffmpeg fails (corrupt/DRM/no audio track) | degrade to document-only + warn; never error the run (mirrors `ImageExtractor`) |
| STT worker crash (addon segfault on bad input) | pool rejects in-flight job on that worker, respawns, marks file `errored`, continues |
| Timeout (pathological/huge file) | per-kind timeout (STT scaled by ffprobe duration) → terminate + respawn |
| Transient (worker OOM) vs deterministic (corrupt file) | retry-once on a fresh worker for transient (parse already does); no retry for deterministic |
| Model missing/offline | document-only + actionable warn; status shows "model missing" |
| Interrupted run | `file_jobs` resumes — skip `done`, retry `pending`/`errored` |

---

## 12. Risk analysis

- **Zero-native-build (highest):** `sherpa-onnx` (prebuilt addon) and `ffmpeg-static` (prebuilt
  binary) are both native + large. **Mitigation:** opt-in + optional packages, gated like OCR; default
  `pnpm` install stays pure WASM + `node:sqlite`; **install-size guard** (`pnpm pack`) must not grow.
- **License:** `ffmpeg-static` is GPL-3.0 → keep as a user-pulled optional dep, never bundled, so GPL
  doesn't infect WitsOS's MIT distribution. `sherpa-onnx` Apache-2.0 (verify at pin time). Document both.
- **Model distribution:** 40 MB–1.5 GB; never bundled; HTTPS download + checksum verify + cache;
  `modelPath` for air-gapped.
- **Security (FFmpeg parses untrusted media — CVE history):** spawn with `-nostdin`,
  `-protocol_whitelist file` (no network/SSRF), timeout, killable, scratch-dir scoped. Verify model
  download checksums. No execution of media-embedded metadata.
- **Partial-coverage debt:** ship audio STT *fully* (timestamps, chunks, status, search) — defer video
  rather than half-ship it.
- **Junk transcripts pollute FTS:** `minConfidence` filter + VAD (skip silence/music) + music-only →
  document-only.
- **Cross-platform:** validate `sherpa-onnx` prebuild load + ffmpeg spawn on **win (current VM) + mac +
  linux (docker)** per CLAUDE.md.
- **Code-path regression:** generalizing the parse worker risks node-count drift — pin with parity
  canary (below). This is the byte-stable-sensitive step.

---

## 13. Recommended implementation plan

Ordered so the risky refactor lands first behind the existing parity tests, then the new capability
stacks on a proven pool.

0. **Extract `JobPool`** — `src/workers/job-pool.ts` from the inline `indexAll` closures; move
   `parse-worker.ts` → `src/workers/parse-worker.ts`. Route `parse` through the pool (cap = parse
   workers; behavior-preserving). **VERIFY node-count parity** before proceeding.
1. **Move OCR/PDF off the main thread** — reroute `runAsyncExtractor` onto the pool's `ocr` lane
   (`src/workers/ocr-worker.ts`). Delivers Phase 5's open "dedicated OCR worker thread" spike. OCR
   tests stay green.
2. **`audio` classification** — `Language` + `EXTENSION_MAP` (`mp3/wav/m4a/aac/flac/ogg/opus/wma`) +
   `isAsyncExtractorLanguage('audio')` in `grammars.ts`.
3. **`SttBackend` seam** — `src/extraction/stt/backend.ts` (`SherpaOnnxSttBackend`, `loadSttBackend`,
   `__setSttBackendForTests`), mirroring `ocr/backend.ts`.
4. **Model management** — `src/extraction/stt/models.ts` (resolve → cache → download + checksum / path).
5. **FFmpeg wrapper** — `src/extraction/audio/ffmpeg.ts` (locate binary, decode → PCM buffer, security
   flags, timeout; ffprobe duration).
6. **`AudioExtractor`** — `src/extraction/languages/audio-extractor.ts`, OCR-style gating; emits
   document + per-segment section nodes + timestamped chunks.
7. **Wire-up** — `registerExtractor(audio)`; route async audio through the pool's `stt` lane.
8. **Config** — `stt` + `workers` blocks in `project-config.ts` (validated, defaults, cached); add a
   `WitsOS.json` writer (the prompt persists the user's choice).
9. **Interactive opt-in (§8.1)** — TTY-gated capability detection in `witsos init`/`index`: eligible
   files + unset capability + `isTTY` → prompt → persist `enabled` to `WitsOS.json` + offer
   `pnpm add`. Hard-gate off for MCP/CI/non-TTY/`--no-prompt`. Retrofit OCR onto the same helper.
10. **Status / UX** — `file_jobs` table (or per-capability columns) tracking per-(file, kind)
   `pending/running/done/error` + retries; `witsos status` reports **separate dimensions**
   (parse/FTS % · ocr % · stt % · embed % later) + queue/retry visibility; add `transcribing` lane to
   `IndexProgress`.
11. **Tests** — fake `SttBackend` (like `__setOcrBackendForTests`); audio-extractor gating matrix;
    opt-in prompt (TTY → prompts + persists choice; non-TTY/`--no-prompt`/daemon → never prompts,
    stays off); pool unit tests (concurrency cap, bounded queue/backpressure, AbortSignal cancel,
    recycle interval, crash → respawn, graceful shutdown); node-count parity canary; install-size guard.
12. **Docs** — `docs/design/phase6-worker-pool-stt.md` (this design); CHANGELOG `[Unreleased]`;
    `PLAN.md` updates (§15).

---

## 14. Suggested repository refactors

- **`src/workers/`** — new home for `JobPool` + per-kind worker entrypoints (relocate `parse-worker.ts`).
- **`loadOptionalBackend<T>`** — generic lazy-load/cache helper deduping `loadOcrBackend` /
  `loadSttBackend` (and Phase 7's embedding backend).
- **Batched SQLite writes** — confirm `storeExtractionResult` per-file inserts are wrapped in a
  transaction (PLAN §6); matters more once the pool feeds results faster.
- **Kind-aware MCP tools** — `callers`/`callees`/`impact` are meaningless on `document`/`section`/audio
  segment nodes; gate by node kind (`src/mcp/tools.ts`, `server-instructions.ts`) so doc/audio nodes
  don't pollute code-flow answers (PLAN §6).
- **`chunks_fts` in search** — ensure `searchNodes`/a `searchChunks` path surfaces transcript chunks;
  a transcript no one can search is half-shipped (PLAN §6).

## 15. Suggested `PLAN.md` updates

- **Phase 5** open spike "dedicated OCR worker thread" → **delivered** by the Phase 6 pool (step 1).
- **Phase 6 row** → split: **6a Audio STT + generalized worker pool** (this work) ✅-track; **video**
  (audio-track STT + embedded subtitles + keyframes) → **new later phase, deferred**. Note: worker pool
  generalized here, reused in Phase 7.
- **§5 prerequisite table** → "Single parse-worker → Worker pool" satisfied by Phase 6; `embedding_status`
  column + explicit classifier still pending for Phase 7.
- **STT backend pivot recorded** (like the OCR ONNX pivot): sherpa-onnx (ONNX, no Python), FFmpeg
  optional, models opt-in/downloaded.

---

## Verification

- **Suite green** — `pnpm test` (esp. `extraction.test.ts`, `frameworks-integration.test.ts`,
  installer contract suite).
- **Node-count parity** — re-index this repo before/after; `codegraph_status` total nodes/edges
  **unchanged for code files** (canary after step 0).
- **Pool unit tests** — N concurrent honored; bounded queue applies backpressure; cancel mid-flight;
  worker crash → respawn + file errored (not whole-run abort); recycle @ interval; graceful shutdown
  rejects pending.
- **Audio smoke** — fixture `.wav` + `stt.enabled` + `sherpa-onnx` installed → `document` + `section`
  nodes + chunk appear → `witsos query` finds transcript text; `{start,end}` in chunk metadata.
  Disabled → document-only, byte-identical to no-STT.
- **Install-size guard** — `pnpm pack` size unchanged (STT/FFmpeg/models optional, not in default).
- **Cross-platform** — ffmpeg spawn + `sherpa-onnx` prebuild load validated on **win (current VM) +
  mac + linux (docker)** per CLAUDE.md.

**Sources (ecosystem grounding):**
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) ·
[sherpa-onnx (registry)](https://www.npmjs.com/package/sherpa-onnx) ·
[tinypool](https://github.com/tinylibs/tinypool) ·
[piscina](https://github.com/piscinajs/piscina) ·
[nodejs-whisper](https://www.npmjs.com/package/nodejs-whisper) ·
[ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)