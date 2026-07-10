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
  CaptureStatus,
  CaptureSummaryMetrics,
  CaptureSummaryRecord
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
  screenshotsEnabled: false,
  screenshotIntervalSeconds: DEFAULT_SCREENSHOT_INTERVAL_SECONDS,
  screenshotRetentionDays: DEFAULT_SCREENSHOT_RETENTION_DAYS,
  intervalSeconds: DEFAULT_CAPTURE_INTERVAL_SECONDS,
  retentionDays: DEFAULT_CAPTURE_RETENTION_DAYS,
  excludePatterns: [],
  autoPublish: false,
  idleThresholdSeconds: DEFAULT_CAPTURE_IDLE_THRESHOLD_SECONDS,
  categoryMap: { ...DEFAULT_CAPTURE_CATEGORY_MAP }
};

function defaultCaptureConfig(): CaptureConfig {
  return { ...DEFAULT_CAPTURE_CONFIG, categoryMap: { ...DEFAULT_CAPTURE_CONFIG.categoryMap } };
}

const CONFIG_META_KEY = "capture.config";
const LAST_RETENTION_DATE_META_KEY = "capture.lastRetentionDate";
const LAST_AUTO_SUMMARY_DATE_META_KEY = "capture.lastAutoSummaryDate";

type CaptureStorageOptions = {
  logger?: CaptureLogger;
};

