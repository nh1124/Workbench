import { mkdirSync, existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CaptureConfig,
  CaptureConfigPatch,
  CaptureLogger,
  CaptureSample,
  CaptureSampleInput,
  CaptureScreenshotRecord,
  CaptureStatus
} from "./types.js";

export const DEFAULT_CAPTURE_INTERVAL_SECONDS = 15;
export const DEFAULT_CAPTURE_RETENTION_DAYS = 14;
export const DEFAULT_CAPTURE_IDLE_THRESHOLD_SECONDS = 300;
export const DEFAULT_SCREENSHOT_INTERVAL_SECONDS = 300;
export const DEFAULT_SCREENSHOT_RETENTION_DAYS = 7;
export const DEFAULT_CAPTURE_CATEGORY_MAP: Record<string, string> = {
  msedge: "Browser",
  chrome: "Browser",
  Code: "Editor",
  explorer: "System"
};

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  enabled: false,
  uploadEnabled: false,
  windowTitleCapture: false,
  windowTitleUpload: false,
  localFileEnabled: false,
  screenshotsEnabled: false,
  screenshotIntervalSeconds: DEFAULT_SCREENSHOT_INTERVAL_SECONDS,
  screenshotRetentionDays: DEFAULT_SCREENSHOT_RETENTION_DAYS,
  intervalSeconds: DEFAULT_CAPTURE_INTERVAL_SECONDS,
  retentionDays: DEFAULT_CAPTURE_RETENTION_DAYS,
  excludePatterns: [],
  idleThresholdSeconds: DEFAULT_CAPTURE_IDLE_THRESHOLD_SECONDS,
  categoryMap: { ...DEFAULT_CAPTURE_CATEGORY_MAP }
};

function defaultCaptureConfig(): CaptureConfig {
  return { ...DEFAULT_CAPTURE_CONFIG, categoryMap: { ...DEFAULT_CAPTURE_CONFIG.categoryMap } };
}

const CONFIG_META_KEY = "capture.config";
const LAST_RETENTION_DATE_META_KEY = "capture.lastRetentionDate";

type CaptureStorageOptions = {
  logger?: CaptureLogger;
};

type CountRow = { count: number };
type SampleRow = { id?: number; sampled_at: string; process_name: string; window_title: string; idle?: number | null };
export type CaptureSampleUploadCursor = { sampledAt: string; id: number };
export type CaptureStoredSample = CaptureSample & { id: number };

export function defaultCaptureDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA?.trim();
  return resolve(localAppData ? join(localAppData, "Workbench", "capture.sqlite") : join(homedir(), "Workbench", "capture.sqlite"));
}

function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function hasWorkbenchMetadataSegment(candidate: string): boolean {
  return resolve(candidate)
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === ".workbench");
}

export function assertCaptureDbPathAllowed(dbPath: string, syncRoot: string): void {
  const resolvedDbPath = resolve(dbPath);
  if (isPathInsideDirectory(syncRoot, resolvedDbPath)) {
    throw new Error("WORKBENCH_CAPTURE_DB_PATH must not be inside the Workbench sync root.");
  }
  if (hasWorkbenchMetadataSegment(resolvedDbPath)) {
    throw new Error("WORKBENCH_CAPTURE_DB_PATH must not be inside a .workbench metadata directory.");
  }
}

export function resolveCaptureDbPath(input: { syncRoot: string; dbPath?: string; env?: NodeJS.ProcessEnv }): string {
  const dbPath = resolve(input.dbPath?.trim() || input.env?.WORKBENCH_CAPTURE_DB_PATH?.trim() || defaultCaptureDbPath(input.env));
  assertCaptureDbPathAllowed(dbPath, input.syncRoot);
  return dbPath;
}

