/**
 * Project-scoped configuration: a committed `WitsOS.json` at the project
 * root that a team shares through version control.
 *
 * Today it carries one thing — `extensions`, an opt-in map from a custom file
 * extension to one of WitsOS's supported languages. The built-in
 * extension → language table (`EXTENSION_MAP` in `extraction/grammars.ts`) is
 * otherwise hardcoded, so a codebase that uses a non-standard extension for a
 * supported language (e.g. `.dota_lua` for Lua) sees those files silently
 * skipped. This lets the project map them once, in a version-controlled file:
 *
 *   {
 *     "extensions": {
 *       ".dota_lua": "lua",
 *       ".tpl": "php"
 *     }
 *   }
 *
 * User mappings merge on TOP of the built-ins and win on conflict, so a project
 * can also re-point a built-in extension (e.g. force `.h` → `cpp`). Absent or
 * malformed config is the zero-config default — no overrides, no error. Invalid
 * individual entries are warned-and-skipped (never fatal): an unparseable
 * project file must not break indexing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Language } from './types';
import { isLanguageSupported } from './extraction/grammars';
import { logWarn } from './errors';

/** Filename of the project-scoped config, resolved relative to the project root. */
export const PROJECT_CONFIG_FILENAME = 'WitsOS.json';

/** Current config schema version. Bump when adding required fields. */
export const CURRENT_CONFIG_VERSION = 1;

export interface ProjectConfig {
  /** Config schema version. Auto-upgraded on load. */
  _version?: number;
  /** Map of custom file extension (`.foo`) to a supported language id. */
  extensions?: Record<string, string>;
  /**
   * Gitignore-style patterns naming gitignored directories whose embedded git
   * repositories should be indexed anyway — the explicit opt-in to override
   * `.gitignore` for nested-repo discovery (#622, #699). Absent/empty (the
   * default) means `.gitignore` is fully respected: gitignored embedded repos
   * are never discovered or indexed (#970, #976).
   */
  includeIgnored?: string[];
  /**
   * Gitignore-style patterns for paths to keep OUT of the index — even when
   * they are git-TRACKED, which `.gitignore` cannot do (#999). The escape hatch
   * for a committed vendor/theme/SDK directory (e.g. a checked-in Metronic theme
   * under `static/`) that bloats the graph and slows indexing but isn't really
   * your code. Matched against project-root-relative paths, so a directory like
   * `"static/"`, a double-star vendor glob, or `"assets/theme"` all work.
   * Absent/empty (the default) excludes nothing beyond the built-in defaults
   * and your `.gitignore`.
   */
  exclude?: string[];
  /**
   * Opt-in OCR (Phase 5). Image files (and, later, scanned PDFs) are only run
   * through the OCR backend when `ocr.enabled` is true AND the optional OCR
   * package is installed. Absent/disabled (the default) keeps the index
   * byte-identical to the no-OCR behavior: an image yields a `document` node
   * and zero chunks (tracked, no junk text).
   */
  ocr?: {
    enabled?: boolean;
    /** Recognition languages (e.g. ["en"]). Default ["en"]. */
    languages?: string[];
    /** Cap input megapixels — larger images are downscaled. Default 25. */
    maxImageMP?: number;
    /** Drop recognized lines below this confidence [0,1]. Default 0.5. */
    minConfidence?: number;
  };
  /**
   * Opt-in STT (Phase 6). Audio files are transcribed only when `stt.enabled`
   * is true AND the optional `sherpa-onnx` + `ffmpeg-static` packages are
   * installed. Absent/disabled yields a `document` node and zero chunks.
   */
  stt?: {
    enabled?: boolean;
    /** Model size keyword ("base", "small", "medium") or absolute path. */
    model?: string;
    /** Absolute path to a local model directory (for offline/air-gapped use). */
    modelPath?: string;
    /** BCP-47 language code or "auto" for language detection. Default "auto". */
    language?: string;
    /** Enable speaker diarization. Default false. */
    diarize?: boolean;
    /** Drop transcript segments below this confidence [0,1]. Default 0.0. */
    minConfidence?: number;
    /** Explicit path to ffmpeg binary (falls back to ffmpeg-static / PATH). */
    ffmpegPath?: string;
    /** Skip STT if video duration exceeds this (seconds). Default 1800 (30 min). */
    maxDurationSecs?: number;
  };
  /**
   * Worker-pool concurrency overrides. `null` = auto (≈ CPU count for parse).
   * Useful on RAM-constrained machines to cap OCR/STT workers.
   */
  workers?: {
    parse?: number | null;
    ocr?: number | null;
    stt?: number | null;
  };
}

