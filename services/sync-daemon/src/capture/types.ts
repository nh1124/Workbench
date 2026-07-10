export type CaptureConfig = {
  enabled: boolean;
  screenshotsEnabled: boolean;
  screenshotIntervalSeconds: number;
  screenshotRetentionDays: number;
  intervalSeconds: number;
  retentionDays: number;
  excludePatterns: string[];
  autoPublish: boolean;
  idleThresholdSeconds: number;
  categoryMap: Record<string, string>;
};

export type CaptureConfigPatch = {
  screenshotsEnabled?: boolean;
  screenshotIntervalSeconds?: number;
  screenshotRetentionDays?: number;
  intervalSeconds?: number;
  retentionDays?: number;
  excludePatterns?: string[];
  autoPublish?: boolean;
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

export type CaptureFocusBlock = {
  startAt: string;
  endAt: string;
  app: string;
  title: string;
  activeSeconds: number;
};

export type CaptureSummaryMetrics = {
  activeSeconds: number;
  idleSeconds: number;
  contextSwitches: number;
  focusBlocks: CaptureFocusBlock[];
  categories: Record<string, number>;
  apps: Record<string, number>;
};

export type CaptureSummaryRecord = {
  summaryDate: string;
  noteResourceId?: string;
  generatedAt: string;
  sampleCount: number;
  published: boolean;
  summaryMarkdown?: string;
  metrics?: CaptureSummaryMetrics;
};

export type CaptureSummaryListResult = {
  items: CaptureSummaryRecord[];
  nextCursor?: string;
};

export type CaptureStatus = {
  enabled: boolean;
  collectorAlive: boolean;
  lastSampleAt?: string;
  lastSummaryAt?: string;
  sampleCount24h: number;
};

export type CaptureSummaryPublishInput = {
  summaryDate: string;
  noteResourceId?: string;
  title: string;
  contentMarkdown: string;
  tags: string[];
  lifecycleState: "raw";
  sampleCount: number;
};

export type CaptureSummaryPublishResult = {
  noteResourceId: string;
  action: "create" | "update";
};

export type CaptureSummaryPublisher = {
  publishSummary(input: CaptureSummaryPublishInput): Promise<CaptureSummaryPublishResult>;
};

export type CaptureLogger = Pick<Console, "warn" | "error" | "info">;

