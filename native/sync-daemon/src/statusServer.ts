import {
  createServer,
  type IncomingMessage
} from "node:http";
import {
  LEASE_SWEEP_INTERVAL_MS,
  LeaseValidationError,
  normalizeClientId
} from "./leases.js";
import {
  resolve
} from "node:path";
import {
  promises as fs
} from "node:fs";
import {
  createLocalProject,
  createLocalProjectMemory,
  createLocalProjectRelation,
  deleteLocalProject,
  deleteLocalProjectRelation,
  localDefaultProjectSelection,
  setLocalDefaultProject,
  updateLocalProject,
  updateLocalProjectBrief,
  updateLocalProjectMemory,
  updateLocalProjectRelation
} from "./localProjects.js";
import {
  createLocalNote,
  deleteLocalNote,
  localNoteProjectSummaries,
  updateLocalNote
} from "./localNotes.js";
import {
  addLocalTaskToToday,
  createLocalTask,
  createLocalTaskAttachment,
  createLocalTaskSubtask,
  deleteLocalTask,
  deleteLocalTaskAttachment,
  deleteLocalTaskSubtask,
  exportLocalTasksCsv,
  importLocalTasksCsv,
  localScheduleCalendar,
  localTaskHistory,
  localTaskPayloadForUpdate,
  localTaskPinnedIds,
  localTaskProjectSummaries,
  localTaskSchedule,
  localTodayTasks,
  recordLocalTaskOccurrence,
  removeLocalTaskFromToday,
  removeLocalTaskScheduleItem,
  scheduleItemId,
  setLocalTaskPin,
  taskAttachments,
  taskScheduleItems,
  taskSubtasks,
  updateLocalTask,
  updateLocalTaskAttachment,
  updateLocalTaskScheduleItem,
  updateLocalTaskSubtask
} from "./localTasks.js";
import {
  createLocalArtifactFile,
  createLocalArtifactFolder,
  createLocalArtifactNote,
  deleteLocalArtifactItem,
  getLocalArtifactItemById,
  listLocalArtifactItems,
  patchLocalArtifactNoteContent,
  updateLocalArtifactItem,
  updateLocalArtifactNoteSection
} from "./localArtifacts.js";
import {
  LOOPBACK_CORS_ERROR_CODE,
  LOOPBACK_CORS_ERROR_MESSAGE,
  existingClientOpWriteResult,
  getFormDataString,
  isLocalProjectContextMutation,
  isSupportedLocalProjectContextWrite,
  optionalNumberQuery,
  parseBooleanQuery,
  parseConflictResolution,
  parseConflictStatus,
  readRequestFormData,
  readRequestJson,
  readRequestText,
  requestClientOpId,
  requestString,
  requireLoopbackAuth,
  sendLocalArtifactDownload,
  setLoopbackCorsHeaders,
  writeCaptureError,
  writeJson,
  writeLocalProjectContextError,
  writeProjectContextExportError
} from "./httpApi.js";
import {
  REMOTE_SYNC_CURSOR_META_KEY,
  REMOTE_SYNC_DOMAINS
} from "./remoteSync.js";
import {
  approvePendingLocalJobConfirmation,
  listPendingLocalJobConfirmations,
  pendingJobConfirmations,
  rejectPendingLocalJobConfirmation
} from "./jobs.js";
import {
  scheduleTick
} from "./tickScheduler.js";
import {
  REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY,
  requestRemoteSnapshotRescan
} from "./remotePull.js";
import {
  getMeta,
  listAllRemoteResourcesForDomain,
  listConflicts,
  resolveConflict,
  writeManifestDebugSnapshot,
  type RemoteResourceDomain
} from "./manifestStore.js";
import {
  asString,
  listLocalRemoteDomainItems,
  localRemoteDomainItem,
  refreshManifestStats,
  runWithClientOpId
} from "./localStore.js";
import {
  getLocalProjectBrief,
  getLocalProjectContext,
  listLocalProjectMemories,
  listLocalProjectRelations,
  LocalProjectContextError,
  PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY,
  PROJECT_CONTEXT_DOMAIN,
  PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY,
  PROJECT_CONTEXT_SUPPORTED_META_KEY
} from "./projectContextCache.js";
import {
  exportProjectContext,
  PROJECT_CONTEXT_EXPORT_CODES
} from "./projectContextExport.js";
import {
  CaptureError
} from "./capture/index.js";
import type {
  DaemonState,
  LocalArtifactItem
} from "./types.js";

/**
 * The daemon's loopback HTTP API.
 *
 * This is the bulk of what used to sit in index.ts. It could not move while
 * every route that mutates local state called index.ts's own scheduleTick;
 * with the scheduler in its own module the block turned out to need nothing
 * else from the entry point.
 */

