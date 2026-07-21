import { randomUUID } from "node:crypto";
import type { CaptureConfig, CaptureLogger } from "./types.js";
import { CaptureStorage, type CaptureSampleUploadCursor } from "./storage.js";
import type { LocalFileEvent } from "./fileWatcher.js";
import type { ServerCapturePolicy } from "./serverPolicy.js";

const MACHINE_KEY_META = "capture.machineKey";
const MACHINE_ID_META = "analyser.machineId";
const SAMPLES_CURSOR_META = "analyser.upload.samplesCursor";
const POLICY_CACHE_MS = 60_000;

export type CapturePostJson = <T = unknown>(path: string, body: unknown) => Promise<T>;
export type CaptureGetJson = <T = unknown>(path: string) => Promise<T>;

export type CaptureUploaderOptions = {
  storage: CaptureStorage;
  postJson: CapturePostJson;
  getJson: CaptureGetJson;
  displayName: string;
  platform: NodeJS.Platform;
  logger?: CaptureLogger;
  createMachineKey?: () => string;
  now?: () => number;
  getServerPolicy?: () => ServerCapturePolicy | null;
};

function parseSampleCursor(value: string | undefined): CaptureSampleUploadCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<CaptureSampleUploadCursor>;
    if (typeof parsed.sampledAt === "string" && Number.isSafeInteger(parsed.id) && Number(parsed.id) >= 0) {
      return { sampledAt: parsed.sampledAt, id: Number(parsed.id) };
    }
  } catch {
    // Ignore invalid analyser cursors and restart from the oldest retained sample.
  }
  return undefined;
}

export class CaptureUploader {
  private readonly storage: CaptureStorage;
  private readonly postJson: CapturePostJson;
  private readonly getJson: CaptureGetJson;
  private readonly displayName: string;
  private readonly platform: NodeJS.Platform;
  private readonly logger?: CaptureLogger;
  private readonly createMachineKey: () => string;
  private readonly now: () => number;
  private readonly getServerPolicy?: () => ServerCapturePolicy | null;
  private lastWarning?: string;
  private policyFetchedAt = 0;
  private serverUploadAllowedState: boolean | null = null;

  constructor(options: CaptureUploaderOptions) {
    this.storage = options.storage;
    this.postJson = options.postJson;
    this.getJson = options.getJson;
    this.displayName = options.displayName;
    this.platform = options.platform;
    this.logger = options.logger;
    this.createMachineKey = options.createMachineKey ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.getServerPolicy = options.getServerPolicy;
  }

  get serverUploadAllowed(): boolean | null {
    return this.serverUploadAllowedState;
  }

  async run(): Promise<void> {
    const config = this.storage.getConfig();
    if (!config.enabled || !config.uploadEnabled) return;

    try {
      const machineId = await this.ensureMachine();
      const allowed = await this.effectiveUploadAllowed(machineId);
      if (allowed !== true) {
        if (allowed === false) this.lastWarning = undefined;
        return;
      }
      await this.uploadSamples(machineId, config);
      this.lastWarning = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastWarning) {
        this.lastWarning = message;
        this.logger?.warn("[capture] analyser upload failed", { message });
      }
    }
  }

  async uploadFileEvents(events: LocalFileEvent[]): Promise<void> {
    if (events.length === 0 || this.getServerPolicy?.()?.localFileUpload !== true) return;
    const machineId = await this.ensureMachine();
    for (let offset = 0; offset < events.length; offset += 500) {
      const batch = events.slice(offset, offset + 500);
      await this.postJson("/api/analyser/observations/ingest", {
        machineId,
        observations: batch.map((event) => ({
          source: "local_file",
          action: `file_${event.eventType}`,
          actorKind: "user",
          occurredAt: event.observedAt,
          resourceRefs: [{ service: "local", resourceType: "file", resourceId: event.relativePath, pathSnapshot: event.root }],
          metadata: {
            eventType: event.eventType,
            root: event.root,
            relativePath: event.relativePath,
            ...(event.mtime ? { mtime: event.mtime } : {}),
            ...(event.size === undefined ? {} : { size: event.size })
          },
          dedupeKey: `local_file:${machineId}:${event.root}:${event.relativePath}:${event.eventType}:${event.mtime ?? event.observedAt}`
        }))
      });
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
    const machine = await this.postJson<{ id?: unknown }>("/api/analyser/machines/register", {
      machineKey: this.machineKey(),
      displayName: this.displayName,
      platform: this.platform
    });
    if (!machine || typeof machine.id !== "string" || !machine.id.trim()) {
      throw new Error("Analyser machine registration returned no machine id.");
    }
    this.storage.setMeta(MACHINE_ID_META, machine.id);
    return machine.id;
  }

  private setServerUploadAllowed(value: boolean | null): void {
    if (value === this.serverUploadAllowedState) return;
    this.serverUploadAllowedState = value;
    this.logger?.info("[capture] analyser foreground upload policy changed", { allowed: value });
  }

  private async effectiveUploadAllowed(machineId: string): Promise<boolean | null> {
    const now = this.now();
    if (this.policyFetchedAt > 0 && now - this.policyFetchedAt < POLICY_CACHE_MS) {
      return this.serverUploadAllowedState;
    }
    this.policyFetchedAt = now;
    try {
      const response = await this.getJson<{ settings?: { foregroundAppUpload?: unknown } }>(
        `/api/analyser/settings/effective?machineId=${encodeURIComponent(machineId)}`
      );
      const allowed = response?.settings?.foregroundAppUpload === true;
      this.setServerUploadAllowed(allowed);
      return allowed;
    } catch (error) {
      this.setServerUploadAllowed(null);
      throw error;
    }
  }

  private async uploadSamples(machineId: string, config: CaptureConfig): Promise<void> {
    let cursor = parseSampleCursor(this.storage.getMeta(SAMPLES_CURSOR_META));
    for (let batchNumber = 0; batchNumber < 4; batchNumber += 1) {
      const rows = this.storage.listSamplesAfter(cursor, 500);
      if (rows.length === 0) return;
      await this.postJson("/api/analyser/observations/ingest", {
        machineId,
        observations: rows.map((sample) => ({
          source: "pc_activity",
          action: "foreground_sample",
          actorKind: "user",
          occurredAt: sample.sampledAt,
          metadata: {
            app: sample.processName,
            idle: sample.idle ?? false,
            intervalSeconds: config.intervalSeconds,
            ...(config.windowTitleUpload && sample.windowTitle ? { windowTitle: sample.windowTitle } : {})
          },
          dedupeKey: `pc:${machineId}:${sample.sampledAt}`
        }))
      });
      const last = rows[rows.length - 1];
      cursor = { sampledAt: last.sampledAt, id: last.id };
      this.storage.setMeta(SAMPLES_CURSOR_META, JSON.stringify(cursor));
      if (rows.length < 500) return;
    }
  }
}

export const CAPTURE_UPLOAD_META_KEYS = {
  machineKey: MACHINE_KEY_META,
  machineId: MACHINE_ID_META,
  samplesCursor: SAMPLES_CURSOR_META
} as const;
