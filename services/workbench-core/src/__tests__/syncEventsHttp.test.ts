import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { after, describe, it, type TestContext } from "node:test";
import type { Pool } from "pg";

type DbModule = typeof import("../db.js");
type HttpServerModule = typeof import("../httpServer.js");
type AuthModule = typeof import("../auth.js");
type TestHarness = {
  db: DbModule;
  httpServer: HttpServerModule;
  auth: AuthModule;
};

const CORE_ENV_URL = new URL("../../.env", import.meta.url);
let harnessPromise: Promise<TestHarness | { skipMessage: string }> | undefined;

function parseEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
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
  const port = Number(process.env.CORE_DB_PORT ?? fileEnv.CORE_DB_PORT);
  return host && Number.isFinite(port) ? { host, port } : undefined;
}

async function canReachTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
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
      if (!endpoint) return { skipMessage: "Core DB env is not configured." };
      if (!(await canReachTcp(endpoint.host, endpoint.port))) {
        return { skipMessage: `Core DB is not reachable at ${endpoint.host}:${endpoint.port}.` };
      }
      try {
        const [db, httpServer, auth] = await Promise.all([
          import("../db.js"),
          import("../httpServer.js"),
          import("../auth.js")
        ]);
        await db.ensureCoreSchema();
        return { db, httpServer, auth };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { skipMessage: `Core SSE harness is unavailable: ${message}` };
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

async function createTestUser(pool: Pool): Promise<{ userId: string; username: string }> {
  const userId = `test-sync-events-${randomUUID()}`;
  const username = `${userId}@example.test`;
  await pool.query(
    "INSERT INTO workbench_users (id, username, password_hash) VALUES ($1, $2, $3)",
    [userId, username, "test-password-hash"]
  );
  return { userId, username };
}

async function waitForListenerCount(
  broadcaster: HttpServerModule["syncEventBroadcaster"],
  userId: string,
  count: number
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (broadcaster.listenerCount(userId) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broadcaster.listenerCount(userId), count);
}

after(async () => {
  const loaded = await harnessPromise;
  if (loaded && !("skipMessage" in loaded)) await loaded.db.getCorePool().end();
});

describe("sync event SSE endpoint", () => {
  it("authenticates, frames sync events, and removes its listener on close", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const pool = harness.db.getCorePool();
    const { userId, username } = await createTestUser(pool);
    const { accessToken } = harness.auth.issueTokenBundle({ userId, username });
    const server = harness.httpServer.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();

    try {
      const unauthenticated = await fetch(`${baseUrl}/api/sync/events`);
      assert.equal(unauthenticated.status, 401);
      assert.deepEqual(await unauthenticated.json(), { message: "Missing bearer token" });

      const response = await fetch(`${baseUrl}/api/sync/events`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream(?:;|$)/);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.equal(response.headers.get("connection"), "keep-alive");
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      assert.ok(response.body);
      await waitForListenerCount(harness.httpServer.syncEventBroadcaster, userId, 1);

      const event = {
        domain: "tasks" as const,
        resourceId: "task-sse-1",
        action: "update" as const,
        ts: "2026-07-13T00:00:00.000Z"
      };
      harness.httpServer.syncEventBroadcaster.publish(userId, event);
      const reader = response.body.getReader();
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      assert.equal(
        new TextDecoder().decode(chunk.value),
        `event: sync\ndata: ${JSON.stringify(event)}\n\n`
      );

      controller.abort();
      await reader.cancel().catch(() => undefined);
      await waitForListenerCount(harness.httpServer.syncEventBroadcaster, userId, 0);
    } finally {
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        (server as Server).close((error) => error ? reject(error) : resolve());
      });
      await pool.query("DELETE FROM workbench_users WHERE id = $1", [userId]);
    }
  });
});
