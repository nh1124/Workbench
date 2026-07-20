import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { after, describe, it, type TestContext } from "node:test";

type HttpServerModule = typeof import("../httpServer.js");
type DbModule = typeof import("../db.js");
type Harness = { httpServer: HttpServerModule; db: DbModule };

const CORE_ENV_URL = new URL("../../.env", import.meta.url);
let harnessPromise: Promise<Harness | { skipMessage: string }> | undefined;

function parseEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
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
    const finish = (reachable: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(reachable); };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function loadHarness(): Promise<Harness | { skipMessage: string }> {
  if (!harnessPromise) {
    harnessPromise = (async () => {
      const endpoint = await readDbEndpoint();
      if (!endpoint) return { skipMessage: "Core DB env is not configured." };
      if (!(await canReachTcp(endpoint.host, endpoint.port))) {
        return { skipMessage: `Core DB is not reachable at ${endpoint.host}:${endpoint.port}.` };
      }
      try {
        const [httpServer, db] = await Promise.all([import("../httpServer.js"), import("../db.js")]);
        return { httpServer, db };
      } catch (error) {
        return { skipMessage: `Core metadata harness is unavailable: ${error instanceof Error ? error.message : String(error)}` };
      }
    })();
  }
  return harnessPromise;
}

async function requireHarness(t: TestContext): Promise<Harness | undefined> {
  const loaded = await loadHarness();
  if ("skipMessage" in loaded) { t.skip(loaded.skipMessage); return undefined; }
  return loaded;
}

after(async () => {
  const loaded = await harnessPromise;
  if (loaded && !("skipMessage" in loaded)) await loaded.db.getCorePool().end();
});

describe("OAuth authorization server metadata", () => {
  it("advertises RFC 8414 required fields including response_types_supported", async (t) => {
    const harness = await requireHarness(t);
    if (!harness) return;

    const server = harness.httpServer.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;

      // RFC 8414 §2: issuer and response_types_supported are REQUIRED; the MCP
      // TS SDK rejects metadata whose response_types_supported is not an array.
      assert.equal(typeof body.issuer, "string");
      assert.ok(Array.isArray(body.response_types_supported), "response_types_supported must be an array");
      assert.deepEqual(body.response_types_supported, ["code"]);
      assert.ok(Array.isArray(body.grant_types_supported));
      assert.ok(Array.isArray(body.code_challenge_methods_supported));
      assert.equal(typeof body.authorization_endpoint, "string");
      assert.equal(typeof body.token_endpoint, "string");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
