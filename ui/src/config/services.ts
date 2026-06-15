const CORE_URL_STORAGE_KEY = "workbench-core-url";
const LOCAL_DAEMON_URL_STORAGE_KEY = "workbench-local-daemon-url";
const LOCAL_MODE_ENABLED_STORAGE_KEY = "workbench-local-mode-enabled";
export const WORKBENCH_LOCAL_DAEMON_URL_CHANGED_EVENT = "workbench-local-daemon-url-changed";
export const WORKBENCH_LOCAL_MODE_CHANGED_EVENT = "workbench-local-mode-changed";

function readViteEnv(name: "VITE_WORKBENCH_CORE_URL" | "VITE_WORKBENCH_LOCAL_DAEMON_URL"): string {
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

function normalizeWorkbenchCoreUrl(raw: string): string {
  return normalizeHttpUrl(raw, "Server");
}

function normalizeWorkbenchLocalDaemonUrl(raw: string): string {
  return normalizeHttpUrl(raw, "Local daemon");
}

const envWorkbenchCoreUrlFallback = readViteEnv("VITE_WORKBENCH_CORE_URL");
const envWorkbenchLocalDaemonUrlFallback = readViteEnv("VITE_WORKBENCH_LOCAL_DAEMON_URL") || "http://127.0.0.1:35780";

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
let workbenchLocalModeEnabledCache: boolean | undefined;

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

function readStoredWorkbenchLocalModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LOCAL_MODE_ENABLED_STORAGE_KEY) === "true";
}

function persistWorkbenchLocalModeEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_MODE_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
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

export function getWorkbenchLocalModeEnabled(): boolean {
  if (workbenchLocalModeEnabledCache !== undefined) return workbenchLocalModeEnabledCache;
  workbenchLocalModeEnabledCache = readStoredWorkbenchLocalModeEnabled();
  return workbenchLocalModeEnabledCache;
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

export function setWorkbenchLocalModeEnabled(enabled: boolean): boolean {
  workbenchLocalModeEnabledCache = enabled;
  persistWorkbenchLocalModeEnabled(enabled);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(WORKBENCH_LOCAL_MODE_CHANGED_EVENT));
  }
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

export const navItems = [
  { path: "/", label: "Home" },
  { path: "/projects", label: "Project" },
  { path: "/tasks", label: "Tasks" },
  { path: "/notes", label: "Notes" },
  { path: "/research", label: "Research" },
  { path: "/images", label: "Images" },
  { path: "/artifacts", label: "Artifacts" }
] as const;
