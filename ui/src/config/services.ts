const CORE_URL_STORAGE_KEY = "workbench-core-url";
const LOCAL_DAEMON_URL_STORAGE_KEY = "workbench-local-daemon-url";
const LOCAL_DAEMON_TOKEN_STORAGE_KEY = "workbench-local-daemon-token";
const LOCAL_MODE_ENABLED_STORAGE_KEY = "workbench-local-mode-enabled";
const LOCAL_ROUTING_MODE_STORAGE_KEY = "workbench-local-routing-mode";
export const WORKBENCH_LOCAL_DAEMON_URL_CHANGED_EVENT = "workbench-local-daemon-url-changed";
export const WORKBENCH_LOCAL_MODE_CHANGED_EVENT = "workbench-local-mode-changed";

export type WorkbenchLocalRoutingMode = "core" | "auto" | "local";
export type WorkbenchLocalRoutingTarget = "core" | "local";

function readViteEnv(
  name: "VITE_WORKBENCH_CORE_URL" | "VITE_WORKBENCH_LOCAL_DAEMON_URL" | "VITE_WORKBENCH_LOCAL_DAEMON_TOKEN"
): string {
  const value = import.meta.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHttpUrl(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} URL is required.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} URL must be a valid URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} URL must start with http:// or https://.`);
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeWorkbenchCoreUrl(raw: string): string {
  const normalized = normalizeHttpUrl(raw, "Server");
  const parsed = new URL(normalized);
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Server URL must use https:// unless it points to localhost.");
  }
  return normalized;
}

function normalizeWorkbenchLocalDaemonUrl(raw: string): string {
  return normalizeHttpUrl(raw, "Local daemon");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "tauri.localhost" ||
    normalized.endsWith(".localhost")
  );
}

const envWorkbenchCoreUrlFallback = readViteEnv("VITE_WORKBENCH_CORE_URL");
const envWorkbenchLocalDaemonUrlFallback = readViteEnv("VITE_WORKBENCH_LOCAL_DAEMON_URL") || "http://127.0.0.1:35780";
const envWorkbenchLocalDaemonTokenFallback = readViteEnv("VITE_WORKBENCH_LOCAL_DAEMON_TOKEN");

const envWorkbenchCoreUrl = (() => {
  if (!envWorkbenchCoreUrlFallback) return "";

  try {
    return normalizeWorkbenchCoreUrl(envWorkbenchCoreUrlFallback);
  } catch {
    return "";
  }
})();

const envWorkbenchLocalDaemonUrl = (() => {
  if (!envWorkbenchLocalDaemonUrlFallback) return "";

  try {
    return normalizeWorkbenchLocalDaemonUrl(envWorkbenchLocalDaemonUrlFallback);
  } catch {
    return "http://127.0.0.1:35780";
  }
})();

let workbenchCoreUrlCache: string | undefined;
let workbenchLocalDaemonUrlCache: string | undefined;
let workbenchLocalDaemonTokenCache: string | undefined;
let workbenchLocalRoutingModeCache: WorkbenchLocalRoutingMode | undefined;
let workbenchAutoLocalFallbackActive = false;

function isServedByWorkbenchCore(): boolean {
  if (typeof window === "undefined") return false;
  const { protocol, port } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return false;
  return !import.meta.env.DEV || port === "";
}

function currentOriginWorkbenchCoreUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    return normalizeWorkbenchCoreUrl(window.location.origin);
  } catch {
    return "";
  }
}

function readStoredWorkbenchCoreUrlRaw(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(CORE_URL_STORAGE_KEY);
  if (!raw) return undefined;

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStoredWorkbenchCoreUrl(): string | undefined {
  try {
    const raw = readStoredWorkbenchCoreUrlRaw();
    if (!raw) return undefined;
    return normalizeWorkbenchCoreUrl(raw);
  } catch {
    return undefined;
  }
}

function persistWorkbenchCoreUrl(value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CORE_URL_STORAGE_KEY, value);
}

function readStoredWorkbenchLocalDaemonUrlRaw(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(LOCAL_DAEMON_URL_STORAGE_KEY);
  if (!raw) return undefined;

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStoredWorkbenchLocalDaemonUrl(): string | undefined {
  try {
    const raw = readStoredWorkbenchLocalDaemonUrlRaw();
    if (!raw) return undefined;
    return normalizeWorkbenchLocalDaemonUrl(raw);
  } catch {
    return undefined;
  }
}

function persistWorkbenchLocalDaemonUrl(value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_DAEMON_URL_STORAGE_KEY, value);
}

function readStoredWorkbenchLocalDaemonTokenRaw(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(LOCAL_DAEMON_TOKEN_STORAGE_KEY);
  if (!raw) return undefined;

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function persistWorkbenchLocalDaemonToken(value: string): void {
  if (typeof window === "undefined") return;
  if (value) {
    window.localStorage.setItem(LOCAL_DAEMON_TOKEN_STORAGE_KEY, value);
  } else {
    window.localStorage.removeItem(LOCAL_DAEMON_TOKEN_STORAGE_KEY);
  }
}

function readStoredWorkbenchLocalModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LOCAL_MODE_ENABLED_STORAGE_KEY) === "true";
}

function normalizeWorkbenchLocalRoutingMode(value: string | null | undefined): WorkbenchLocalRoutingMode | undefined {
  return value === "core" || value === "auto" || value === "local" ? value : undefined;
}

function readStoredWorkbenchLocalRoutingMode(): WorkbenchLocalRoutingMode {
  if (typeof window === "undefined") return "core";
  return normalizeWorkbenchLocalRoutingMode(window.localStorage.getItem(LOCAL_ROUTING_MODE_STORAGE_KEY))
    ?? (readStoredWorkbenchLocalModeEnabled() ? "local" : "core");
}

