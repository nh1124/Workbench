import { artifactsClient, notesClient, projectsClient } from "./internalClients.js";

export const MAINTENANCE_QUEUE_KINDS = ["memory", "note", "brief", "index_drift", "artifact"] as const;
export type MaintenanceQueueKind = (typeof MAINTENANCE_QUEUE_KINDS)[number];

export const MAINTENANCE_QUEUE_REASONS = [
  "raw",
  "expired",
  "unconfirmed",
  "conflict",
  "manual",
  "source_changed",
  "unused",
  "brief_unmaintained",
  "brief_oversized"
] as const;
export type MaintenanceQueueReason = (typeof MAINTENANCE_QUEUE_REASONS)[number];

export type MaintenanceQueueOptions = {
  kind?: string;
  reason?: string;
  projectId?: string;
  cursor?: string;
  limit?: number;
};

export type MaintenanceQueueItem = {
  id: string;
  kind: MaintenanceQueueKind;
  projectId: string;
  projectName: string;
  resourceId: string;
  title: string;
  excerpt: string;
  reasons: string[];
  authority?: string;
  lifecycleState?: string;
  lastConfirmedAt?: string | null;
  reviewAfter?: string | null;
  path?: string;
  artifactKind?: string;
  version?: number;
  flaggedBy?: string;
  flaggedAt?: string;
  updatedAt: string;
  suggestedActions: string[];
};

export type MaintenanceQueueResult = {
  items: MaintenanceQueueItem[];
  nextCursor?: string;
  totals: {
    byReason: Record<string, number>;
  };
};

export type MaintenanceQueueSourceClient = (
  token: string,
  options?: { projectId?: string; reason?: string; cursor?: string; limit?: number }
) => Promise<unknown>;

export type MaintenanceQueueSourceClients = Record<MaintenanceQueueKind, MaintenanceQueueSourceClient>;

type QueuePage = {
  items: MaintenanceQueueItem[];
  nextCursor?: string;
  totals: {
    byReason: Record<string, number>;
  };
};

type CompositeCursor = {
  v: 1;
  sources: Partial<Record<MaintenanceQueueKind, string>>;
  exhausted?: MaintenanceQueueKind[];
};

type SourceState = {
  kind: MaintenanceQueueKind;
  cursor?: string;
  head?: MaintenanceQueueItem;
  headNextCursor?: string;
  exhausted: boolean;
  totalsLoaded: boolean;
};

const SOURCE_REASONS: Record<MaintenanceQueueKind, readonly MaintenanceQueueReason[]> = {
  memory: ["raw", "expired", "unconfirmed", "conflict", "manual"],
  note: ["raw", "expired", "conflict", "manual"],
  brief: ["brief_unmaintained", "brief_oversized"],
  index_drift: ["source_changed", "unused"],
  artifact: ["conflict", "manual"]
};

export class MaintenanceQueueInputError extends Error {
  readonly status = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MaintenanceQueueInputError";
    this.code = code;
  }
}

export const defaultMaintenanceQueueSources: MaintenanceQueueSourceClients = {
  memory: (token, options) => projectsClient.listMemoryMaintenanceQueue(token, options),
  note: (token, options) => notesClient.listMaintenanceQueue(token, options),
  brief: (token, options) => projectsClient.listBriefMaintenanceQueue(token, options),
  index_drift: (token, options) => projectsClient.listIndexDriftMaintenanceQueue(token, options),
  artifact: (token, options) => artifactsClient.listArtifactMaintenanceQueue(token, options)
};

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return 20;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function parseKinds(kind: string | undefined): MaintenanceQueueKind[] {
  if (!kind?.trim()) return [...MAINTENANCE_QUEUE_KINDS];
  const requested = kind.split(",").map((value) => value.trim()).filter(Boolean);
  if (requested.length === 0) return [...MAINTENANCE_QUEUE_KINDS];
  const result: MaintenanceQueueKind[] = [];
  for (const value of requested) {
    if (!MAINTENANCE_QUEUE_KINDS.includes(value as MaintenanceQueueKind)) {
      throw new MaintenanceQueueInputError("INVALID_MAINTENANCE_KIND", "Invalid maintenance queue kind.");
    }
    if (!result.includes(value as MaintenanceQueueKind)) result.push(value as MaintenanceQueueKind);
  }
  return result;
}

function normalizeReason(reason: string | undefined): string | undefined {
  if (!reason?.trim()) return undefined;
  const normalized = reason.trim();
  if (!MAINTENANCE_QUEUE_REASONS.includes(normalized as MaintenanceQueueReason)) {
    throw new MaintenanceQueueInputError("INVALID_MAINTENANCE_REASON", "Invalid maintenance queue reason.");
  }
  return normalized;
}