/** Validated OCR config. */
export interface OcrConfig {
  enabled: boolean;
  languages: string[];
  maxImageMP: number;
  minConfidence: number;
}

/** Validated STT config. */
export interface SttConfig {
  enabled: boolean;
  model: string;
  modelPath: string | null;
  language: string;
  diarize: boolean;
  minConfidence: number;
  ffmpegPath: string | null;
  maxDurationSecs: number;
}

/** Validated workers config. */
export interface WorkersConfig {
  parse: number | null;
  ocr: number | null;
  stt: number | null;
}

/** Parsed, validated view of a project's `WitsOS.json`. */
interface ParsedConfig {
  _version: number;
  extensions: Record<string, Language>;
  includeIgnored: string[];
  exclude: string[];
  ocr: OcrConfig;
  stt: SttConfig;
  workers: WorkersConfig;
}

/** The zero-config OCR default: disabled. */
const DEFAULT_OCR: OcrConfig = Object.freeze({
  enabled: false,
  languages: Object.freeze(['en']) as unknown as string[],
  maxImageMP: 25,
  minConfidence: 0.5,
});

/** The zero-config STT default: disabled. */
const DEFAULT_STT: SttConfig = Object.freeze({
  enabled: false,
  model: 'base',
  modelPath: null,
  language: 'auto',
  diarize: false,
  minConfidence: 0.0,
  ffmpegPath: null,
  maxDurationSecs: 1800,
});

/** The zero-config workers default: auto everywhere. */
const DEFAULT_WORKERS: WorkersConfig = Object.freeze({ parse: null, ocr: null, stt: null });

interface CacheEntry {
  mtimeMs: number;
  config: ParsedConfig;
}

/**
 * Cache keyed by project root. The loader is called once per indexing/scan/sync
 * operation (and per watch event), so the mtime guard keeps repeat calls to one
 * `stat` while a single `WitsOS.json` is in force. Keying by root keeps two
 * projects in the same process (the daemon / multi-project MCP server) isolated.
 */
const cache = new Map<string, CacheEntry>();

/** Shared frozen empties so the no-config path allocates nothing. */
const EMPTY_EXTENSIONS: Record<string, Language> = Object.freeze({});
const EMPTY_CONFIG: ParsedConfig = Object.freeze({
  _version: CURRENT_CONFIG_VERSION,
  extensions: EMPTY_EXTENSIONS,
  includeIgnored: Object.freeze([]) as unknown as string[],
  exclude: Object.freeze([]) as unknown as string[],
  ocr: DEFAULT_OCR,
  stt: DEFAULT_STT,
  workers: DEFAULT_WORKERS,
});

/**
 * Normalize a user-provided extension key to the `.ext` lowercase form used by
 * the built-in map. Returns null for keys that can never match a real file
 * extension (so the caller warns and skips):
 *   - empty / just "."
 *   - multi-part (".d.ts") — language detection keys off the FINAL extension
 *     only (`lastIndexOf('.')`), so a multi-dot key would never be consulted.
 *   - anything containing a path separator.
 */
function normalizeExtKey(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let ext = raw.trim().toLowerCase();
  if (!ext) return null;
  if (!ext.startsWith('.')) ext = '.' + ext;
  const body = ext.slice(1);
  if (!body) return null;
  if (body.includes('.') || body.includes('/') || body.includes('\\')) return null;
  return ext;
}

/**
 * Upgrade project config if schema version is outdated.
 * Writes the upgraded config back to disk and returns true if upgraded.
 */
