import type {
  CaptureConfig,
  CaptureConfigPatch,
  CaptureLogger,
  CaptureStatus,
  CaptureSample
} from "./types.js";
import { CaptureStorage, validateCaptureConfigPatch } from "./storage.js";
import { CaptureError, CaptureSupervisor, type CaptureSupervisorOptions } from "./supervisor.js";
import { ScreenshotScheduler, type ScreenshotSchedulerOptions } from "./screenshotScheduler.js";

export type CaptureManagerOptions = {
  syncRoot: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: CaptureLogger;
  supervisorOptions?: Partial<Omit<CaptureSupervisorOptions, "onSample" | "logger" | "platform">>;
  screenshotOptions?: Partial<Omit<ScreenshotSchedulerOptions, "logger" | "platform" | "screenshotsDir" | "getConfig" | "getLastForeground" | "onCaptured">>;
};

export type CaptureApiStatus = {
  dbPath: string;
  config: CaptureConfig;
  status: CaptureStatus;
};

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
  private readonly logger?: CaptureLogger;
  private readonly screenshotScheduler: ScreenshotScheduler;
  private lastForeground?: CaptureSample;

  constructor(options: CaptureManagerOptions) {
    this.logger = options.logger;
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
        this.lastForeground = sample;
        this.storage.insertSample(sample, this.storage.getConfig());
      }
    });
    this.screenshotScheduler = new ScreenshotScheduler({
      platform: options.platform,
      logger: options.logger,
      ...options.screenshotOptions,
      screenshotsDir: this.storage.screenshotsDir,
      getConfig: () => this.storage.getConfig(),
      getLastForeground: () => this.lastForeground,
      onCaptured: (input) => { this.storage.insertScreenshot(input); }
    });
  }

  close(): void {
    this.supervisor.stop();
    this.screenshotScheduler.stop();
    this.storage.close();
  }

  async startFromConfig(): Promise<void> {
    const config = this.storage.getConfig();
    if (!config.enabled) return;
    try {
      await this.supervisor.start(config);
      this.screenshotScheduler.start();
    } catch (error) {
      this.logger?.warn("[capture] configured collector did not start", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  status(serverUploadAllowed: boolean | null = null): CaptureStatus {
    return this.storage.status(this.supervisor.alive, serverUploadAllowed);
  }

  apiStatus(serverUploadAllowed: boolean | null = null): CaptureApiStatus {
    return {
      dbPath: this.storage.dbPath,
      config: this.storage.getConfig(),
      status: this.status(serverUploadAllowed)
    };
  }

  config(): CaptureConfig {
    return this.storage.getConfig();
  }

  async enable(): Promise<CaptureApiStatus> {
    const config = this.storage.setEnabled(true);
    try {
      await this.supervisor.start(config);
      this.screenshotScheduler.start();
    } catch (error) {
      this.storage.setEnabled(false);
      throw error;
    }
    return this.apiStatus();
  }

  async disable(): Promise<CaptureApiStatus> {
    this.storage.setEnabled(false);
    this.supervisor.stop();
    this.screenshotScheduler.stop();
    return this.apiStatus();
  }

  async updateConfig(rawPatch: Record<string, unknown>): Promise<CaptureApiStatus> {
    const previous = this.storage.getConfig();
    const patch = validateCaptureConfigPatch(rawPatch);
    const next = this.storage.updateConfig(patch as CaptureConfigPatch);
    if (next.enabled && (
      previous.intervalSeconds !== next.intervalSeconds
      || previous.idleThresholdSeconds !== next.idleThresholdSeconds
    )) {
      await this.supervisor.restart(next);
    }
    if (previous.enabled !== next.enabled || previous.screenshotsEnabled !== next.screenshotsEnabled || previous.screenshotIntervalSeconds !== next.screenshotIntervalSeconds) {
      this.screenshotScheduler.start();
    }
    return this.apiStatus();
  }

  listScreenshots(options: { date?: string; limit?: number; cursor?: string } = {}): Record<string, unknown> {
    if (options.date) validateSummaryDate(options.date);
    return this.storage.listScreenshots(options);
  }

  screenshotFilePath(id: number): string {
    if (!Number.isSafeInteger(id) || id <= 0) throw new CaptureError("Screenshot id is invalid.", 400, "CAPTURE_SCREENSHOT_ID_INVALID");
    const filePath = this.storage.screenshotFilePath(id);
    if (!filePath) throw new CaptureError("Screenshot not found.", 404, "CAPTURE_SCREENSHOT_NOT_FOUND");
    return filePath;
  }

  runDailyRetention(now = new Date()): void {
    const config = this.storage.getConfig();
    this.storage.runDailyRetention(config, now);
  }
}

export { CaptureError } from "./supervisor.js";