function normalizeConfig(value: unknown): CaptureConfig {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_CAPTURE_CONFIG.enabled,
    uploadEnabled: typeof record.uploadEnabled === "boolean" ? record.uploadEnabled : DEFAULT_CAPTURE_CONFIG.uploadEnabled,
    windowTitleCapture: typeof record.windowTitleCapture === "boolean" ? record.windowTitleCapture : false,
    windowTitleUpload: typeof record.windowTitleUpload === "boolean" ? record.windowTitleUpload : false,
    localFileEnabled: typeof record.localFileEnabled === "boolean" ? record.localFileEnabled : false,
    screenshotsEnabled: typeof record.screenshotsEnabled === "boolean" ? record.screenshotsEnabled : false,
    screenshotIntervalSeconds: isIntegerBetween(record.screenshotIntervalSeconds, 60, 3600)
      ? record.screenshotIntervalSeconds : DEFAULT_SCREENSHOT_INTERVAL_SECONDS,
    screenshotRetentionDays: isIntegerBetween(record.screenshotRetentionDays, 1, 90)
      ? record.screenshotRetentionDays : DEFAULT_SCREENSHOT_RETENTION_DAYS,
    intervalSeconds: typeof record.intervalSeconds === "number" && Number.isInteger(record.intervalSeconds) && record.intervalSeconds > 0
      ? record.intervalSeconds
      : DEFAULT_CAPTURE_CONFIG.intervalSeconds,
    retentionDays: typeof record.retentionDays === "number" && Number.isInteger(record.retentionDays) && record.retentionDays > 0
      ? record.retentionDays
      : DEFAULT_CAPTURE_CONFIG.retentionDays,
    excludePatterns: Array.isArray(record.excludePatterns)
      ? record.excludePatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : [],
    idleThresholdSeconds: isValidIdleThreshold(record.idleThresholdSeconds)
      ? record.idleThresholdSeconds
      : DEFAULT_CAPTURE_CONFIG.idleThresholdSeconds,
    categoryMap: normalizeCategoryMap(record.categoryMap)
  };
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isValidIdleThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 60 && value <= 3600;
}

function isCategoryMap(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.entries(value as Record<string, unknown>).every(([processName, category]) => (
      processName.trim().length > 0 && typeof category === "string" && category.trim().length > 0
    ));
}

function normalizeCategoryMap(value: unknown): Record<string, string> {
  if (!isCategoryMap(value)) return { ...DEFAULT_CAPTURE_CATEGORY_MAP };
  return Object.fromEntries(Object.entries(value).map(([processName, category]) => [processName.trim(), category.trim()]));
}

