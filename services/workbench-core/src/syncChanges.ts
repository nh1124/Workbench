import {
  commitConsumerCursor,
  getConsumerCursor,
  initializeSyncConsumer,
  normalizeSyncConsumerId,
  SyncConsumerCursorInputError,
  type SyncConsumerCursorCommit,
  type SyncConsumerInitializeResult
} from "./syncConsumerCursorsStore.js";
import { listSyncEvents, SYNC_DOMAINS, type SyncDomain, type SyncEvent } from "./syncStore.js";

export const SYNC_CHANGES_DOMAINS = SYNC_DOMAINS;

export type SyncChangesPullOptions = {
  consumer?: unknown;
  cursor?: unknown;
  domains?: unknown;
  limit?: unknown;
};

export type SyncChangesPullResult = {
  consumer: string;
  cursor: string;
  events: SyncEvent[];
  nextCursor?: string;
};

function normalizeOptionalCursor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const cursor = value.trim();
  return cursor.length > 0 ? cursor : undefined;
}

export function clampSyncChangesLimit(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : 100;
  const integer = Number.isFinite(parsed) ? Math.floor(parsed) : 100;
  return Math.max(1, Math.min(500, integer));
}

export function parseSyncChangesDomains(value: unknown): SyncDomain[] | undefined {
  if (value === undefined || value === null) return undefined;
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const supported = new Set<string>(SYNC_DOMAINS);
  const requestedDomains = rawValues
    .filter((entry): entry is string => typeof entry === "string")
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (requestedDomains.length === 0) return undefined;
  const unsupported = requestedDomains.find((entry) => !supported.has(entry));
  if (unsupported) {
    throw new SyncConsumerCursorInputError(`unsupported sync domain: ${unsupported}`);
  }
  return [...new Set(requestedDomains)] as SyncDomain[];
}

export async function pullSyncChanges(
  userId: string,
  options: SyncChangesPullOptions = {}
): Promise<SyncChangesPullResult> {
  const consumer = normalizeSyncConsumerId(options.consumer);
  const suppliedCursor = normalizeOptionalCursor(options.cursor);
  const storedCursor = suppliedCursor ? undefined : await getConsumerCursor(userId, consumer);
  const cursor = suppliedCursor ?? storedCursor ?? "0";
  const domains = parseSyncChangesDomains(options.domains);
  const limit = clampSyncChangesLimit(options.limit);
  const result = await listSyncEvents(userId, cursor, limit, domains);
  return {
    consumer,
    cursor,
    events: result.events,
    nextCursor: result.nextCursor
  };
}

export async function commitSyncChangesCursor(
  userId: string,
  input: { consumer?: unknown; cursor?: unknown }
): Promise<SyncConsumerCursorCommit> {
  return commitConsumerCursor(userId, input.consumer, input.cursor);
}

export async function initializeSyncChangesConsumer(
  userId: string,
  input: { consumer: unknown; startAt?: unknown; scope?: unknown }
): Promise<SyncConsumerInitializeResult> {
  return initializeSyncConsumer(userId, input);
}
