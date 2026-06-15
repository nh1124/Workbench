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
          kind: "download_artifact",
          target: "downloads",
          payload: { blobId: "artifact:test-download", filename: "report.md" }
        }
      });
      assert.equal(createJobResponse.status, 201);
      const jobId = String(createJobResponse.body.id);
      assert.equal(createJobResponse.body.status, "pending");

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
      const pullResponse = await requestJson(server.baseUrl, "GET", "/api/sync/pull?limit=10", {
        headers: daemonHeaders
      });
      assert.equal(pullResponse.status, 200);
      const events = pullResponse.body.events as Array<Record<string, unknown>>;
      assert.equal(events.length, 1);
      assert.equal(events[0].cursor, recorded.cursor);
      assert.equal(events[0].resourceId, "note-http-sync");

      const snapshotResponse = await requestJson(server.baseUrl, "GET", "/api/sync/snapshot?domains=", {
        headers: daemonHeaders
      });
      assert.equal(snapshotResponse.status, 200);
      assert.deepEqual(snapshotResponse.body.domains, {});

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

      const unsupportedTaskPushResponse = await requestJson(server.baseUrl, "POST", "/api/sync/push", {
        headers: daemonHeaders,
        body: {
          ops: [
            {
              clientOpId: "task-subtask-op",
              domain: "tasks",
              action: "update",
              resourceId: "task-http-sync",
              relation: "subtask",
              payload: { occurrenceDate: "2026-06-15" }
            }
          ]
        }
      });
      assert.equal(unsupportedTaskPushResponse.status, 409);
      assert.deepEqual(unsupportedTaskPushResponse.body.applied, []);
      const taskRejected = unsupportedTaskPushResponse.body.rejected as Array<Record<string, unknown>>;
      assert.equal(taskRejected.length, 1);
      assert.equal(taskRejected[0].clientOpId, "task-subtask-op");
      assert.equal(taskRejected[0].code, "SYNC_TASK_RELATION_NOT_SUPPORTED");

      const blobUploadResponse = await requestJson(server.baseUrl, "PUT", "/api/sync/blobs/test-blob", {
        headers: daemonHeaders,
        body: { contentBase64: "AA==" }
      });
      assert.equal(blobUploadResponse.status, 501);
    } finally {
      await server.close();
      await cleanupTestUser(pool, userId);
    }
  });
});