export function validateCaptureConfigPatch(patch: Record<string, unknown>): CaptureConfigPatch {
  const next: CaptureConfigPatch = {};
  if (patch.uploadEnabled !== undefined) {
    if (typeof patch.uploadEnabled !== "boolean") throw new Error("uploadEnabled must be a boolean.");
    next.uploadEnabled = patch.uploadEnabled;
  }
  if (patch.windowTitleCapture !== undefined) {
    if (typeof patch.windowTitleCapture !== "boolean") throw new Error("windowTitleCapture must be a boolean.");
    next.windowTitleCapture = patch.windowTitleCapture;
  }
  if (patch.windowTitleUpload !== undefined) {
    if (typeof patch.windowTitleUpload !== "boolean") throw new Error("windowTitleUpload must be a boolean.");
    next.windowTitleUpload = patch.windowTitleUpload;
  }
  if (patch.localFileEnabled !== undefined) {
    if (typeof patch.localFileEnabled !== "boolean") throw new Error("localFileEnabled must be a boolean.");
    next.localFileEnabled = patch.localFileEnabled;
  }
  if (patch.screenshotsEnabled !== undefined) {
    if (typeof patch.screenshotsEnabled !== "boolean") throw new Error("screenshotsEnabled must be a boolean.");
    next.screenshotsEnabled = patch.screenshotsEnabled;
  }
  if (patch.screenshotIntervalSeconds !== undefined) {
    if (!isIntegerBetween(patch.screenshotIntervalSeconds, 60, 3600)) throw new Error("screenshotIntervalSeconds must be an integer between 60 and 3600.");
    next.screenshotIntervalSeconds = patch.screenshotIntervalSeconds;
  }
  if (patch.screenshotRetentionDays !== undefined) {
    if (!isIntegerBetween(patch.screenshotRetentionDays, 1, 90)) throw new Error("screenshotRetentionDays must be an integer between 1 and 90.");
    next.screenshotRetentionDays = patch.screenshotRetentionDays;
  }
  if (patch.intervalSeconds !== undefined) {
    if (typeof patch.intervalSeconds !== "number" || !Number.isInteger(patch.intervalSeconds) || patch.intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive integer.");
    }
    next.intervalSeconds = patch.intervalSeconds;
  }
  if (patch.retentionDays !== undefined) {
    if (typeof patch.retentionDays !== "number" || !Number.isInteger(patch.retentionDays) || patch.retentionDays <= 0) {
      throw new Error("retentionDays must be a positive integer.");
    }
    next.retentionDays = patch.retentionDays;
  }
  if (patch.excludePatterns !== undefined) {
    if (!Array.isArray(patch.excludePatterns) || patch.excludePatterns.some((pattern) => typeof pattern !== "string")) {
      throw new Error("excludePatterns must be an array of strings.");
    }
    next.excludePatterns = patch.excludePatterns;
  }
  if (patch.idleThresholdSeconds !== undefined) {
    if (!isValidIdleThreshold(patch.idleThresholdSeconds)) {
      throw new Error("idleThresholdSeconds must be an integer between 60 and 3600.");
    }
    next.idleThresholdSeconds = patch.idleThresholdSeconds;
  }
  if (patch.categoryMap !== undefined) {
    if (!isCategoryMap(patch.categoryMap)) {
      throw new Error("categoryMap must be an object mapping non-empty process names to non-empty category strings.");
    }
    next.categoryMap = normalizeCategoryMap(patch.categoryMap);
  }
  return next;
}

function toSample(row: SampleRow): CaptureSample {
  return {
    sampledAt: row.sampled_at,
    processName: row.process_name,
    windowTitle: row.window_title,
    idle: Boolean(row.idle)
  };
}