type CountRow = { count: number };
type SampleRow = { sampled_at: string; process_name: string; window_title: string; idle?: number | null };
type SummaryRow = {
  summary_date: string;
  note_resource_id: string | null;
  generated_at: string;
  sample_count: number;
  summary_markdown?: string | null;
  metrics_json?: string | null;
};

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
    autoPublish: typeof record.autoPublish === "boolean" ? record.autoPublish : DEFAULT_CAPTURE_CONFIG.autoPublish,
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
  if (patch.autoPublish !== undefined) {
    if (typeof patch.autoPublish !== "boolean") {
      throw new Error("autoPublish must be a boolean.");
    }
    next.autoPublish = patch.autoPublish;
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

function parseMetrics(value: string | null | undefined): CaptureSummaryMetrics | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as CaptureSummaryMetrics
      : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(row: SummaryRow, includeDetail = false): CaptureSummaryRecord {
  return {
    summaryDate: row.summary_date,
    noteResourceId: row.note_resource_id ?? undefined,
    generatedAt: row.generated_at,
    sampleCount: Number(row.sample_count ?? 0),
    published: Boolean(row.note_resource_id),
    ...(includeDetail ? {
      summaryMarkdown: row.summary_markdown ?? undefined,
      metrics: parseMetrics(row.metrics_json)
    } : {})
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
      CREATE TABLE IF NOT EXISTS capture_summaries (
        summary_date TEXT PRIMARY KEY,
        note_resource_id TEXT,
        generated_at TEXT NOT NULL,
        sample_count INTEGER NOT NULL
      );
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
    this.ensureSummaryMarkdownColumn();
    this.ensureSampleIdleColumn();
    this.ensureSummaryMetricsColumn();
  }

  private ensureSummaryMarkdownColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(capture_summaries)").all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "summary_markdown")) {
      this.db.exec("ALTER TABLE capture_summaries ADD COLUMN summary_markdown TEXT");
    }
  }

  private ensureSampleIdleColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(capture_samples)").all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "idle")) {
      this.db.exec("ALTER TABLE capture_samples ADD COLUMN idle INTEGER NOT NULL DEFAULT 0");
    }
  }

  private ensureSummaryMetricsColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(capture_summaries)").all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "metrics_json")) {
      this.db.exec("ALTER TABLE capture_summaries ADD COLUMN metrics_json TEXT");
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

  getLastAutoSummaryDate(): string | undefined {
    return this.getMeta(LAST_AUTO_SUMMARY_DATE_META_KEY);
  }

  setLastAutoSummaryDate(date: string): void {
    this.setMeta(LAST_AUTO_SUMMARY_DATE_META_KEY, date);
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
    `).run(sample.sampledAt, sample.processName, sample.windowTitle, sample.idle ? 1 : 0);
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

  listSamplesForDate(summaryDate: string): CaptureSample[] {
    const start = `${summaryDate}T00:00:00.000Z`;
    const end = `${nextDateString(summaryDate)}T00:00:00.000Z`;
    return (this.db.prepare(`
      SELECT sampled_at, process_name, window_title, idle
      FROM capture_samples
      WHERE sampled_at >= ? AND sampled_at < ?
      ORDER BY sampled_at ASC, id ASC
    `).all(start, end) as SampleRow[]).map(toSample);
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

  getSummary(summaryDate: string): CaptureSummaryRecord | undefined {
    const row = this.db.prepare(`
      SELECT summary_date, note_resource_id, generated_at, sample_count, summary_markdown, metrics_json
      FROM capture_summaries
      WHERE summary_date = ?
    `).get(summaryDate) as SummaryRow | undefined;
    return row ? toSummary(row, true) : undefined;
  }

  listSummaries(options: { limit?: number; cursor?: string } = {}): { items: CaptureSummaryRecord[]; nextCursor?: string } {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
    const cursor = options.cursor?.trim();
    const rows = (cursor
      ? this.db.prepare(`
          SELECT summary_date, note_resource_id, generated_at, sample_count
          FROM capture_summaries
          WHERE summary_date < ?
          ORDER BY summary_date DESC
          LIMIT ?
        `).all(cursor, limit + 1)
      : this.db.prepare(`
          SELECT summary_date, note_resource_id, generated_at, sample_count
          FROM capture_summaries
          ORDER BY summary_date DESC
          LIMIT ?
        `).all(limit + 1)) as SummaryRow[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => toSummary(row)),
      ...(rows.length > limit && page.length > 0 ? { nextCursor: page[page.length - 1].summary_date } : {})
    };
  }

  saveSummary(
    summaryDate: string,
    summaryMarkdown: string,
    sampleCount: number,
    metricsOrGeneratedAt?: CaptureSummaryMetrics | string,
    generatedAt = new Date().toISOString()
  ): CaptureSummaryRecord {
    const metrics = typeof metricsOrGeneratedAt === "string" ? undefined : metricsOrGeneratedAt;
    const persistedAt = typeof metricsOrGeneratedAt === "string" ? metricsOrGeneratedAt : generatedAt;
    // Preserves note_resource_id so regeneration keeps the published-note linkage.
    this.db.prepare(`
      INSERT INTO capture_summaries (summary_date, note_resource_id, generated_at, sample_count, summary_markdown, metrics_json)
      VALUES (?, NULL, ?, ?, ?, ?)
      ON CONFLICT(summary_date) DO UPDATE SET
        generated_at = excluded.generated_at,
        sample_count = excluded.sample_count,
        summary_markdown = excluded.summary_markdown,
        metrics_json = excluded.metrics_json
    `).run(summaryDate, persistedAt, sampleCount, summaryMarkdown, metrics ? JSON.stringify(metrics) : null);
    const stored = this.getSummary(summaryDate);
    if (!stored) throw new Error(`Capture summary for ${summaryDate} was not persisted.`);
    return stored;
  }

  setSummaryNoteResourceId(summaryDate: string, noteResourceId: string): CaptureSummaryRecord | undefined {
    this.db.prepare(`
      UPDATE capture_summaries SET note_resource_id = ? WHERE summary_date = ?
    `).run(noteResourceId, summaryDate);
    return this.getSummary(summaryDate);
  }

  status(collectorAlive: boolean, now = new Date()): CaptureStatus {
    const lastSample = this.db.prepare("SELECT MAX(sampled_at) AS sampled_at FROM capture_samples").get() as { sampled_at?: string | null };
    const lastSummary = this.db.prepare("SELECT MAX(generated_at) AS generated_at FROM capture_summaries").get() as { generated_at?: string | null };
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const sampleCount = this.db.prepare("SELECT COUNT(*) AS count FROM capture_samples WHERE sampled_at >= ?").get(since) as CountRow;
    return {
      enabled: this.getConfig().enabled,
      collectorAlive,
      lastSampleAt: lastSample.sampled_at ?? undefined,
      lastSummaryAt: lastSummary.generated_at ?? undefined,
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

