import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { after, describe, it, type TestContext } from "node:test";
import type { Pool } from "pg";

type DbModule = typeof import("../db.js");
type HttpServerModule = typeof import("../httpServer.js");
type AuthModule = typeof import("../auth.js");
type SyncStoreModule = typeof import("../syncStore.js");
type TestHarness = {
  db: DbModule;
  httpServer: HttpServerModule;
  auth: AuthModule;
  syncStore: SyncStoreModule;
};

type JsonResponse = {
  status: number;
  body: Record<string, unknown>;
  text: string;
};

const CORE_ENV_URL = new URL("../../.env", import.meta.url);

let harnessPromise: Promise<TestHarness | { skipMessage: string }> | undefined;

function parseEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }
  return values;
}

async function readDbEndpoint(): Promise<{ host: string; port: number } | undefined> {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(await readFile(CORE_ENV_URL, "utf8"));
  } catch {
    fileEnv = {};
  }
  const host = process.env.CORE_DB_HOST ?? fileEnv.CORE_DB_HOST;
  const portRaw = process.env.CORE_DB_PORT ?? fileEnv.CORE_DB_PORT;
  const port = Number(portRaw);
  if (!host || !Number.isFinite(port)) {
    return undefined;
  }
  return { host, port };
}

async function canReachTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function loadHarness(): Promise<TestHarness | { skipMessage: string }> {
  if (!harnessPromise) {
    harnessPromise = (async () => {
      const endpoint = await readDbEndpoint();
      if (!endpoint) {
        return { skipMessage: "Core DB env is not configured." };
      }
      if (!(await canReachTcp(endpoint.host, endpoint.port))) {
        return { skipMessage: `Core DB is not reachable at ${endpoint.host}:${endpoint.port}.` };
      }

      try {
        const [db, httpServer, auth, syncStore] = await Promise.all([
          import("../db.js"),
          import("../httpServer.js"),
          import("../auth.js"),
          import("../syncStore.js")
        ]);
        await db.ensureCoreSchema();
        return { db, httpServer, auth, syncStore };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { skipMessage: `Core HTTP harness is unavailable: ${message}` };
      }
    })();
  }
  return harnessPromise;
}

async function requireHarness(t: TestContext): Promise<TestHarness | undefined> {
  const loaded = await loadHarness();
  if ("skipMessage" in loaded) {
    t.skip(loaded.skipMessage);
    return undefined;
  }
  return loaded;
}

async function startTestServer(harness: TestHarness): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = harness.httpServer.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        (server as Server).close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function createTestUser(pool: Pool, label: string): Promise<{ userId: string; username: string }> {
  const userId = `test-local-http-${label}-${randomUUID()}`;
  const username = `${userId}@example.test`;
  await pool.query(
    `
      INSERT INTO workbench_users (id, username, password_hash)
      VALUES ($1, $2, $3)
    `,
    [userId, username, "test-password-hash"]
  );
  return { userId, username };
}

async function cleanupTestUser(pool: Pool, userId: string): Promise<void> {
  await pool.query("DELETE FROM workbench_users WHERE id = $1", [userId]);
}

function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function localClientHeaders(localClientId: string, clientToken: string): Record<string, string> {
  return {
    "x-workbench-local-client-id": localClientId,
    "x-workbench-local-client-token": clientToken
  };
}

async function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    body = JSON.parse(text) as Record<string, unknown>;
  }
  return { status: response.status, body, text };
}

after(async () => {
  const loaded = await harnessPromise;
  if (loaded && !("skipMessage" in loaded)) {
    await loaded.db.getCorePool().end();
  }
});

