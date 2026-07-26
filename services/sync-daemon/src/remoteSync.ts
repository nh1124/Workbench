import type { SyncErrorMetadata } from "./manifestStore.js";

export type SyncErrorDetails = SyncErrorMetadata & {
  errorMessage: string;
};

export function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function errorCodeFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return stringFromUnknown(code);
}

export function statusFromUnknown(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = (value as { status?: unknown; statusCode?: unknown }).status
    ?? (value as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

export function classifySyncError(input: unknown): SyncErrorDetails {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  const errorMessage = stringFromUnknown(record?.message)
    ?? (input instanceof Error ? input.message : undefined)
    ?? stringFromUnknown(input)
    ?? "Sync operation failed";
  const errorCode = stringFromUnknown(record?.code) ?? errorCodeFromUnknown(input);
  const status = typeof record?.status === "number" ? record.status : statusFromUnknown(input);
  const normalizedCode = errorCode?.toUpperCase() ?? "";
  const normalizedMessage = errorMessage.toLowerCase();

  if (normalizedCode === "SYNC_VERSION_CONFLICT" || normalizedCode === "VERSION_CONFLICT" || status === 409) {
    return { errorMessage, errorCode, errorCategory: "version_conflict", retryable: false };
  }
  if (normalizedCode.includes("CHECKSUM")) {
    return { errorMessage, errorCode, errorCategory: "checksum", retryable: false };
  }
  if (normalizedCode.includes("CAPABILITY")) {
    return { errorMessage, errorCode, errorCategory: "capability", retryable: false };
  }
  if (status === 401 || status === 403 || normalizedCode.includes("UNAUTHORIZED") || normalizedCode.includes("AUTH")) {
    return { errorMessage, errorCode, errorCategory: "auth", retryable: false };
  }
  if (
    normalizedCode.includes("PATH")
    || normalizedCode.includes("TRAVERSAL")
    || normalizedMessage.includes("unsafe path")
    || normalizedMessage.includes("invalid local artifact path")
    || normalizedMessage.includes("outside the sync root")
    || normalizedMessage.includes(".workbench")
  ) {
    return { errorMessage, errorCode, errorCategory: "path_rejection", retryable: false };
  }
  if (normalizedCode.includes("NOT_SUPPORTED") || normalizedCode.includes("UNSUPPORTED")) {
    return { errorMessage, errorCode, errorCategory: "unsupported", retryable: false };
  }
  if (normalizedMessage.includes("conflict") || normalizedMessage.includes("unsynced local")) {
    return { errorMessage, errorCode, errorCategory: "local_conflict", retryable: false };
  }
  if (
    normalizedCode.includes("INVALID")
    || normalizedCode.includes("VALIDATION")
    || normalizedCode.includes("NOT_FOUND")
    || normalizedCode.includes("BASE64")
    || normalizedMessage.includes("exceeds max sync size")
    || status === 404
    || status === 400
  ) {
    return { errorMessage, errorCode, errorCategory: "validation", retryable: false };
  }
  if (
    normalizedCode.includes("TUNNEL")
    || normalizedMessage.includes("cloudflare tunnel is offline")
    || normalizedMessage.includes("cloudflare tunnel unavailable")
  ) {
    return { errorMessage, errorCode, errorCategory: "network", retryable: true };
  }
  if (
    normalizedCode === "SYNC_PUSH_OPERATION_FAILED"
    || (typeof status === "number" && status >= 500)
  ) {
    return { errorMessage, errorCode, errorCategory: "server", retryable: true };
  }
  if (
    normalizedMessage.includes("fetch failed")
    || normalizedMessage.includes("network")
    || normalizedMessage.includes("econnrefused")
    || normalizedMessage.includes("econnreset")
    || normalizedMessage.includes("enotfound")
    || normalizedMessage.includes("etimedout")
    || normalizedCode === "ECONNREFUSED"
    || normalizedCode === "ECONNRESET"
    || normalizedCode === "ENOTFOUND"
    || normalizedCode === "ETIMEDOUT"
    || normalizedCode.startsWith("UND_ERR_")
  ) {
    return { errorMessage, errorCode, errorCategory: "network", retryable: true };
  }
  return { errorMessage, errorCode, errorCategory: "unknown", retryable: false };
}
