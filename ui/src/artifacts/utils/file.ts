import type { ArtifactItem } from "../../types/models";
import type { ArtifactEditorDraft } from "../types";
import { leafPath } from "./path";

export function formatSize(value?: number): string {
  if (!value || value <= 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function sanitizeExportFilename(value: string): string {
  const trimmed = value.trim();
  const fallback = "artifact";
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
}

export function ensureItemExportFilename(item: ArtifactItem): string {
  const base = leafPath(item.path) || item.title || "artifact";
  if (item.kind === "note" && !/\.[a-z0-9]+$/i.test(base)) {
    return `${base}.md`;
  }
  return base;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeExportFilename(filename);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function isPdf(item: ArtifactEditorDraft): boolean {
  const mime = (item.mimeType ?? "").toLowerCase();
  if (mime.includes("pdf")) return true;
  return /\.pdf$/i.test(item.path);
}

export function isImage(item: ArtifactEditorDraft): boolean {
  const mime = (item.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(item.path);
}

export function isWordDocument(item: ArtifactEditorDraft): boolean {
  const mime = (item.mimeType ?? "").toLowerCase();
  if (
    mime.includes("application/msword") ||
    mime.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
    mime.includes("application/vnd.ms-word")
  ) {
    return true;
  }
  return /\.(doc|docx|docm)$/i.test(item.path);
}

export function extractYoutubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
    if (u.hostname === "youtube.com" || u.hostname === "www.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|v)\/([^/?&]+)/);
      if (m) return m[1];
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}
