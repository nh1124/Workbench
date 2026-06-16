import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { after, describe, it, type TestContext } from "node:test";

type DbModule = typeof import("../db.js");
type OAuthDynamicClientsStoreModule = typeof import("../oauthDynamicClientsStore.js");
type TestHarness = {
  db: DbModule;
  oauthDynamicClients: OAuthDynamicClientsStoreModule;
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
  return host && Number.isFinite(port) ? { host, port } : undefined;
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
        const [db, oauthDynamicClients] = await Promise.all([
          import("../db.js"),
          import("../oauthDynamicClientsStore.js")
        ]);
        await db.ensureCoreSchema();
        return { db, oauthDynamicClients };
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

after(async () => {
  const loaded = await harnessPromise;
  if (loaded && !("skipMessage" in loaded)) {
    await loaded.db.getCorePool().end();
  }
});

describe("oauthDynamicClientsStore", () => {
  it("persists and reads dynamic OAuth client registrations", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const clientId = `workbench_dcr_test_${randomUUID()}`;
    try {
      const saved = await harness.oauthDynamicClients.saveOAuthDynamicClient({
        clientId,
        clientName: "Test MCP Client",
        redirectUris: ["https://client.example.test/callback"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"]
      });

      assert.equal(saved.clientId, clientId);
      assert.equal(saved.clientName, "Test MCP Client");
      assert.deepEqual(saved.redirectUris, ["https://client.example.test/callback"]);
      assert.deepEqual(saved.grantTypes, ["authorization_code", "refresh_token"]);
      assert.deepEqual(saved.responseTypes, ["code"]);
      assert.equal(typeof saved.createdAtMs, "number");

      const loaded = await harness.oauthDynamicClients.getOAuthDynamicClient(clientId);
      assert.deepEqual(loaded, saved);
      assert.equal(await harness.oauthDynamicClients.getOAuthDynamicClient(`${clientId}-missing`), undefined);
    } finally {
      await harness.db.getCorePool().query("DELETE FROM oauth_dynamic_clients WHERE client_id = $1", [clientId]);
    }
  });
});