function nextDateString(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function compileExcludePatterns(patterns: string[], logger?: CaptureLogger): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch (error) {
      logger?.warn("[capture] ignoring invalid exclude pattern", {
        pattern,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return compiled;
}

function isExcluded(sample: CaptureSampleInput, config: CaptureConfig, logger?: CaptureLogger): boolean {
  const target = `${sample.processName}\n${sample.windowTitle}`;
  return compileExcludePatterns(config.excludePatterns, logger).some((pattern) => pattern.test(target));
}

export class CaptureStorage {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly logger?: CaptureLogger;

  constructor(dbPath: string, options: CaptureStorageOptions = {}) {
    this.dbPath = resolve(dbPath);
    this.logger = options.logger;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.ensureSchema();
  }

  static open(input: { syncRoot: string; dbPath?: string; env?: NodeJS.ProcessEnv; logger?: CaptureLogger }): CaptureStorage {
    return new CaptureStorage(resolveCaptureDbPath(input), { logger: input.logger });
  }

  static exists(input: { syncRoot: string; dbPath?: string; env?: NodeJS.ProcessEnv }): boolean {
    return existsSync(resolveCaptureDbPath(input));
  }

  close(): void {
    this.db.close();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sampled_at TEXT NOT NULL,
        process_name TEXT NOT NULL,
        window_title TEXT NOT NULL,
        idle INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_capture_samples_time ON capture_samples(sampled_at);
      CREATE TABLE IF NOT EXISTS capture_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capture_screenshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        file_path TEXT NOT NULL,
        process_name TEXT,
        window_title TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_capture_screenshots_time ON capture_screenshots(captured_at DESC, id DESC);
    `);
    this.ensureSampleIdleColumn();
  }

  private ensureSampleIdleColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(capture_samples)").all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "idle")) {
      this.db.exec("ALTER TABLE capture_samples ADD COLUMN idle INTEGER NOT NULL DEFAULT 0");
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM capture_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO capture_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getLastRetentionDate(): string | undefined {
    return this.getMeta(LAST_RETENTION_DATE_META_KEY);
  }

  setLastRetentionDate(date: string): void {
    this.setMeta(LAST_RETENTION_DATE_META_KEY, date);
  }

  getConfig(): CaptureConfig {
    const raw = this.getMeta(CONFIG_META_KEY);
    if (!raw) return defaultCaptureConfig();
    try {
      return normalizeConfig(JSON.parse(raw) as unknown);
    } catch {
      return defaultCaptureConfig();
    }
  }

  setConfig(config: CaptureConfig): CaptureConfig {
    const normalized = normalizeConfig(config);
    this.setMeta(CONFIG_META_KEY, JSON.stringify(normalized));
    return normalized;
  }

  updateConfig(patch: CaptureConfigPatch): CaptureConfig {
    return this.setConfig({ ...this.getConfig(), ...patch });
  }

  setEnabled(enabled: boolean): CaptureConfig {
    return this.setConfig({ ...this.getConfig(), enabled });
  }

  insertSample(sample: CaptureSampleInput, config = this.getConfig()): boolean {
    if (isExcluded(sample, config, this.logger)) return false;
    this.db.prepare(`
      INSERT INTO capture_samples (sampled_at, process_name, window_title, idle)
      VALUES (?, ?, ?, ?)
    `).run(sample.sampledAt, sample.processName, config.windowTitleCapture ? sample.windowTitle : "", sample.idle ? 1 : 0);
    return true;
  }

  get screenshotsDir(): string {
    return join(dirname(this.dbPath), "screenshots");
  }

  insertScreenshot(input: { capturedAt: string; filePath: string; processName?: string; windowTitle?: string }): number {
    const result = this.db.prepare(`INSERT INTO capture_screenshots (captured_at, file_path, process_name, window_title) VALUES (?, ?, ?, ?)`)
      .run(input.capturedAt, resolve(input.filePath), input.processName ?? null, input.windowTitle ?? null);
    return Number(result.lastInsertRowid);
  }

  listScreenshots(options: { date?: string; limit?: number; cursor?: string } = {}): { items: CaptureScreenshotRecord[]; nextCursor?: string } {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
    const cursor = options.cursor && /^\d+$/.test(options.cursor) ? Number(options.cursor) : undefined;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.date) { clauses.push("captured_at >= ? AND captured_at < ?"); params.push(`${options.date}T00:00:00.000Z`, `${nextDateString(options.date)}T00:00:00.000Z`); }
    if (cursor !== undefined) { clauses.push("id < ?"); params.push(cursor); }
    const rows = this.db.prepare(`SELECT id, captured_at, process_name, window_title FROM capture_screenshots ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY captured_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as Array<{ id: number; captured_at: string; process_name: string | null; window_title: string | null }>;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({ id: row.id, capturedAt: row.captured_at, processName: row.process_name ?? undefined, windowTitle: row.window_title ?? undefined })),
      ...(rows.length > limit && page.length ? { nextCursor: String(page[page.length - 1].id) } : {})
    };
  }

  screenshotFilePath(id: number): string | undefined {
    const row = this.db.prepare("SELECT file_path FROM capture_screenshots WHERE id = ?").get(id) as { file_path?: string } | undefined;
    if (!row?.file_path) return undefined;
    const filePath = resolve(row.file_path);
    return isPathInsideDirectory(this.screenshotsDir, filePath) && filePath !== resolve(this.screenshotsDir) ? filePath : undefined;
  }

  deleteScreenshotsOlderThan(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
    const rows = this.db.prepare("SELECT file_path FROM capture_screenshots WHERE captured_at < ?").all(cutoff) as Array<{ file_path: string }>;
    for (const row of rows) {
      try { unlinkSync(row.file_path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger?.warn("[capture] failed to delete screenshot", { filePath: row.file_path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const result = this.db.prepare("DELETE FROM capture_screenshots WHERE captured_at < ?").run(cutoff);
    if (existsSync(this.screenshotsDir)) for (const entry of readdirSync(this.screenshotsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.screenshotsDir, entry.name);
      try { if (readdirSync(directory).length === 0) rmdirSync(directory); } catch (error) { this.logger?.warn("[capture] failed to remove empty screenshot directory", { directory, message: error instanceof Error ? error.message : String(error) }); }
    }
    return Number(result.changes ?? 0);
  }

  listSamplesAfter(cursor: CaptureSampleUploadCursor | string | undefined, limit: number): CaptureStoredSample[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const tupleCursor = typeof cursor === "string"
      ? { sampledAt: cursor, id: Number.MAX_SAFE_INTEGER }
      : cursor;
    const rows = (tupleCursor
      ? this.db.prepare(`
          SELECT id, sampled_at, process_name, window_title, idle
          FROM capture_samples
          WHERE sampled_at > ? OR (sampled_at = ? AND id > ?)
          ORDER BY sampled_at ASC, id ASC
          LIMIT ?
        `).all(tupleCursor.sampledAt, tupleCursor.sampledAt, tupleCursor.id, boundedLimit)
      : this.db.prepare(`
          SELECT id, sampled_at, process_name, window_title, idle
          FROM capture_samples
          ORDER BY sampled_at ASC, id ASC
          LIMIT ?
        `).all(boundedLimit)) as SampleRow[];
    return rows.map((row) => ({ ...toSample(row), id: Number(row.id) }));
  }

  deleteSamplesOlderThan(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare("DELETE FROM capture_samples WHERE sampled_at < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }

  runDailyRetention(config = this.getConfig(), now = new Date()): number {
    const today = now.toISOString().slice(0, 10);
    if (this.getLastRetentionDate() === today) return 0;
    const removed = this.deleteSamplesOlderThan(config.retentionDays, now);
    this.deleteScreenshotsOlderThan(config.screenshotRetentionDays, now);
    this.setLastRetentionDate(today);
    return removed;
  }

  status(collectorAlive: boolean, serverUploadAllowed: boolean | null = null, now = new Date()): CaptureStatus {
    const lastSample = this.db.prepare("SELECT MAX(sampled_at) AS sampled_at FROM capture_samples").get() as { sampled_at?: string | null };
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const sampleCount = this.db.prepare("SELECT COUNT(*) AS count FROM capture_samples WHERE sampled_at >= ?").get(since) as CountRow;
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      uploadEnabled: config.uploadEnabled,
      serverUploadAllowed,
      windowTitleCapture: config.windowTitleCapture,
      windowTitleUpload: config.windowTitleUpload,
      collectorAlive,
      lastSampleAt: lastSample.sampled_at ?? undefined,
      sampleCount24h: Number(sampleCount.count ?? 0)
    };
  }
}

export function readCaptureStatusSnapshot(input: {
  syncRoot: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  collectorAlive?: boolean;
  logger?: CaptureLogger;
}): { dbPath: string; config: CaptureConfig; status: CaptureStatus } {
  const dbPath = resolveCaptureDbPath(input);
  if (!existsSync(dbPath)) {
    return {
      dbPath,
      config: defaultCaptureConfig(),
      status: {
        enabled: false,
        uploadEnabled: false,
        serverUploadAllowed: null,
        windowTitleCapture: false,
        windowTitleUpload: false,
        collectorAlive: input.collectorAlive ?? false,
        sampleCount24h: 0
      }
    };
  }
  const storage = new CaptureStorage(dbPath, { logger: input.logger });
  try {
    return {
      dbPath,
      config: storage.getConfig(),
      status: storage.status(input.collectorAlive ?? false)
    };
  } finally {
    storage.close();
  }
}

