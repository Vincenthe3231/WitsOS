/**
 * Compute CapabilityStatus from the live index (Phase 6).
 *
 * Reads audio/image file counts from the indexed nodes table and checks
 * WitsOS.json to determine whether each capability is already set.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_CONFIG_FILENAME } from '../project-config';
import type { CapabilityStatus } from './capability-prompt';

/**
 * Read the indexed DB for audio/image counts and check WitsOS.json for
 * existing capability settings. Returns a CapabilityStatus for the prompt.
 *
 * @param cg  Any object that exposes `.db` (DatabaseConnection) or a query
 *            method. The WitsOS class stores it as `this.db`.
 */
export async function loadParsedCapabilityStatus(
  cg: unknown,
  rootDir: string,
): Promise<CapabilityStatus> {
  let audioFileCount = 0;
  let imageFileCount = 0;

  // Query the DB for file-level document nodes by language.
  try {
    const db = (cg as any).db ?? (cg as any)._db;
    if (db) {
      const audioRow = db.prepare("SELECT count(*) AS n FROM nodes WHERE language='audio'").get() as { n: number } | undefined;
      audioFileCount = audioRow?.n ?? 0;
      const imageRow = db.prepare("SELECT count(*) AS n FROM nodes WHERE language='image'").get() as { n: number } | undefined;
      imageFileCount = imageRow?.n ?? 0;
    }
  } catch { /* DB not available — counts stay 0 */ }

  // Check WitsOS.json for existing capability flags.
  let sttAlreadySet = false;
  let ocrAlreadySet = false;
  try {
    const configPath = path.join(rootDir, PROJECT_CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (raw.stt && typeof raw.stt === 'object' && 'enabled' in (raw.stt as object)) {
        sttAlreadySet = true;
      }
      if (raw.ocr && typeof raw.ocr === 'object' && 'enabled' in (raw.ocr as object)) {
        ocrAlreadySet = true;
      }
    }
  } catch { /* non-fatal */ }

  return { audioFileCount, imageFileCount, sttAlreadySet, ocrAlreadySet };
}
