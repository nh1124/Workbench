import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DaemonConfig } from "./config.js";

export function isReservedWindowsName(value: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}

export function sanitizeFileName(raw: string): string {
  const fallback = "download.bin";
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || isReservedWindowsName(cleaned)) return fallback;
  return cleaned.slice(0, 180);
}

export function sanitizePathSegment(raw: string, fallback = "untitled"): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || isReservedWindowsName(cleaned)) return fallback;
  return cleaned.slice(0, 180);
}

export function parseContentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const quoted = value.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const plain = value.match(/filename\s*=\s*([^;]+)/i);
  return plain?.[1]?.trim();
}

export async function uniquePath(directory: string, filename: string): Promise<string> {
  const parsed = filename.match(/^(.*?)(\.[^.]+)?$/);
  const base = parsed?.[1] || "download";
  const ext = parsed?.[2] || "";
  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(directory, index === 0 ? `${base}${ext}` : `${base} (${index})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return join(directory, `${base}-${Date.now()}${ext}`);
}

export function normalizeSha256Checksum(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error("Invalid download checksum header");
  }
  return hex;
}

export function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export function pathHasUnsafeRootOrTraversal(pathValue: string): boolean {
  const normalized = normalizeRelativePath(pathValue);
  const trimmed = normalized.trim();
  if (!trimmed) return false;
  if (isAbsolute(pathValue) || isAbsolute(normalized) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("//")) {
    return true;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

export function pathContainsReservedSegment(pathValue: string): boolean {
  return normalizeRelativePath(pathValue).split("/").some((segment) => isReservedWindowsName(segment));
}

export function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relativePath = normalizeRelativePath(relative(resolve(directory), resolve(candidate)));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../"));
}

export function relativeSyncPath(config: DaemonConfig, absolutePath: string): string | undefined {
  if (!isPathInsideDirectory(config.syncRoot, absolutePath)) {
    return undefined;
  }
  const rel = relative(config.syncRoot, absolutePath);
  if (!rel || resolve(config.syncRoot, rel) === resolve(config.syncRoot, ".workbench")) {
    return undefined;
  }
  return normalizeRelativePath(rel);
}

export function isIgnoredSyncRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/^\/+/, "");
  const fileName = basename(normalized).toLowerCase();
  if (!normalized || normalized === ".workbench" || normalized.startsWith(".workbench/")) return true;
  if (pathContainsReservedSegment(normalized)) return true;
  if (fileName === "thumbs.db" || fileName === ".ds_store") return true;
  if (fileName.startsWith("~$") || fileName.startsWith(".~")) return true;
  if (fileName.endsWith("~") || fileName.endsWith(".tmp") || fileName.endsWith(".temp")) return true;
  if (fileName.endsWith(".swp") || fileName.endsWith(".swo") || fileName.endsWith(".part")) return true;
  if (fileName.endsWith(".crdownload") || fileName.endsWith(".download")) return true;
  return false;
}

export function isIgnoredSyncPath(config: DaemonConfig, absolutePath: string): boolean {
  const relativePath = relativeSyncPath(config, absolutePath);
  return !relativePath || isIgnoredSyncRelativePath(relativePath);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitForStableFile(absolutePath: string): Promise<{
  size: number;
  mtime: Date;
  mtimeMs: number;
} | undefined> {
  let previous: { size: number; mtimeMs: number; mtime: Date } | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      return {
        size: stat.size,
        mtime: stat.mtime,
        mtimeMs: stat.mtimeMs
      };
    }
    previous = { size: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
    await sleep(180);
  }
  return previous;
}

export async function walkSyncFiles(config: DaemonConfig, current = config.syncRoot, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".workbench") continue;
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkSyncFiles(config, absolutePath, files);
    } else if (entry.isFile() && !isIgnoredSyncPath(config, absolutePath)) {
      files.push(absolutePath);
    }
  }
  return files;
}

export async function walkSyncDirectories(
  config: DaemonConfig,
  current = config.syncRoot,
  directories: string[] = []
): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".workbench") continue;
    if (!entry.isDirectory()) continue;
    const absolutePath = join(current, entry.name);
    const relativePath = relativeSyncPath(config, absolutePath);
    if (!relativePath || isIgnoredSyncRelativePath(relativePath)) continue;
    directories.push(relativePath);
    await walkSyncDirectories(config, absolutePath, directories);
  }
  return directories;
}

export async function hashFile(absolutePath: string): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export function mimeTypeForPath(pathValue: string): string {
  const ext = extname(pathValue).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".html") return "text/html";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

export function artifactKindForPath(pathValue: string): "note" | "file" {
  const ext = extname(pathValue).toLowerCase();
  return ext === ".md" || ext === ".markdown" ? "note" : "file";
}

export function directoryPathFor(relativePath: string): string | undefined {
  const directory = normalizeRelativePath(dirname(relativePath));
  return directory === "." ? undefined : directory;
}

export function titleFor(relativePath: string): string {
  const name = basename(relativePath);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

export function defaultNotePath(title: string): string {
  const base = sanitizePathSegment(title, "untitled");
  return /\.[a-z0-9]{1,12}$/i.test(base) ? base : `${base}.md`;
}

export function normalizeArtifactRelativePath(raw: string, fallbackLeaf = "untitled.md"): string {
  if (pathHasUnsafeRootOrTraversal(raw)) return "";
  const normalized = normalizeRelativePath(raw).replace(/^\/+/, "");
  const segments = normalized
    .split("/")
    .map((segment, index, values) => sanitizePathSegment(segment, index === values.length - 1 ? fallbackLeaf : "folder"))
    .filter((segment) => segment.length > 0);
  return normalizeRelativePath(segments.join("/"));
}

export function normalizeArtifactFolderPath(raw: string): string {
  if (pathHasUnsafeRootOrTraversal(raw)) return "";
  const normalized = normalizeRelativePath(raw).replace(/^\/+|\/+$/g, "");
  const segments = normalized
    .split("/")
    .map((segment) => sanitizePathSegment(segment, "folder"))
    .filter((segment) => segment.length > 0);
  return normalizeRelativePath(segments.join("/"));
}

export function resolveSyncRootRelativePath(config: DaemonConfig, relativePath: string): string | undefined {
  if (pathHasUnsafeRootOrTraversal(relativePath)) return undefined;
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || isIgnoredSyncRelativePath(normalized)) return undefined;
  const absolutePath = resolve(config.syncRoot, normalized);
  const relativeToRoot = normalizeRelativePath(relative(config.syncRoot, absolutePath));
  if (
    !relativeToRoot
    || relativeToRoot === ".."
    || relativeToRoot.startsWith("../")
    || resolve(config.syncRoot, relativeToRoot) === resolve(config.syncRoot, ".workbench")
  ) {
    return undefined;
  }
  return absolutePath;
}