describe("local client HTTP APIs", () => {
  it("handles local client registration, heartbeat, jobs, revoke, and delete through HTTP", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "jobs");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = await startTestServer(harness);
    try {
      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-http-a",
          clientName: "HTTP Laptop",
          platform: "win32",
          capabilities: { downloads: true },
          syncRootId: "main",
          syncRootLabel: "Workbench Main",
          default: true
        }
      });
      assert.equal(registerResponse.status, 201);
      const registeredClient = registerResponse.body.client as Record<string, unknown>;
      const localClientId = String(registeredClient.id);
      const clientToken = String(registerResponse.body.clientToken);
      assert.match(clientToken, /^wblc_/);
      assert.equal(registeredClient.default, true);

      const heartbeatResponse = await requestJson(
        server.baseUrl,
        "POST",
        `/api/local-clients/${encodeURIComponent(localClientId)}/heartbeat`,
        {
          headers: localClientHeaders(localClientId, clientToken),
          body: { daemonVersion: "0.1.0-http-test", syncRootState: { pending: 0 } }
        }
      );
      assert.equal(heartbeatResponse.status, 200);
      const heartbeat = heartbeatResponse.body.heartbeat as Record<string, unknown>;
      assert.equal(heartbeat.daemonVersion, "0.1.0-http-test");
      assert.equal(heartbeat.online, true);

      const listClientsResponse = await requestJson(server.baseUrl, "GET", "/api/local-clients", {
        headers: bearerHeaders(accessToken)
      });
      assert.equal(listClientsResponse.status, 200);
      const clients = listClientsResponse.body.items as Array<Record<string, unknown>>;
      assert.equal(clients.length, 1);
      assert.equal(clients[0].id, localClientId);

      const patchResponse = await requestJson(
        server.baseUrl,
        "PATCH",
        `/api/local-clients/${encodeURIComponent(localClientId)}`,
        {
          headers: bearerHeaders(accessToken),
          body: { clientName: "HTTP Laptop Updated", capabilities: { downloads: true, sync: true } }
        }
      );
      assert.equal(patchResponse.status, 200);
      assert.equal(patchResponse.body.clientName, "HTTP Laptop Updated");

      const createJobResponse = await requestJson(server.baseUrl, "POST", "/api/local-jobs", {
        headers: bearerHeaders(accessToken),
        body: {
          localClientId,
          idempotencyKey: "http-download-report",
          kind: "download_artifact",
          target: "downloads",
          payload: { blobId: "artifact:test-download", filename: "report.md" }
        }
      });
      assert.equal(createJobResponse.status, 201);
      const jobId = String(createJobResponse.body.id);
      assert.equal(createJobResponse.body.status, "pending");
      assert.equal(createJobResponse.body.idempotencyKey, "http-download-report");

      const duplicateCreateJobResponse = await requestJson(server.baseUrl, "POST", "/api/local-jobs", {
        headers: bearerHeaders(accessToken),
        body: {
          localClientId,
          idempotencyKey: "http-download-report",
          kind: "download_artifact",
          target: "downloads",
          payload: { blobId: "artifact:duplicate", filename: "duplicate.md" }
        }
      });
      assert.equal(duplicateCreateJobResponse.status, 201);
      assert.equal(duplicateCreateJobResponse.body.id, jobId);
      assert.deepEqual(duplicateCreateJobResponse.body.payload, {
        blobId: "artifact:test-download",
        filename: "report.md"
      });

      const claimResponse = await requestJson(server.baseUrl, "POST", "/api/local-jobs/claim", {
        headers: localClientHeaders(localClientId, clientToken),
        body: { limit: 5 }
      });
      assert.equal(claimResponse.status, 200);
      const claimed = claimResponse.body.items as Array<Record<string, unknown>>;
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].id, jobId);
      assert.equal(claimed[0].status, "running");

      const runningListResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-jobs?status=running&localClientId=${encodeURIComponent(localClientId)}`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(runningListResponse.status, 200);
      const runningJobs = runningListResponse.body.items as Array<Record<string, unknown>>;
      assert.equal(runningJobs.length, 1);
      assert.equal(runningJobs[0].id, jobId);

      const completeResponse = await requestJson(
        server.baseUrl,
        "POST",
        `/api/local-jobs/${encodeURIComponent(jobId)}/complete`,
        {
          headers: localClientHeaders(localClientId, clientToken),
          body: { result: { localPath: "C:/Downloads/report.md", checksum: "sha256:abc", sizeBytes: 12 } }
        }
      );
      assert.equal(completeResponse.status, 200);
      assert.equal(completeResponse.body.status, "completed");
      const daemonCompleteResult = completeResponse.body.result as Record<string, unknown>;
      assert.equal(daemonCompleteResult.localPath, "C:/Downloads/report.md");

      const redactedDetailResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-jobs/${encodeURIComponent(jobId)}`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(redactedDetailResponse.status, 200);
      const redactedDetailResult = redactedDetailResponse.body.result as Record<string, unknown>;
      assert.equal(redactedDetailResult.localPath, undefined);
      assert.equal(redactedDetailResult.localPathAvailable, true);
      assert.equal(redactedDetailResult.localPathRedacted, true);
      assert.equal(redactedDetailResult.checksum, "sha256:abc");

      const fullDetailResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-jobs/${encodeURIComponent(jobId)}?includeLocalPaths=true`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(fullDetailResponse.status, 200);
      const fullDetailResult = fullDetailResponse.body.result as Record<string, unknown>;
      assert.equal(fullDetailResult.localPath, "C:/Downloads/report.md");

      const redactedListResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-jobs?status=completed&localClientId=${encodeURIComponent(localClientId)}`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(redactedListResponse.status, 200);
      const redactedListJobs = redactedListResponse.body.items as Array<Record<string, unknown>>;
      assert.equal(redactedListJobs.length, 1);
      const redactedListResult = redactedListJobs[0].result as Record<string, unknown>;
      assert.equal(redactedListResult.localPath, undefined);
      assert.equal(redactedListResult.localPathAvailable, true);

      const fullListResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-jobs?status=completed&localClientId=${encodeURIComponent(localClientId)}&includeLocalPaths=true`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(fullListResponse.status, 200);
      const fullListJobs = fullListResponse.body.items as Array<Record<string, unknown>>;
      assert.equal(fullListJobs.length, 1);
      const fullListResult = fullListJobs[0].result as Record<string, unknown>;
      assert.equal(fullListResult.localPath, "C:/Downloads/report.md");

      const eventsResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-jobs/${encodeURIComponent(jobId)}/events`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(eventsResponse.status, 200);
      const jobEvents = eventsResponse.body.items as Array<Record<string, unknown>>;
      assert.deepEqual(jobEvents.map((event) => event.eventType), ["created", "claimed", "completed"]);

      const retryCreateResponse = await requestJson(server.baseUrl, "POST", "/api/local-jobs", {
        headers: bearerHeaders(accessToken),
        body: {
          localClientId,
          kind: "materialize_resource",
          target: "sync-folder",
          payload: { resourceId: "notes:http-retry" }
        }
      });
      assert.equal(retryCreateResponse.status, 201);
      const retryJobId = String(retryCreateResponse.body.id);

      const retryClaimResponse = await requestJson(server.baseUrl, "POST", "/api/local-jobs/claim", {
        headers: localClientHeaders(localClientId, clientToken),
        body: { limit: 1 }
      });
      assert.equal(retryClaimResponse.status, 200);
      const retryClaimed = retryClaimResponse.body.items as Array<Record<string, unknown>>;
      assert.equal(retryClaimed.length, 1);
      assert.equal(retryClaimed[0].id, retryJobId);

      const retryFailResponse = await requestJson(
        server.baseUrl,
        "POST",
        `/api/local-jobs/${encodeURIComponent(retryJobId)}/fail`,
        {
          headers: localClientHeaders(localClientId, clientToken),
          body: { error: "temporary unavailable", retryable: true, retryAfterSeconds: 3600 }
        }
      );
      assert.equal(retryFailResponse.status, 200);
      assert.equal(retryFailResponse.body.status, "pending");
      assert.equal(typeof retryFailResponse.body.nextAttemptAt, "string");

      const retryTooEarlyClaimResponse = await requestJson(server.baseUrl, "POST", "/api/local-jobs/claim", {
        headers: localClientHeaders(localClientId, clientToken),
        body: { limit: 1 }
      });
      assert.equal(retryTooEarlyClaimResponse.status, 200);
      assert.deepEqual(retryTooEarlyClaimResponse.body.items, []);

      const revokeResponse = await requestJson(
        server.baseUrl,
        "POST",
        `/api/local-clients/${encodeURIComponent(localClientId)}/revoke`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(revokeResponse.status, 200);
      assert.equal(revokeResponse.body.revoked, true);
      const revokedClient = revokeResponse.body.client as Record<string, unknown>;
      assert.equal(revokedClient.enabled, false);

      const unauthorizedClaimResponse = await requestJson(server.baseUrl, "POST", "/api/local-jobs/claim", {
        headers: localClientHeaders(localClientId, clientToken),
        body: { limit: 1 }
      });
      assert.equal(unauthorizedClaimResponse.status, 401);
      assert.equal(unauthorizedClaimResponse.body.code, "INVALID_LOCAL_CLIENT_TOKEN");

      const deleteResponse = await requestJson(
        server.baseUrl,
        "DELETE",
        `/api/local-clients/${encodeURIComponent(localClientId)}`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(deleteResponse.status, 204);
      assert.equal(deleteResponse.text, "");
    } finally {
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });

  it("archives local clients through owner API and hides them from default lists", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "archive");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = await startTestServer(harness);
    try {
      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-http-archive",
          clientName: "Archive HTTP Laptop",
          platform: "win32",
          syncRootId: "main",
          syncRootLabel: "Workbench Main",
          default: true
        }
      });
      assert.equal(registerResponse.status, 201);
      const registeredClient = registerResponse.body.client as Record<string, unknown>;
      const localClientId = String(registeredClient.id);
      const clientToken = String(registerResponse.body.clientToken);

      const archiveResponse = await requestJson(
        server.baseUrl,
        "POST",
        `/api/local-clients/${encodeURIComponent(localClientId)}/archive`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(archiveResponse.status, 200);
      assert.equal(archiveResponse.body.id, localClientId);
      assert.equal(archiveResponse.body.enabled, false);
      assert.equal(archiveResponse.body.default, false);
      assert.equal(typeof archiveResponse.body.archivedAt, "string");

      const defaultListResponse = await requestJson(server.baseUrl, "GET", "/api/local-clients", {
        headers: bearerHeaders(accessToken)
      });
      assert.equal(defaultListResponse.status, 200);
      assert.deepEqual(defaultListResponse.body.items, []);

      const archivedListResponse = await requestJson(server.baseUrl, "GET", "/api/local-clients?includeArchived=true", {
        headers: bearerHeaders(accessToken)
      });
      assert.equal(archivedListResponse.status, 200);
      const archivedClients = archivedListResponse.body.items as Array<Record<string, unknown>>;
      assert.equal(archivedClients.length, 1);
      assert.equal(archivedClients[0].id, localClientId);
      assert.equal(archivedClients[0].archivedAt, archiveResponse.body.archivedAt);

      const archivedHeartbeatResponse = await requestJson(
        server.baseUrl,
        "POST",
        `/api/local-clients/${encodeURIComponent(localClientId)}/heartbeat`,
        {
          headers: localClientHeaders(localClientId, clientToken),
          body: { daemonVersion: "0.1.0-http-test", syncRootState: {} }
        }
      );
      assert.equal(archivedHeartbeatResponse.status, 401);
      assert.equal(archivedHeartbeatResponse.body.code, "INVALID_LOCAL_CLIENT_TOKEN");

      const auditResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-clients/audit-events?localClientId=${encodeURIComponent(localClientId)}&limit=10`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(auditResponse.status, 200);
      const auditEvents = auditResponse.body.items as Array<Record<string, unknown>>;
      const archivedEvent = auditEvents.find((event) => event.eventType === "archived");
      assert.ok(archivedEvent);
      assert.equal((archivedEvent.detail as Record<string, unknown>).revokedTokens, 1);
    } finally {
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });

  it("allows daemon-authenticated sync reads and rejects unauthenticated sync access", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "sync");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = await startTestServer(harness);
    try {
      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-sync-a",
          clientName: "Sync Daemon",
          platform: "linux",
          syncRootId: "main",
          syncRootLabel: "Workbench Sync"
        }
      });
      assert.equal(registerResponse.status, 201);
      const registeredClient = registerResponse.body.client as Record<string, unknown>;
      const localClientId = String(registeredClient.id);
      const clientToken = String(registerResponse.body.clientToken);
      const daemonHeaders = localClientHeaders(localClientId, clientToken);

      const unauthenticatedPull = await requestJson(server.baseUrl, "GET", "/api/sync/pull");
      assert.equal(unauthenticatedPull.status, 401);

      const recorded = await harness.syncStore.recordSyncEvent(userId, "notes", "note-http-sync", "update", {
        title: "HTTP sync note"
      });
      const recordedDelete = await harness.syncStore.recordSyncEvent(userId, "notes", "note-http-tombstone", "delete", {
        source: "test"
      });
      const pullResponse = await requestJson(server.baseUrl, "GET", "/api/sync/pull?limit=10", {
        headers: daemonHeaders
      });
      assert.equal(pullResponse.status, 200);
      const events = pullResponse.body.events as Array<Record<string, unknown>>;
      assert.equal(events.length, 2);
      assert.equal(events[0].cursor, recorded.cursor);
      assert.equal(events[0].resourceId, "note-http-sync");
      assert.equal(events[1].cursor, recordedDelete.cursor);
      assert.equal(events[1].resourceId, "note-http-tombstone");
      assert.equal(events[1].action, "delete");
      const deletePayload = events[1].payload as Record<string, unknown>;
      assert.equal(deletePayload.deleted, true);
      assert.equal(typeof deletePayload.deletedAt, "string");
      assert.equal(typeof deletePayload.resourceDeletedAt, "string");

      const versions = await harness.syncStore.listSyncResourceVersions(userId, ["notes"]);
      const tombstoneVersion = versions.find((version) => version.resourceId === "note-http-tombstone");
      assert.equal(tombstoneVersion?.deletedAt, deletePayload.deletedAt);

      const snapshotResponse = await requestJson(server.baseUrl, "GET", "/api/sync/snapshot?domains=", {
        headers: daemonHeaders
      });
      assert.equal(snapshotResponse.status, 200);
      assert.deepEqual(snapshotResponse.body.domains, {});
      assert.equal(snapshotResponse.body.baselineCursor, recordedDelete.cursor);
      assert.deepEqual(snapshotResponse.body.supportedDomains, [
        "projects", "notes", "artifacts", "tasks", "project_context"
      ]);

      const echoedBaselineResponse = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/snapshot?domains=&baselineCursor=0007",
        { headers: daemonHeaders }
      );
      assert.equal(echoedBaselineResponse.status, 200);
      assert.equal(echoedBaselineResponse.body.baselineCursor, "0007");

      const pushResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [] }
      });
      assert.equal(pushResponse.status, 202);
      assert.deepEqual(pushResponse.body.applied, []);
      assert.deepEqual(pushResponse.body.rejected, []);

      await harness.syncStore.recordSyncEvent(userId, "projects", "project-http-sync", "update", {
        name: "HTTP sync project"
      });
      const conflictPushResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [
            {
              clientOpId: "project-conflict-op",
              domain: "projects",
              action: "update",
              resourceId: "project-http-sync",
              baseVersion: 0,
              payload: { name: "Stale local name" }
            }
          ]
        }
      });
      assert.equal(conflictPushResponse.status, 409);
      assert.deepEqual(conflictPushResponse.body.applied, []);
      const rejected = conflictPushResponse.body.rejected as Array<Record<string, unknown>>;
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].clientOpId, "project-conflict-op");
      assert.equal(rejected[0].code, "SYNC_VERSION_CONFLICT");

      const relationValidationResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [
            {
              clientOpId: "project-default-invalid",
              domain: "projects",
              action: "update",
              relation: "default",
              payload: {}
            },
            {
              clientOpId: "task-occurrence-invalid",
              domain: "tasks",
              action: "update",
              resourceId: "task-http-sync",
              relation: "occurrence",
              payload: { targetDate: "2026-06-15" }
            },
            {
              clientOpId: "task-subtask-invalid",
              domain: "tasks",
              action: "update",
              resourceId: "task-http-sync",
              relation: "subtask",
              payload: { occurrenceDate: "2026-06-15" }
            },
            {
              clientOpId: "task-today-invalid",
              domain: "tasks",
              action: "create",
              resourceId: "task-http-sync",
              relation: "today",
              payload: {}
            },
            {
              clientOpId: "task-schedule-item-invalid",
              domain: "tasks",
              action: "update",
              resourceId: "task-http-sync",
              relation: "scheduleItem",
              payload: { scheduleId: 1 }
            }
          ]
        }
      });
      assert.equal(relationValidationResponse.status, 409);
      assert.deepEqual(relationValidationResponse.body.applied, []);
      const relationRejected = relationValidationResponse.body.rejected as Array<Record<string, unknown>>;
      assert.equal(relationRejected.length, 5);
      const rejectionCodes = new Map(relationRejected.map((entry) => [entry.clientOpId, entry.code]));
      assert.equal(rejectionCodes.get("project-default-invalid"), "SYNC_PROJECT_DEFAULT_PAYLOAD_INVALID");
      assert.equal(rejectionCodes.get("task-occurrence-invalid"), "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID");
      assert.equal(rejectionCodes.get("task-subtask-invalid"), "SYNC_TASK_SUBTASK_ID_REQUIRED");
      assert.equal(rejectionCodes.get("task-today-invalid"), "SYNC_TASK_TODAY_PAYLOAD_INVALID");
      assert.equal(rejectionCodes.get("task-schedule-item-invalid"), "SYNC_TASK_SCHEDULE_ITEM_PAYLOAD_INVALID");

      const unsupportedTaskPushResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [
            {
              clientOpId: "task-unsupported-relation-op",
              domain: "tasks",
              action: "update",
              resourceId: "task-http-sync",
              relation: "reminder",
              payload: {}
            }
          ]
        }
      });
      assert.equal(unsupportedTaskPushResponse.status, 409);
      assert.deepEqual(unsupportedTaskPushResponse.body.applied, []);
      const taskRejected = unsupportedTaskPushResponse.body.rejected as Array<Record<string, unknown>>;
      assert.equal(taskRejected.length, 1);
      assert.equal(taskRejected[0].clientOpId, "task-unsupported-relation-op");
      assert.equal(taskRejected[0].code, "SYNC_TASK_RELATION_NOT_SUPPORTED");

      const attachmentPushResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [
            {
              clientOpId: "task-attachment-op",
              domain: "tasks",
              action: "create",
              resourceId: "task-http-sync",
              relation: "attachment",
              payload: {
                filename: "attachment.bin",
                contentBase64: "AA==",
                checksum: "sha256:not-the-actual-digest"
              }
            }
          ]
        }
      });
      assert.equal(attachmentPushResponse.status, 409);
      assert.deepEqual(attachmentPushResponse.body.applied, []);
      const attachmentRejected = attachmentPushResponse.body.rejected as Array<Record<string, unknown>>;
      assert.equal(attachmentRejected.length, 1);
      assert.equal(attachmentRejected[0].clientOpId, "task-attachment-op");
      assert.equal(attachmentRejected[0].code, "SYNC_BLOB_CHECKSUM_MISMATCH");

      const unsupportedBlobUploadResponse = await requestJson(server.baseUrl, "PUT", "/api/sync/blobs/test-blob", {
        headers: daemonHeaders,
        body: { contentBase64: "AA==" }
      });
      assert.equal(unsupportedBlobUploadResponse.status, 404);

      const checksumBlobUploadResponse = await requestJson(server.baseUrl, "PUT", "/api/sync/blobs/artifact:artifact-http-sync", {
        headers: daemonHeaders,
        body: {
          contentBase64: "AA==",
          checksum: "sha256:not-the-actual-digest"
        }
      });
      assert.equal(checksumBlobUploadResponse.status, 400);
      assert.equal(checksumBlobUploadResponse.body.code, "SYNC_BLOB_CHECKSUM_MISMATCH");

      const taskChecksumBlobUploadResponse = await requestJson(
        server.baseUrl,
        "PUT",
        "/api/sync/blobs/task-attachment:task-http-sync:attachment-http-sync",
        {
          headers: daemonHeaders,
          body: {
            contentBase64: "AA==",
            checksum: "sha256:not-the-actual-digest"
          }
        }
      );
      assert.equal(taskChecksumBlobUploadResponse.status, 400);
      assert.equal(taskChecksumBlobUploadResponse.body.code, "SYNC_BLOB_CHECKSUM_MISMATCH");
    } finally {
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });

  it("applies and deduplicates project context sync pushes with strict invalidation recording", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "sync-project-context");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = await startTestServer(harness);
    const originalFetch = globalThis.fetch;
    const coreOrigin = new URL(server.baseUrl).origin;
    const projectRequests: Array<{ method: string; pathname: string; body: Record<string, unknown> }> = [];

    try {
      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-sync-project-context",
          clientName: "Project Context Sync Daemon",
          platform: "linux",
          syncRootId: "project-context",
          syncRootLabel: "Project Context Sync"
        }
      });
      assert.equal(registerResponse.status, 201);
      const registeredClient = registerResponse.body.client as Record<string, unknown>;
      const daemonHeaders = localClientHeaders(
        String(registeredClient.id),
        String(registerResponse.body.clientToken)
      );

      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.origin === coreOrigin) return originalFetch(input, init);

        const method = (init?.method ?? "GET").toUpperCase();
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as Record<string, unknown>
          : {};
        projectRequests.push({ method, pathname: url.pathname, body });

        if (url.pathname === "/projects/project-context-brief/brief" && method === "PUT") {
          return new Response(JSON.stringify({
            projectId: "project-context-brief",
            contentMarkdown: body.contentMarkdown,
            version: 2
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.pathname === "/projects/project-context-conflict/brief" && method === "PUT") {
          return new Response(JSON.stringify({
            code: "VERSION_CONFLICT",
            message: "Brief version conflict: expected 1, current 2."
          }), { status: 409, headers: { "Content-Type": "application/json" } });
        }
        if (url.pathname === "/projects/project-context-memory/memories" && method === "POST") {
          return new Response(JSON.stringify({
            ...body,
            id: "memory-project-context",
            projectId: "project-context-memory"
          }), { status: 201, headers: { "Content-Type": "application/json" } });
        }
        if (url.pathname === "/project-relations/relation-project-context" && method === "GET") {
          return new Response(JSON.stringify({
            id: "relation-project-context",
            sourceProjectId: "project-context-source",
            targetProjectId: "project-context-target"
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.pathname === "/project-relations/relation-project-context" && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected upstream request in project context sync push test: ${method} ${url.href}`);
      };

      const briefOp = {
        clientOpId: "project-context-brief-op",
        domain: "project_context",
        action: "update",
        relation: "brief",
        resourceId: "project-context-brief",
        payload: { contentMarkdown: "# Updated brief", expectedVersion: 1 }
      };
      const briefResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [briefOp] }
      });
      assert.equal(briefResponse.status, 202);
      assert.deepEqual(briefResponse.body.rejected, []);
      const briefApplied = briefResponse.body.applied as Array<Record<string, unknown>>;
      assert.equal(briefApplied.length, 1);
      assert.equal(briefApplied[0].domain, "project_context");
      assert.equal(briefApplied[0].resourceId, "project-context-brief");
      assert.equal(typeof briefApplied[0].version, "number");
      assert.equal(typeof briefApplied[0].cursor, "string");
      assert.deepEqual(projectRequests[0], {
        method: "PUT",
        pathname: "/projects/project-context-brief/brief",
        body: { contentMarkdown: "# Updated brief", expectedVersion: 1, updatedByKind: "user" }
      });
      const briefLedger = await harness.syncStore.getAppliedClientOp(userId, "project-context-brief-op");
      assert.equal(briefLedger?.domain, "project_context");
      assert.equal(briefLedger?.resourceId, "project-context-brief");
      assert.equal(briefLedger?.version, briefApplied[0].version);
      assert.equal(briefLedger?.cursor, briefApplied[0].cursor);

      const briefReplay = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [briefOp] }
      });
      assert.equal(briefReplay.status, 202);
      const briefReplayApplied = briefReplay.body.applied as Array<Record<string, unknown>>;
      assert.equal(briefReplayApplied[0].deduplicated, true);
      assert.equal(projectRequests.filter((request) => request.pathname === "/projects/project-context-brief/brief").length, 1);

      const memoryOp = {
        clientOpId: "project-context-memory-op",
        domain: "project_context",
        action: "create",
        relation: "memory",
        resourceId: "project-context-memory",
        payload: {
          relation: "memory",
          kind: "decision",
          bodyMarkdown: "Use synchronous context invalidations."
        }
      };
      const memoryResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [memoryOp] }
      });
      assert.equal(memoryResponse.status, 202);
      const memoryApplied = memoryResponse.body.applied as Array<Record<string, unknown>>;
      assert.equal(memoryApplied.length, 1);
      const memoryRequest = projectRequests.find((request) => request.pathname === "/projects/project-context-memory/memories");
      assert.deepEqual(memoryRequest, {
        method: "POST",
        pathname: "/projects/project-context-memory/memories",
        body: {
          kind: "decision",
          bodyMarkdown: "Use synchronous context invalidations.",
          authority: "user_confirmed",
          createdByKind: "user"
        }
      });
      assert.ok(await harness.syncStore.getAppliedClientOp(userId, "project-context-memory-op"));

      const memoryReplay = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [memoryOp] }
      });
      assert.equal(memoryReplay.status, 202);
      const memoryReplayApplied = memoryReplay.body.applied as Array<Record<string, unknown>>;
      assert.equal(memoryReplayApplied[0].deduplicated, true);
      assert.equal(projectRequests.filter((request) => request.pathname === "/projects/project-context-memory/memories").length, 1);

      const relationBaselineCursor = await harness.syncStore.getLatestSyncCursor(userId);
      const relationResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [{
            clientOpId: "project-context-relation-delete-op",
            domain: "project_context",
            action: "delete",
            relation: "relation",
            resourceId: "project-context-source",
            payload: { relationId: "relation-project-context" }
          }]
        }
      });
      assert.equal(relationResponse.status, 202);
      const relationApplied = relationResponse.body.applied as Array<Record<string, unknown>>;
      assert.equal(relationApplied.length, 1);
      const relationRequests = projectRequests.filter((request) => request.pathname === "/project-relations/relation-project-context");
      assert.deepEqual(relationRequests.map((request) => request.method), ["GET", "DELETE"]);
      const relationEvents = await harness.syncStore.listSyncEvents(
        userId,
        relationBaselineCursor,
        10,
        ["project_context"]
      );
      assert.deepEqual(relationEvents.events.map((event) => event.resourceId), [
        "project-context-source",
        "project-context-target"
      ]);
      assert.equal(relationEvents.events[0].cursor, relationApplied[0].cursor);
      assert.equal(relationEvents.events[0].payload.clientOpId, "project-context-relation-delete-op");
      assert.equal(relationEvents.events[1].payload.clientOpId, undefined);

      const conflictOp = {
        clientOpId: "project-context-brief-conflict-op",
        domain: "project_context",
        action: "update",
        relation: "brief",
        resourceId: "project-context-conflict",
        payload: { contentMarkdown: "# Stale brief", expectedVersion: 1 }
      };
      const conflictResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [conflictOp] }
      });
      assert.equal(conflictResponse.status, 409);
      assert.deepEqual(conflictResponse.body.applied, []);
      const conflictRejected = conflictResponse.body.rejected as Array<Record<string, unknown>>;
      assert.equal(conflictRejected[0].code, "VERSION_CONFLICT");
      assert.equal(conflictRejected[0].message, "Brief version conflict: expected 1, current 2.");
      assert.equal(await harness.syncStore.getAppliedClientOp(userId, "project-context-brief-conflict-op"), undefined);

      const conflictRetry = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [conflictOp] }
      });
      assert.equal(conflictRetry.status, 409);
      assert.equal(projectRequests.filter((request) => request.pathname === "/projects/project-context-conflict/brief").length, 2);
      assert.equal(await harness.syncStore.getAppliedClientOp(userId, "project-context-brief-conflict-op"), undefined);

      const requestCountBeforeUnknownRelation = projectRequests.length;
      const unknownRelationResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [{
            clientOpId: "project-context-unknown-relation-op",
            domain: "project_context",
            action: "update",
            relation: "link",
            resourceId: "project-context-brief",
            payload: {}
          }]
        }
      });
      assert.equal(unknownRelationResponse.status, 409);
      const unknownRejected = unknownRelationResponse.body.rejected as Array<Record<string, unknown>>;
      assert.equal(unknownRejected[0].code, "SYNC_PROJECT_CONTEXT_RELATION_NOT_SUPPORTED");
      assert.equal(projectRequests.length, requestCountBeforeUnknownRelation);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });

  it("validates and forwards note metadata during sync push", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "sync-note-metadata");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = await startTestServer(harness);
    const originalFetch = globalThis.fetch;
    const coreOrigin = new URL(server.baseUrl).origin;
    const noteRequests: Array<{ method: string; pathname: string; body: Record<string, unknown> }> = [];

    try {
      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-sync-note-metadata",
          clientName: "Sync Daemon",
          platform: "linux",
          syncRootId: "notes",
          syncRootLabel: "Notes Sync"
        }
      });
      assert.equal(registerResponse.status, 201);
      const registeredClient = registerResponse.body.client as Record<string, unknown>;
      const daemonHeaders = localClientHeaders(
        String(registeredClient.id),
        String(registerResponse.body.clientToken)
      );

      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.origin === coreOrigin) return originalFetch(input, init);

        const method = (init?.method ?? "GET").toUpperCase();
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as Record<string, unknown>
          : {};
        if (url.pathname === "/notes" && method === "POST") {
          noteRequests.push({ method, pathname: url.pathname, body });
          const id = body.title === "Created through REST" ? "note-created-rest" : "note-created-raw";
          return new Response(JSON.stringify({ ...body, id }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        const noteMatch = url.pathname.match(/^\/notes\/([^/]+)$/);
        if (noteMatch && method === "PATCH") {
          const id = decodeURIComponent(noteMatch[1]);
          noteRequests.push({ method, pathname: url.pathname, body });
          return new Response(JSON.stringify({ ...body, id }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        throw new Error(`Unexpected upstream request in sync note metadata test: ${method} ${url.href}`);
      };

      const rawCreateResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [{
            clientOpId: "note-create-raw",
            domain: "notes",
            action: "create",
            payload: {
              title: "Capture Daily Summary 2026-07-07",
              content: "Captured activity",
              tags: ["workbench-capture"]
            }
          }]
        }
      });
      assert.equal(rawCreateResponse.status, 202);
      assert.deepEqual(rawCreateResponse.body.rejected, []);
      const rawApplied = rawCreateResponse.body.applied as Array<Record<string, unknown>>;
      assert.equal(rawApplied.length, 1);
      assert.equal(rawApplied[0].resourceId, "note-created-raw");
      assert.equal(noteRequests.length, 1);
      assert.deepEqual(noteRequests[0], {
        method: "POST",
        pathname: "/notes",
        body: {
          title: "Capture Daily Summary 2026-07-07",
          content: "Captured activity",
          tags: ["workbench-capture"]
        }
      });

      const repeatedCreateResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [{
            clientOpId: "note-create-raw",
            domain: "notes",
            action: "create",
            payload: {
              title: "Capture Daily Summary 2026-07-07",
              content: "Captured activity",
              tags: ["workbench-capture"]
            }
          }]
        }
      });
      assert.equal(repeatedCreateResponse.status, 202);
      const repeatedApplied = repeatedCreateResponse.body.applied as Array<Record<string, unknown>>;
      assert.equal(repeatedApplied.length, 1);
      assert.equal(repeatedApplied[0].resourceId, "note-created-raw");
      assert.equal(repeatedApplied[0].deduplicated, true);
      assert.equal(noteRequests.length, 1);

      noteRequests.length = 0;
      const restClientOpId = randomUUID();
      const restCreateResponse = await requestJson(server.baseUrl, "POST", "/api/notes", {
        headers: {
          ...bearerHeaders(accessToken),
          "x-workbench-client-op-id": restClientOpId
        },
        body: {
          title: "Created through REST",
          content: "Core may have applied this before the network failed"
        }
      });
      assert.equal(restCreateResponse.status, 201);
      assert.equal(restCreateResponse.body.id, "note-created-rest");
      assert.equal(noteRequests.length, 1);

      const replayAfterRestResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [{
            clientOpId: restClientOpId,
            domain: "notes",
            action: "create",
            payload: {
              title: "Created through REST",
              content: "Core may have applied this before the network failed"
            }
          }]
        }
      });
      assert.equal(replayAfterRestResponse.status, 202);
      const replayApplied = replayAfterRestResponse.body.applied as Array<Record<string, unknown>>;
      assert.equal(replayApplied.length, 1);
      assert.equal(replayApplied[0].resourceId, "note-created-rest");
      assert.equal(replayApplied[0].deduplicated, true);
      assert.equal(noteRequests.length, 1);

      noteRequests.length = 0;
      const mixedResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [
            {
              clientOpId: "note-triaged-continues",
              domain: "notes",
              action: "update",
              resourceId: "note-triaged",
              payload: {
                title: "Still applies",
                tags: ["capture", "triaged"]
              }
            }
          ]
        }
      });
      assert.equal(mixedResponse.status, 202);
      assert.deepEqual(mixedResponse.body.rejected, []);
      const mixedApplied = mixedResponse.body.applied as Array<Record<string, unknown>>;
      assert.equal(mixedApplied.length, 1);
      assert.equal(mixedApplied[0].clientOpId, "note-triaged-continues");
      assert.equal(mixedApplied[0].resourceId, "note-triaged");
      assert.deepEqual(noteRequests, [{
        method: "PATCH",
        pathname: "/notes/note-triaged",
        body: {
          title: "Still applies",
          tags: ["capture", "triaged"]
        }
      }]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });

  it("serves bearer-only sync changes with consumer cursors and domain filters", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "changes-a");
    const { userId: otherUserId, username: otherUsername } = await createTestUser(pool, "changes-b");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const { accessToken: otherAccessToken } = harness.auth.issueTokenBundle({
      userId: otherUserId,
      username: otherUsername
    });
    const server = await startTestServer(harness);
    try {
      const unauthenticatedPull = await requestJson(server.baseUrl, "GET", "/api/sync/changes");
      assert.equal(unauthenticatedPull.status, 401);
      const unauthenticatedCommit = await requestJson(server.baseUrl, "POST", "/api/sync/changes/commit", {
        body: { cursor: "1" }
      });
      assert.equal(unauthenticatedCommit.status, 401);

      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-sync-changes-a",
          clientName: "Sync Changes Daemon",
          platform: "linux",
          capabilities: { scopes: ["sync.pull"] },
          syncRootId: "changes",
          syncRootLabel: "Changes"
        }
      });
      assert.equal(registerResponse.status, 201);
      const localClientId = String((registerResponse.body.client as Record<string, unknown>).id);
      const clientToken = String(registerResponse.body.clientToken);
      const localOnlyPull = await requestJson(server.baseUrl, "GET", "/api/sync/changes", {
        headers: localClientHeaders(localClientId, clientToken)
      });
      assert.equal(localOnlyPull.status, 401);
      assert.deepEqual(localOnlyPull.body, { message: "Missing bearer token" });

      const noteEvent = await harness.syncStore.recordSyncEvent(userId, "notes", "note-change-a", "update", {
        title: "Note change"
      });
      const projectEvent = await harness.syncStore.recordSyncEvent(userId, "projects", "project-change-a", "update", {
        name: "Project change"
      });
      const otherEvent = await harness.syncStore.recordSyncEvent(otherUserId, "notes", "note-change-b", "update", {
        title: "Other owner note"
      });

      const filtered = await requestJson(server.baseUrl, "GET", "/api/sync/changes?cursor=0&domains=notes&limit=5000", {
        headers: bearerHeaders(accessToken)
      });
      assert.equal(filtered.status, 200);
      assert.equal(filtered.body.consumer, "maintenance-agent");
      assert.equal(filtered.body.cursor, "0");
      const filteredEvents = filtered.body.events as Array<Record<string, unknown>>;
      assert.deepEqual(filteredEvents.map((event) => event.resourceId), ["note-change-a"]);
      assert.equal(filtered.body.nextCursor, noteEvent.cursor);

      const defaultCommit = await requestJson(server.baseUrl, "POST", "/api/sync/changes/commit", {
        headers: bearerHeaders(accessToken),
        body: { cursor: noteEvent.cursor }
      });
      assert.equal(defaultCommit.status, 200);
      assert.equal(defaultCommit.body.consumer, "maintenance-agent");
      assert.equal(defaultCommit.body.cursor, noteEvent.cursor);
      assert.equal(typeof defaultCommit.body.updatedAt, "string");

      const secondaryCommit = await requestJson(server.baseUrl, "POST", "/api/sync/changes/commit", {
        headers: bearerHeaders(accessToken),
        body: { consumer: "secondary-agent", cursor: "0" }
      });
      assert.equal(secondaryCommit.status, 200);
      assert.equal(secondaryCommit.body.consumer, "secondary-agent");

      const defaultPull = await requestJson(server.baseUrl, "GET", "/api/sync/changes?limit=10", {
        headers: bearerHeaders(accessToken)
      });
      assert.equal(defaultPull.status, 200);
      assert.equal(defaultPull.body.cursor, noteEvent.cursor);
      const defaultEvents = defaultPull.body.events as Array<Record<string, unknown>>;
      assert.deepEqual(defaultEvents.map((event) => event.resourceId), ["project-change-a"]);
      assert.equal(defaultPull.body.nextCursor, projectEvent.cursor);

      const secondaryPull = await requestJson(server.baseUrl, "GET", "/api/sync/changes?consumer=secondary-agent&limit=10", {
        headers: bearerHeaders(accessToken)
      });
      assert.equal(secondaryPull.status, 200);
      assert.equal(secondaryPull.body.cursor, "0");
      const secondaryEvents = secondaryPull.body.events as Array<Record<string, unknown>>;
      assert.deepEqual(secondaryEvents.map((event) => event.resourceId), ["note-change-a", "project-change-a"]);

      const secondDefaultCommit = await requestJson(server.baseUrl, "POST", "/api/sync/changes/commit", {
        headers: bearerHeaders(accessToken),
        body: { cursor: projectEvent.cursor }
      });
      assert.equal(secondDefaultCommit.status, 200);

      const userSeparatedPull = await requestJson(server.baseUrl, "GET", "/api/sync/changes?limit=10", {
        headers: bearerHeaders(otherAccessToken)
      });
      assert.equal(userSeparatedPull.status, 200);
      assert.equal(userSeparatedPull.body.cursor, "0");
      const otherEvents = userSeparatedPull.body.events as Array<Record<string, unknown>>;
      assert.deepEqual(otherEvents.map((event) => event.resourceId), ["note-change-b"]);
      assert.equal(userSeparatedPull.body.nextCursor, otherEvent.cursor);

      const exhaustedDefaultPull = await requestJson(server.baseUrl, "GET", "/api/sync/changes?limit=10", {
        headers: bearerHeaders(accessToken)
      });
      assert.equal(exhaustedDefaultPull.status, 200);
      assert.equal(exhaustedDefaultPull.body.cursor, projectEvent.cursor);
      assert.deepEqual(exhaustedDefaultPull.body.events, []);
      assert.equal(exhaustedDefaultPull.body.nextCursor, projectEvent.cursor);
    } finally {
      await server.close();
      await cleanupTestUser(pool, userId);
      await cleanupTestUser(pool, otherUserId);
    }
  });

  it("serves Project context snapshots and emits equivalent HTTP/MCP relation invalidations", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "project-context-sync");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = await startTestServer(harness);
    const originalFetch = globalThis.fetch;
    const coreOrigin = new URL(server.baseUrl).origin;
    let contextLimitError = false;
    let exportMode: "ok" | "limit" | "missing" | "invalid" = "ok";

    try {
      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-project-context-sync",
          clientName: "Project Context Sync Daemon",
          platform: "linux",
          syncRootId: "project-context",
          syncRootLabel: "Project Context"
        }
      });
      assert.equal(registerResponse.status, 201);
      const registeredClient = registerResponse.body.client as Record<string, unknown>;
      const daemonHeaders = localClientHeaders(
        String(registeredClient.id),
        String(registerResponse.body.clientToken)
      );

      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.origin === coreOrigin) return originalFetch(input, init);

        const method = (init?.method ?? "GET").toUpperCase();
        if (url.pathname === "/projects/project-context-a/sync-context" && method === "GET") {
          if (contextLimitError) {
            return new Response(JSON.stringify({
              code: "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED",
              message: "Project context exceeds the sync limit"
            }), { status: 413, headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({
            projectId: "project-context-a",
            complete: true,
            counts: { memories: 1, relations: 1 },
            project: { id: "project-context-a", name: "Project A" },
            brief: { projectId: "project-context-a", version: 2, contentMarkdown: "# Project A" },
            memories: [{ id: "memory-a", projectId: "project-context-a" }],
            relations: [{
              id: "relation-a",
              sourceProjectId: "project-context-a",
              targetProjectId: "project-context-b"
            }]
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.pathname === "/projects/project-context-a/context-export" && method === "GET") {
          assert.match(new Headers(init?.headers).get("Authorization") ?? "", /^Bearer\s+\S+$/);
          if (exportMode === "limit") {
            return new Response(JSON.stringify({
              code: "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED",
              message: "Project context export exceeds the limit"
            }), { status: 413, headers: { "Content-Type": "application/json" } });
          }
          if (exportMode === "missing") {
            return new Response(JSON.stringify({ message: "Project not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          const projectId = exportMode === "invalid" ? "project-context-other" : "project-context-a";
          return new Response(JSON.stringify({
            schemaVersion: 1,
            packageType: "workbench.project-context-export",
            generatedAt: "2026-06-23T00:00:00.000Z",
            complete: true,
            project: {
              id: "project-context-a",
              name: "Project A",
              status: "active",
              updatedAt: "2026-06-23T00:00:00.000Z",
              ownerAccountId: userId
            },
            brief: {
              projectId: "project-context-a",
              contentMarkdown: "# Project A",
              version: 2,
              updatedAt: "2026-06-23T00:00:00.000Z"
            },
            memories: [{
              id: "memory-a",
              projectId,
              kind: "decision",
              bodyMarkdown: "Decision",
              authority: "user_confirmed",
              status: "active",
              createdAt: "2026-06-23T00:00:00.000Z",
              updatedAt: "2026-06-23T00:00:00.000Z"
            }],
            relations: [],
            links: [],
            indexEntries: [],
            generatedSummary: null,
            counts: { memories: 1, relations: 0, links: 0, indexEntries: 0 }
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.pathname === "/projects" && method === "GET") {
          return new Response(JSON.stringify({
            items: [{ id: "project-context-a", name: "Project A" }],
            nextCursor: "next-project-page"
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        const relationMatch = url.pathname.match(/^\/project-relations\/([^/]+)$/);
        if (relationMatch && method === "GET") {
          const relationId = decodeURIComponent(relationMatch[1]);
          return new Response(JSON.stringify({
            id: relationId,
            sourceProjectId: "project-context-a",
            targetProjectId: "project-context-b",
            relationType: "related",
            directionality: "bidirectional",
            version: 1
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (relationMatch && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected upstream request in Project context sync test: ${method} ${url.href}`);
      };

      const unauthenticated = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/project-context/project-context-a"
      );
      assert.equal(unauthenticated.status, 401);

      const detail = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/project-context/project-context-a?baselineCursor=0009",
        { headers: daemonHeaders }
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.schemaVersion, 1);
      assert.equal(detail.body.projectId, "project-context-a");
      assert.equal(detail.body.baselineCursor, "0009");
      assert.equal(detail.body.complete, true);
      assert.deepEqual(detail.body.counts, { memories: 1, relations: 1 });

      const snapshot = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/snapshot?domains=project_context&limit=10&baselineCursor=0009",
        { headers: daemonHeaders }
      );
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.baselineCursor, "0009");
      assert.deepEqual(snapshot.body.supportedDomains, [
        "projects", "notes", "artifacts", "tasks", "project_context"
      ]);
      const contextPage = (snapshot.body.domains as Record<string, unknown>).project_context as Record<string, unknown>;
      assert.equal(contextPage.nextCursor, "next-project-page");
      const contextItems = contextPage.items as Array<Record<string, unknown>>;
      assert.equal(contextItems.length, 1);
      assert.equal(contextItems[0].baselineCursor, "0009");

      const exportResponse = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/projects/project-context-a/context-export",
        { headers: daemonHeaders }
      );
      assert.equal(exportResponse.status, 200);
      assert.equal(exportResponse.body.packageType, "workbench.project-context-export");
      assert.equal(JSON.stringify(exportResponse.body).includes(userId), false);
      assert.equal(JSON.stringify(exportResponse.body).includes("ownerAccountId"), false);

      exportMode = "limit";
      const exportLimit = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/projects/project-context-a/context-export",
        { headers: daemonHeaders }
      );
      assert.equal(exportLimit.status, 413);
      assert.equal(exportLimit.body.code, "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED");

      exportMode = "missing";
      const exportMissing = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/projects/project-context-a/context-export",
        { headers: daemonHeaders }
      );
      assert.equal(exportMissing.status, 404);
      assert.equal(exportMissing.body.message, "Project not found");

      exportMode = "invalid";
      const exportInvalid = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/projects/project-context-a/context-export",
        { headers: daemonHeaders }
      );
      assert.equal(exportInvalid.status, 502);
      assert.equal(exportInvalid.body.code, "PROJECT_CONTEXT_EXPORT_UNAVAILABLE");
      exportMode = "ok";

      const invalidBaseline = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/project-context/project-context-a?baselineCursor=not-a-cursor",
        { headers: daemonHeaders }
      );
      assert.equal(invalidBaseline.status, 400);
      assert.equal(invalidBaseline.body.code, "SYNC_BASELINE_CURSOR_INVALID");

      contextLimitError = true;
      const limitError = await requestJson(
        server.baseUrl,
        "GET",
        "/api/sync/project-context/project-context-a?baselineCursor=10",
        { headers: daemonHeaders }
      );
      contextLimitError = false;
      assert.equal(limitError.status, 413);
      assert.equal(limitError.body.code, "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED");

      const eventBaseline = await harness.syncStore.getLatestSyncCursor(userId);
      const httpDelete = await requestJson(
        server.baseUrl,
        "DELETE",
        "/api/project-relations/relation-http",
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(httpDelete.status, 204);

      type McpHandler = (input: Record<string, unknown>) => Promise<unknown>;
      const handlers = new Map<string, McpHandler>();
      const fakeServer = {
        registerTool(name: string, _definition: unknown, handler: McpHandler): void {
          handlers.set(name, handler);
        }
      };
      const { registerProjectContextTools } = await import("../mcp/registerProjectContextTools.js");
      registerProjectContextTools(fakeServer as never, { accessToken });
      const removeRelation = handlers.get("projects.relations.remove");
      assert.ok(removeRelation);
      await removeRelation({ relationId: "relation-mcp" });

      const invalidations = await harness.syncStore.listSyncEvents(userId, eventBaseline, 20);
      const relationInvalidations = invalidations.events.filter((event) =>
        event.domain === "project_context"
        && (event.payload as Record<string, unknown>).entityType === "relation"
      );
      assert.equal(relationInvalidations.length, 4);
      assert.deepEqual(
        relationInvalidations.map((event) => event.resourceId).sort(),
        ["project-context-a", "project-context-a", "project-context-b", "project-context-b"]
      );
      const sources = relationInvalidations.map((event) =>
        (event.payload as Record<string, unknown>).source
      ).sort();
      assert.deepEqual(sources, ["core-api", "core-api", "core-mcp", "core-mcp"]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });

  it("enforces local client capabilities and exposes audit events", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool, "capabilities");
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = await startTestServer(harness);
    try {
      const registerResponse = await requestJson(server.baseUrl, "POST", "/api/local-clients/register", {
        headers: bearerHeaders(accessToken),
        body: {
          deviceId: "device-capability-http",
          clientName: "Read Only Sync Daemon",
          platform: "linux",
          capabilities: { scopes: ["sync.pull"] },
          syncRootId: "main"
        }
      });
      assert.equal(registerResponse.status, 201);
      const registeredClient = registerResponse.body.client as Record<string, unknown>;
      const localClientId = String(registeredClient.id);
      const clientToken = String(registerResponse.body.clientToken);
      const daemonHeaders = localClientHeaders(localClientId, clientToken);
      assert.deepEqual((registeredClient.capabilities as Record<string, unknown>).scopes, ["sync.pull"]);

      const pullResponse = await requestJson(server.baseUrl, "GET", "/api/sync/pull", {
        headers: daemonHeaders
      });
      assert.equal(pullResponse.status, 200);

      const pushResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: { ops: [] }
      });
      assert.equal(pushResponse.status, 403);
      assert.equal(pushResponse.body.code, "LOCAL_CLIENT_CAPABILITY_DENIED");
      assert.equal(pushResponse.body.capability, "sync.push");

      const auditResponse = await requestJson(
        server.baseUrl,
        "GET",
        `/api/local-clients/audit-events?localClientId=${encodeURIComponent(localClientId)}&limit=10`,
        { headers: bearerHeaders(accessToken) }
      );
      assert.equal(auditResponse.status, 200);
      const auditEvents = auditResponse.body.items as Array<Record<string, unknown>>;
      assert.ok(auditEvents.some((event) => event.eventType === "registered"));
      const denied = auditEvents.find((event) => event.eventType === "capability_denied");
      assert.ok(denied);
      assert.equal((denied.detail as Record<string, unknown>).capability, "sync.push");
    } finally {
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });
});