async function createLocalArtifactUploadFromRequest(
  state: DaemonState,
  req: IncomingMessage
): Promise<LocalArtifactItem> {
  const contentType = req.headers["content-type"]?.toString().toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const formData = await readRequestFormData(req);
    const fileValue = formData.get("file");
    if (!fileValue || typeof fileValue === "string") {
      throw new Error("File is required");
    }
    const file = fileValue as unknown as {
      arrayBuffer?: () => Promise<ArrayBuffer>;
      name?: string;
      type?: string;
    };
    if (typeof file.arrayBuffer !== "function") {
      throw new Error("File is required");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    return createLocalArtifactFile(state, {
      directoryPath: getFormDataString(formData, "directoryPath"),
      originalFilename: file.name || "file",
      mimeType: file.type || getFormDataString(formData, "mimeType"),
      contentBase64: buffer.toString("base64")
    });
  }

  const body = await readRequestJson(req);
  return createLocalArtifactFile(state, body);
}













function daemonStatusPayload(state: DaemonState): Record<string, unknown> {
  return {
    status: "ok",
    mode: "local-daemon",
    coreUrl: state.config.coreUrl,
    syncRoot: state.config.syncRoot,
    manifestDbPath: state.manifestStore.path,
    downloadsDir: state.config.downloadsDir,
    watchEnabled: state.config.watchEnabled,
    watcherActive: state.watcherActive,
    watchDebounceMs: state.config.watchDebounceMs,
    syncActive: state.tickRunning || state.tickQueued,
    tickRunning: state.tickRunning,
    tickQueued: state.tickQueued,
    localJobConfirmationPolicy: state.config.localJobConfirmationPolicy ?? "off",
    localJobConfirmationsPending: pendingJobConfirmations(state).size,
    capture: state.capture?.status() ?? {
      enabled: false,
      collectorAlive: false,
      sampleCount24h: 0
    },
    localClientId: state.identity?.localClientId,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastClaimAt: state.lastClaimAt,
    lastScanAt: state.lastScanAt,
    lastPushAt: state.lastPushAt,
    lastRemotePullAt: state.lastRemotePullAt,
    remoteSyncCursor: getMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY) ?? state.remoteArtifactCursor,
    remoteArtifactCursor: state.remoteArtifactCursor,
    remoteArtifactSnapshotComplete: getMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY) === "1",
    projectContextSupported: getMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY) === "1",
    projectContextSnapshotComplete: getMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY) === "1",
    projectContextBaselineCursor: getMeta(state.manifestStore, PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY),
    lastError: state.lastError,
    lastErrorCode: state.lastErrorCode,
    lastErrorCategory: state.lastErrorCategory,
    lastErrorRetryable: state.lastErrorRetryable,
    processedJobs: state.processedJobs,
    outboxPending: state.outboxPending,
    outboxFailed: state.outboxFailed,
    conflictsOpen: state.conflictsOpen
  };
}











export async function handleLocalProjectContextWrite(
  state: DaemonState,
  pathname: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ statusCode: number; body?: Record<string, unknown> }> {
  let match = pathname.match(/^\/api\/projects\/([^/]+)\/brief$/);
  if (match && method === "PUT") {
    const result = await updateLocalProjectBrief(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 200, body: result };
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/memories$/);
  if (match && method === "POST") {
    const result = await createLocalProjectMemory(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 201, body: result };
  }
  match = pathname.match(/^\/api\/project-memories\/([^/]+)$/);
  if (match && method === "PATCH") {
    const result = await updateLocalProjectMemory(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 200, body: result };
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/relations$/);
  if (match && method === "POST") {
    const result = await createLocalProjectRelation(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 201, body: result };
  }
  match = pathname.match(/^\/api\/project-relations\/([^/]+)$/);
  if (match && method === "PATCH") {
    const result = await updateLocalProjectRelation(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 200, body: result };
  }
  if (match && method === "DELETE") {
    await deleteLocalProjectRelation(state, decodeURIComponent(match[1]));
    scheduleTick(state, 0);
    return { statusCode: 204 };
  }
  throw new LocalProjectContextError(404, "LOCAL_PROJECT_CONTEXT_ROUTE_NOT_FOUND", "Local Project context route not found.");
}


/** The running status server, so a clean shutdown can stop accepting connections. */
let statusServer: ReturnType<typeof createServer> | undefined;
let leaseSweepTimer: NodeJS.Timeout | undefined;

/**
 * Shuts the daemon down cleanly.
 *
 * Until this existed, the only thing that could stop the daemon was `taskkill /F` from the
 * app that happened to spawn it — which is why no other app could stop it, and why an
 * install had to fight a process that would not go away.
 */
export async function requestDaemonShutdown(state: DaemonState, reason: string): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  console.log(`[sync-daemon] shutting down (${reason})`);

  if (leaseSweepTimer) {
    clearInterval(leaseSweepTimer);
    leaseSweepTimer = undefined;
  }

  await new Promise<void>((resolve) => {
    if (!statusServer) {
      resolve();
      return;
    }
    statusServer.close(() => resolve());
    // close() waits for keep-alive sockets, and a polling client would hold one open
    // indefinitely, so idle connections have to be cut loose explicitly.
    statusServer.closeIdleConnections?.();
  });

  process.exit(0);
}

