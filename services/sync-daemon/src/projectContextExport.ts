import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PROJECT_CONTEXT_EXPORT_CODES = {
  limitExceeded: "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED",
  unavailable: "PROJECT_CONTEXT_EXPORT_UNAVAILABLE",
  pathUnsafe: "PROJECT_CONTEXT_EXPORT_PATH_UNSAFE",
  symlinkRejected: "PROJECT_CONTEXT_EXPORT_SYMLINK_REJECTED",
  writeFailed: "PROJECT_CONTEXT_EXPORT_WRITE_FAILED"
} as const;

export type ProjectContextExportCode = typeof PROJECT_CONTEXT_EXPORT_CODES[keyof typeof PROJECT_CONTEXT_EXPORT_CODES];

export class ProjectContextExportError extends Error {
  readonly code: ProjectContextExportCode;
  readonly status: number;

  constructor(code: ProjectContextExportCode, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectContextExportError";
    this.code = code;
    this.status = status;
  }
}

export type ProjectContextExportIdentity = {
  localClientId: string;
  localClientToken: string;
};

export type ProjectContextExportConfig = {
  coreUrl: string;
  syncRoot: string;
};

export type ProjectContextExportSnapshot = {
  schemaVersion: 1;
  packageType: "workbench.project-context-export";
  generatedAt: string;
  complete: true;
  project: Record<string, unknown>;
  brief: Record<string, unknown>;
  memories: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  links: Record<string, unknown>[];
  indexEntries: Record<string, unknown>[];
  generatedSummary: unknown;
  counts: {
    memories: number;
    relations: number;
    links: number;
    indexEntries: number;
  };
};

type ExportFileName = "PROJECT.md" | "memory.jsonl" | "relations.jsonl" | "links.jsonl" | "index.jsonl" | "summary.json";

type ExportFileMetadata = {
  sha256: string;
  bytes: number;
  records: number;
  authoritative?: false;
  importPolicy?: "ignore";
};

export type ProjectContextExportManifest = {
  schemaVersion: 1;
  packageType: "workbench.project-context-export";
  exportId: string;
  projectId: string;
  projectUpdatedAt: string;
  createdAt: string;
  briefVersion: number;
  counts: ProjectContextExportSnapshot["counts"];
  files: Record<ExportFileName, ExportFileMetadata>;
  importPolicy: "unsupported";
  containsSensitiveData: true;
};

export type ProjectContextExportCurrent = {
  schemaVersion: 1;
  exportId: string;
  snapshot: string;
  manifestSha256: string;
  updatedAt: string;
};

export type ProjectContextExportResult = {
  schemaVersion: 1;
  exportId: string;
  projectId: string;
  snapshot: string;
  current: ProjectContextExportCurrent;
  manifest: ProjectContextExportManifest;
};

export type ProjectContextExportOptions = {
  fetchImpl?: typeof fetch;
  exportId?: string;
  now?: () => Date;
  beforePublishCurrent?: () => void | Promise<void>;
};

const MAX_MEMORIES = 10_000;
const MAX_RELATIONS = 10_000;
const MAX_LINKS = 50_000;
const MAX_INDEX_ENTRIES = 100_000;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const EXPORT_FILES: ExportFileName[] = [
  "PROJECT.md",
  "memory.jsonl",
  "relations.jsonl",
  "links.jsonl",
  "index.jsonl",
  "summary.json"
];

function error(code: ProjectContextExportCode, message: string, status: number, cause?: unknown): ProjectContextExportError {
  return new ProjectContextExportError(code, message, status, cause === undefined ? undefined : { cause });
}

function unavailable(message: string, cause?: unknown): ProjectContextExportError {
  return error(PROJECT_CONTEXT_EXPORT_CODES.unavailable, message, 503, cause);
}

