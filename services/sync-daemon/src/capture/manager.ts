import type {
  CaptureConfig,
  CaptureConfigPatch,
  CaptureLogger,
  CaptureStatus,
  CaptureSummaryPublisher
} from "./types.js";
import { buildCaptureSummaryMarkdown } from "./summarizer.js";
import { CaptureStorage, validateCaptureConfigPatch } from "./storage.js";
import { CaptureError, CaptureSupervisor, type CaptureSupervisorOptions } from "./supervisor.js";

export type CaptureManagerOptions = {
  syncRoot: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: CaptureLogger;
  publisher: CaptureSummaryPublisher;
  supervisorOptions?: Partial<Omit<CaptureSupervisorOptions, "onSample" | "logger" | "platform">>;
};

export type CaptureApiStatus = {
  dbPath: string;
  config: CaptureConfig;
  status: CaptureStatus;
};

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function previousDateString(date: Date): string {
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

function validateSummaryDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CaptureError("date must use YYYY-MM-DD format.", 400, "CAPTURE_DATE_INVALID");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CaptureError("date must be a valid calendar date.", 400, "CAPTURE_DATE_INVALID");
  }
  return value;
}

export class CaptureManager {
  readonly storage: CaptureStorage;
  private readonly supervisor: CaptureSupervisor;
  private readonly publisher: CaptureSummaryPublisher;
  private readonly logger?: CaptureLogger;

  constructor(options: CaptureManagerOptions) {
    this.logger = options.logger;
    this.publisher = options.publisher;
    this.storage = CaptureStorage.open({
      syncRoot: options.syncRoot,
      dbPath: options.dbPath,
      env: options.env,
      logger: options.logger
    });
    this.supervisor = new CaptureSupervisor({
      platform: options.platform,
      logger: options.logger,
      ...options.supervisorOptions,
      onSample: (sample) => {
        this.storage.insertSample(sample, this.storage.getConfig());
      }
    });
  }

  close(): void {
    this.supervisor.stop();
    this.storage.close();
  }

  async startFromConfig(): Promise<void> {
    const config = this.storage.getConfig();
    if (!config.enabled) return;
    try {
      await this.supervisor.start(config);
    } catch (error) {
      this.logger?.warn("[capture] configured collector did not start", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  status(): CaptureStatus {
    return this.storage.status(this.supervisor.alive);
  }

  apiStatus(): CaptureApiStatus {
    return {
      dbPath: this.storage.dbPath,
      config: this.storage.getConfig(),
      status: this.status()
    };
  }

  config(): CaptureConfig {
    return this.storage.getConfig();
  }

  async enable(): Promise<CaptureApiStatus> {
    const config = this.storage.setEnabled(true);
    try {
      await this.supervisor.start(config);
    } catch (error) {
      this.storage.setEnabled(false);
      throw error;
    }
    return this.apiStatus();
  }

  async disable(): Promise<CaptureApiStatus> {
    this.storage.setEnabled(false);
    this.supervisor.stop();
    return this.apiStatus();
  }

  async updateConfig(rawPatch: Record<string, unknown>): Promise<CaptureApiStatus> {
    const previous = this.storage.getConfig();
    const patch = validateCaptureConfigPatch(rawPatch);
    const next = this.storage.updateConfig(patch as CaptureConfigPatch);
    if (next.enabled && previous.intervalSeconds !== next.intervalSeconds) {
      await this.supervisor.restart(next);
    }
    return this.apiStatus();
  }

  async summarize(summaryDate?: string, now = new Date()): Promise<Record<string, unknown>> {
    const date = validateSummaryDate(summaryDate ?? previousDateString(now));
    const config = this.storage.getConfig();
    const samples = this.storage.listSamplesForDate(date);
    const existing = this.storage.getSummary(date);
    const title = `Capture Daily Summary ${date}`;
    const contentMarkdown = buildCaptureSummaryMarkdown(date, samples, config.intervalSeconds);
    const published = await this.publisher.publishSummary({
      summaryDate: date,
      noteResourceId: existing?.noteResourceId,
      title,
      contentMarkdown,
      tags: ["workbench-capture"],
      lifecycleState: "raw",
      sampleCount: samples.length
    });
    const summary = this.storage.recordSummary(date, published.noteResourceId, samples.length, now.toISOString());
    return {
      ...summary,
      action: published.action,
      title
    };
  }

  async runDailyTasks(now = new Date()): Promise<void> {
    const config = this.storage.getConfig();
    this.storage.runDailyRetention(config, now);
    if (!config.enabled) return;
    const today = dateString(now);
    if (this.storage.getLastAutoSummaryDate() === today) return;
    await this.summarize(previousDateString(now), now);
    this.storage.setLastAutoSummaryDate(today);
  }
}

export { CaptureError } from "./supervisor.js";