function persistWorkbenchLocalRoutingMode(mode: WorkbenchLocalRoutingMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_ROUTING_MODE_STORAGE_KEY, mode);
  window.localStorage.setItem(LOCAL_MODE_ENABLED_STORAGE_KEY, mode === "local" ? "true" : "false");
}

export function getWorkbenchCoreUrl(): string {
  if (workbenchCoreUrlCache !== undefined) return workbenchCoreUrlCache;
  workbenchCoreUrlCache = isServedByWorkbenchCore()
    ? currentOriginWorkbenchCoreUrl() || readStoredWorkbenchCoreUrl() || envWorkbenchCoreUrl
    : readStoredWorkbenchCoreUrl() ?? envWorkbenchCoreUrl;
  return workbenchCoreUrlCache;
}

export function getWorkbenchLocalDaemonUrl(): string {
  if (workbenchLocalDaemonUrlCache !== undefined) return workbenchLocalDaemonUrlCache;
  workbenchLocalDaemonUrlCache = readStoredWorkbenchLocalDaemonUrl() ?? envWorkbenchLocalDaemonUrl;
  return workbenchLocalDaemonUrlCache;
}

export function getWorkbenchLocalDaemonToken(): string {
  if (workbenchLocalDaemonTokenCache !== undefined) return workbenchLocalDaemonTokenCache;
  workbenchLocalDaemonTokenCache = readStoredWorkbenchLocalDaemonTokenRaw() ?? envWorkbenchLocalDaemonTokenFallback;
  return workbenchLocalDaemonTokenCache;
}

export function getWorkbenchLocalRoutingMode(): WorkbenchLocalRoutingMode {
  if (workbenchLocalRoutingModeCache !== undefined) return workbenchLocalRoutingModeCache;
  workbenchLocalRoutingModeCache = readStoredWorkbenchLocalRoutingMode();
  return workbenchLocalRoutingModeCache;
}

export function getWorkbenchAutoLocalFallbackActive(): boolean {
  return workbenchAutoLocalFallbackActive;
}

export function setWorkbenchAutoLocalFallbackActive(active: boolean): boolean {
  if (workbenchAutoLocalFallbackActive === active) return active;
  workbenchAutoLocalFallbackActive = active;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(WORKBENCH_LOCAL_MODE_CHANGED_EVENT));
  }
  return active;
}

export function resolveWorkbenchLocalRoutingTarget(
  mode: WorkbenchLocalRoutingMode,
  online: boolean
): WorkbenchLocalRoutingTarget {
  if (mode === "local") return "local";
  if (mode === "auto" && !online) return "local";
  return "core";
}

export function getWorkbenchLocalModeEnabled(): boolean {
  return getWorkbenchLocalRoutingMode() === "local";
}

export function setWorkbenchCoreUrl(raw: string): string {
  const normalized = normalizeWorkbenchCoreUrl(raw);
  workbenchCoreUrlCache = normalized;
  persistWorkbenchCoreUrl(normalized);
  return normalized;
}

export function setWorkbenchLocalDaemonUrl(raw: string): string {
  const normalized = normalizeWorkbenchLocalDaemonUrl(raw);
  workbenchLocalDaemonUrlCache = normalized;
  persistWorkbenchLocalDaemonUrl(normalized);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(WORKBENCH_LOCAL_DAEMON_URL_CHANGED_EVENT));
  }
  return normalized;
}

export function setWorkbenchLocalDaemonToken(raw: string): string {
  const normalized = raw.trim();
  workbenchLocalDaemonTokenCache = normalized;
  persistWorkbenchLocalDaemonToken(normalized);
  return normalized;
}

export function setWorkbenchLocalRoutingMode(mode: WorkbenchLocalRoutingMode): WorkbenchLocalRoutingMode {
  workbenchLocalRoutingModeCache = mode;
  workbenchAutoLocalFallbackActive = false;
  persistWorkbenchLocalRoutingMode(mode);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(WORKBENCH_LOCAL_MODE_CHANGED_EVENT));
  }
  return mode;
}

export function setWorkbenchLocalModeEnabled(enabled: boolean): boolean {
  setWorkbenchLocalRoutingMode(enabled ? "local" : "core");
  return enabled;
}

export function getWorkbenchCoreUrlInitialValue(): string {
  return isServedByWorkbenchCore()
    ? currentOriginWorkbenchCoreUrl() || readStoredWorkbenchCoreUrlRaw() || envWorkbenchCoreUrlFallback
    : readStoredWorkbenchCoreUrlRaw() ?? envWorkbenchCoreUrlFallback;
}

export function getWorkbenchLocalDaemonUrlInitialValue(): string {
  return readStoredWorkbenchLocalDaemonUrlRaw() ?? envWorkbenchLocalDaemonUrlFallback;
}

export function getWorkbenchLocalDaemonTokenInitialValue(): string {
  return readStoredWorkbenchLocalDaemonTokenRaw() ?? envWorkbenchLocalDaemonTokenFallback;
}

export const navItems = [
  { path: "/", label: "Home" },
  { path: "/projects", label: "Project" },
  { path: "/analyser", label: "Analyser" },
  { path: "/tasks", label: "Tasks" },
  { path: "/notes", label: "Notes" },
  { path: "/research", label: "Research" },
  { path: "/images", label: "Images" },
  { path: "/mindmaps", label: "Mindmap" },
  { path: "/wbs", label: "WBS" },
  { path: "/artifacts", label: "Artifacts" }
] as const;
