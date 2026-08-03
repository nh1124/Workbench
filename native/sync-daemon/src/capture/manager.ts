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
import type { ServerCapturePolicy } from "./serverPolicy.js";
import { FileWatcher, type LocalFileEvent } from "./fileWatcher.js";

export type CaptureManagerOptions = {
  syncRoot: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: CaptureLogger;
  supervisorOptions?: Partial<Omit<CaptureSupervisorOptions, "onSample" | "logger" | "platform">>;
  screenshotOptions?: Partial<Omit<ScreenshotSchedulerOptions, "logger" | "platform" | "screenshotsDir" | "getConfig" | "getLastForeground" | "onCaptured">>;
  // Returns the last-known server effective policy (null until first fetch).
  // Acquisition runs only when the local opt-in AND the server policy agree.
  getServerPolicy?: () => ServerCapturePolicy | null;
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
  private readonly fileWatcher: FileWatcher;
  private readonly getServerPolicy?: () => ServerCapturePolicy | null;
  private lastForeground?: CaptureSample;

  constructor(options: CaptureManagerOptions) {
    this.logger = options.logger;
    this.getServerPolicy = options.getServerPolicy;
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
        this.storage.insertSample(sample, this.effectiveConfig());
      }
    });
    this.screenshotScheduler = new ScreenshotScheduler({
      platform: options.platform,
      logger: options.logger,
      ...options.screenshotOptions,
      screenshotsDir: this.storage.screenshotsDir,
      getConfig: () => this.effectiveConfig(),
      getLastForeground: () => this.lastForeground,
      onCaptured: (input) => { this.storage.insertScreenshot(input); }
    });
    this.fileWatcher = new FileWatcher({
      getPolicy: () => this.serverPolicy(),
      getEnabled: () => this.effectiveConfig().localFileEnabled,
      logger: options.logger
    });
  }

  private serverPolicy(): ServerCapturePolicy | null {
    return this.getServerPolicy?.() ?? null;
  }

  /**
   * Local config narrowed by the server policy (stricter-wins). Until the first
   * successful server fetch the policy is null and server-gated sources remain off.
   */
  private effectiveConfig(): CaptureConfig {
    const local = this.storage.getConfig();
    const policy = this.serverPolicy();
    if (!policy) {
      return {
        ...local,
        enabled: false,
        screenshotsEnabled: false,
        windowTitleCapture: false,
        localFileEnabled: false
      };
    }
    return {
      ...local,
      enabled: local.enabled && policy.foregroundAppCapture === true,
      screenshotsEnabled: local.screenshotsEnabled && policy.screenshots !== "off",
      windowTitleCapture: local.windowTitleCapture && policy.windowTitleCapture === true,
      localFileEnabled: local.localFileEnabled && policy.localFileEvents === "metadata"
    };
  }

  /**
   * Re-evaluate acquisition against the current effective config. Called after a
   * server-policy refresh so a UI toggle stops (or starts) local collection.
   */
  async reconcile(): Promise<void> {
    const effective = this.effectiveConfig();
    try {
      if (effective.enabled && !this.supervisor.alive) {
        await this.supervisor.start(effective);
      } else if (!effective.enabled && this.supervisor.alive) {
        this.supervisor.stop();
      }
    } catch (error) {
      this.logger?.warn("[capture] reconcile could not (re)start the sampler", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
    const wantScreenshots = effective.enabled && effective.screenshotsEnabled;
    if (wantScreenshots && !this.screenshotScheduler.active) {
      this.screenshotScheduler.start();
    } else if (!wantScreenshots && this.screenshotScheduler.active) {
      this.screenshotScheduler.stop();
    }
    // sync() internally checks getEnabled() (= effectiveConfig().localFileEnabled)
    // and getPolicy().localRootAllow, starting/stopping watchers accordingly.
    this.fileWatcher.sync();
  }

  close(): void {
    this.supervisor.stop();
    this.screenshotScheduler.stop();
    this.fileWatcher.stop();
    this.storage.close();
  }

  async startFromConfig(): Promise<void> {
    const config = this.effectiveConfig();
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

  drainFileEvents(): LocalFileEvent[] {
    return this.fileWatcher.drain();
  }

  requeueFileEvents(events: LocalFileEvent[]): void {
    this.fileWatcher.requeue(events);
  }

  async enable(): Promise<CaptureApiStatus> {
    this.storage.setEnabled(true);
    const config = this.effectiveConfig();
    try {
      if (config.enabled) {
        await this.supervisor.start(config);
        this.screenshotScheduler.start();
      }
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
    this.storage.updateConfig(patch as CaptureConfigPatch);
    const next = this.effectiveConfig();
    if (next.enabled && (
      previous.intervalSeconds !== next.intervalSeconds
      || previous.idleThresholdSeconds !== next.idleThresholdSeconds
    )) {
      await this.supervisor.restart(next);
    }
    // Server policy or the local toggles may have flipped acquisition; reconcile
    // brings the sampler and screenshot scheduler in line with the effective config.
    await this.reconcile();
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