function limitExceeded(message: string): ProjectContextExportError {
  return error(PROJECT_CONTEXT_EXPORT_CODES.limitExceeded, message, 413);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable(`Core returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw unavailable(`Core returned an invalid ${label} collection.`);
  }
  return value as Record<string, unknown>[];
}

function exactCount(value: unknown, expected: number, label: string): number {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw unavailable(`Core returned a mismatched ${label} count.`);
  }
  return value as number;
}

function assertWithinCount(value: number, maximum: number, label: string): void {
  if (value > maximum) throw limitExceeded(`${label} exceeds the export limit of ${maximum} records.`);
}

function normalizedForbiddenKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "owneraccountid"
    || normalized === "localpath"
    || normalized === "syncroot"
    || normalized === "downloadsdir"
    || normalized === "localclienttoken"
    || normalized === "accesstoken"
    || normalized === "apitoken"
    || normalized === "authorization";
}

function sanitizeExportValue(value: unknown, seen = new Set<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw unavailable("Core export snapshot contains a circular value.");
    seen.add(value);
    const result = value.map((item) => sanitizeExportValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw unavailable("Core export snapshot contains a circular value.");
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!normalizedForbiddenKey(key)) result[key] = sanitizeExportValue(item, seen);
    }
    seen.delete(value);
    return result;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === undefined) {
    throw unavailable("Core export snapshot contains a non-JSON value.");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw unavailable("Core export snapshot contains a non-finite number.");
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function canonicalJsonLine(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireStringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw unavailable(`Core returned an invalid ${label} ${key}.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFields(fields: string[]): (left: Record<string, unknown>, right: Record<string, unknown>) => number {
  return (left, right) => {
    for (const field of fields) {
      const compared = compareText(stringField(left[field]), stringField(right[field]));
      if (compared !== 0) return compared;
    }
    return 0;
  };
}

function jsonLines(items: Record<string, unknown>[]): Buffer {
  const lines = items.map(canonicalJsonLine);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function markdownValue(value: unknown, fallback = "-"): string {
  const text = normalizeLf(stringField(value)).trim();
  return text || fallback;
}

export function serializeProjectMarkdown(snapshot: ProjectContextExportSnapshot): Buffer {
  const project = snapshot.project;
  const brief = snapshot.brief;
  const name = markdownValue(project.name, "Untitled Project").replace(/\n+/g, " ");
  const status = markdownValue(project.status).replace(/\n+/g, " ");
  const updatedAt = markdownValue(project.updatedAt).replace(/\n+/g, " ");
  const description = markdownValue(project.description);
  const briefMarkdown = markdownValue(brief.contentMarkdown);
  const value = [
    `# ${name}`,
    "",
    `- Status: ${status}`,
    `- Updated: ${updatedAt}`,
    "",
    "## Description",
    "",
    description,
    "",
    "## Project brief",
    "",
    briefMarkdown,
    ""
  ].join("\n");
  return Buffer.from(value, "utf8");
}

function recordBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJsonLine(value), "utf8");
}

function assertRecordLimits(snapshot: ProjectContextExportSnapshot): void {
  const values: unknown[] = [
    snapshot.project,
    snapshot.brief,
    ...snapshot.memories,
    ...snapshot.relations,
    ...snapshot.links,
    ...snapshot.indexEntries,
    snapshot.generatedSummary
  ];
  for (const value of values) {
    if (recordBytes(value) > MAX_RECORD_BYTES) {
      throw limitExceeded(`A serialized export record exceeds ${MAX_RECORD_BYTES} bytes.`);
    }
  }
}

function canonicalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? undefined : value;
}

