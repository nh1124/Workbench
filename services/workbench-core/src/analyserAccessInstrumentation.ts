import type express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { verifyAccessToken } from "./auth.js";
import {
  analyserInternalClient,
  InternalServiceError,
  serviceBaseUrls,
  type AnalyserInternalIngestResult
} from "./internalClients.js";
import { logger } from "./logger.js";

const SETTINGS_TTL_MS = 60_000;
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_THRESHOLD = 50;

type AccessLevel = "off" | "mutations" | "reads_and_mutations";
type AccessKind = "read" | "mutation";
type EffectiveAccessSettingsResult = {
  settings: { mcpAccess: AccessLevel; uiAccess: AccessLevel };
};
type AccessLogger = {
  error(message: string, details?: Record<string, unknown>): void;
};

export type ResourceRef = {
  service: string;
  resourceType: string;
  resourceId: string;
  pathSnapshot?: string;
};

export interface AnalyserAccessInstrumentationDeps {
  getEffectiveSettings(query: { coreUserId: string }): Promise<EffectiveAccessSettingsResult>;
  ingestObservations(body: {
    coreUserId: string;
    observations: unknown[];
  }): Promise<AnalyserInternalIngestResult>;
  analyserBaseUrl?: string;
  logger: AccessLogger;
  now(): number;
  randomUUID(): string;
  resolveCoreUserId(req: express.Request): string | undefined | Promise<string | undefined>;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

type ResolvedDeps = AnalyserAccessInstrumentationDeps;
type AccessObservation = Record<string, unknown>;
type SettingsCacheEntry = {
  expiresAt: number;
  value?: EffectiveAccessSettingsResult["settings"] | null;
  pending?: Promise<EffectiveAccessSettingsResult["settings"] | null | undefined>;
};
type UserBuffer = { observations: AccessObservation[]; deps: ResolvedDeps };

let settingsCache = new Map<string, SettingsCacheEntry>();
let userBuffers = new Map<string, UserBuffer>();
let instrumentedServers = new WeakSet<object>();
let flushTimer: ReturnType<typeof globalThis.setInterval> | undefined;
let clearFlushTimer: typeof globalThis.clearInterval | undefined;
const pendingAccessTasks = new Set<Promise<void>>();
const inFlightFlushes = new Set<Promise<void>>();
const loggedErrorMessages = new Set<string>();

function defaultResolveCoreUserId(req: express.Request): string | undefined {
  const raw = req.header("authorization");
  if (!raw) return undefined;
  const [scheme, token] = raw.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token?.trim()) return undefined;
  try {
    return verifyAccessToken(token.trim()).sub;
  } catch {
    return undefined;
  }
}

function realDeps(): ResolvedDeps {
  return {
    getEffectiveSettings: (query) => (
      analyserInternalClient.getEffectiveSettings(query) as unknown as Promise<EffectiveAccessSettingsResult>
    ),
    ingestObservations: analyserInternalClient.ingestObservations,
    analyserBaseUrl: serviceBaseUrls.analyser,
    logger,
    now: Date.now,
    randomUUID,
    resolveCoreUserId: defaultResolveCoreUserId,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval
  };
}

