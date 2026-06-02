const CORE_URL_STORAGE_KEY = "workbench-core-url";

function readViteEnv(name: "VITE_WORKBENCH_CORE_URL"): string {
  const value = import.meta.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWorkbenchCoreUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Server URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Server URL must be a valid URL (e.g. http://localhost:3000).");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must start with http:// or https://.");
  }

  return parsed.toString().replace(/\/+$/, "");
}

const envWorkbenchCoreUrlFallback = readViteEnv("VITE_WORKBENCH_CORE_URL");

const envWorkbenchCoreUrl = (() => {
  if (!envWorkbenchCoreUrlFallback) return "";

  try {
    return normalizeWorkbenchCoreUrl(envWorkbenchCoreUrlFallback);
  } catch {
    return "";
  }
})();

let workbenchCoreUrlCache: string | undefined;

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

export function getWorkbenchCoreUrl(): string {
  if (workbenchCoreUrlCache !== undefined) return workbenchCoreUrlCache;
  workbenchCoreUrlCache = isServedByWorkbenchCore()
    ? currentOriginWorkbenchCoreUrl() || readStoredWorkbenchCoreUrl() || envWorkbenchCoreUrl
    : readStoredWorkbenchCoreUrl() ?? envWorkbenchCoreUrl;
  return workbenchCoreUrlCache;
}

export function setWorkbenchCoreUrl(raw: string): string {
  const normalized = normalizeWorkbenchCoreUrl(raw);
  workbenchCoreUrlCache = normalized;
  persistWorkbenchCoreUrl(normalized);
  return normalized;
}

export function getWorkbenchCoreUrlInitialValue(): string {
  return isServedByWorkbenchCore()
    ? currentOriginWorkbenchCoreUrl() || readStoredWorkbenchCoreUrlRaw() || envWorkbenchCoreUrlFallback
    : readStoredWorkbenchCoreUrlRaw() ?? envWorkbenchCoreUrlFallback;
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