function assertExportAssociations(snapshot: {
  project: Record<string, unknown>;
  brief: Record<string, unknown>;
  memories: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  links: Record<string, unknown>[];
  indexEntries: Record<string, unknown>[];
  generatedSummary: unknown;
}, projectId: string): void {
  if (requireStringField(snapshot.project, "id", "project") !== projectId) {
    throw unavailable("Core returned a Project other than the requested Project.");
  }
  if (requireStringField(snapshot.brief, "projectId", "brief") !== projectId) {
    throw unavailable("Core returned a Project brief for a different Project.");
  }
  for (const memory of snapshot.memories) {
    requireStringField(memory, "id", "memory");
    if (requireStringField(memory, "projectId", "memory") !== projectId) {
      throw unavailable("Core returned Project memory for a different Project.");
    }
    if (!canonicalIsoTimestamp(memory.createdAt) || !canonicalIsoTimestamp(memory.updatedAt)) {
      throw unavailable("Core returned Project memory with invalid timestamps.");
    }
  }
  for (const relation of snapshot.relations) {
    requireStringField(relation, "id", "relation");
    const sourceProjectId = requireStringField(relation, "sourceProjectId", "relation");
    const targetProjectId = requireStringField(relation, "targetProjectId", "relation");
    if (sourceProjectId !== projectId && targetProjectId !== projectId) {
      throw unavailable("Core returned Project relation unrelated to the requested Project.");
    }
  }
  for (const link of snapshot.links) {
    requireStringField(link, "id", "link");
    if (requireStringField(link, "projectId", "link") !== projectId) {
      throw unavailable("Core returned Project link for a different Project.");
    }
    if (!canonicalIsoTimestamp(link.linkedAt)) {
      throw unavailable("Core returned Project link with an invalid linkedAt timestamp.");
    }
  }
  for (const entry of snapshot.indexEntries) {
    requireStringField(entry, "id", "index entry");
    if (requireStringField(entry, "projectId", "index entry") !== projectId) {
      throw unavailable("Core returned Project index entry for a different Project.");
    }
  }
  if (snapshot.generatedSummary !== null && snapshot.generatedSummary !== undefined) {
    const summary = asObject(snapshot.generatedSummary, "generated summary");
    if (requireStringField(summary, "projectId", "generated summary") !== projectId) {
      throw unavailable("Core returned generated summary for a different Project.");
    }
  }
}

