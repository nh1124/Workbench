export type CaptureConfig = {
  // Server policy mapping:
  // enabled -> foregroundAppCapture
  // uploadEnabled -> foregroundAppUpload
  enabled: boolean;
  uploadEnabled: boolean;
  windowTitleCapture: boolean;
  windowTitleUpload: boolean;
  localFileEnabled: boolean;
  screenshotsEnabled: boolean;
  screenshotIntervalSeconds: number;
  screenshotRetentionDays: number;
  intervalSeconds: number;
  retentionDays: number;
  excludePatterns: string[];
  idleThresholdSeconds: number;
  categoryMap: Record<string, string>;
};

export type CaptureConfigPatch = {
  uploadEnabled?: boolean;
  windowTitleCapture?: boolean;
  windowTitleUpload?: boolean;
  localFileEnabled?: boolean;
  screenshotsEnabled?: boolean;
  screenshotIntervalSeconds?: number;
  screenshotRetentionDays?: number;
  intervalSeconds?: number;
  retentionDays?: number;
  excludePatterns?: string[];
  idleThresholdSeconds?: number;
  categoryMap?: Record<string, string>;
};

export type CaptureScreenshotRecord = {
  id: number;
  capturedAt: string;
  processName?: string;
  windowTitle?: string;
};

export type CaptureSample = {
  sampledAt: string;
  processName: string;
  windowTitle: string;
  idle?: boolean;
};

export type CaptureSampleInput = CaptureSample;

export type CaptureStatus = {
  enabled: boolean;
  uploadEnabled: boolean;
  serverUploadAllowed: boolean | null;
  windowTitleCapture: boolean;
  windowTitleUpload: boolean;
  collectorAlive: boolean;
  lastSampleAt?: string;
  sampleCount24h: number;
};

export type CaptureLogger = Pick<Console, "warn" | "error" | "info">;

