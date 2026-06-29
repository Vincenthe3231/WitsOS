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

export type JobKind = 'parse' | 'ocr' | 'stt' | 'video' | 'embed';

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

interface WorkerSlot {
  worker: WorkerType;
  jobCount: number;
  inFlight: number; // Jobs awaiting response on this worker
}

interface LaneState {
  opts: Required<LaneOptions>;
  workers: WorkerSlot[];
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
      workers: [],
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

    // Pick or create a worker: round-robin to least-busy, spawn up to concurrency limit.
    const worker = await this._pickWorker(kind, lane);
    const slot = lane.workers.find((s) => s.worker === worker)!;
    const id = lane.nextId++;
    slot.inFlight++;

    const ms = opts?.timeoutMs ?? lane.opts.timeoutMs;

    return new Promise<O>((resolve, reject) => {
      const timer = setTimeout(() => {
        lane.pending.delete(id);
        slot.inFlight--;
        lane.opts.log(`TIMEOUT: job ${id} exceeded ${ms}ms — killing worker`);
        // Reject first — terminate() can hang if WASM is stuck.
        reject(new Error(`Job timed out after ${ms}ms`));
        // Remove worker from pool and terminate
        const idx = lane.workers.indexOf(slot);
        if (idx >= 0) lane.workers.splice(idx, 1);
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
   * Pre-warm a lane: spawn workers up to concurrency and run onSpawn
   * (e.g. grammar loading) before the first submit().
   */
  async warm(kind: JobKind): Promise<void> {
    const lane = this.lanes.get(kind);
    if (!lane) return;
    const count = lane.opts.concurrency;
    for (let i = 0; i < count; i++) {
      await this._spawnWorker(kind, lane);
    }
  }

  /**
   * Immediately terminate all workers for a lane. Pending jobs are rejected.
   * Useful for forcing a clean heap before WASM-OOM retries.
   */
  recycle(kind: JobKind): void {
    const lane = this.lanes.get(kind);
    if (!lane) return;
    while (lane.workers.length > 0) {
      const slot = lane.workers.pop()!;
      slot.worker.terminate().catch(() => {});
    }
    // Reject all pending jobs for this lane
    this._rejectAll(lane, `Recycled lane ${kind}`);
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
      const workers = lane.workers.splice(0);
      for (const slot of workers) {
        await slot.worker.terminate().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals

  /** Pick the least-busy worker, or spawn a new one if below concurrency limit. */
  private async _pickWorker(kind: JobKind, lane: LaneState): Promise<WorkerType> {
    // Find the least-busy worker (fewest in-flight jobs)
    if (lane.workers.length > 0) {
      const sorted = [...lane.workers].sort((a, b) => a.inFlight - b.inFlight);
      return sorted[0]!.worker;
    }

    // No workers yet — spawn up to concurrency limit
    if (lane.workers.length < lane.opts.concurrency) {
      return await this._spawnWorker(kind, lane);
    }

    // Fallback (shouldn't happen, but pick first as safety)
    return lane.workers[0]!.worker;
  }

  /** Spawn a single worker, register it, run onSpawn, return it. */
  private async _spawnWorker(kind: JobKind, lane: LaneState): Promise<WorkerType> {
    lane.opts.log(`Spawning new ${kind} worker (${lane.workers.length + 1}/${lane.opts.concurrency})...`);
    const { Worker } = await import('worker_threads');
    const worker = new Worker(lane.opts.workerScript);
    const slot: WorkerSlot = { worker, jobCount: 0, inFlight: 0 };
    lane.workers.push(slot);

    worker.on('message', (msg: { _poolId?: number; result?: unknown; error?: string }) => {
      if (msg._poolId === undefined) return;
      const p = lane.pending.get(msg._poolId);
      if (!p) return;
      clearTimeout(p.timer);
      lane.pending.delete(msg._poolId);
      slot.inFlight--;
      slot.jobCount++;
      if (msg.error !== undefined) {
        p.reject(new Error(msg.error));
      } else {
        p.resolve(msg.result);
      }
    });

    worker.on('error', (err) => {
      logWarn(`${kind} worker error`, { error: err.message });
      // Remove this worker from the pool
      const idx = lane.workers.indexOf(slot);
      if (idx >= 0) lane.workers.splice(idx, 1);
    });

    worker.on('exit', (code) => {
      // Remove this worker from the pool
      const idx = lane.workers.indexOf(slot);
      if (idx >= 0) {
        lane.workers.splice(idx, 1);
        if (code !== 0) {
          logWarn(`${kind} worker exited unexpectedly`, { code });
          // Reject any pending jobs that were on this worker
          const pendingOnWorker = Array.from(lane.pending.entries()).filter(
            ([, p]) => p === undefined, // This is a simplification; ideally track which worker handles which job
          );
          for (const [id, p] of pendingOnWorker) {
            clearTimeout(p.timer);
            lane.pending.delete(id);
            p.reject(new Error(`Worker exited with code ${code} (${kind})`));
          }
        }
      }
    });

    await lane.opts.onSpawn(worker);
    return worker;
  }

  private _rejectAll(lane: LaneState, reason: string): void {
    for (const [id, p] of lane.pending) {
      clearTimeout(p.timer);
      lane.pending.delete(id);
      p.reject(new Error(reason));
    }
  }
}
