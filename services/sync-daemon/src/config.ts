import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeCoreUrl } from "./coreUrl.js";
import { parseSecureIdentityMode, type SecureIdentityMode } from "./identityStorage.js";

export type LocalJobConfirmationPolicy = "off" | "downloads" | "all";

export type DaemonConfig = {
  coreUrl: string;
  accessToken?: string;
  apiToken?: string;
  /** Absent means secure: the local API requires a token. */
  allowAnonymousApi?: boolean;
  /** Exit once no app has held a lease for the grace period. Off by default: sync keeps running with every window closed. */
  exitWhenIdle?: boolean;
  syncRoot: string;
  downloadsDir: string;
  deviceId: string;
  clientName: string;
  syncRootId: string;
  syncRootLabel: string;
  intervalMs: number;
  httpPort: number;
  apiAllowedOrigins?: string[];
  maxSyncFileBytes: number;
  watchEnabled: boolean;
  watchDebounceMs: number;
  persistClientIdentity?: boolean;
  secureClientIdentity?: SecureIdentityMode;
  localJobConfirmationPolicy?: LocalJobConfirmationPolicy;
};

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function envBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

export function parseLocalJobConfirmationPolicy(value: string | undefined): LocalJobConfirmationPolicy {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return "off";
  }
  if (normalized === "downloads" || normalized === "download" || normalized === "outside-sync-folder") {
    return "downloads";
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "all") {
    return "all";
  }
  return "off";
}

export function normalizeConfiguredOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "*" || trimmed === "null") return trimmed;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function parseLoopbackAllowedOrigins(raw: string | undefined): string[] | undefined {
  const values = raw
    ?.split(",")
    .map((value) => normalizeConfiguredOrigin(value))
    .filter((value): value is string => Boolean(value));
  return values && values.length > 0 ? [...new Set(values)] : undefined;
}

export function readConfig(): DaemonConfig {
  const syncRoot = resolve(env("WORKBENCH_SYNC_ROOT") ?? join(homedir(), "WorkbenchSync"));
  const downloadsDir = resolve(env("WORKBENCH_DOWNLOADS_DIR") ?? join(homedir(), "Downloads"));
  const intervalRaw = Number(env("WORKBENCH_DAEMON_INTERVAL_MS") ?? "5000");
  const httpPortRaw = Number(env("WORKBENCH_DAEMON_HTTP_PORT") ?? "35780");
  const maxSyncFileBytesRaw = Number(env("WORKBENCH_MAX_SYNC_FILE_BYTES") ?? String(10 * 1024 * 1024));
  const watchDebounceRaw = Number(env("WORKBENCH_SYNC_WATCH_DEBOUNCE_MS") ?? "800");
  const watchEnabledRaw = env("WORKBENCH_SYNC_WATCH")?.toLowerCase();
  const persistIdentityRaw = env("WORKBENCH_PERSIST_CLIENT_IDENTITY") ?? env("WORKBENCH_LOCAL_CLIENT_IDENTITY_FILE");
  const secureIdentityRaw = env("WORKBENCH_SECURE_CLIENT_IDENTITY") ?? env("WORKBENCH_LOCAL_CLIENT_SECURE_STORAGE");
  const localJobConfirmationRaw = env("WORKBENCH_LOCAL_JOB_CONFIRMATION") ?? env("WORKBENCH_LOCAL_JOB_CONFIRMATION_POLICY");
  return {
    coreUrl: normalizeCoreUrl(env("WORKBENCH_CORE_URL") ?? "http://localhost:3000"),
    accessToken: env("WORKBENCH_ACCESS_TOKEN"),
    apiToken: env("WORKBENCH_DAEMON_API_TOKEN") ?? env("WORKBENCH_LOCAL_DAEMON_TOKEN"),
    allowAnonymousApi: envBoolean(env("WORKBENCH_DAEMON_ALLOW_ANONYMOUS"), false),
    exitWhenIdle: envBoolean(env("WORKBENCH_DAEMON_EXIT_WHEN_IDLE"), false),
    syncRoot,
    downloadsDir,
    deviceId: env("WORKBENCH_DEVICE_ID") ?? `${hostname()}-${randomUUID()}`,
    clientName: env("WORKBENCH_CLIENT_NAME") ?? `${hostname()} Workbench daemon`,
    syncRootId: env("WORKBENCH_SYNC_ROOT_ID") ?? "default",
    syncRootLabel: env("WORKBENCH_SYNC_ROOT_LABEL") ?? "Workbench Sync",
    intervalMs: Number.isFinite(intervalRaw) ? Math.max(1000, intervalRaw) : 5000,
    httpPort: Number.isFinite(httpPortRaw) ? Math.max(0, httpPortRaw) : 35780,
    apiAllowedOrigins: parseLoopbackAllowedOrigins(
      env("WORKBENCH_DAEMON_ALLOWED_ORIGINS") ?? env("WORKBENCH_LOCAL_DAEMON_ALLOWED_ORIGINS")
    ),
    maxSyncFileBytes: Number.isFinite(maxSyncFileBytesRaw) ? Math.max(1024, maxSyncFileBytesRaw) : 10 * 1024 * 1024,
    watchEnabled: watchEnabledRaw !== "0" && watchEnabledRaw !== "false" && watchEnabledRaw !== "off",
    watchDebounceMs: Number.isFinite(watchDebounceRaw) ? Math.max(100, watchDebounceRaw) : 800,
    persistClientIdentity: envBoolean(persistIdentityRaw, true),
    secureClientIdentity: parseSecureIdentityMode(secureIdentityRaw),
    localJobConfirmationPolicy: parseLocalJobConfirmationPolicy(localJobConfirmationRaw)
  };
}

export async function ensureDirs(config: DaemonConfig): Promise<void> {
  await fs.mkdir(config.syncRoot, { recursive: true });
  await fs.mkdir(config.downloadsDir, { recursive: true });
  await fs.mkdir(join(config.syncRoot, ".workbench"), { recursive: true });
  await fs.mkdir(join(config.syncRoot, ".workbench", "conflicts"), { recursive: true });
}

export const DAEMON_TOKEN_FILE = "daemon-token";

/**
 * Resolves the loopback API token, generating and persisting one on first run.
 *
 * The local API can write to the filesystem and mutate offline data, and requests
 * without an Origin header are not covered by the CORS allowlist, so it must never
 * be reachable unauthenticated. Generating a stable token keeps existing setups
 * working without forcing manual configuration.
 */
export async function ensureLoopbackApiToken(config: DaemonConfig): Promise<void> {
  if (config.apiToken) return;
  if (config.allowAnonymousApi) {
    console.warn(
      "[workbench-daemon] WORKBENCH_DAEMON_ALLOW_ANONYMOUS is set: the local API is reachable by any process on this machine."
    );
    return;
  }

  const tokenPath = join(config.syncRoot, ".workbench", DAEMON_TOKEN_FILE);
  try {
    const existing = (await fs.readFile(tokenPath, "utf8")).trim();
    if (existing) {
      config.apiToken = existing;
      return;
    }
  } catch {
    // No persisted token yet; fall through and create one.
  }

  const generated = randomUUID().replace(/-/g, "");
  await fs.writeFile(tokenPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  config.apiToken = generated;
  console.warn(
    `[workbench-daemon] Generated a local API token at ${tokenPath}. ` +
    "Paste it into Settings > Local daemon, or set WORKBENCH_DAEMON_API_TOKEN, to let clients connect."
  );
}
