import { config as loadEnv } from "dotenv";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

export interface StoredImageData {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg"
};

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function storageRoot(): string {
  const configured = optionalEnv("IMAGES_STORAGE_DIR") ?? "storage";
  return path.isAbsolute(configured) ? configured : path.resolve(__dirname, "..", configured);
}

function ownerHash(ownerCoreUserId: string): string {
  return createHash("sha256").update(ownerCoreUserId).digest("hex").slice(0, 24);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function extensionForMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType.toLowerCase()] ?? "bin";
}

function safeStoragePath(storageKey: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(root)) {
    throw new Error("Invalid storage key");
  }
  return resolved;
}

export async function putImageBuffer(input: {
  ownerCoreUserId: string;
  kind: "assets" | "references" | "masks";
  id: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<StoredImageData> {
  const ownerSegment = ownerHash(input.ownerCoreUserId);
  const extension = extensionForMime(input.mimeType);
  const storageKey = path.join(ownerSegment, input.kind, `${input.id}.${extension}`).replace(/\\/g, "/");
  const absolutePath = safeStoragePath(storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.buffer);
  return {
    storageKey,
    sha256: sha256(input.buffer),
    sizeBytes: input.buffer.length
  };
}

export async function readImageBuffer(storageKey: string): Promise<Buffer> {
  return readFile(safeStoragePath(storageKey));
}

export async function deleteImageBuffer(storageKey: string): Promise<void> {
  await rm(safeStoragePath(storageKey), { force: true });
}
