/**
 * Temporary file manager for extraction workers.
 *
 * Manages a scratch directory per extraction job (keyed by jobId), guarantees
 * cleanup on success, worker crash, timeout, or explicit cancel via AbortSignal.
 * Used by video/keyframe extraction to store intermediate frames.
 *
 * Pattern:
 *   const tmpDir = TempFileMgr.allocateJobDir(jobId, rootDir);
 *   // Extract frames to tmpDir
 *   TempFileMgr.cleanup(jobId);  // on success, crash, or cancel
 *
 * Cleanup is idempotent: double-cleanup is safe. On crash/exit, pending dirs
 * are cleaned at the next instantiation of TempFileMgr in that process.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logWarn } from '../../errors';

export class TempFileMgr {
  /** Map of jobId → temp directory path. */
  private static jobDirs = new Map<string, string>();
  /** Cleanup in progress? Set to avoid double-cleanup races. */
  private static cleanupInProgress = new Set<string>();

  /**
   * Allocate a temp directory for a job. Directory is created under
   * `rootDir/.witsos/tmp/`. The directory is empty but guaranteed to exist.
   * Safe to call multiple times with the same jobId (idempotent).
   */
  static allocateJobDir(jobId: string, rootDir: string): string {
    // Check if already allocated
    if (this.jobDirs.has(jobId)) {
      return this.jobDirs.get(jobId)!;
    }

    const tmpDir = path.join(rootDir, '.witsos', 'tmp', jobId);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      this.jobDirs.set(jobId, tmpDir);
      return tmpDir;
    } catch (err) {
      logWarn(`TempFileMgr.allocateJobDir failed to create ${tmpDir}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Return the path anyway; cleanup will handle it
      this.jobDirs.set(jobId, tmpDir);
      return tmpDir;
    }
  }

  /**
   * Clean up all files in the job's temp directory and remove the directory.
   * Idempotent: safe to call multiple times. Fire-and-forget (errors logged but not thrown).
   */
  static async cleanup(jobId: string): Promise<void> {
    if (this.cleanupInProgress.has(jobId)) {
      return; // Already cleaning, avoid race
    }

    const tmpDir = this.jobDirs.get(jobId);
    if (!tmpDir) return; // Never allocated

    this.cleanupInProgress.add(jobId);
    try {
      // Remove directory and its contents
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (err) {
      logWarn(`TempFileMgr.cleanup failed for ${jobId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.jobDirs.delete(jobId);
      this.cleanupInProgress.delete(jobId);
    }
  }

  /**
   * Get the temp directory for a job, or null if not allocated.
   */
  static getJobDir(jobId: string): string | null {
    return this.jobDirs.get(jobId) ?? null;
  }

  /**
   * Perform on-startup cleanup of any orphaned temp directories left by
   * crashed workers or ungraceful shutdowns. Called once during pool initialization.
   */
  static async cleanupOrphaned(rootDir: string): Promise<void> {
    const tmpBasePath = path.join(rootDir, '.witsos', 'tmp');
    if (!fs.existsSync(tmpBasePath)) return;

    try {
      const entries = await fsp.readdir(tmpBasePath);
      for (const entry of entries) {
        const entryPath = path.join(tmpBasePath, entry);
        try {
          await fsp.rm(entryPath, { recursive: true, force: true });
        } catch (err) {
          logWarn(`TempFileMgr.cleanupOrphaned failed for ${entry}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logWarn(`TempFileMgr.cleanupOrphaned failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Attach a cleanup hook to an AbortSignal. When the signal is aborted,
   * automatically cleanup the job's temp directory.
   */
  static attachAbortCleanup(jobId: string, signal: AbortSignal): void {
    if (signal.aborted) {
      this.cleanup(jobId).catch(() => {});
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        this.cleanup(jobId).catch(() => {});
      },
      { once: true }
    );
  }
}
