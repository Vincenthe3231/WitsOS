/**
 * Generalized worker-thread pool for CPU-heavy extraction jobs (Phase 6).
 *
 * Manages per-kind (parse / ocr / stt / embed) lanes, each with its own
 * worker script, concurrency cap, recycle interval, timeout, and optional
 * spawn hook (e.g. pre-loading WASM grammars in the parse lane).
 *
 * Worker message protocol:
 *   request  → worker receives  { _poolId: number, ...payload }
 *   success  ← worker sends     { _poolId: number, result: <O> }
 *   failure  ← worker sends     { _poolId: number, error: string }
 *
 * Native / WASM crashes (process.exit) are caught via the worker 'exit'
 * event; all in-flight jobs on that worker are rejected and the lane
 * respawns transparently on the next submit().
 *
 * DB writes MUST remain on the main thread — workers return ExtractionResult
 * objects only; callers store them.
 */

import type { Worker as WorkerType } from 'worker_threads';
import { logWarn } from '../errors';

export type JobKind = 'parse' | 'ocr' | 'stt' | 'embed';

export interface LaneOptions {
  /** Absolute path to the compiled worker script (.js). */
  workerScript: string;
  /** Maximum parallel workers for this lane (default 1). */
  concurrency?: number;
  /** Recycle worker after this many completed jobs (0 = never). */
  recycleAfter?: number;
  /** Default timeout per job in ms (default 30_000). */
  timeoutMs?: number;
  /**
   * Called once immediately after a worker thread is spawned, before the
   * lane accepts jobs. Use it to send initialisation messages (e.g.
   * load-grammars) and await their acknowledgement.
   */
  onSpawn?: (worker: WorkerType) => Promise<void>;
  /** Optional verbose logger — receives lifecycle messages. */
  log?: (msg: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LaneState {
  opts: Required<LaneOptions>;
  worker: WorkerType | null;
  jobCount: number;
  pending: Map<number, Pending>;
  nextId: number;
}

export class JobPool {
  private lanes = new Map<JobKind, LaneState>();

  /**
   * Register (or replace) a lane for a job kind. Must be called before
   * the first submit() for that kind. Safe to call when no jobs are
   * in-flight.
   */
  registerLane(kind: JobKind, opts: LaneOptions): void {
    this.lanes.set(kind, {
      opts: {
        workerScript: opts.workerScript,
        concurrency: opts.concurrency ?? 1,
        recycleAfter: opts.recycleAfter ?? 0,
        timeoutMs: opts.timeoutMs ?? 30_000,
        onSpawn: opts.onSpawn ?? (() => Promise.resolve()),
        log: opts.log ?? (() => {}),
      },
      worker: null,
      jobCount: 0,
      pending: new Map(),
      nextId: 0,
    });
  }

  /** Returns true when a lane for `kind` has been registered. */
  hasLane(kind: JobKind): boolean {
    return this.lanes.has(kind);
  }

  /**
   * Submit a job to the named lane. Returns a Promise that resolves with
   * the worker's `result` or rejects on timeout / crash / abort.
   */
  async submit<I extends object, O>(
    kind: JobKind,
    payload: I,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<O> {
    const lane = this.lanes.get(kind);
    if (!lane) throw new Error(`JobPool: no lane registered for kind '${kind}'`);

    if (opts?.signal?.aborted) throw new Error('Aborted');

    // Recycle before the next job if the threshold was reached.
    if (lane.opts.recycleAfter > 0 && lane.jobCount >= lane.opts.recycleAfter) {
      this._recycleSync(kind, lane);
    }

    const worker = await this._ensureWorker(kind, lane);
    const id = lane.nextId++;
    lane.jobCount++;

    const ms = opts?.timeoutMs ?? lane.opts.timeoutMs;

    return new Promise<O>((resolve, reject) => {
      const timer = setTimeout(() => {
        lane.pending.delete(id);
        lane.opts.log(`TIMEOUT: job ${id} exceeded ${ms}ms — killing worker`);
        // Reject first — terminate() can hang if WASM is stuck.
        reject(new Error(`Job timed out after ${ms}ms`));
        if (lane.worker === worker) {
          lane.worker = null;
          lane.jobCount = 0;
        }
        worker.terminate().catch(() => {});
      }, ms);

      lane.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      if (opts?.signal) {
        opts.signal.addEventListener(
          'abort',
          () => {
            const p = lane.pending.get(id);
            if (p) {
              clearTimeout(p.timer);
              lane.pending.delete(id);
              p.reject(new Error('Aborted'));
            }
          },
          { once: true },
        );
      }

      worker.postMessage({ _poolId: id, ...payload });
    });
  }

  /**
   * Pre-warm a lane: spawn the worker and run onSpawn (e.g. grammar loading)
   * before the first submit(). No-op if no lane is registered or worker is
   * already running.
   */
  async warm(kind: JobKind): Promise<void> {
    const lane = this.lanes.get(kind);
    if (!lane) return;
    await this._ensureWorker(kind, lane);
  }

  /**
   * Immediately terminate the current worker for a lane (fire-and-forget)
   * so the next submit() gets a fresh process. Pending jobs on that worker
   * are rejected. Useful for forcing a clean heap before WASM-OOM retries.
   */
  recycle(kind: JobKind): void {
    const lane = this.lanes.get(kind);
    if (lane) this._recycleSync(kind, lane);
  }

  /** Wait for all in-flight jobs across every lane to settle. */
  async drain(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const lane of this.lanes.values()) {
      for (const [, p] of lane.pending) {
        waits.push(
          new Promise<void>((res) => {
            const origResolve = p.resolve;
            const origReject = p.reject;
            p.resolve = (v) => { origResolve(v); res(); };
            p.reject = (e) => { origReject(e); res(); };
          }),
        );
      }
    }
    await Promise.allSettled(waits);
  }

  /** Terminate all workers and reject all pending jobs. */
  async shutdown(): Promise<void> {
    for (const [, lane] of this.lanes) {
      this._rejectAll(lane, 'JobPool shutting down');
      if (lane.worker) {
        const w = lane.worker;
        lane.worker = null;
        await w.terminate().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals

  private async _ensureWorker(kind: JobKind, lane: LaneState): Promise<WorkerType> {
    if (lane.worker) return lane.worker;

    lane.opts.log(`Spawning new ${kind} worker...`);
    const { Worker } = await import('worker_threads');
    const worker = new Worker(lane.opts.workerScript);
    lane.worker = worker;
    lane.jobCount = 0;

    worker.on('message', (msg: { _poolId?: number; result?: unknown; error?: string }) => {
      if (msg._poolId === undefined) return;
      const p = lane.pending.get(msg._poolId);
      if (!p) return;
      clearTimeout(p.timer);
      lane.pending.delete(msg._poolId);
      if (msg.error !== undefined) {
        p.reject(new Error(msg.error));
      } else {
        p.resolve(msg.result);
      }
    });

    worker.on('error', (err) => {
      logWarn(`${kind} worker error`, { error: err.message });
      this._rejectAll(lane, `Worker error (${kind}): ${err.message}`);
    });

    worker.on('exit', (code) => {
      if (lane.worker === worker) {
        lane.worker = null;
        lane.jobCount = 0;
      }
      if (code !== 0 && lane.pending.size > 0) {
        logWarn(`${kind} worker exited unexpectedly`, { code });
        this._rejectAll(lane, `Worker exited with code ${code} (${kind})`);
      }
    });

    await lane.opts.onSpawn(worker);
    return worker;
  }

  private _recycleSync(kind: JobKind, lane: LaneState): void {
    if (!lane.worker) return;
    const w = lane.worker;
    lane.opts.log(
      `Recycling ${kind} worker after ${lane.jobCount} jobs (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`,
    );
    lane.worker = null;
    lane.jobCount = 0;
    // Fire-and-forget — terminate() can hang if WASM is stuck.
    w.terminate().catch(() => {});
  }

  private _rejectAll(lane: LaneState, reason: string): void {
    for (const [id, p] of lane.pending) {
      clearTimeout(p.timer);
      lane.pending.delete(id);
      p.reject(new Error(reason));
    }
  }
}