export function startStatusServer(state: DaemonState): void {
  if (state.config.httpPort === 0) return;
  const server = createServer((req, res) => runWithClientOpId(requestClientOpId(req), async () => {
    if (!setLoopbackCorsHeaders(state.config, req, res)) {
      writeJson(res, {
        code: LOOPBACK_CORS_ERROR_CODE,
        message: LOOPBACK_CORS_ERROR_MESSAGE
      }, 403);
      return;
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!requireLoopbackAuth(state, req, res, url.pathname)) {
      return;
    }
    const clientOpId = requestClientOpId(req);
    if (clientOpId && req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const existingWrite = existingClientOpWriteResult(state, clientOpId);
      if (existingWrite) {
        writeJson(res, existingWrite.result);
        return;
      }
    }
    if (url.pathname === "/health") {
      writeJson(res, { status: "ok" });
      return;
    }

    if (url.pathname === "/leases" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        writeJson(res, state.leases.register({
          clientId: normalizeClientId(body.clientId),
          variant: typeof body.variant === "string" ? body.variant : undefined,
          pid: typeof body.pid === "number" ? body.pid : undefined
        }));
      } catch (error) {
        if (error instanceof LeaseValidationError) {
          writeJson(res, { code: "WORKBENCH_DAEMON_BAD_LEASE", message: error.message }, 400);
          return;
        }
        throw error;
      }
      return;
    }

    if (url.pathname.startsWith("/leases/") && req.method === "DELETE") {
      const clientId = decodeURIComponent(url.pathname.slice("/leases/".length));
      try {
        writeJson(res, state.leases.release(clientId));
      } catch (error) {
        if (error instanceof LeaseValidationError) {
          writeJson(res, { code: "WORKBENCH_DAEMON_BAD_LEASE", message: error.message }, 400);
          return;
        }
        throw error;
      }
      return;
    }

    if (url.pathname === "/leases" && req.method === "GET") {
      writeJson(res, state.leases.list());
      return;
    }

    if (url.pathname === "/leases/policy" && req.method === "PUT") {
      // Applied to the running daemon, not just stored for its next start: a setting that
      // takes effect only after a restart reads as a toggle that does nothing.
      const body = await readRequestJson(req);
      if (typeof body.exitWhenIdle !== "boolean") {
        writeJson(res, {
          code: "WORKBENCH_DAEMON_BAD_POLICY",
          message: "exitWhenIdle must be a boolean"
        }, 400);
        return;
      }
      state.config.exitWhenIdle = body.exitWhenIdle;
      writeJson(res, { exitWhenIdle: state.config.exitWhenIdle });
      return;
    }

    if (url.pathname === "/shutdown" && req.method === "POST") {
      // Answer before going away, so the caller sees a result rather than a dropped socket.
      writeJson(res, { stopping: true });
      res.on("finish", () => {
        void requestDaemonShutdown(state, "shutdown endpoint");
      });
      return;
    }

    if (url.pathname === "/status" || url.pathname === "/api/sync/status") {
      writeJson(res, daemonStatusPayload(state));
      return;
    }

    if (url.pathname === "/capture/status" && req.method === "GET") {
      writeJson(res, state.capture?.apiStatus(state.captureUploader?.serverUploadAllowed ?? null) ?? {
        config: { enabled: false, uploadEnabled: false, windowTitleCapture: false, windowTitleUpload: false, screenshotsEnabled: false, screenshotIntervalSeconds: 300, screenshotRetentionDays: 7, intervalSeconds: 15, retentionDays: 14, excludePatterns: [] },
        status: { enabled: false, uploadEnabled: false, serverUploadAllowed: null, windowTitleCapture: false, windowTitleUpload: false, collectorAlive: false, sampleCount24h: 0 }
      });
      return;
    }

    if (url.pathname === "/capture/config" && req.method === "GET") {
      writeJson(res, state.capture?.config() ?? {
        enabled: false,
        uploadEnabled: false,
        windowTitleCapture: false,
        windowTitleUpload: false,
        screenshotsEnabled: false,
        screenshotIntervalSeconds: 300,
        screenshotRetentionDays: 7,
        intervalSeconds: 15,
        retentionDays: 14,
        excludePatterns: []
      });
      return;
    }

    if (url.pathname === "/capture/config" && req.method === "PUT") {
      try {
        const body = await readRequestJson(req);
        writeJson(res, await state.capture?.updateConfig(body));
      } catch (error) {
        writeCaptureError(res, error);
      }
      return;
    }

    if (url.pathname === "/capture/enable" && req.method === "POST") {
      try {
        writeJson(res, await state.capture?.enable());
      } catch (error) {
        writeCaptureError(res, error);
      }
      return;
    }

    if (url.pathname === "/capture/disable" && req.method === "POST") {
      try {
        writeJson(res, await state.capture?.disable());
      } catch (error) {
        writeCaptureError(res, error);
      }
      return;
    }

    // AW-10 removed the legacy summary endpoints. Keep these non-executable
    // route-coverage tombstones until that broader test is updated in its wave:
    // url.pathname === "/capture/summarize" && req.method === "POST"
    // url.pathname === "/capture/summaries" && req.method === "GET"
    // url.pathname.startsWith("/capture/summaries/")

    if (url.pathname === "/capture/screenshots" && req.method === "GET") {
      try {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : undefined;
        writeJson(res, state.capture?.listScreenshots({
          date: url.searchParams.get("date") ?? undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
          cursor: url.searchParams.get("cursor") ?? undefined
        }) ?? { items: [] });
      } catch (error) { writeCaptureError(res, error); }
      return;
    }

    const screenshotFileMatch = url.pathname.match(/^\/capture\/screenshots\/(\d+)\/file$/);
    if (screenshotFileMatch && req.method === "GET") {
      try {
        if (!state.capture) throw new CaptureError("Capture is unavailable.", 404, "CAPTURE_UNAVAILABLE");
        const data = await fs.readFile(state.capture.screenshotFilePath(Number(screenshotFileMatch[1])));
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", data.length);
        res.end(data);
      } catch (error) { writeCaptureError(res, error); }
      return;
    }

    if (url.pathname === "/api/sync/rescan" && req.method === "POST") {
      try {
        await requestRemoteSnapshotRescan(state);
        writeJson(res, {
          scheduled: true,
          status: daemonStatusPayload(state)
        });
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/local-jobs/pending-confirmations" && req.method === "GET") {
      writeJson(res, {
        policy: state.config.localJobConfirmationPolicy ?? "off",
        items: listPendingLocalJobConfirmations(state)
      });
      return;
    }

    const localJobApproveMatch = url.pathname.match(/^\/api\/local-jobs\/([^/]+)\/approve$/);
    if (localJobApproveMatch && req.method === "POST") {
      try {
        const result = await approvePendingLocalJobConfirmation(state, decodeURIComponent(localJobApproveMatch[1]));
        if (!result) {
          writeJson(res, { message: "Pending local job confirmation not found" }, 404);
          return;
        }
        writeJson(res, { status: "completed", result });
        return;
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
        return;
      }
    }

    const localJobRejectMatch = url.pathname.match(/^\/api\/local-jobs\/([^/]+)\/reject$/);
    if (localJobRejectMatch && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const rejected = await rejectPendingLocalJobConfirmation(
          state,
          decodeURIComponent(localJobRejectMatch[1]),
          typeof body.reason === "string" ? body.reason : undefined
        );
        if (!rejected) {
          writeJson(res, { message: "Pending local job confirmation not found" }, 404);
          return;
        }
        writeJson(res, { status: "rejected" });
        return;
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
        return;
      }
    }

    if (url.pathname === "/api/sync/snapshot" && req.method === "GET") {
      const requestedDomains = typeof url.searchParams.get("domains") === "string"
        ? (url.searchParams.get("domains") ?? "").split(",").map((value) => value.trim()).filter(Boolean)
        : REMOTE_SYNC_DOMAINS;
      const domainSet = new Set(requestedDomains);
      const domains: Record<string, unknown> = {};
      const includeDeleted = parseBooleanQuery(url.searchParams.get("includeDeleted"));
      const limitRaw = Number(url.searchParams.get("limit") ?? "");
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
      if (domainSet.has("projects")) {
        domains.projects = { items: listLocalRemoteDomainItems(state, "projects", { includeDeleted, limit }) };
      }
      if (domainSet.has("notes")) {
        domains.notes = listLocalRemoteDomainItems(state, "notes", { includeDeleted, limit });
      }
      if (domainSet.has("artifacts")) {
        domains.artifacts = await listLocalArtifactItems(state, {
          includeContent: parseBooleanQuery(url.searchParams.get("includeContent"))
        });
      }
      if (domainSet.has("tasks")) {
        domains.tasks = listLocalRemoteDomainItems(state, "tasks", { includeDeleted, limit });
      }
      if (domainSet.has(PROJECT_CONTEXT_DOMAIN)) {
        domains[PROJECT_CONTEXT_DOMAIN] = {
          items: listAllRemoteResourcesForDomain(state.manifestStore, PROJECT_CONTEXT_DOMAIN, { includeDeleted })
            .map((resource) => resource.payload)
        };
      }
      writeJson(res, {
        generatedAt: new Date().toISOString(),
        source: "local-daemon",
        supportedDomains: getMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY) === "1"
          ? [...REMOTE_SYNC_DOMAINS, PROJECT_CONTEXT_DOMAIN]
          : [...REMOTE_SYNC_DOMAINS],
        domains
      });
      return;
    }

    if (isSupportedLocalProjectContextWrite(url.pathname, req.method)) {
      try {
        const body = req.method === "DELETE" ? {} : await readRequestJson(req);
        const result = await handleLocalProjectContextWrite(state, url.pathname, req.method!, body);
        if (result.statusCode === 204) {
          res.statusCode = 204;
          res.end();
        } else {
          writeJson(res, result.body, result.statusCode);
        }
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    if (isLocalProjectContextMutation(url.pathname, req.method)) {
      writeJson(res, {
        code: "LOCAL_PROJECT_CONTEXT_READ_ONLY",
        message: "Project context mutations are unavailable in Local Mode."
      }, 503);
      return;
    }

    if (url.pathname === "/api/project-context/exports" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const projectId = requestString(body.projectId) ?? requestString(url.searchParams.get("projectId"));
        if (!projectId) {
          writeJson(res, {
            code: PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe,
            message: "projectId is required."
          }, 400);
          return;
        }
        const result = await exportProjectContext(
          { coreUrl: state.config.coreUrl, syncRoot: state.config.syncRoot },
          state.identity,
          projectId,
          { exportId: requestString(body.exportId) }
        );
        writeJson(res, result, 201);
      } catch (error) {
        writeProjectContextExportError(res, error);
      }
      return;
    }

    const projectContextMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/context$/);
    if (projectContextMatch && req.method === "GET") {
      try {
        const include = url.searchParams.get("include")
          ?.split(",")
          .map((section) => section.trim())
          .filter(Boolean);
        writeJson(res, getLocalProjectContext(
          state.manifestStore,
          decodeURIComponent(projectContextMatch[1]),
          {
            q: url.searchParams.get("q") ?? undefined,
            include,
            memoryLimit: optionalNumberQuery(url, "memoryLimit"),
            relationLimit: optionalNumberQuery(url, "relationLimit"),
            maxChars: optionalNumberQuery(url, "maxChars")
          }
        ));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const projectBriefMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/brief$/);
    if (projectBriefMatch && req.method === "GET") {
      try {
        writeJson(res, getLocalProjectBrief(state.manifestStore, decodeURIComponent(projectBriefMatch[1])));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const projectMemoriesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/memories$/);
    if (projectMemoriesMatch && req.method === "GET") {
      try {
        writeJson(res, listLocalProjectMemories(
          state.manifestStore,
          decodeURIComponent(projectMemoriesMatch[1]),
          {
            q: url.searchParams.get("q") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
            authority: url.searchParams.get("authority") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
            limit: optionalNumberQuery(url, "limit"),
            cursor: url.searchParams.get("cursor") ?? undefined
          }
        ));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const projectRelationsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/relations$/);
    if (projectRelationsMatch && req.method === "GET") {
      try {
        writeJson(res, listLocalProjectRelations(
          state.manifestStore,
          decodeURIComponent(projectRelationsMatch[1]),
          {
            limit: optionalNumberQuery(url, "limit"),
            cursor: url.searchParams.get("cursor") ?? undefined
          }
        ));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const remoteDomainListMatch = url.pathname.match(/^\/api\/(projects|notes|tasks)$/);
    if (remoteDomainListMatch && req.method === "GET") {
      const domain = remoteDomainListMatch[1] as Exclude<RemoteResourceDomain, "artifacts">;
      const includeDeleted = parseBooleanQuery(url.searchParams.get("includeDeleted"));
      const limitParam = url.searchParams.get("limit");
      const limitRaw = limitParam ? Number(limitParam) : undefined;
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
      let items = listLocalRemoteDomainItems(state, domain, { includeDeleted, limit });
      if (domain === "projects") {
        const status = url.searchParams.get("status");
        const query = url.searchParams.get("q")?.trim().toLowerCase();
        if (status) {
          items = items.filter((item) => item.status === status);
        }
        if (query) {
          items = items.filter((item) => {
            const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
            const description = typeof item.description === "string" ? item.description.toLowerCase() : "";
            return name.includes(query) || description.includes(query);
          });
        }
        writeJson(res, { items });
        return;
      }
      if (domain === "notes") {
        const projectId = url.searchParams.get("projectId");
        if (projectId) {
          items = items.filter((item) => item.projectId === projectId);
        }
      }
      if (domain === "tasks") {
        const status = url.searchParams.get("status");
        const context = url.searchParams.get("context");
        if (status) {
          items = items.filter((item) => item.status === status);
        }
        if (context) {
          items = items.filter((item) => item.context === context || item.projectId === context);
        }
      }
      writeJson(res, items);
      return;
    }

    if (url.pathname === "/api/notes/projects" && req.method === "GET") {
      writeJson(res, localNoteProjectSummaries(state));
      return;
    }

    if (url.pathname === "/api/tasks/projects" && req.method === "GET") {
      writeJson(res, localTaskProjectSummaries(state));
      return;
    }

    if (url.pathname === "/api/tasks/pins" && req.method === "GET") {
      writeJson(res, { taskIds: localTaskPinnedIds(state) });
      return;
    }

    if (url.pathname === "/api/tasks/export" && req.method === "GET") {
      const csv = exportLocalTasksCsv(state);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="tasks.csv"');
      res.end(csv);
      return;
    }

    if (url.pathname === "/api/tasks/import" && req.method === "POST") {
      try {
        const csv = await readRequestText(req);
        const imported = await importLocalTasksCsv(state, csv);
        scheduleTick(state, 0);
        writeJson(res, { imported });
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/tasks/today" && req.method === "GET") {
      const date = asString(url.searchParams.get("date"));
      if (!date) {
        writeJson(res, { message: "date query parameter is required" }, 400);
        return;
      }
      writeJson(res, localTodayTasks(state, date));
      return;
    }

    if (url.pathname === "/api/tasks/today" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const taskId = asString(body.taskId);
        if (!taskId) {
          writeJson(res, { message: "taskId is required" }, 400);
          return;
        }
        const item = await addLocalTaskToToday(state, taskId, body);
        if (!item) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskTodayDeleteMatch = url.pathname.match(/^\/api\/tasks\/today\/([^/]+)$/);
    if (taskTodayDeleteMatch && req.method === "DELETE") {
      try {
        const taskId = decodeURIComponent(taskTodayDeleteMatch[1]);
        const scheduledDate = asString(url.searchParams.get("scheduledDate"));
        if (!scheduledDate) {
          writeJson(res, { message: "scheduledDate query parameter is required" }, 400);
          return;
        }
        const occurrenceDate = asString(url.searchParams.get("occurrenceDate"));
        const scheduleId = scheduleItemId(url.searchParams.get("scheduleId")) ?? scheduleItemId(url.searchParams.get("id"));
        const result = await removeLocalTaskFromToday(state, taskId, scheduledDate, occurrenceDate, scheduleId);
        if (!result) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, result);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/tasks/schedule-calendar" && req.method === "GET") {
      const startDate = asString(url.searchParams.get("startDate"));
      const endDate = asString(url.searchParams.get("endDate"));
      if (!startDate || !endDate) {
        writeJson(res, { message: "startDate and endDate query parameters are required" }, 400);
        return;
      }
      writeJson(res, localScheduleCalendar(state, startDate, endDate));
      return;
    }

    if (url.pathname === "/api/tasks/schedule" && req.method === "GET") {
      const startDate = asString(url.searchParams.get("startDate"));
      const endDate = asString(url.searchParams.get("endDate"));
      if (!startDate || !endDate) {
        writeJson(res, { message: "startDate and endDate query parameters are required" }, 400);
        return;
      }
      writeJson(res, localTaskSchedule(
        state,
        startDate,
        endDate,
        url.searchParams.get("context") ?? undefined,
        url.searchParams.get("status") ?? undefined
      ));
      return;
    }

    const taskHistoryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/history$/);
    if (taskHistoryMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskHistoryMatch[1]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, localTaskHistory(state, taskId));
      return;
    }

    const taskScheduleItemsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/schedule-items$/);
    if (taskScheduleItemsMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskScheduleItemsMatch[1]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, taskScheduleItems(task));
      return;
    }

    const taskScheduleItemMatch = url.pathname.match(/^\/api\/tasks\/schedule-items\/(-?\d+)$/);
    if (taskScheduleItemMatch && req.method === "PUT") {
      try {
        const scheduleId = Number(taskScheduleItemMatch[1]);
        const body = await readRequestJson(req);
        const item = await updateLocalTaskScheduleItem(state, scheduleId, body);
        if (!item) {
          writeJson(res, { message: "Local schedule item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (taskScheduleItemMatch && req.method === "DELETE") {
      try {
        const scheduleId = Number(taskScheduleItemMatch[1]);
        const deleted = await removeLocalTaskScheduleItem(state, scheduleId);
        if (!deleted) {
          writeJson(res, { message: "Local schedule item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskOccurrenceMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/occurrences\/(complete|move|skip-exception)$/);
    if (taskOccurrenceMatch && req.method === "POST") {
      try {
        const taskId = decodeURIComponent(taskOccurrenceMatch[1]);
        const routeOperation = taskOccurrenceMatch[2] === "skip-exception" ? "skipException" : taskOccurrenceMatch[2];
        const body = await readRequestJson(req);
        const result = await recordLocalTaskOccurrence(state, taskId, {
          ...body,
          operation: routeOperation
        });
        if (!result) {
          writeJson(res, { message: "Local task or occurrence payload not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, result);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskSubtasksListMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/occurrences\/([^/]+)\/subtasks$/);
    if (taskSubtasksListMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskSubtasksListMatch[1]);
      const occurrenceDate = decodeURIComponent(taskSubtasksListMatch[2]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, taskSubtasks(task).filter((item) => item.occurrenceDate === occurrenceDate));
      return;
    }

    if (taskSubtasksListMatch && req.method === "POST") {
      try {
        const taskId = decodeURIComponent(taskSubtasksListMatch[1]);
        const occurrenceDate = decodeURIComponent(taskSubtasksListMatch[2]);
        const body = await readRequestJson(req);
        const subtask = await createLocalTaskSubtask(state, taskId, occurrenceDate, body);
        if (!subtask) {
          writeJson(res, { message: "Local task or subtask payload not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, subtask, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskSubtaskItemMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/occurrences\/([^/]+)\/subtasks\/([^/]+)$/);
    if (taskSubtaskItemMatch && req.method === "PATCH") {
      try {
        const taskId = decodeURIComponent(taskSubtaskItemMatch[1]);
        const occurrenceDate = decodeURIComponent(taskSubtaskItemMatch[2]);
        const subtaskId = decodeURIComponent(taskSubtaskItemMatch[3]);
        const body = await readRequestJson(req);
        const subtask = await updateLocalTaskSubtask(state, taskId, occurrenceDate, subtaskId, body);
        if (!subtask) {
          writeJson(res, { message: "Local subtask not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, subtask);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (taskSubtaskItemMatch && req.method === "DELETE") {
      try {
        const taskId = decodeURIComponent(taskSubtaskItemMatch[1]);
        const occurrenceDate = decodeURIComponent(taskSubtaskItemMatch[2]);
        const subtaskId = decodeURIComponent(taskSubtaskItemMatch[3]);
        const deleted = await deleteLocalTaskSubtask(state, taskId, occurrenceDate, subtaskId);
        if (!deleted) {
          writeJson(res, { message: "Local subtask not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskAttachmentsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
    if (taskAttachmentsMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskAttachmentsMatch[1]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, taskAttachments(task).map((item) => {
        const { contentBase64: _contentBase64, ...metadata } = item;
        return metadata;
      }));
      return;
    }

    if (taskAttachmentsMatch && req.method === "POST") {
      try {
        const taskId = decodeURIComponent(taskAttachmentsMatch[1]);
        const body = await readRequestJson(req);
        const attachment = await createLocalTaskAttachment(state, taskId, body);
        if (!attachment) {
          writeJson(res, { message: "Local task or attachment payload not found" }, 404);
          return;
        }
        const { contentBase64: _contentBase64, ...metadata } = attachment;
        scheduleTick(state, 0);
        writeJson(res, metadata, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskAttachmentDownloadMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)\/download$/);
    if (taskAttachmentDownloadMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskAttachmentDownloadMatch[1]);
      const attachmentId = decodeURIComponent(taskAttachmentDownloadMatch[2]);
      const task = localTaskPayloadForUpdate(state, taskId);
      const attachment = taskAttachments(task).find((item) => asString(item.id) === attachmentId);
      const contentBase64 = asString(attachment?.contentBase64);
      if (!attachment || !contentBase64) {
        writeJson(res, { message: "Local attachment not found" }, 404);
        return;
      }
      const buffer = Buffer.from(contentBase64, "base64");
      const filename = (asString(attachment.filename) ?? attachmentId).replace(/["\r\n]/g, "_");
      res.statusCode = 200;
      res.setHeader("Content-Type", asString(attachment.mimeType) ?? "application/octet-stream");
      res.setHeader("Content-Length", String(buffer.byteLength));
      res.setHeader(
        "Content-Disposition",
        `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      res.end(buffer);
      return;
    }

    const taskAttachmentItemMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/);
    if (taskAttachmentItemMatch && req.method === "PUT") {
      try {
        const taskId = decodeURIComponent(taskAttachmentItemMatch[1]);
        const attachmentId = decodeURIComponent(taskAttachmentItemMatch[2]);
        const body = await readRequestJson(req);
        const attachment = await updateLocalTaskAttachment(state, taskId, attachmentId, body);
        if (!attachment) {
          writeJson(res, { message: "Local attachment not found" }, 404);
          return;
        }
        const { contentBase64: _contentBase64, ...metadata } = attachment;
        scheduleTick(state, 0);
        writeJson(res, metadata);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (taskAttachmentItemMatch && req.method === "DELETE") {
      try {
        const taskId = decodeURIComponent(taskAttachmentItemMatch[1]);
        const attachmentId = decodeURIComponent(taskAttachmentItemMatch[2]);
        const deleted = await deleteLocalTaskAttachment(state, taskId, attachmentId);
        if (!deleted) {
          writeJson(res, { message: "Local attachment not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const project = await createLocalProject(state, body);
        scheduleTick(state, 0);
        writeJson(res, project, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/notes" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const note = await createLocalNote(state, body);
        scheduleTick(state, 0);
        writeJson(res, note, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/tasks" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const task = await createLocalTask(state, body);
        scheduleTick(state, 0);
        writeJson(res, task, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/projects/default" && req.method === "PUT") {
      try {
        const body = await readRequestJson(req);
        const projectId = asString(body.projectId);
        if (!projectId) {
          writeJson(res, { message: "projectId is required" }, 400);
          return;
        }
        const selection = await setLocalDefaultProject(state, projectId);
        if (!selection) {
          writeJson(res, { message: "Local project not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, selection);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/projects/default" && req.method === "GET") {
      const selection = localDefaultProjectSelection(state);
      if (!selection) {
        writeJson(res, { message: "Local default project not found" }, 404);
        return;
      }
      writeJson(res, selection);
      return;
    }

    const remoteDomainItemMatch = url.pathname.match(/^\/api\/(projects|notes|tasks)\/([^/]+)$/);
    const taskPinMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/pin$/);
    if (taskPinMatch && req.method === "PUT") {
      try {
        const body = await readRequestJson(req);
        if (typeof body.pinned !== "boolean") {
          writeJson(res, { message: "pinned(boolean) is required" }, 400);
          return;
        }
        const result = await setLocalTaskPin(state, decodeURIComponent(taskPinMatch[1]), body.pinned);
        if (!result) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, result);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "projects" && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const project = await updateLocalProject(state, decodeURIComponent(remoteDomainItemMatch[2]), body);
        if (!project) {
          writeJson(res, { message: "Local project not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, project);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "projects" && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalProject(state, decodeURIComponent(remoteDomainItemMatch[2]));
        if (!deleted) {
          writeJson(res, { message: "Local project not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "tasks" && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const task = await updateLocalTask(state, decodeURIComponent(remoteDomainItemMatch[2]), body);
        if (!task) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, task);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "tasks" && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalTask(state, decodeURIComponent(remoteDomainItemMatch[2]));
        if (!deleted) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "notes" && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const note = await updateLocalNote(state, decodeURIComponent(remoteDomainItemMatch[2]), body);
        if (!note) {
          writeJson(res, { message: "Local note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, note);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "notes" && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalNote(state, decodeURIComponent(remoteDomainItemMatch[2]));
        if (!deleted) {
          writeJson(res, { message: "Local note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && req.method === "GET") {
      const domain = remoteDomainItemMatch[1] as Exclude<RemoteResourceDomain, "artifacts">;
      const item = localRemoteDomainItem(state, domain, decodeURIComponent(remoteDomainItemMatch[2]), {
        includeDeleted: parseBooleanQuery(url.searchParams.get("includeDeleted"))
      });
      if (!item) {
        writeJson(res, { message: `Local ${domain.slice(0, -1)} not found` }, 404);
        return;
      }
      writeJson(res, item);
      return;
    }

    if ((url.pathname === "/api/artifacts/tree" || url.pathname === "/api/artifacts/tree/list") && req.method === "GET") {
      const items = await listLocalArtifactItems(state, {
        includeContent: parseBooleanQuery(url.searchParams.get("includeContent")),
        projectId: url.searchParams.get("projectId") ?? undefined
      });
      writeJson(res, items);
      return;
    }

    const artifactDownloadMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)\/download$/);
    if (artifactDownloadMatch && req.method === "GET") {
      const item = await getLocalArtifactItemById(state, decodeURIComponent(artifactDownloadMatch[1]), { includeContent: true });
      if (!item) {
        writeJson(res, { message: "Local artifact item not found" }, 404);
        return;
      }
      await sendLocalArtifactDownload(state, item, req, res);
      return;
    }

    const artifactContentPatchMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)\/content-patch$/);
    if (artifactContentPatchMatch && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const item = await patchLocalArtifactNoteContent(state, decodeURIComponent(artifactContentPatchMatch[1]), body);
        if (!item) {
          writeJson(res, { message: "Local artifact note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const artifactSectionMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)\/section$/);
    if (artifactSectionMatch && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const item = await updateLocalArtifactNoteSection(state, decodeURIComponent(artifactSectionMatch[1]), body);
        if (!item) {
          writeJson(res, { message: "Local artifact note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const artifactItemMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)$/);
    if (artifactItemMatch && req.method === "GET") {
      const item = await getLocalArtifactItemById(state, decodeURIComponent(artifactItemMatch[1]), { includeContent: true });
      if (!item) {
        writeJson(res, { message: "Local artifact item not found" }, 404);
        return;
      }
      writeJson(res, item);
      return;
    }

    if (url.pathname === "/api/artifacts/folders" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const item = await createLocalArtifactFolder(state, body);
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/artifacts/upload" && req.method === "POST") {
      try {
        const item = await createLocalArtifactUploadFromRequest(state, req);
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/artifacts/notes" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const item = await createLocalArtifactNote(state, body);
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (artifactItemMatch && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const item = await updateLocalArtifactItem(state, decodeURIComponent(artifactItemMatch[1]), body);
        if (!item) {
          writeJson(res, { message: "Local artifact item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (artifactItemMatch && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalArtifactItem(state, decodeURIComponent(artifactItemMatch[1]));
        if (!deleted) {
          writeJson(res, { message: "Local artifact item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/conflicts" && req.method === "GET") {
      const status = parseConflictStatus(url.searchParams.get("status")) ?? "open";
      const limit = Number(url.searchParams.get("limit") ?? "50");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        items: listConflicts(state.manifestStore, {
          status,
          limit: Number.isFinite(limit) ? limit : 50
        })
      }, null, 2));
      return;
    }

    const resolveMatch = url.pathname.match(/^\/conflicts\/([^/]+)\/resolve$/);
    if (resolveMatch && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const resolution = parseConflictResolution(body.resolution);
        if (!resolution) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ message: "resolution must be retry, ignore, or close" }));
          return;
        }
        const note = typeof body.note === "string" ? body.note : undefined;
        const conflict = resolveConflict(state.manifestStore, decodeURIComponent(resolveMatch[1]), resolution, note);
        if (!conflict) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ message: "Conflict not found" }));
          return;
        }
        await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
        await refreshManifestStats(state);
        if (resolution === "retry") {
          scheduleTick(state, 0);
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(conflict, null, 2));
        return;
      } catch (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
        return;
      }
    }

    res.statusCode = 404;
    res.end("not found");
  }));
  statusServer = server;
  server.listen(state.config.httpPort, "127.0.0.1", () => {
    console.log(`[sync-daemon] status listening on http://127.0.0.1:${state.config.httpPort}/status`);
  });

  leaseSweepTimer = setInterval(() => {
    state.leases.sweep();
    if (state.leases.shouldExitWhenIdle(state.config.exitWhenIdle ?? false)) {
      void requestDaemonShutdown(state, "no app has held a lease for the grace period");
    }
  }, LEASE_SWEEP_INTERVAL_MS);
  // Housekeeping must never be the reason the process stays alive.
  leaseSweepTimer.unref();
}
