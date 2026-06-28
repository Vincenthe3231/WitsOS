# Phase 6c Implementation Roadmap

**Status:** Starting preconditions (P1–P5), then 6c-1 (metadata+subtitles).

**Verified against:** LAST_SESSION_PLAN.md + live CodeGraph index (323 files, 5137 nodes).

---

## Preconditions Implementation Order

### Phase 1: P1 — Generalize Async/Binary Dispatch (HIGH LEVERAGE)

**Current state:** Hardcoded god-branch in 5 locations
- `isAsyncExtractorLanguage()` @ grammars.ts:378 → checks `pdf || image || audio`
- `runAsyncExtractor()` @ index.ts:1741 → if/else branches per language
- `indexAll()` @ index.ts:1347,1355 → awaits media serially in per-file loop
- `registerLane()` @ index.ts:1198,1212 → hardcoded 'ocr', 'stt' registration
- Extractor-registry no binary support — `createSync(filePath, source: string)` only

**Deliverable:** MediaExtractorRegistry
- Replaces `isAsyncExtractorLanguage`/`runAsyncExtractor` god-branch
- Exposes `{match, lane, createAsync(filePath, bytesOrPath, cfg, tmp)}`
- Indexing dispatches media through registry, not hardcoded if/else
- `video` language ready to slot in (Phase 6c-1/2/3 only need registration + worker)

**Files changed:**
- `src/extraction/extractor-registry.ts` → new `MediaExtractorRegistry` (mirrors `ExtractorRegistry`)
- `src/extraction/grammars.ts` → remove `isAsyncExtractorLanguage`, add `video` language
- `src/extraction/index.ts` → refactor indexAll media dispatch to use registry
- `src/extraction/languages/` → update Image/Audio/PDF extractors (should be no-op, just wired through registry)
- Tests: `extraction.test.ts` for registry dispatch contract

**Timeline:** 2–3 days (coupled changes, high risk/reward)

---

### Phase 2: P2 — Fix JobPool Concurrency + Pipeline Media Submit

**Current state:** 
- `LaneState.worker` is singleton (line 53 in job-pool.ts)
- `concurrency` option stored but `_ensureWorker` never spawns >1
- Media submitted with per-file `await` → serial execution

**Deliverable:**
- Option 1: Implement true multi-worker lanes (spawn up to `concurrency` workers, queue + distribute)
- Option 2: Remove `concurrency` option, keep 1 worker per lane, fix pipelining

**Recommendation:** Option 2 (simpler, sufficient for video — encode/decode are per-file parallelism, not in-process)
- Remove `concurrency` from LaneOptions
- Remove the "lie" comment
- Pipeline media submits without per-file `await` (back-pressure via bounded in-flight window)

**Files changed:**
- `src/workers/job-pool.ts` → remove concurrency tracking
- `src/extraction/index.ts` → pipeline media submits (submit all, await in batch at end)
- Tests: `job-pool.test.ts` for back-pressure behavior

**Timeline:** 1 day

---

### Phase 3: P3 — TempFileMgr (Temp-File Lifecycle)

**Current state:** None. Tests clean up manually; extractors have no guaranteed cleanup.

**Deliverable:** 
- `TempFileMgr` class: `mkdir`, `writeSync`, `cleanup(jobId)`
- Called by worker on `spawn` (mkdir), on `exit`/timeout/cancel (cleanup)
- Tracks per-job temp files; cascading cleanup on crash/cancel/timeout

**Files changed:**
- `src/extraction/util/tempfile-manager.ts` → new
- `src/workers/` → pass `tmpDir` to workers on spawn
- `src/extraction/audio/ffmpeg.ts` → use TempFileMgr for subtitle demux
- Tests: `tempfile-manager.test.ts` for cleanup contract (especially crash/timeout)

**Timeline:** 1 day

---

### Phase 4: P4 — Media Memory Bound (Streaming Decode)

**Current state:** `decodeAudioToPcm` loads whole PCM into memory (230 MB/hour).

**Deliverable:**
- For audio: stream decode to temp file (or windowed buffer) instead of all-in-memory
- For keyframes: use TempFileMgr, don't hold frame images in memory
- Config options: max-audio-duration-sec (cap before STT even starts), keyframe-cap

**Files changed:**
- `src/extraction/audio/ffmpeg.ts` → add temp-decode option
- `src/extraction/languages/audio-extractor.ts` → use temp-decoded path
- `project-config.ts` → add `media.maxDurationSec`, `media.maxKeyframes`
- Tests: `audio-stt.test.ts` test long-audio with memory cap

**Timeline:** 1 day

---

### Phase 5: P5 — MCP Kind-Gating (Flow Tools)

**Current state:** `callers`, `callees`, `impact` have no filter for `document`/`section` nodes.

**Deliverable:**
- Filter out document/section nodes from callers/callees/impact
- Return success-shaped "not applicable" response for code-only queries against media

**Files changed:**
- `src/mcp/tools.ts` → add kind filter in callers/callees/impact handlers
- Tests: `mcp-tools.test.ts` test gating matrix (code-only, media-only, mixed)

**Timeline:** 1 day

---

## Phase 6c-1 Implementation (Subtitles + Metadata)

**After P1–P5 pass.**

**Deliverable:**
- `VideoExtractor` class (reuses P1 registry dispatch)
- ffprobe metadata extraction → document node + metadata chunk
- Subtitle track detection (embedded + sidecar .srt/.vtt)
- Subtitle parsing (pure-JS SRT/VTT/ASS parser)
- Subtitle-as-chunks (timing in metadata)

**Files changed:**
- `src/extraction/languages/video-extractor.ts` → new
- `src/extraction/subtitles/` → new module (srt-parser, vtt-parser, etc.)
- `src/extraction/audio/ffmpeg.ts` → add demux-subtitle operation
- `src/extraction/grammars.ts` → add .mp4/.mkv/.webm extensions
- Tests: `video-extractor.test.ts`, `subtitle-parser.test.ts`

**Timeline:** 2 days

---

## Preconditions Verification Checklist

- [ ] **P1:** MediaExtractorRegistry wired; code paths use registry, not if/else
- [ ] **P2:** Media pipelined (no per-file await); back-pressure window enforced
- [ ] **P3:** TempFileMgr cleanup tested on crash/cancel/timeout
- [ ] **P4:** Long-audio (1hr+) indexes without OOM; keyframes streamed to temp
- [ ] **P5:** callers/callees/impact exclude document/section; success-shaped response
- [ ] **Code regression:** `codegraph_status` node/edge count byte-identical

---

## Timeline Estimate

- **P1:** 2–3 days (highest risk; coupled changes)
- **P2:** 1 day
- **P3:** 1 day
- **P4:** 1 day
- **P5:** 1 day
- **6c-1:** 2 days
- **Total:** ~9 days

**Dependencies:** P1 → (P2, P3, P4, P5 in parallel) → 6c-1

---

## Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| P1 refactor breaks existing audio/image/PDF | Test each path before merging; integration tests for all three |
| Media pipelining causes OOM before P3/P4 land | P3/P4 consecutive, finish before shipping |
| Temp cleanup fails on Windows file locks | Validate on Parallels Windows VM |
| MCP kind-gating breaks existing workflows | Gentle deprecation in response ("this query applies to code only") |

