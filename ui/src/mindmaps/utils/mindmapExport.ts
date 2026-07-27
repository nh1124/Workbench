import { saveFileWithDialog } from "../../lib/api";
import type { MindmapExportFormat } from "../../types/models";
import { extensionForFilename } from "./mindmapTree";

/**
 * Export plumbing for mindmaps: format naming, artifact path parsing, SVG
 * rasterisation, and writing a file to disk.
 *
 * None of it touches React state, so it lives outside the page — which also
 * makes the naming and path rules directly testable.
 */

export type ExportDestination = "download" | "artifact";
export type RasterExportFormat = "png" | "jpeg";
export type MindmapUiExportFormat = MindmapExportFormat | RasterExportFormat;

type FileSavePicker = {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
};

type WritableFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type WindowWithSavePicker = Window & {
  showSaveFilePicker?: (options?: FileSavePicker) => Promise<WritableFileHandle>;
};

function pickerMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim() || "text/plain";
}

export function isRasterExportFormat(format: MindmapUiExportFormat): format is RasterExportFormat {
  return format === "png" || format === "jpeg";
}

export function extensionForExportFormat(format: MindmapUiExportFormat): string {
  if (format === "markdown") return "md";
  if (format === "jpeg") return "jpeg";
  return format;
}

export function withFileExtension(filename: string, extension: string): string {
  const base = filename.trim() || "mindmap-export";
  return `${base.replace(/\.[a-z0-9]+$/i, "")}.${extension}`;
}

export function splitArtifactUploadPath(pathValue: string | undefined): { directoryPath?: string; filename?: string } {
  const normalized = pathValue?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return {};
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.pop();
  return {
    directoryPath: parts.length > 0 ? parts.join("/") : undefined,
    filename
  };
}

function parseSvgLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function svgDimensions(svgText: string): { width: number; height: number } {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = parsed.documentElement;
  const viewBox = svg.getAttribute("viewBox")?.split(/\s+/).map((part) => Number.parseFloat(part));
  const viewBoxWidth = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : undefined;
  const viewBoxHeight = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : undefined;
  return {
    width: Math.max(1, Math.ceil(parseSvgLength(svg.getAttribute("width")) ?? viewBoxWidth ?? 1200)),
    height: Math.max(1, Math.ceil(parseSvgLength(svg.getAttribute("height")) ?? viewBoxHeight ?? 800))
  };
}

export async function rasterizeSvg(svgText: string, mimeType: "image/png" | "image/jpeg"): Promise<Blob> {
  const { width, height } = svgDimensions(svgText);
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available.");
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  const image = new Image();
  const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Mindmap image could not be rendered."));
      image.src = url;
    });
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Mindmap image could not be encoded."));
      }, mimeType, mimeType === "image/jpeg" ? 0.92 : undefined);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadBlobFile(filename: string, mimeType: string, blob: Blob): Promise<void> {
  if (await saveFileWithDialog(blob, filename).catch(() => false)) return;

  const savePicker = (window as WindowWithSavePicker).showSaveFilePicker;
  if (savePicker) {
    try {
      const acceptMimeType = pickerMimeType(mimeType);
      const handle = await savePicker({
        suggestedName: filename || "mindmap-export.txt",
        types: [{
          description: "Mindmap export",
          accept: { [acceptMimeType]: [extensionForFilename(filename)] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "mindmap-export.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadTextFile(filename: string, mimeType: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  await downloadBlobFile(filename, mimeType, blob);
}