export function normalizeProjectContextExportSnapshot(raw: unknown, projectId: string): ProjectContextExportSnapshot {
  const root = asObject(raw, "project context export response");
  if (root.schemaVersion !== 1
    || root.packageType !== "workbench.project-context-export"
    || root.complete !== true
    || !canonicalIsoTimestamp(root.generatedAt)) {
    throw unavailable("Core returned an unsupported or incomplete project context export response.");
  }
  const project = asObject(sanitizeExportValue(root.project), "project");
  const brief = asObject(sanitizeExportValue(root.brief), "brief");
  const memories = asRecordArray(sanitizeExportValue(root.memories), "memory");
  const relations = asRecordArray(sanitizeExportValue(root.relations), "relation");
  const links = asRecordArray(sanitizeExportValue(root.links), "link");
  const indexEntries = asRecordArray(sanitizeExportValue(root.indexEntries), "index");
  const generatedSummary = sanitizeExportValue(root.generatedSummary);
  assertExportAssociations({ project, brief, memories, relations, links, indexEntries, generatedSummary }, projectId);
  assertWithinCount(memories.length, MAX_MEMORIES, "Memory");
  assertWithinCount(relations.length, MAX_RELATIONS, "Relation");
  assertWithinCount(links.length, MAX_LINKS, "Link");
  assertWithinCount(indexEntries.length, MAX_INDEX_ENTRIES, "Index");

  const generatedAt = canonicalIsoTimestamp(root.generatedAt);
  if (!generatedAt) throw unavailable("Core returned an invalid project context export timestamp.");
  const countsValue = asObject(root.counts, "counts");
  const counts = {
    memories: exactCount(countsValue.memories, memories.length, "memory"),
    relations: exactCount(countsValue.relations, relations.length, "relation"),
    links: exactCount(countsValue.links, links.length, "link"),
    indexEntries: exactCount(countsValue.indexEntries, indexEntries.length, "index")
  };
  const snapshot: ProjectContextExportSnapshot = {
    schemaVersion: 1,
    packageType: "workbench.project-context-export",
    generatedAt,
    complete: true,
    project,
    brief,
    memories: [...memories].sort(compareFields(["createdAt", "id"])),
    relations: [...relations].sort(compareFields(["sourceProjectId", "targetProjectId", "relationType", "id"])),
    links: [...links].sort(compareFields(["linkedAt", "id"])),
    indexEntries: [...indexEntries].sort(compareFields([
      "sourceService",
      "resourceType",
      "path",
      "resourceId",
      "associationKind",
      "id"
    ])),
    generatedSummary,
    counts
  };
  assertRecordLimits(snapshot);
  return snapshot;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileMetadata(buffer: Buffer, records: number): ExportFileMetadata {
  return { sha256: sha256(buffer), bytes: buffer.byteLength, records };
}

function serializeFiles(snapshot: ProjectContextExportSnapshot): Record<ExportFileName, Buffer> {
  return {
    "PROJECT.md": serializeProjectMarkdown(snapshot),
    "memory.jsonl": jsonLines(snapshot.memories),
    "relations.jsonl": jsonLines(snapshot.relations),
    "links.jsonl": jsonLines(snapshot.links),
    "index.jsonl": jsonLines(snapshot.indexEntries),
    "summary.json": Buffer.from(canonicalJson(snapshot.generatedSummary), "utf8")
  };
}

function buildManifest(
  snapshot: ProjectContextExportSnapshot,
  projectId: string,
  exportId: string,
  createdAt: string,
  files: Record<ExportFileName, Buffer>
): ProjectContextExportManifest {
  const projectUpdatedAt = stringField(snapshot.project.updatedAt);
  if (!projectUpdatedAt || !Number.isFinite(Date.parse(projectUpdatedAt))) {
    throw unavailable("Core export snapshot is missing project.updatedAt.");
  }
  const briefVersionValue = snapshot.brief.version;
  if (!Number.isSafeInteger(briefVersionValue) || (briefVersionValue as number) < 0) {
    throw unavailable("Core export snapshot has an invalid brief version.");
  }
  return {
    schemaVersion: 1,
    packageType: "workbench.project-context-export",
    exportId,
    projectId,
    projectUpdatedAt,
    createdAt,
    briefVersion: briefVersionValue as number,
    counts: { ...snapshot.counts },
    files: {
      "PROJECT.md": fileMetadata(files["PROJECT.md"], 1),
      "memory.jsonl": fileMetadata(files["memory.jsonl"], snapshot.counts.memories),
      "relations.jsonl": fileMetadata(files["relations.jsonl"], snapshot.counts.relations),
      "links.jsonl": fileMetadata(files["links.jsonl"], snapshot.counts.links),
      "index.jsonl": {
        ...fileMetadata(files["index.jsonl"], snapshot.counts.indexEntries),
        authoritative: false,
        importPolicy: "ignore"
      },
      "summary.json": fileMetadata(files["summary.json"], snapshot.generatedSummary === null ? 0 : 1)
    },
    importPolicy: "unsupported",
    containsSensitiveData: true
  };
}

function pathInside(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith("..\\") && !value.startsWith("../") && !isAbsolute(value));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function assertNotSymlink(stats: Stats, path: string): void {
  if (stats.isSymbolicLink()) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.symlinkRejected, `Export path contains a symlink or reparse point: ${path}`, 400);
  }
}

async function ensureSafeDirectory(syncRoot: string, target: string): Promise<void> {
  const root = resolve(syncRoot);
  const targetPath = resolve(target);
  if (!pathInside(root, targetPath)) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, "Export path escapes the configured sync root.", 400);
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await fs.lstat(root);
  assertNotSymlink(rootStats, root);
  if (!rootStats.isDirectory()) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, "Configured sync root is not a directory.", 400);
  }
  const rootReal = await fs.realpath(root);
  if (!samePath(rootReal, root)) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.symlinkRejected, "Configured sync root resolves through a symlink or reparse point.", 400);
  }
  const segments = relative(root, targetPath).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stats = await lstatIfExists(current);
    if (!stats) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
      stats = await fs.lstat(current);
    }
    assertNotSymlink(stats, current);
    if (!stats.isDirectory()) {
      throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, `Export path component is not a directory: ${current}`, 400);
    }
    await fs.chmod(current, 0o700).catch(() => undefined);
    const currentReal = await fs.realpath(current);
    if (!pathInside(rootReal, currentReal)) {
      throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, "Export path resolves outside the configured sync root.", 400);
    }
  }
}

