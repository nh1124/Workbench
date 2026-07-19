import { isDeepStrictEqual } from "node:util";
import {
  commitConsumerCursor,
  getConsumerState,
  getConsumerStateWithPool,
  initializeSyncConsumer,
  normalizeSyncConsumerId,
  normalizeSyncConsumerScope,
  SyncConsumerCursorInputError,
  type SyncConsumerScope,
  type SyncConsumerCursorCommit,
  type SyncConsumerState,
  type SyncConsumerInitializeResult
} from "./syncConsumerCursorsStore.js";
import {
  listSyncEvents,
  listSyncEventsScoped,
  listSyncEventsScopedWithPool,
  listSyncEventsWithPool,
  SYNC_DOMAINS,
  type SyncDomain,
  type SyncEvent,
  type SyncEventScope
} from "./syncStore.js";

export const SYNC_CHANGES_DOMAINS = SYNC_DOMAINS;

export type SyncChangesPullOptions = {
  consumer?: unknown;
  cursor?: unknown;
  domains?: unknown;
  limit?: unknown;
  projectId?: unknown;
  pathPrefix?: unknown;
  resourceTypes?: unknown;
  actions?: unknown;
  includeContent?: unknown;
  includePatch?: unknown;
};

export type SyncChangesPullResult = {
  consumer: string;
  cursor: string;
  events: SyncEvent[];
  nextCursor?: string;
  appliedScope?: SyncConsumerScope;
  scannedThrough?: string;
};

export class SyncConsumerScopeMismatchError extends Error {
  status = 400;
  code = "SYNC_CONSUMER_SCOPE_MISMATCH";
}

type SyncChangesQueryPool = {
  query<Row = never>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};

type SyncChangesOperations = {
  getConsumerState(userId: string, consumer: string): Promise<SyncConsumerState | undefined>;
  listLegacy(
    userId: string,
    cursor: string,
    limit: number,
    domains?: SyncDomain[]
  ): Promise<{ events: SyncEvent[]; nextCursor?: string }>;
  listScoped(
    userId: string,
    cursor: string,
    limit: number,
    scope: SyncEventScope
  ): Promise<{ events: SyncEvent[]; nextCursor?: string; scannedThrough: string }>;
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

function parseOptionalBoolean(value: unknown, field: "includeContent" | "includePatch"): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    throw new SyncConsumerCursorInputError(`${field} must be a boolean`);
  }
  return value;
}

function requestScopeFromOptions(options: SyncChangesPullOptions): SyncConsumerScope | undefined {
  const rawScope: Record<string, unknown> = {};
  for (const field of ["projectId", "pathPrefix", "resourceTypes", "actions"] as const) {
    if (options[field] !== undefined) rawScope[field] = options[field];
  }
  return normalizeSyncConsumerScope(rawScope);
}

function withoutDomains(scope: SyncConsumerScope): SyncConsumerScope | undefined {
  const { domains: _domains, ...rest } = scope;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function scopedDomains(domains: SyncDomain[] | undefined): SyncDomain[] | undefined {
  if (domains === undefined) return undefined;
  return normalizeSyncConsumerScope({ domains })?.domains;
}

function scopeMismatch(): SyncConsumerScopeMismatchError {
  return new SyncConsumerScopeMismatchError("Requested sync filters conflict with the consumer's bound scope");
}

function redactEvents(events: SyncEvent[], includeContent: boolean, includePatch: boolean): SyncEvent[] {
  if (includeContent && includePatch) return events;
  return events.map((event) => {
    const payload = structuredClone(event.payload);
    if (!includeContent) {
      const resource = payload.resource;
      if (resource && typeof resource === "object" && !Array.isArray(resource)) {
        const record = resource as Record<string, unknown>;
        if (typeof record.contentMarkdown === "string") {
          const contentLength = record.contentMarkdown.length;
          delete record.contentMarkdown;
          record.contentLength = contentLength;
        }
      }
    }
    if (!includePatch) delete payload.patch;
    return { ...event, payload };
  });
}

async function pullSyncChangesWithOperations(
  operations: SyncChangesOperations,
  userId: string,
  options: SyncChangesPullOptions
): Promise<SyncChangesPullResult> {
  const consumer = normalizeSyncConsumerId(options.consumer);
  const suppliedCursor = normalizeOptionalCursor(options.cursor);
  const consumerState = await operations.getConsumerState(userId, consumer);
  const cursor = suppliedCursor ?? consumerState?.cursor ?? "0";
  const domains = parseSyncChangesDomains(options.domains);
  const limit = clampSyncChangesLimit(options.limit);
  const requestScope = requestScopeFromOptions(options);
  const boundScope = consumerState?.scope;
  const includeContent = parseOptionalBoolean(options.includeContent, "includeContent");
  const includePatch = parseOptionalBoolean(options.includePatch, "includePatch");
  const hasIncludeOption = options.includeContent !== undefined || options.includePatch !== undefined;

  let effectiveScope: SyncConsumerScope | undefined;
  if (boundScope) {
    if (requestScope && !isDeepStrictEqual(requestScope, withoutDomains(boundScope))) {
      throw scopeMismatch();
    }
    effectiveScope = boundScope;
  } else {
    effectiveScope = requestScope;
  }

  if (!effectiveScope && !hasIncludeOption) {
    const result = await operations.listLegacy(userId, cursor, limit, domains);
    return {
      consumer,
      cursor,
      events: result.events,
      nextCursor: result.nextCursor
    };
  }

  const canonicalDomains = scopedDomains(domains);
  if (effectiveScope?.domains !== undefined && canonicalDomains !== undefined
    && !isDeepStrictEqual(effectiveScope.domains, canonicalDomains)) {
    throw scopeMismatch();
  }
  const mergedScope = normalizeSyncConsumerScope({
    ...(effectiveScope ?? {}),
    ...(canonicalDomains !== undefined ? { domains: canonicalDomains } : {})
  });
  const result = await operations.listScoped(userId, cursor, limit, mergedScope ?? {});
  const events = redactEvents(result.events, includeContent, includePatch);
  return {
    consumer,
    cursor,
    events,
    nextCursor: result.nextCursor,
    ...(mergedScope ? { appliedScope: mergedScope, scannedThrough: result.scannedThrough } : {})
  };
}

export async function pullSyncChanges(
  userId: string,
  options: SyncChangesPullOptions = {}
): Promise<SyncChangesPullResult> {
  return pullSyncChangesWithOperations({
    getConsumerState,
    listLegacy: listSyncEvents,
    listScoped: listSyncEventsScoped
  }, userId, options);
}

/** @internal Exported so pull integration can be tested with the same mock pool as the stores. */
export async function pullSyncChangesWithPool(
  pool: SyncChangesQueryPool,
  userId: string,
  options: SyncChangesPullOptions = {}
): Promise<SyncChangesPullResult> {
  return pullSyncChangesWithOperations({
    getConsumerState: (ownerId, consumer) => getConsumerStateWithPool(pool, ownerId, consumer),
    listLegacy: (ownerId, cursor, limit, domains) =>
      listSyncEventsWithPool(pool, ownerId, cursor, limit, domains),
    listScoped: (ownerId, cursor, limit, scope) =>
      listSyncEventsScopedWithPool(pool, ownerId, cursor, limit, scope)
  }, userId, options);
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