function decodeCompositeCursor(cursor: string | undefined): CompositeCursor {
  if (!cursor?.trim()) return { v: 1, sources: {} };
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid cursor");
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("invalid cursor");
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<CompositeCursor> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.v !== 1) {
      throw new Error("invalid cursor");
    }
    const sources = parsed.sources;
    if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw new Error("invalid cursor");
    const cleanSources: Partial<Record<MaintenanceQueueKind, string>> = {};
    for (const [kind, value] of Object.entries(sources)) {
      if (!MAINTENANCE_QUEUE_KINDS.includes(kind as MaintenanceQueueKind)) throw new Error("invalid cursor");
      if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
        throw new Error("invalid cursor");
      }
      cleanSources[kind as MaintenanceQueueKind] = value;
    }
    let exhausted: MaintenanceQueueKind[] | undefined;
    if (parsed.exhausted !== undefined) {
      if (!Array.isArray(parsed.exhausted)) throw new Error("invalid cursor");
      exhausted = [];
      for (const value of parsed.exhausted) {
        if (typeof value !== "string" || !MAINTENANCE_QUEUE_KINDS.includes(value as MaintenanceQueueKind)) {
          throw new Error("invalid cursor");
        }
        if (!exhausted.includes(value as MaintenanceQueueKind)) exhausted.push(value as MaintenanceQueueKind);
      }
    }
    return { v: 1, sources: cleanSources, ...(exhausted?.length ? { exhausted } : {}) };
  } catch {
    throw new MaintenanceQueueInputError("INVALID_CURSOR", "Invalid cursor.");
  }
}

function encodeCompositeCursor(
  sources: Partial<Record<MaintenanceQueueKind, string>>,
  exhausted?: MaintenanceQueueKind[]
): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    sources,
    ...(exhausted?.length ? { exhausted } : {})
  }), "utf8").toString("base64url");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toQueueItem(value: unknown): MaintenanceQueueItem {
  const record = asRecord(value);
  const kind = record.kind;
  if (!MAINTENANCE_QUEUE_KINDS.includes(kind as MaintenanceQueueKind)) {
    throw new Error("Maintenance queue source returned an invalid item kind.");
  }
  for (const field of ["id", "projectId", "projectName", "resourceId", "title", "excerpt", "updatedAt"] as const) {
    if (typeof record[field] !== "string") {
      throw new Error(`Maintenance queue source returned an invalid item ${field}.`);
    }
  }
  if (!Array.isArray(record.reasons) || !record.reasons.every((reason) => typeof reason === "string")) {
    throw new Error("Maintenance queue source returned invalid item reasons.");
  }
  if (!Array.isArray(record.suggestedActions) || !record.suggestedActions.every((action) => typeof action === "string")) {
    throw new Error("Maintenance queue source returned invalid item suggestedActions.");
  }
  const id = record.id as string;
  const projectId = record.projectId as string;
  const projectName = record.projectName as string;
  const resourceId = record.resourceId as string;
  const title = record.title as string;
  const excerpt = record.excerpt as string;
  const updatedAt = record.updatedAt as string;
  return {
    id,
    kind: kind as MaintenanceQueueKind,
    projectId,
    projectName,
    resourceId,
    title,
    excerpt,
    reasons: record.reasons as string[],
    ...(typeof record.authority === "string" ? { authority: record.authority } : {}),
    ...(typeof record.lifecycleState === "string" ? { lifecycleState: record.lifecycleState } : {}),
    ...(typeof record.lastConfirmedAt === "string" || record.lastConfirmedAt === null ? { lastConfirmedAt: record.lastConfirmedAt } : {}),
    ...(typeof record.reviewAfter === "string" || record.reviewAfter === null ? { reviewAfter: record.reviewAfter } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.artifactKind === "string" ? { artifactKind: record.artifactKind } : {}),
    ...(typeof record.version === "number" && Number.isFinite(record.version) ? { version: record.version } : {}),
    ...(typeof record.flaggedBy === "string" ? { flaggedBy: record.flaggedBy } : {}),
    ...(typeof record.flaggedAt === "string" ? { flaggedAt: record.flaggedAt } : {}),
    updatedAt,
    suggestedActions: record.suggestedActions as string[]
  };
}

function toQueuePage(value: unknown): QueuePage {
  const record = asRecord(value);
  if (!Array.isArray(record.items)) {
    throw new Error("Maintenance queue source returned an invalid page.");
  }
  if (record.nextCursor !== undefined && typeof record.nextCursor !== "string") {
    throw new Error("Maintenance queue source returned an invalid cursor.");
  }
  const totals = asRecord(record.totals);
  const byReasonSource = asRecord(totals.byReason);
  const byReason: Record<string, number> = {};
  for (const [reason, count] of Object.entries(byReasonSource)) {
    if (typeof count === "number" && Number.isFinite(count)) byReason[reason] = count;
  }
  return {
    items: record.items.map(toQueueItem),
    ...(typeof record.nextCursor === "string" && record.nextCursor ? { nextCursor: record.nextCursor } : {}),
    totals: { byReason }
  };
}