async function assertSafeExistingPath(syncRoot: string, path: string, expected: "file" | "directory"): Promise<void> {
  if (!pathInside(syncRoot, path)) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, "Export path escapes the configured sync root.", 400);
  }
  const stats = await lstatIfExists(path);
  if (!stats) return;
  assertNotSymlink(stats, path);
  if ((expected === "file" && !stats.isFile()) || (expected === "directory" && !stats.isDirectory())) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, `Unexpected export path type: ${path}`, 400);
  }
}

async function writeDurableFile(path: string, value: Buffer, exclusive = true): Promise<void> {
  const handle = await fs.open(path, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(path, 0o600).catch(() => undefined);
}

function countJsonlRecords(buffer: Buffer): number {
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n")) return -1;
  return text.slice(0, -1).split("\n").filter((line) => line.length > 0).length;
}

async function verifyStagedFiles(
  stagePath: string,
  files: Record<ExportFileName, Buffer>,
  manifest: ProjectContextExportManifest
): Promise<void> {
  for (const filename of EXPORT_FILES) {
    const buffer = await fs.readFile(join(stagePath, filename));
    const metadata = manifest.files[filename];
    if (!buffer.equals(files[filename]) || buffer.byteLength !== metadata.bytes || sha256(buffer) !== metadata.sha256) {
      throw new Error(`Staged export file verification failed: ${filename}`);
    }
    if (filename.endsWith(".jsonl") && countJsonlRecords(buffer) !== metadata.records) {
      throw new Error(`Staged export record verification failed: ${filename}`);
    }
    if (!buffer.toString("utf8").endsWith("\n")) {
      throw new Error(`Staged export file lacks its final LF: ${filename}`);
    }
  }
  const manifestBuffer = await fs.readFile(join(stagePath, "manifest.json"));
  if (!manifestBuffer.equals(Buffer.from(canonicalJson(manifest), "utf8"))) {
    throw new Error("Staged export manifest verification failed.");
  }
}

function validateProjectId(projectId: string): string {
  if (!projectId || projectId.trim() !== projectId || Buffer.byteLength(projectId, "utf8") > 1024) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, "projectId must be a non-empty stable identifier.", 400);
  }
  const encoded = Buffer.from(projectId, "utf8").toString("base64url");
  if (!encoded || encoded.includes("/") || encoded.includes("\\") || encoded === "." || encoded === "..") {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, "projectId cannot be encoded as a safe export path segment.", 400);
  }
  return encoded;
}

function validateExportId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw error(PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe, "Export ID is not a valid UUID.", 400);
  }
  return value.toLowerCase();
}

