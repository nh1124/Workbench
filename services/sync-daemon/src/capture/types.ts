export type CaptureConfig = {
  enabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
  excludePatterns: string[];
};

export type CaptureConfigPatch = {
  intervalSeconds?: number;
  retentionDays?: number;
  excludePatterns?: string[];
};

export type CaptureSample = {
  sampledAt: string;
  processName: string;
  windowTitle: string;
};

export type CaptureSummaryRecord = {
  summaryDate: string;
  noteResourceId?: string;
  generatedAt: string;
  sampleCount: number;
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

