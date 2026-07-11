import { randomUUID } from "node:crypto";
import type { CaptureLogger } from "./types.js";
import { CaptureStorage, type CaptureSampleUploadCursor } from "./storage.js";

const MACHINE_KEY_META = "capture.machineKey";
const MACHINE_ID_META = "capture.machineId";
const SAMPLES_CURSOR_META = "capture.upload.samplesCursor";
const SUMMARIES_WATERMARK_META = "capture.upload.summariesWatermark";

export type CapturePostJson = <T = unknown>(path: string, body: unknown) => Promise<T>;

export type CaptureUploaderOptions = {
  storage: CaptureStorage;
  postJson: CapturePostJson;
  displayName: string;
  platform: NodeJS.Platform;
  logger?: CaptureLogger;
  createMachineKey?: () => string;
};

function parseSampleCursor(value: string | undefined): CaptureSampleUploadCursor | string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<CaptureSampleUploadCursor>;
    if (typeof parsed.sampledAt === "string" && Number.isSafeInteger(parsed.id) && Number(parsed.id) >= 0) {
      return { sampledAt: parsed.sampledAt, id: Number(parsed.id) };
    }
  } catch {
    // Legacy cursors stored only sampled_at.
  }
  return value;
}

export class CaptureUploader {
  private readonly storage: CaptureStorage;
  private readonly postJson: CapturePostJson;
  private readonly displayName: string;
  private readonly platform: NodeJS.Platform;
  private readonly logger?: CaptureLogger;
  private readonly createMachineKey: () => string;
  private lastWarning?: string;

  constructor(options: CaptureUploaderOptions) {
    this.storage = options.storage;
    this.postJson = options.postJson;
    this.displayName = options.displayName;
    this.platform = options.platform;
    this.logger = options.logger;
    this.createMachineKey = options.createMachineKey ?? randomUUID;
  }

  async run(): Promise<void> {
    const config = this.storage.getConfig();
    if (!config.enabled || !config.uploadEnabled) return;

    try {
      const machineId = await this.ensureMachine();
      await this.uploadSamples(machineId);
      await this.uploadSummaries(machineId);
      this.lastWarning = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastWarning) {
        this.lastWarning = message;
        this.logger?.warn("[capture] insights upload failed", { message });
      }
    }
  }

  private machineKey(): string {
    const existing = this.storage.getMeta(MACHINE_KEY_META)?.trim();
    if (existing) return existing;
    const created = this.createMachineKey();
    this.storage.setMeta(MACHINE_KEY_META, created);
    return created;
  }

  private async ensureMachine(): Promise<string> {
    const existing = this.storage.getMeta(MACHINE_ID_META)?.trim();
    if (existing) return existing;
    const machine = await this.postJson<{ id?: unknown }>("/api/insights/machines/register", {
      machineKey: this.machineKey(),
      displayName: this.displayName,
      platform: this.platform
    });
    if (!machine || typeof machine.id !== "string" || !machine.id.trim()) {
      throw new Error("Insights machine registration returned no machine id.");
    }
    this.storage.setMeta(MACHINE_ID_META, machine.id);
    return machine.id;
  }

  private async uploadSamples(machineId: string): Promise<void> {
    let cursor = parseSampleCursor(this.storage.getMeta(SAMPLES_CURSOR_META));
    for (let batchNumber = 0; batchNumber < 4; batchNumber += 1) {
      const rows = this.storage.listSamplesAfter(cursor, 500);
      if (rows.length === 0) return;
      await this.postJson("/api/insights/ingest/samples", {
        machineId,
        samples: rows.map(({ id: _id, ...sample }) => ({ ...sample, idle: sample.idle ?? false }))
      });
      const last = rows[rows.length - 1];
      cursor = { sampledAt: last.sampledAt, id: last.id };
      this.storage.setMeta(SAMPLES_CURSOR_META, JSON.stringify(cursor));
      if (rows.length < 500) return;
    }
  }

  private async uploadSummaries(machineId: string): Promise<void> {
    const rows = this.storage.listSummariesGeneratedAfter(this.storage.getMeta(SUMMARIES_WATERMARK_META), 50);
    if (rows.length === 0) return;
    await this.postJson("/api/insights/ingest/summaries", {
      machineId,
      summaries: rows.map((summary) => ({
        summaryDate: summary.summaryDate,
        summaryMarkdown: summary.summaryMarkdown ?? "",
        metricsJson: summary.metrics,
        sampleCount: summary.sampleCount,
        generatedAt: summary.generatedAt
      }))
    });
    this.storage.setMeta(SUMMARIES_WATERMARK_META, rows[rows.length - 1].generatedAt);
  }
}

export const CAPTURE_UPLOAD_META_KEYS = {
  machineKey: MACHINE_KEY_META,
  machineId: MACHINE_ID_META,
  samplesCursor: SAMPLES_CURSOR_META,
  summariesWatermark: SUMMARIES_WATERMARK_META
} as const;