function upgradeProjectConfigIfNeeded(file: string): boolean {
  try {
    const rawConfig = JSON.parse(fs.readFileSync(file, 'utf-8')) as ProjectConfig;
    const version = rawConfig._version ?? 0;

    if (version >= CURRENT_CONFIG_VERSION) return false;

    // Read scaffold to get all new defaults
    const scaffold: ProjectConfig = {
      _version: CURRENT_CONFIG_VERSION,
      extensions: {},
      includeIgnored: [],
      exclude: [],
      ocr: {
        enabled: false,
        languages: ['en'],
        maxImageMP: 25,
        minConfidence: 0.5,
      },
      stt: {
        enabled: false,
        model: 'base',
        language: 'auto',
        diarize: false,
        minConfidence: 0.0,
        maxDurationSecs: 1800,
      },
      workers: {
        parse: null,
        ocr: 1,
        stt: 1,
      },
    };

    // Merge: scaffold defaults + user's current values (user wins on conflicts)
    const upgraded: ProjectConfig = {
      _version: CURRENT_CONFIG_VERSION,
      extensions: { ...scaffold.extensions, ...rawConfig.extensions },
      includeIgnored: rawConfig.includeIgnored ?? scaffold.includeIgnored,
      exclude: rawConfig.exclude ?? scaffold.exclude,
      ocr: { ...scaffold.ocr, ...rawConfig.ocr },
      stt: { ...scaffold.stt, ...rawConfig.stt },
      workers: { ...scaffold.workers, ...rawConfig.workers },
    };

    fs.writeFileSync(file, JSON.stringify(upgraded, null, 2) + '\n', 'utf-8');
    cache.delete(path.dirname(file)); // clear cache so next load picks up upgrade
    logWarn(`Upgraded ${PROJECT_CONFIG_FILENAME} from v${version} to v${CURRENT_CONFIG_VERSION}`, { file });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read + JSON-parse a `WitsOS.json` once and return its validated view.
 * Every failure mode degrades to the zero-config default — a missing file, bad
 * JSON, or a typo'd value never throws.
 */
function parseConfig(file: string): ParsedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return EMPTY_CONFIG;
  }

  // Try to upgrade if file exists and version is outdated
  try {
    upgradeProjectConfigIfNeeded(file);
    // Re-read after potential upgrade
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    // If upgrade fails, continue with original content
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(`Ignoring ${PROJECT_CONFIG_FILENAME}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_CONFIG;
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY_CONFIG;

  const extensions = extractExtensions(parsed, file);
  const includeIgnored = extractIncludeIgnored(parsed, file);
  const exclude = extractExclude(parsed, file);
  const ocr = extractOcr(parsed, file);
  const stt = extractStt(parsed, file);
  const workers = extractWorkers(parsed, file);
  const _version = CURRENT_CONFIG_VERSION;
  if (
    extensions === EMPTY_EXTENSIONS &&
    includeIgnored.length === 0 &&
    exclude.length === 0 &&
    ocr === DEFAULT_OCR &&
    stt === DEFAULT_STT &&
    workers === DEFAULT_WORKERS
  ) {
    return EMPTY_CONFIG;
  }
  return { _version, extensions, includeIgnored, exclude, ocr, stt, workers };
}

/**
 * Validate the `ocr` block. Every failure mode degrades to the disabled
 * default — a bad value never throws and never silently enables OCR.
 */
function extractOcr(parsed: object, file: string): OcrConfig {
  const raw = (parsed as ProjectConfig).ocr;
  if (raw === undefined) return DEFAULT_OCR;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logWarn(`Ignoring "ocr" in ${PROJECT_CONFIG_FILENAME}: must be an object`, { file });
    return DEFAULT_OCR;
  }

  const enabled = raw.enabled === true;
  if (!enabled) return DEFAULT_OCR; // disabled — no need to parse the rest

  let languages = DEFAULT_OCR.languages;
  if (Array.isArray(raw.languages)) {
    const langs = raw.languages.filter((l): l is string => typeof l === 'string' && !!l.trim());
    if (langs.length > 0) languages = langs.map((l) => l.trim());
  }

  const maxImageMP =
    typeof raw.maxImageMP === 'number' && raw.maxImageMP > 0
      ? raw.maxImageMP
      : DEFAULT_OCR.maxImageMP;

  const minConfidence =
    typeof raw.minConfidence === 'number' && raw.minConfidence >= 0 && raw.minConfidence <= 1
      ? raw.minConfidence
      : DEFAULT_OCR.minConfidence;

  return { enabled: true, languages, maxImageMP, minConfidence };
}

/**
 * Validate the `stt` block. Every failure mode degrades to the disabled
 * default — a bad value never throws and never silently enables STT.
 */
function extractStt(parsed: object, file: string): SttConfig {
  const raw = (parsed as ProjectConfig).stt;
  if (raw === undefined) return DEFAULT_STT;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logWarn(`Ignoring "stt" in ${PROJECT_CONFIG_FILENAME}: must be an object`, { file });
    return DEFAULT_STT;
  }

  const enabled = raw.enabled === true;
  if (!enabled) return DEFAULT_STT;

  const model =
    typeof raw.model === 'string' && raw.model.trim()
      ? raw.model.trim()
      : DEFAULT_STT.model;

  const modelPath =
    typeof raw.modelPath === 'string' && raw.modelPath.trim()
      ? raw.modelPath.trim()
      : null;

  const language =
    typeof raw.language === 'string' && raw.language.trim()
      ? raw.language.trim()
      : DEFAULT_STT.language;

  const diarize = raw.diarize === true;

  const minConfidence =
    typeof raw.minConfidence === 'number' && raw.minConfidence >= 0 && raw.minConfidence <= 1
      ? raw.minConfidence
      : DEFAULT_STT.minConfidence;

  const ffmpegPath =
    typeof raw.ffmpegPath === 'string' && raw.ffmpegPath.trim()
      ? raw.ffmpegPath.trim()
      : null;

  const maxDurationSecs =
    typeof raw.maxDurationSecs === 'number' && raw.maxDurationSecs > 0
      ? raw.maxDurationSecs
      : DEFAULT_STT.maxDurationSecs;

  return { enabled: true, model, modelPath, language, diarize, minConfidence, ffmpegPath, maxDurationSecs };
}

/**
 * Validate the `workers` block. Returns the auto default on any bad value.
 */
function extractWorkers(parsed: object, file: string): WorkersConfig {
  const raw = (parsed as ProjectConfig).workers;
  if (raw === undefined) return DEFAULT_WORKERS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logWarn(`Ignoring "workers" in ${PROJECT_CONFIG_FILENAME}: must be an object`, { file });
    return DEFAULT_WORKERS;
  }

  const parseNum = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
    return null;
  };

  return {
    parse: parseNum((raw as WorkersConfig).parse),
    ocr: parseNum((raw as WorkersConfig).ocr),
    stt: parseNum((raw as WorkersConfig).stt),
  };
}

/**
 * Validate the `extensions` map. Every failure mode degrades to "no overrides
 * from this entry" — a bad value or a typo'd language never throws.
 */
function extractExtensions(parsed: object, file: string): Record<string, Language> {
  const exts = (parsed as ProjectConfig).extensions;
  if (!exts || typeof exts !== 'object' || Array.isArray(exts)) return EMPTY_EXTENSIONS;

  const out: Record<string, Language> = {};
  for (const [rawKey, rawVal] of Object.entries(exts)) {
    const key = normalizeExtKey(rawKey);
    if (!key) {
      logWarn(`Ignoring extension mapping in ${PROJECT_CONFIG_FILENAME}: "${rawKey}" is not a valid file extension`, { file });
      continue;
    }
    if (typeof rawVal !== 'string' || !isLanguageSupported(rawVal as Language)) {
      logWarn(`Ignoring extension "${rawKey}" in ${PROJECT_CONFIG_FILENAME}: "${String(rawVal)}" is not a supported language`, { file });
      continue;
    }
    out[key] = rawVal as Language;
  }

  return Object.keys(out).length > 0 ? out : EMPTY_EXTENSIONS;
}

/**
 * Validate the `includeIgnored` patterns: an array of non-empty gitignore-style
 * strings. A non-array value or a non-string/blank entry warns-and-skips; never
 * throws. Patterns are kept verbatim (trimmed) so they match exactly as a
 * `.gitignore` line would.
 */
function extractIncludeIgnored(parsed: object, file: string): string[] {
  const raw = (parsed as ProjectConfig).includeIgnored;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "includeIgnored" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring an "includeIgnored" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Validate the `exclude` patterns: an array of non-empty gitignore-style
 * strings naming paths to keep out of the index even when git-tracked (#999). A
 * non-array value or a non-string/blank entry warns-and-skips; never throws.
 * Patterns are kept verbatim (trimmed) so they match exactly as a `.gitignore`
 * line would, against project-root-relative paths.
 */
function extractExclude(parsed: object, file: string): string[] {
  const raw = (parsed as ProjectConfig).exclude;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "exclude" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring an "exclude" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Load the parsed `WitsOS.json` for a project, mtime-cached. A missing or
 * malformed file yields the zero-config default. One `stat` (and at most one
 * read/parse) while a single config file is in force, shared across every field.
 */
function loadParsedConfig(rootDir: string): ParsedConfig {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // No config file — drop any stale cache entry and return the default.
    cache.delete(rootDir);
    return EMPTY_CONFIG;
  }

  const entry = cache.get(rootDir);
  if (entry && entry.mtimeMs === mtimeMs) return entry.config;

  const config = parseConfig(file);
  cache.set(rootDir, { mtimeMs, config });
  return config;
}

/**
 * Load the validated extension overrides for a project, mtime-cached.
 *
 * Returns a map of `.ext` → supported language id. The result merges on top of
 * the built-in extension map at the point of use (see `detectLanguage` /
 * `isSourceFile`), with these user mappings taking precedence. Returns an empty
 * map when there is no `WitsOS.json` (the zero-config default).
 */
export function loadExtensionOverrides(rootDir: string): Record<string, Language> {
  return loadParsedConfig(rootDir).extensions;
}

/**
 * Load the validated `includeIgnored` patterns for a project, mtime-cached.
 *
 * These name gitignored directories whose embedded git repositories should be
 * indexed despite `.gitignore` (#622, #699). An empty result — the zero-config
 * default — means `.gitignore` is fully respected: gitignored embedded repos
 * are never discovered or indexed (#970, #976).
 */
export function loadIncludeIgnoredPatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).includeIgnored;
}

/**
 * Load the validated `exclude` patterns for a project, mtime-cached.
 *
 * These name paths to keep OUT of the index even when git-tracked — the escape
 * hatch for a committed vendor/theme/SDK directory `.gitignore` can't drop
 * (#999). An empty result — the zero-config default — excludes nothing beyond
 * the built-in defaults and the project's `.gitignore`.
 */
export function loadExcludePatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).exclude;
}

/**
 * Load the validated OCR config for a project, mtime-cached. Returns the
 * disabled default (`enabled:false`) when there is no `WitsOS.json` or no `ocr`
 * block — so the OCR path is never taken unless a project opts in explicitly.
 */
export function loadOcrConfig(rootDir: string): OcrConfig {
  return loadParsedConfig(rootDir).ocr;
}

/**
 * Load the validated STT config for a project, mtime-cached. Returns the
 * disabled default (`enabled:false`) when there is no `WitsOS.json` or no `stt`
 * block — so the STT path is never taken unless a project opts in explicitly.
 */
export function loadSttConfig(rootDir: string): SttConfig {
  return loadParsedConfig(rootDir).stt;
}

/**
 * Load the validated workers config for a project, mtime-cached.
 * Returns `{ parse: null, ocr: null, stt: null }` (auto everywhere) by default.
 */
export function loadWorkersConfig(rootDir: string): WorkersConfig {
  return loadParsedConfig(rootDir).workers;
}

/**
 * Write one or more top-level keys into the project's WitsOS.json, creating
 * the file if absent. Used by the interactive opt-in prompt to persist the
 * user's capability choice without clobbering other settings.
 */
export function writeProjectConfig(rootDir: string, patch: Partial<ProjectConfig>): void {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch { /* file absent or invalid — start fresh */ }

  const merged = { ...existing, ...patch };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  // Invalidate the mtime cache so next load picks up the change.
  cache.delete(rootDir);
}

/**
 * Create WitsOS.json with all available config options at their defaults.
 * Only writes if the file does not already exist — never clobbers existing config.
 * Call after `witsos init` / `witsos index` so users can discover and edit all flags
 * without hand-writing JSON. When new config keys are added to ProjectConfig, add them
 * here too so every fresh project gets a fully-documented scaffold.
 */
export function scaffoldProjectConfig(rootDir: string): void {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);
  if (fs.existsSync(file)) return;

  const scaffold: ProjectConfig = {
    _version: CURRENT_CONFIG_VERSION,
    extensions: {},
    includeIgnored: [],
    exclude: [],
    ocr: {
      enabled: false,
      languages: ['en'],
      maxImageMP: 25,
      minConfidence: 0.5,
    },
    stt: {
      enabled: false,
      model: 'base',
      language: 'auto',
      diarize: false,
      minConfidence: 0.0,
      maxDurationSecs: 1800,
    },
    workers: {
      parse: null,
      ocr: 1,
      stt: 1,
    },
  };

  try {
    fs.writeFileSync(file, JSON.stringify(scaffold, null, 2) + '\n', 'utf-8');
    cache.delete(rootDir);
  } catch { /* non-fatal: config is optional */ }
}

/** Test/maintenance hook: forget cached config (e.g. after rewriting it in a test). */
export function clearProjectConfigCache(): void {
  cache.clear();
}