function resolveDeps(overrides: Partial<AnalyserAccessInstrumentationDeps> = {}): ResolvedDeps {
  return { ...realDeps(), ...overrides };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logErrorOnce(deps: ResolvedDeps, error: unknown): void {
  const message = errorMessage(error);
  if (loggedErrorMessages.has(message)) return;
  loggedErrorMessages.add(message);
  deps.logger.error("Analyser access instrumentation failed", { message });
}

async function getSettings(
  coreUserId: string,
  deps: ResolvedDeps
): Promise<EffectiveAccessSettingsResult["settings"] | null | undefined> {
  const cached = settingsCache.get(coreUserId);
  if (cached && cached.expiresAt > deps.now()) {
    if (cached.pending) return cached.pending;
    return cached.value;
  }

  const pending = (async () => {
    try {
      const result = await deps.getEffectiveSettings({ coreUserId });
      settingsCache.set(coreUserId, {
        expiresAt: deps.now() + SETTINGS_TTL_MS,
        value: result.settings
      });
      return result.settings;
    } catch (error) {
      if (error instanceof InternalServiceError && error.status === 404) {
        settingsCache.set(coreUserId, { expiresAt: deps.now() + SETTINGS_TTL_MS, value: null });
        return null;
      }
      settingsCache.delete(coreUserId);
      logErrorOnce(deps, error);
      return undefined;
    }
  })();

  settingsCache.set(coreUserId, { expiresAt: Number.POSITIVE_INFINITY, pending });
  return pending;
}

function settingAllows(level: AccessLevel, kind: AccessKind): boolean {
  return level === "reads_and_mutations" || (level === "mutations" && kind === "mutation");
}

function ensureFlushTimer(deps: ResolvedDeps): void {
  if (flushTimer) return;
  flushTimer = deps.setInterval(() => { void flushAccessObservationsNow(); }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  clearFlushTimer = deps.clearInterval;
}

function flushUser(coreUserId: string): Promise<void> | undefined {
  const buffer = userBuffers.get(coreUserId);
  if (!buffer || buffer.observations.length === 0) return undefined;
  userBuffers.delete(coreUserId);
  const flush = buffer.deps.ingestObservations({
    coreUserId,
    observations: buffer.observations
  }).then(() => undefined).catch((error: unknown) => {
    logErrorOnce(buffer.deps, error);
  });
  inFlightFlushes.add(flush);
  void flush.finally(() => { inFlightFlushes.delete(flush); });
  return flush;
}

function enqueue(coreUserId: string, observation: AccessObservation, deps: ResolvedDeps): void {
  const buffer = userBuffers.get(coreUserId) ?? { observations: [], deps };
  buffer.deps = deps;
  buffer.observations.push(observation);
  userBuffers.set(coreUserId, buffer);
  ensureFlushTimer(deps);
  if (buffer.observations.length >= FLUSH_THRESHOLD) void flushUser(coreUserId);
}

function trackAccessTask(task: Promise<void>, deps: ResolvedDeps): void {
  const tracked = task.catch((error: unknown) => { logErrorOnce(deps, error); });
  pendingAccessTasks.add(tracked);
  void tracked.finally(() => { pendingAccessTasks.delete(tracked); });
}

async function recordIfEnabled(input: {
  coreUserId: string;
  setting: "mcpAccess" | "uiAccess";
  kind: AccessKind;
  observation: AccessObservation;
}, deps: ResolvedDeps): Promise<void> {
  const settings = await getSettings(input.coreUserId, deps);
  if (!settings || !settingAllows(settings[input.setting], input.kind)) return;
  enqueue(input.coreUserId, input.observation, deps);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResourceRefExtractor = (args: unknown) => ResourceRef[];

function resourceRefExtractor(
  service: string,
  resourceType: string,
  idField: string,
  pathField?: string
): ResourceRefExtractor {
  return (args) => {
    if (!isRecord(args)) return [];
    const resourceId = args[idField];
    if (typeof resourceId !== "string" || resourceId.trim().length === 0) return [];
    const pathSnapshot = pathField === undefined ? undefined : args[pathField];
    return [{
      service,
      resourceType,
      resourceId,
      ...(typeof pathSnapshot === "string" && pathSnapshot.trim().length > 0 ? { pathSnapshot } : {})
    }];
  };
}

const noteRef = resourceRefExtractor("notes", "note", "id");
const artifactItemRef = resourceRefExtractor("artifacts", "artifact_item", "id", "path");
const projectIdRef = resourceRefExtractor("projects", "project", "projectId");
const projectRef = resourceRefExtractor("projects", "project", "id");
const taskRef = resourceRefExtractor("tasks", "task", "id");
const mindmapRef = resourceRefExtractor("mindmaps", "mindmap", "id");
const wbsRef = resourceRefExtractor("wbs", "wbs", "id");

const MCP_RESOURCE_REF_EXTRACTORS: Readonly<Record<string, ResourceRefExtractor>> = {
  "notes.get": noteRef,
  "notes.update": noteRef,
  "notes.delete": noteRef,
  "artifacts.item.get": artifactItemRef,
  "artifacts.item.update": artifactItemRef,
  "artifacts.item.move": artifactItemRef,
  "artifacts.item.delete": artifactItemRef,
  "artifacts.item.metadata.update": artifactItemRef,
  "projects.get": projectRef,
  "projects.context.get": projectIdRef,
  "projects.index.search": projectIdRef,
  "projects.brief.get": projectIdRef,
  "projects.brief.update": projectIdRef,
  "tasks.get": taskRef,
  "tasks.update": taskRef,
  "tasks.delete": taskRef,
  "mindmaps.get": mindmapRef,
  "mindmaps.update": mindmapRef,
  "wbs.get": wbsRef,
  "wbs.update": wbsRef
};

export function resourceRefsForTool(toolName: string, args: unknown): ResourceRef[] {
  return MCP_RESOURCE_REF_EXTRACTORS[toolName]?.(args) ?? [];
}

function isExcludedTool(name: string): boolean {
  return name.startsWith("analyser.") || name.startsWith("auth.");
}

function thrownErrorClass(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  try {
    const constructor = (error as { constructor?: { name?: unknown } }).constructor;
    return typeof constructor?.name === "string" ? constructor.name : undefined;
  } catch {
    return undefined;
  }
}

export function instrumentMcpServer(
  server: McpServer,
  ctx: { accessToken: string; coreUserId: string },
  overrides: Partial<AnalyserAccessInstrumentationDeps> = {}
): McpServer {
  const deps = resolveDeps(overrides);
  if (!deps.analyserBaseUrl || instrumentedServers.has(server)) return server;

  const originalRegisterTool = server.registerTool.bind(server) as unknown as (...args: unknown[]) => unknown;
  const patchedRegisterTool = (
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown
  ): unknown => {
    if (isExcludedTool(name)) return originalRegisterTool(name, config, handler);

    const kind: AccessKind = isRecord(config.annotations)
      && config.annotations.readOnlyHint === true
      ? "read"
      : "mutation";
    const wrappedHandler = async function(this: unknown, ...handlerArgs: unknown[]): Promise<unknown> {
      const startedAt = deps.now();
      let ok = false;
      let errorClass: string | undefined;
      try {
        const result = await handler.apply(this, handlerArgs);
        ok = true;
        return result;
      } catch (error) {
        errorClass = thrownErrorClass(error);
        throw error;
      } finally {
        const durationMs = Math.max(0, deps.now() - startedAt);
        const args = handlerArgs[0];
        const projectId = isRecord(args) && typeof args.projectId === "string"
          ? args.projectId
          : undefined;
        trackAccessTask(recordIfEnabled({
          coreUserId: ctx.coreUserId,
          setting: "mcpAccess",
          kind,
          observation: {
            source: "mcp_access",
            action: `tool:${name}`,
            actorKind: "agent",
            occurredAt: new Date(deps.now()).toISOString(),
            metadata: {
              tool: name,
              kind,
              ok,
              durationMs,
              ...(errorClass === undefined ? {} : { errorClass })
            },
            ...(projectId === undefined ? {} : { projectId }),
            resourceRefs: resourceRefsForTool(name, args),
            dedupeKey: `mcp:${deps.randomUUID()}`
          }
        }, deps), deps);
      }
    };
    return originalRegisterTool(name, config, wrappedHandler);
  };

  (server as unknown as { registerTool: typeof patchedRegisterTool }).registerTool = patchedRegisterTool;
  instrumentedServers.add(server);
  return server;
}

const HTTP_EXCLUDED_PREFIXES = [
  "/api/analyser",
  "/api/sync",
  "/api/auth",
  "/api/oauth"
];
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HttpResourceRefPattern = {
  pattern: RegExp;
  service: string;
  resourceType: string;
};

const HTTP_RESOURCE_REF_PATTERNS: readonly HttpResourceRefPattern[] = [
  { pattern: /^\/api\/artifacts\/items\/([^/?#]+)(?:\/|$)/i, service: "artifacts", resourceType: "artifact_item" },
  { pattern: /^\/api\/wbs\/plans\/([^/?#]+)(?:\/|$)/i, service: "wbs", resourceType: "wbs" },
  { pattern: /^\/api\/tasks\/today\/([^/?#]+)(?:\/|$)/i, service: "tasks", resourceType: "task" },
  { pattern: /^\/api\/notes\/([^/?#]+)(?:\/|$)/i, service: "notes", resourceType: "note" },
  { pattern: /^\/api\/projects\/([^/?#]+)(?:\/|$)/i, service: "projects", resourceType: "project" },
  { pattern: /^\/api\/tasks\/([^/?#]+)(?:\/|$)/i, service: "tasks", resourceType: "task" },
  { pattern: /^\/api\/mindmaps\/([^/?#]+)(?:\/|$)/i, service: "mindmaps", resourceType: "mindmap" },
  { pattern: /^\/api\/wbs\/([^/?#]+)(?:\/|$)/i, service: "wbs", resourceType: "wbs" }
];

const HTTP_RESERVED_ID_SEGMENTS = new Set([
  ":id",
  "bulk",
  "default",
  "dependencies",
  "export",
  "import",
  "items",
  "lbs",
  "plans",
  "pins",
  "projects",
  "schedule",
  "schedule-calendar",
  "schedule-items",
  "today"
]);

function isResourceIdSegment(segment: string): boolean {
  return segment.length > 0 && !HTTP_RESERVED_ID_SEGMENTS.has(segment.toLowerCase());
}

export function resourceRefsForHttp(method: string, pathname: string): ResourceRef[] {
  void method;
  const pathWithoutQuery = pathname.split(/[?#]/, 1)[0] ?? pathname;
  for (const { pattern, service, resourceType } of HTTP_RESOURCE_REF_PATTERNS) {
    const resourceId = pattern.exec(pathWithoutQuery)?.[1];
    if (!resourceId || !isResourceIdSegment(resourceId)) continue;
    return [{ service, resourceType, resourceId }];
  }
  return [];
}

function shouldObserveHttp(method: string, pathname: string): boolean {
  const lowerPath = pathname.toLowerCase();
  if (method === "OPTIONS" || pathname === "/health" || !pathname.startsWith("/api/")) return false;
  if (HTTP_EXCLUDED_PREFIXES.some((prefix) => lowerPath.startsWith(prefix))) return false;
  return !lowerPath.includes("secret") && !lowerPath.includes("token");
}

function normalizeHttpPath(pathname: string): string {
  return pathname.split("/").map((segment) => (
    UUID_SEGMENT.test(segment) || /^\d+$/.test(segment) ? ":id" : segment
  )).join("/");
}

export function analyserHttpAccessMiddleware(
  overrides: Partial<AnalyserAccessInstrumentationDeps> = {}
): express.RequestHandler {
  const deps = resolveDeps(overrides);
  if (!deps.analyserBaseUrl) return (_req, _res, next) => next();

  return (req, res, next) => {
    const method = req.method.toUpperCase();
    const pathname = req.path;
    if (!shouldObserveHttp(method, pathname)) {
      next();
      return;
    }

    const startedAt = deps.now();
    const coreUserId = Promise.resolve(deps.resolveCoreUserId(req)).catch(() => undefined);
    res.on("finish", () => {
      const durationMs = Math.max(0, deps.now() - startedAt);
      const normalizedPath = normalizeHttpPath(pathname);
      const kind: AccessKind = method === "GET" || method === "HEAD" ? "read" : "mutation";
      trackAccessTask((async () => {
        const resolvedCoreUserId = await coreUserId;
        if (!resolvedCoreUserId) return;
        await recordIfEnabled({
          coreUserId: resolvedCoreUserId,
          setting: "uiAccess",
          kind,
          observation: {
            source: "ui_access",
            action: `http:${method} ${normalizedPath}`,
            actorKind: "user",
            occurredAt: new Date(deps.now()).toISOString(),
            metadata: {
              route: normalizedPath,
              method,
              kind,
              status: res.statusCode,
              ok: res.statusCode < 400,
              durationMs
            },
            resourceRefs: resourceRefsForHttp(method, pathname),
            dedupeKey: `http:${deps.randomUUID()}`
          }
        }, deps);
      })(), deps);
    });
    next();
  };
}

export async function flushAccessObservationsNow(): Promise<void> {
  while (pendingAccessTasks.size > 0) await Promise.all([...pendingAccessTasks]);
  const flushes = [...userBuffers.keys()]
    .map((coreUserId) => flushUser(coreUserId))
    .filter((flush): flush is Promise<void> => flush !== undefined);
  await Promise.all([...inFlightFlushes, ...flushes]);
}

export function _resetForTests(): void {
  if (flushTimer && clearFlushTimer) clearFlushTimer(flushTimer);
  flushTimer = undefined;
  clearFlushTimer = undefined;
  settingsCache = new Map();
  userBuffers = new Map();
  instrumentedServers = new WeakSet();
  pendingAccessTasks.clear();
  inFlightFlushes.clear();
  loggedErrorMessages.clear();
}
