import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { after, describe, it, type TestContext } from "node:test";
import type { Pool } from "pg";

type DbModule = typeof import("../db.js");
type LocalClientsStoreModule = typeof import("../localClientsStore.js");
type TestHarness = {
  db: DbModule;
  localClients: LocalClientsStoreModule;
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
        const [db, localClients] = await Promise.all([
          import("../db.js"),
          import("../localClientsStore.js")
        ]);
        await db.ensureCoreSchema();
        return { db, localClients };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { skipMessage: `Core DB harness is unavailable: ${message}` };
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

async function createTestUser(pool: Pool, label: string): Promise<string> {
  const userId = `test-local-${label}-${randomUUID()}`;
  await pool.query(
    `
      INSERT INTO workbench_users (id, username, password_hash)
      VALUES ($1, $2, $3)
    `,
    [userId, `${userId}@example.test`, "test-password-hash"]
  );
  return userId;
}

async function cleanupTestUser(pool: Pool, userId: string): Promise<void> {
  await pool.query("DELETE FROM workbench_users WHERE id = $1", [userId]);
}

after(async () => {
  const loaded = await harnessPromise;
  if (loaded && !("skipMessage" in loaded)) {
    await loaded.db.getCorePool().end();
  }
});

describe("localClientsStore", () => {
  it("registers clients, verifies tokens, records heartbeat, and revokes credentials", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const userId = await createTestUser(pool, "identity");
    try {
      const registered = await harness.localClients.registerLocalClient(userId, {
        deviceId: "device-a",
        clientName: "Studio Laptop",
        platform: "win32",
        capabilities: { downloads: true, sync: true },
        syncRootId: "main",
        syncRootLabel: "Workbench Main",
        default: true
      });

      assert.equal(registered.client.userId, userId);
      assert.equal(registered.client.deviceId, "device-a");
      assert.equal(registered.client.default, true);
      assert.match(registered.clientToken, /^wblc_/);

      const verified = await harness.localClients.verifyLocalClientToken(
        registered.client.id,
        registered.clientToken
      );
      assert.equal(verified.id, registered.client.id);

      await assert.rejects(
        () => harness.localClients.verifyLocalClientToken(registered.client.id, "wrong-token"),
        { name: "Error", code: "INVALID_LOCAL_CLIENT_TOKEN" }
      );

      const heartbeat = await harness.localClients.recordLocalClientHeartbeat(registered.client, {
        daemonVersion: "0.1.0-test",
        syncRootState: { pending: 0, conflicts: 0 }
      });
      assert.equal(heartbeat.heartbeat?.daemonVersion, "0.1.0-test");
      assert.equal(heartbeat.heartbeat?.online, true);
      assert.deepEqual(heartbeat.heartbeat?.syncRootState, { pending: 0, conflicts: 0 });

      const disabled = await harness.localClients.updateLocalClient(userId, registered.client.id, {
        enabled: false
      });
      assert.equal(disabled?.enabled, false);
      await assert.rejects(
        () => harness.localClients.verifyLocalClientToken(registered.client.id, registered.clientToken),
        { name: "Error", code: "INVALID_LOCAL_CLIENT_TOKEN" }
      );

      await harness.localClients.updateLocalClient(userId, registered.client.id, { enabled: true });
      const revoked = await harness.localClients.revokeLocalClientTokens(userId, registered.client.id);
      assert.equal(revoked, true);
      await assert.rejects(
        () => harness.localClients.verifyLocalClientToken(registered.client.id, registered.clientToken),
        { name: "Error", code: "INVALID_LOCAL_CLIENT_TOKEN" }
      );

      const reRegistered = await harness.localClients.registerLocalClient(userId, {
        deviceId: "device-a",
        clientName: "Studio Laptop Renamed",
        platform: "win32",
        syncRootId: "main",
        syncRootLabel: "Workbench Main",
        default: true
      });
      assert.equal(reRegistered.client.id, registered.client.id);
      assert.notEqual(reRegistered.clientToken, registered.clientToken);
      assert.equal(reRegistered.client.clientName, "Studio Laptop Renamed");
      await harness.localClients.verifyLocalClientToken(reRegistered.client.id, reRegistered.clientToken);
    } finally {
      await cleanupTestUser(pool, userId);
    }
  });

  it("selects a default online client and rejects ambiguous implicit job targets", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const userId = await createTestUser(pool, "selection");
    try {
      const first = await harness.localClients.registerLocalClient(userId, {
        deviceId: "device-a",
        clientName: "Default Laptop",
        platform: "win32",
        syncRootId: "main",
        default: true
      });
      const second = await harness.localClients.registerLocalClient(userId, {
        deviceId: "device-b",
        clientName: "Desktop",
        platform: "linux",
        syncRootId: "main"
      });
      await harness.localClients.recordLocalClientHeartbeat(first.client, { syncRootState: {} });
      await harness.localClients.recordLocalClientHeartbeat(second.client, { syncRootState: {} });

      const defaultJob = await harness.localClients.createLocalJob(userId, {
        kind: "download_artifact",
        target: "sync-folder",
        payload: { blobId: "artifact:one" }
      });
      assert.equal(defaultJob.localClientId, first.client.id);

      await harness.localClients.updateLocalClient(userId, first.client.id, { default: false });
      await assert.rejects(
        () =>
          harness.localClients.createLocalJob(userId, {
            kind: "download_artifact",
            target: "downloads",
            payload: { blobId: "artifact:two" }
          }),
        { name: "Error", code: "AMBIGUOUS_LOCAL_CLIENT" }
      );

      await harness.localClients.updateLocalClient(userId, second.client.id, { enabled: false });
      const singleOnlineJob = await harness.localClients.createLocalJob(userId, {
        kind: "materialize_resource",
        target: "sync-folder",
        payload: { resourceId: "notes:note-1" }
      });
      assert.equal(singleOnlineJob.localClientId, first.client.id);
    } finally {
      await cleanupTestUser(pool, userId);
    }
  });

  it("claims, completes, fails, and scopes jobs to the owning local client", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const userA = await createTestUser(pool, "jobs-a");
    const userB = await createTestUser(pool, "jobs-b");
    try {
      const clientA = await harness.localClients.registerLocalClient(userA, {
        deviceId: "device-a",
        clientName: "Laptop A",
        platform: "win32",
        syncRootId: "main"
      });
      const clientB = await harness.localClients.registerLocalClient(userB, {
        deviceId: "device-b",
        clientName: "Laptop B",
        platform: "darwin",
        syncRootId: "main"
      });

      const job = await harness.localClients.createLocalJob(userA, {
        localClientId: clientA.client.id,
        kind: "download_artifact",
        target: "downloads",
        payload: { blobId: "artifact:download-1", filename: "report.md" },
        ttlSeconds: 120
      });
      assert.equal(job.status, "pending");
      assert.equal(job.attempts, 0);

      const otherClientClaims = await harness.localClients.claimLocalJobsForClient(clientB.client.id, 5);
      assert.deepEqual(otherClientClaims, []);

      const claims = await harness.localClients.claimLocalJobsForClient(clientA.client.id, 5);
      assert.equal(claims.length, 1);
      assert.equal(claims[0].id, job.id);
      assert.equal(claims[0].status, "running");
      assert.equal(claims[0].attempts, 1);

      const duplicateClaims = await harness.localClients.claimLocalJobsForClient(clientA.client.id, 5);
      assert.deepEqual(duplicateClaims, []);

      const wrongClientComplete = await harness.localClients.completeLocalJobForClient(clientB.client.id, job.id, {
        localPath: "C:/Downloads/report.md"
      });
      assert.equal(wrongClientComplete, undefined);

      const completed = await harness.localClients.completeLocalJobForClient(clientA.client.id, job.id, {
        localPath: "C:/Downloads/report.md",
        checksum: "sha256:abc",
        sizeBytes: 12
      });
      assert.equal(completed?.status, "completed");
      assert.deepEqual(completed?.result, {
        localPath: "C:/Downloads/report.md",
        checksum: "sha256:abc",
        sizeBytes: 12
      });

      const completeAgain = await harness.localClients.completeLocalJobForClient(clientA.client.id, job.id, {});
      assert.equal(completeAgain, undefined);

      const failingJob = await harness.localClients.createLocalJob(userA, {
        localClientId: clientA.client.id,
        kind: "materialize_resource",
        target: "sync-folder",
        payload: { resourceId: "notes:missing" }
      });
      await harness.localClients.claimLocalJobsForClient(clientA.client.id, 1);
      const failed = await harness.localClients.failLocalJobForClient(
        clientA.client.id,
        failingJob.id,
        "download source unavailable"
      );
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.errorMessage, "download source unavailable");

      const completedJobs = await harness.localClients.listLocalJobsForUser(userA, {
        localClientId: clientA.client.id,
        status: "completed"
      });
      assert.equal(completedJobs.length, 1);
      assert.equal(completedJobs[0].id, job.id);
    } finally {
      await cleanupTestUser(pool, userA);
      await cleanupTestUser(pool, userB);
    }
  });

  it("deduplicates idempotent jobs and records local job events", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const userId = await createTestUser(pool, "idempotency");
    try {
      const registered = await harness.localClients.registerLocalClient(userId, {
        deviceId: "device-idempotent",
        clientName: "Idempotent Laptop",
        platform: "win32",
        syncRootId: "main"
      });

      const first = await harness.localClients.createLocalJob(userId, {
        localClientId: registered.client.id,
        idempotencyKey: "download-report-1",
        kind: "download_artifact",
        target: "downloads",
        payload: { blobId: "artifact:one" }
      });
      const duplicate = await harness.localClients.createLocalJob(userId, {
        localClientId: registered.client.id,
        idempotencyKey: "download-report-1",
        kind: "download_artifact",
        target: "downloads",
        payload: { blobId: "artifact:two" }
      });
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.idempotencyKey, "download-report-1");
      assert.deepEqual(duplicate.payload, { blobId: "artifact:one" });

      const claimed = await harness.localClients.claimLocalJobsForClient(registered.client.id, 1);
      assert.equal(claimed[0].id, first.id);
      const completed = await harness.localClients.completeLocalJobForClient(registered.client.id, first.id, {
        localPath: "C:/Downloads/one.md"
      });
      assert.equal(completed?.status, "completed");

      const duplicateCompleted = await harness.localClients.createLocalJob(userId, {
        localClientId: registered.client.id,
        idempotencyKey: "download-report-1",
        kind: "download_artifact",
        target: "downloads",
        payload: { blobId: "artifact:three" }
      });
      assert.equal(duplicateCompleted.id, first.id);
      assert.equal(duplicateCompleted.status, "completed");

      const events = await harness.localClients.listLocalJobEventsForUser(userId, first.id);
      assert.deepEqual(events.map((event) => event.eventType), ["created", "claimed", "completed"]);
      assert.equal(events[0].detail.idempotencyKey, "download-report-1");
      assert.equal(events[1].detail.attempts, 1);
    } finally {
      await cleanupTestUser(pool, userId);
    }
  });

  it("schedules retry attempts and marks expired jobs failed", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const userId = await createTestUser(pool, "retry-expiry");
    try {
      const registered = await harness.localClients.registerLocalClient(userId, {
        deviceId: "device-retry",
        clientName: "Retry Laptop",
        platform: "linux",
        syncRootId: "main"
      });

      const retryJob = await harness.localClients.createLocalJob(userId, {
        localClientId: registered.client.id,
        kind: "materialize_resource",
        target: "sync-folder",
        payload: { resourceId: "notes:retry" }
      });
      await harness.localClients.claimLocalJobsForClient(registered.client.id, 1);
      const retryScheduled = await harness.localClients.failLocalJobForClient(
        registered.client.id,
        retryJob.id,
        "temporary offline",
        { retryable: true, retryAfterSeconds: 3600 }
      );
      assert.equal(retryScheduled?.status, "pending");
      assert.equal(retryScheduled?.failedAt, undefined);
      assert.ok(retryScheduled?.nextAttemptAt);

      const tooEarlyClaims = await harness.localClients.claimLocalJobsForClient(registered.client.id, 1);
      assert.deepEqual(tooEarlyClaims, []);

      await pool.query("UPDATE local_jobs SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1", [retryJob.id]);
      const retryClaims = await harness.localClients.claimLocalJobsForClient(registered.client.id, 1);
      assert.equal(retryClaims.length, 1);
      assert.equal(retryClaims[0].id, retryJob.id);
      assert.equal(retryClaims[0].attempts, 2);

      const retryEvents = await harness.localClients.listLocalJobEventsForUser(userId, retryJob.id);
      assert.deepEqual(retryEvents.map((event) => event.eventType), ["created", "claimed", "retry_scheduled", "claimed"]);

      const expiredJob = await harness.localClients.createLocalJob(userId, {
        localClientId: registered.client.id,
        kind: "download_artifact",
        target: "downloads",
        payload: { blobId: "artifact:expired" }
      });
      await pool.query("UPDATE local_jobs SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [expiredJob.id]);
      const expired = await harness.localClients.getLocalJob(userId, expiredJob.id);
      assert.equal(expired?.status, "failed");
      assert.equal(expired?.errorMessage, "expired");
      assert.ok(expired?.failedAt);

      const expiredEvents = await harness.localClients.listLocalJobEventsForUser(userId, expiredJob.id);
      assert.deepEqual(expiredEvents.map((event) => event.eventType), ["created", "expired"]);
    } finally {
      await cleanupTestUser(pool, userId);
    }
  });
});