function addTotals(target: Record<string, number>, source: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source)) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function compareQueueItems(left: MaintenanceQueueItem, right: MaintenanceQueueItem): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sourceOptions(
  options: { projectId?: string; reason?: string; limit?: number },
  cursor: string | undefined,
  limit: number
): { projectId?: string; reason?: string; cursor?: string; limit?: number } {
  return {
    projectId: options.projectId,
    reason: options.reason,
    cursor,
    limit
  };
}

async function fetchSourcePage(
  sources: MaintenanceQueueSourceClients,
  token: string,
  kind: MaintenanceQueueKind,
  options: { projectId?: string; reason?: string; limit?: number },
  cursor: string | undefined,
  limit: number
): Promise<QueuePage> {
  return toQueuePage(await sources[kind](token, sourceOptions(options, cursor, limit)));
}

async function aggregateSingleSource(
  token: string,
  kind: MaintenanceQueueKind,
  cursor: CompositeCursor,
  options: { projectId?: string; reason?: string; limit: number },
  sources: MaintenanceQueueSourceClients
): Promise<MaintenanceQueueResult> {
  const page = await fetchSourcePage(sources, token, kind, options, cursor.sources[kind], options.limit);
  return {
    items: page.items.sort(compareQueueItems).slice(0, options.limit),
    ...(page.nextCursor ? { nextCursor: encodeCompositeCursor({ [kind]: page.nextCursor }) } : {}),
    totals: page.totals
  };
}

export async function aggregateMaintenanceQueue(
  token: string,
  rawOptions: MaintenanceQueueOptions = {},
  sources: MaintenanceQueueSourceClients = defaultMaintenanceQueueSources
): Promise<MaintenanceQueueResult> {
  const kinds = parseKinds(rawOptions.kind);
  const reason = normalizeReason(rawOptions.reason);
  const activeKinds = reason
    ? kinds.filter((kind) => SOURCE_REASONS[kind].includes(reason as MaintenanceQueueReason))
    : kinds;
  const limit = clampLimit(rawOptions.limit);
  const cursor = decodeCompositeCursor(rawOptions.cursor);
  const baseOptions = { projectId: rawOptions.projectId, reason, limit };

  if (activeKinds.length === 0) {
    return { items: [], totals: { byReason: {} } };
  }

  if (activeKinds.length === 1) {
    return aggregateSingleSource(token, activeKinds[0], cursor, baseOptions, sources);
  }

  const totals: Record<string, number> = {};
  const states: SourceState[] = activeKinds.map((kind) => ({
    kind,
    cursor: cursor.sources[kind],
    exhausted: cursor.exhausted?.includes(kind) ?? false,
    totalsLoaded: false
  }));

  async function fetchHead(state: SourceState): Promise<void> {
    const page = await fetchSourcePage(sources, token, state.kind, baseOptions, state.cursor, 1);
    if (!state.totalsLoaded) {
      addTotals(totals, page.totals.byReason);
      state.totalsLoaded = true;
    }
    if (state.exhausted) {
      state.head = undefined;
      state.headNextCursor = undefined;
      return;
    }
    state.head = page.items[0];
    state.headNextCursor = page.nextCursor;
    state.exhausted = page.items.length === 0;
  }

  await Promise.all(states.map(fetchHead));

  const items: MaintenanceQueueItem[] = [];
  while (items.length < limit) {
    const candidates = states.filter((state) => state.head);
    if (candidates.length === 0) break;
    candidates.sort((left, right) => compareQueueItems(left.head as MaintenanceQueueItem, right.head as MaintenanceQueueItem));
    const selected = candidates[0];
    items.push(selected.head as MaintenanceQueueItem);
    selected.cursor = selected.headNextCursor;
    selected.head = undefined;
    selected.headNextCursor = undefined;
    if (selected.cursor) {
      await fetchHead(selected);
    } else {
      selected.exhausted = true;
    }
  }

  const hasMore = states.some((state) => state.head);
  const nextSources: Partial<Record<MaintenanceQueueKind, string>> = {};
  const exhausted: MaintenanceQueueKind[] = [];
  for (const state of states) {
    if (state.exhausted) exhausted.push(state.kind);
    else if (state.cursor) nextSources[state.kind] = state.cursor;
  }

  return {
    items,
    ...(hasMore ? { nextCursor: encodeCompositeCursor(nextSources, exhausted) } : {}),
    totals: { byReason: totals }
  };
}
