import type { CaptureLogger } from "./types.js";

/**
 * Subset of the Analyser effective collection settings the capture layer needs
 * to gate acquisition. The server is authoritative: acquisition runs only when
 * BOTH the local opt-in AND the server policy allow it (stricter-wins).
 */
export type ServerCapturePolicy = {
  foregroundAppCapture: "off" | "metadata";
  foregroundAppUpload: boolean;
  windowTitleCapture: boolean;
  windowTitleUpload: boolean;
  screenshots: "off" | "local_only";
  localFileEvents: "off" | "metadata";
  localFileUpload: boolean;
  localRootAllow: string[];
  localRootDeny: string[];
  excludePatterns: string[];
};

type RawSettings = Partial<Record<keyof ServerCapturePolicy, unknown>>;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeServerCapturePolicy(raw: RawSettings | undefined): ServerCapturePolicy {
  return {
    foregroundAppCapture: raw?.foregroundAppCapture === "metadata" ? "metadata" : "off",
    foregroundAppUpload: raw?.foregroundAppUpload === true,
    windowTitleCapture: raw?.windowTitleCapture === true,
    windowTitleUpload: raw?.windowTitleUpload === true,
    screenshots: raw?.screenshots === "local_only" ? "local_only" : "off",
    localFileEvents: raw?.localFileEvents === "metadata" ? "metadata" : "off",
    localFileUpload: raw?.localFileUpload === true,
    localRootAllow: stringArray(raw?.localRootAllow),
    localRootDeny: stringArray(raw?.localRootDeny),
    excludePatterns: stringArray(raw?.excludePatterns)
  };
}

export type CaptureServerPolicyProviderOptions = {
  getJson: <T>(path: string) => Promise<T>;
  getMachineId: () => string | undefined;
  logger?: CaptureLogger;
  now?: () => number;
  ttlMs?: number;
};

/**
 * Fetches the owner/machine effective collection policy from Core with a short
 * TTL cache. On failure the last known value is kept (no flapping); until the
 * first successful fetch, callers treat the policy as unknown and fall back to
 * the local opt-in as the sole gate.
 */
export class CaptureServerPolicyProvider {
  private value: ServerCapturePolicy | null = null;
  private fetchedAt = 0;
  private lastWarning?: string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: CaptureServerPolicyProviderOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  get(): ServerCapturePolicy | null {
    return this.value;
  }

  async refresh(): Promise<ServerCapturePolicy | null> {
    const now = this.now();
    if (this.fetchedAt > 0 && now - this.fetchedAt < this.ttlMs) return this.value;
    this.fetchedAt = now;
    try {
      const machineId = this.options.getMachineId();
      const query = machineId ? `?machineId=${encodeURIComponent(machineId)}` : "";
      const response = await this.options.getJson<{ settings?: RawSettings }>(
        `/api/analyser/settings/effective${query}`
      );
      this.value = normalizeServerCapturePolicy(response?.settings);
      this.lastWarning = undefined;
      return this.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastWarning) {
        this.lastWarning = message;
        this.options.logger?.warn("[capture] server policy refresh failed", { message });
      }
      return this.value;
    }
  }
}
