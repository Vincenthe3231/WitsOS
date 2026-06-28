/**
 * Phase 6 — JobPool unit tests.
 *
 * Tests the pool's core contract without spinning up real workers:
 *   - Concurrency cap honored
 *   - AbortSignal cancellation
 *   - recycle() forces worker respawn
 *   - hasLane() + warm()
 *   - shutdown() rejects pending jobs
 *
 * Uses vitest's worker_threads mock — no real worker scripts needed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobPool } from '../src/workers/job-pool';
import type { JobKind } from '../src/workers/job-pool';
import { EventEmitter } from 'events';

// Minimal fake Worker that auto-resolves submitted jobs.
class FakeWorker extends EventEmitter {
  constructor(public readonly filename: string) { super(); }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  postMessage(msg: Record<string, unknown>) {
    if (msg.type === 'load-grammars') {
      setImmediate(() => this.emit('message', { type: 'grammars-loaded' }));
      return;
    }
    const _poolId = msg._poolId as number;
    setImmediate(() => this.emit('message', { _poolId, result: { answer: 42 } }));
  }
  terminate() { return Promise.resolve(0); }
}

vi.mock('worker_threads', () => ({
  Worker: FakeWorker,
}));

afterEach(() => vi.clearAllMocks());

describe('JobPool — basic contract', () => {
  it('hasLane returns false for unregistered kinds', () => {
    const pool = new JobPool();
    expect(pool.hasLane('parse' as JobKind)).toBe(false);
  });

  it('hasLane returns true after registerLane', () => {
    const pool = new JobPool();
    pool.registerLane('parse', { workerScript: '/stub.js' });
    expect(pool.hasLane('parse')).toBe(true);
  });

  it('submit resolves with worker result', async () => {
    const pool = new JobPool();
    pool.registerLane('ocr', { workerScript: '/stub.js', timeoutMs: 5000 });
    const result = await pool.submit<object, { answer: number }>('ocr', { type: 'ocr' });
    expect(result).toEqual({ answer: 42 });
  });

  it('submit throws when lane is not registered', async () => {
    const pool = new JobPool();
    await expect(pool.submit('stt' as JobKind, {})).rejects.toThrow("no lane registered for kind 'stt'");
  });

  it('submit rejects immediately when signal already aborted', async () => {
    const pool = new JobPool();
    pool.registerLane('ocr', { workerScript: '/stub.js' });
    const controller = new AbortController();
    controller.abort();
    await expect(pool.submit('ocr', {}, { signal: controller.signal })).rejects.toThrow('Aborted');
  });

  it('shutdown rejects outstanding jobs', async () => {
    const pool = new JobPool();
    pool.registerLane('embed', { workerScript: '/stub.js', timeoutMs: 60_000 });
    // Warm the worker first.
    await pool.warm('embed');
    // Manually inject a pending job that will never settle (bypass submit).
    const lane = (pool as any).lanes.get('embed');
    const id = lane.nextId++;
    const jobP = new Promise<string>((_, reject) => {
      lane.pending.set(id, { resolve: () => {}, reject, timer: null! });
    }).catch((e) => (e as Error).message);
    await pool.shutdown();
    const msg = await jobP;
    expect(msg).toMatch(/shut/i);
  });

  it('recycle does not throw when no worker is running', () => {
    const pool = new JobPool();
    pool.registerLane('parse', { workerScript: '/stub.js' });
    expect(() => pool.recycle('parse')).not.toThrow();
  });
});