async function fetchLiveSnapshot(
  config: ProjectContextExportConfig,
  identity: ProjectContextExportIdentity,
  projectId: string,
  fetchImpl: typeof fetch
): Promise<ProjectContextExportSnapshot> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${config.coreUrl}/api/sync/projects/${encodeURIComponent(projectId)}/context-export`,
      {
        method: "GET",
        headers: {
          "x-workbench-local-client-id": identity.localClientId,
          "x-workbench-local-client-token": identity.localClientToken
        }
      }
    );
  } catch (cause) {
    throw unavailable("The live Core project context export is unavailable.", cause);
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text.trim() ? JSON.parse(text) : undefined;
  } catch (cause) {
    throw unavailable("Core returned an invalid project context export response.", cause);
  }
  if (!response.ok) {
    const upstream = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (response.status === 413 || upstream.code === PROJECT_CONTEXT_EXPORT_CODES.limitExceeded) {
      throw limitExceeded(typeof upstream.message === "string" ? upstream.message : "Core project context export limit exceeded.");
    }
    throw unavailable(typeof upstream.message === "string" ? upstream.message : "The live Core project context export is unavailable.");
  }
  return normalizeProjectContextExportSnapshot(body, projectId);
}

export async function exportProjectContext(
  config: ProjectContextExportConfig,
  identity: ProjectContextExportIdentity | undefined,
  projectId: string,
  options: ProjectContextExportOptions = {}
): Promise<ProjectContextExportResult> {
  const projectSegment = validateProjectId(projectId);
  if (!identity?.localClientId || !identity.localClientToken) {
    throw unavailable("A registered local client identity is required for project context export.");
  }
  const snapshot = await fetchLiveSnapshot(config, identity, projectId, options.fetchImpl ?? fetch);
  const exportId = validateExportId(options.exportId ?? randomUUID());
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const files = serializeFiles(snapshot);
  const manifest = buildManifest(snapshot, projectId, exportId, createdAt, files);
  const manifestBuffer = Buffer.from(canonicalJson(manifest), "utf8");
  const totalBytes = Object.values(files).reduce((total, value) => total + value.byteLength, 0) + manifestBuffer.byteLength;
  if (totalBytes > MAX_TOTAL_BYTES) throw limitExceeded(`Export package exceeds ${MAX_TOTAL_BYTES} bytes.`);

  const projectRoot = join(resolve(config.syncRoot), ".workbench", "project-context", projectSegment);
  const snapshotsRoot = join(projectRoot, "snapshots");
  const snapshotPath = join(snapshotsRoot, exportId);
  const stagePath = join(snapshotsRoot, `.staging-${exportId}-${randomUUID()}`);
  const currentPath = join(projectRoot, "current.json");
  const currentTempPath = join(projectRoot, `.current-${exportId}-${randomUUID()}.tmp`);
  let stageCreated = false;
  let snapshotPublished = false;
  try {
    await ensureSafeDirectory(config.syncRoot, snapshotsRoot);
    await assertSafeExistingPath(config.syncRoot, snapshotPath, "directory");
    if (await lstatIfExists(snapshotPath)) {
      throw new Error(`Immutable export snapshot already exists: ${exportId}`);
    }
    await assertSafeExistingPath(config.syncRoot, currentPath, "file");
    await fs.mkdir(stagePath, { mode: 0o700 });
    stageCreated = true;
    const stageStats = await fs.lstat(stagePath);
    assertNotSymlink(stageStats, stagePath);

    for (const filename of EXPORT_FILES) await writeDurableFile(join(stagePath, filename), files[filename]);
    await writeDurableFile(join(stagePath, "manifest.json"), manifestBuffer);
    await verifyStagedFiles(stagePath, files, manifest);
    await assertSafeExistingPath(config.syncRoot, snapshotPath, "directory");
    if (await lstatIfExists(snapshotPath)) throw new Error(`Immutable export snapshot already exists: ${exportId}`);
    await fs.rename(stagePath, snapshotPath);
    stageCreated = false;
    snapshotPublished = true;

    const current: ProjectContextExportCurrent = {
      schemaVersion: 1,
      exportId,
      snapshot: `snapshots/${exportId}`,
      manifestSha256: sha256(manifestBuffer),
      updatedAt: createdAt
    };
    const currentBuffer = Buffer.from(canonicalJson(current), "utf8");
    await writeDurableFile(currentTempPath, currentBuffer);
    await assertSafeExistingPath(config.syncRoot, currentPath, "file");
    await options.beforePublishCurrent?.();
    await assertSafeExistingPath(config.syncRoot, currentPath, "file");
    await fs.rename(currentTempPath, currentPath);
    await fs.chmod(currentPath, 0o600).catch(() => undefined);
    return {
      schemaVersion: 1,
      exportId,
      projectId,
      snapshot: current.snapshot,
      current,
      manifest
    };
  } catch (cause) {
    await fs.rm(currentTempPath, { force: true }).catch(() => undefined);
    if (stageCreated) await fs.rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof ProjectContextExportError) throw cause;
    throw error(
      PROJECT_CONTEXT_EXPORT_CODES.writeFailed,
      snapshotPublished
        ? "Export snapshot was written, but current.json was not changed."
        : "Project context export could not be written.",
      500,
      cause
    );
  }
}

export async function assertProjectContextExportReadable(path: string): Promise<void> {
  await fs.access(path, fsConstants.R_OK);
}
