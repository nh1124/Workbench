import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import net from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it, type TestContext } from "node:test";

/**
 * End-to-end coverage of the OAuth authorization-code and refresh-token grants.
 *
 * Before this, only the discovery metadata was tested: the code that actually
 * issues and validates tokens — PKCE, single-use codes, client/redirect/resource
 * binding and refresh rotation — had none. It is the highest risk area to move,
 * so this exists to be the safety net for splitting httpServer.ts, and asserts
 * observable HTTP behaviour only, never internals.
 *
 * Not covered: authorization-code and refresh-token expiry (both are time-based
 * and would need clock control), and genuine scope narrowing (only one scope
 * exists today, so no strict subset can be requested).
 */

type HttpServerModule = typeof import("../httpServer.js");
type DbModule = typeof import("../db.js");
type Harness = { httpServer: HttpServerModule; db: DbModule };

const CORE_ENV_URL = new URL("../../.env", import.meta.url);
let harnessPromise: Promise<Harness | { skipMessage: string }> | undefined;
let server: Server | undefined;
let baseUrl = "";

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
      // Only an unavailable database is a legitimate reason to skip. Once it is
      // reachable, an import or schema failure is a real defect — swallowing it
      // into a skip would let a broken extraction report a green suite.
      const [httpServer, db] = await Promise.all([import("../httpServer.js"), import("../db.js")]);
      await db.ensureCoreSchema();
      return { httpServer, db };
    })();
  }
  return harnessPromise;
}

async function requireHarness(t: TestContext): Promise<Harness | undefined> {
  const loaded = await loadHarness();
  if ("skipMessage" in loaded) { t.skip(loaded.skipMessage); return undefined; }
  if (!server) {
    server = loaded.httpServer.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  return loaded;
}

after(async () => {
  if (server) { server.close(); await once(server, "close"); }
  const loaded = await harnessPromise;
  if (loaded && !("skipMessage" in loaded)) await loaded.db.getCorePool().end();
});

// --- flow helpers -----------------------------------------------------------

// Dynamic registration only accepts https redirect URIs.
const REDIRECT_URI = "https://oauth-flow-test.example/callback";

function pkcePair() {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function form(values: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
    redirect: "manual"
  };
}

/** The token endpoint binds everything to this server's canonical resource. */
async function canonicalResource(): Promise<string> {
  const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  const body = await res.json() as { resource?: string };
  assert.equal(typeof body.resource, "string");
  return body.resource as string;
}

async function registerClient(grantTypes = ["authorization_code", "refresh_token"]): Promise<string> {
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `flow-test-${randomUUID().slice(0, 8)}`,
      redirect_uris: [REDIRECT_URI],
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  const raw = await res.text();
  assert.equal(res.status, 201, `client registration failed: ${raw}`);
  const body = JSON.parse(raw) as { client_id?: string };
  assert.equal(typeof body.client_id, "string");
  return body.client_id as string;
}

async function registerUser(): Promise<{ username: string; password: string }> {
  const username = `oauthflow_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = `Pw-${randomUUID()}`;
  const res = await fetch(`${baseUrl}/accounts/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(res.status, 201, `user registration failed: ${await res.text()}`);
  return { username, password };
}

/** Drives POST /authorize and returns the issued authorization code. */
async function authorize(input: {
  clientId: string;
  resource: string;
  challenge: string;
  username: string;
  password: string;
  state?: string;
  challengeMethod?: string;
}): Promise<string> {
  const res = await fetch(`${baseUrl}/authorize`, form({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: REDIRECT_URI,
    resource: input.resource,
    scope: "mcp:tools",
    code_challenge: input.challenge,
    code_challenge_method: input.challengeMethod ?? "S256",
    ...(input.state ? { state: input.state } : {}),
    username: input.username,
    password: input.password
  }));

  assert.equal(res.status, 302, `expected redirect, got ${res.status}: ${await res.text()}`);
  const location = res.headers.get("location");
  assert.ok(location, "authorize must redirect with a Location header");
  const target = new URL(location as string);
  // The code must be delivered to the registered callback, not anywhere else.
  const registered = new URL(REDIRECT_URI);
  assert.equal(`${target.origin}${target.pathname}`, `${registered.origin}${registered.pathname}`);
  const code = target.searchParams.get("code");
  assert.ok(code, "redirect must carry an authorization code");
  return code as string;
}

async function token(values: Record<string, string>) {
  const res = await fetch(`${baseUrl}/oauth/token`, form(values));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// --- tests ------------------------------------------------------------------

describe("OAuth authorization_code grant", () => {
  it("issues an access token and a refresh token for a valid PKCE exchange", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();

    const code = await authorize({ clientId, resource, challenge, ...user });
    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(typeof body.access_token, "string");
    assert.equal(body.token_type, "bearer");
    assert.equal(body.scope, "mcp:tools");
    assert.equal(typeof body.refresh_token, "string");
    assert.ok(Number(body.expires_in) > 0);

    // Asserting the shape alone would accept a junk or wrongly-signed token, so
    // spend it against a protected endpoint and confirm it identifies the user.
    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${body.access_token as string}` }
    });
    const meRaw = await me.text();
    assert.equal(me.status, 200, `issued access token was rejected: ${meRaw}`);
    const identity = JSON.parse(meRaw) as { user?: { username?: string } };
    assert.equal(identity.user?.username, user.username);
  });

  it("preserves state on the redirect so clients can correlate the callback", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { challenge } = pkcePair();
    const state = randomUUID();

    const res = await fetch(`${baseUrl}/authorize`, form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource,
      scope: "mcp:tools",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      ...user
    }));
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location") as string).searchParams.get("state"), state);
  });

  it("rejects a replayed authorization code", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });

    const exchange = () => token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource
    });

    assert.equal((await exchange()).status, 200);
    const replay = await exchange();
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
  });

  it("rejects a mismatched PKCE verifier and burns the code", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });

    const wrong = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pkcePair().verifier,
      redirect_uri: REDIRECT_URI,
      resource
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");

    // Retry with the CORRECT verifier: it must still fail, which is only true if
    // the failed attempt burned the code. Retrying with another wrong verifier
    // would fail either way and prove nothing.
    const retry = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource
    });
    assert.equal(retry.status, 400);
    assert.equal(retry.body.error, "invalid_grant", "a burned code must not become usable again");
  });

  it("rejects an exchange from a different client than the code was issued to", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const otherClientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });

    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: otherClientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource
    });
    assert.equal(status, 401);
    assert.equal(body.error, "invalid_client");
  });

  it("rejects a redirect_uri that differs from the authorize request", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });

    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "https://oauth-flow-test.example/other",
      resource
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_grant");
  });

  it("rejects a resource that is not this server's canonical resource", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });

    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: "https://someone-elses-server.example/mcp"
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_target");
  });

  it("falls back to the resource recorded on the code when the request omits it", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });

    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(typeof body.access_token, "string");
  });

  it("requires code, verifier and redirect_uri", async (t) => {
    if (!(await requireHarness(t))) return;

    const clientId = await registerClient();
    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: "",
      code_verifier: "",
      redirect_uri: ""
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_request");
  });

  it("requires a client_id", async (t) => {
    if (!(await requireHarness(t))) return;

    const { status, body } = await token({ grant_type: "authorization_code" });
    assert.equal(status, 401);
    assert.equal(body.error, "invalid_client");
  });

  it("rejects an unsupported grant type", async (t) => {
    if (!(await requireHarness(t))) return;

    const { status, body } = await token({ grant_type: "password" });
    assert.equal(status, 400);
    assert.equal(body.error, "unsupported_grant_type");
  });

  it("issues no refresh token to a client that did not register the grant", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient(["authorization_code"]);
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });

    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(typeof body.access_token, "string");
    assert.equal(body.refresh_token, undefined);
  });
});

describe("POST /authorize", () => {
  it("re-renders the form without a code when the password is wrong", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();

    const res = await fetch(`${baseUrl}/authorize`, form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource,
      scope: "mcp:tools",
      code_challenge: pkcePair().challenge,
      code_challenge_method: "S256",
      username: user.username,
      password: "not-the-password"
    }));

    assert.equal(res.status, 401);
    assert.equal(res.headers.get("location"), null);
    assert.match(await res.text(), /Invalid username or password/);
  });

  it("rejects an authorize request aimed at another server's resource", async (t) => {
    if (!(await requireHarness(t))) return;

    const clientId = await registerClient();
    const user = await registerUser();

    const res = await fetch(`${baseUrl}/authorize`, form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: "https://someone-elses-server.example/mcp",
      scope: "mcp:tools",
      code_challenge: pkcePair().challenge,
      code_challenge_method: "S256",
      ...user
    }));

    assert.equal(res.status, 400);
    assert.equal((await res.json() as Record<string, unknown>).error, "invalid_target");
  });

  it("rejects an unregistered redirect_uri", async (t) => {
    if (!(await requireHarness(t))) return;

    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();

    const res = await fetch(`${baseUrl}/authorize`, form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://oauth-flow-test.example/not-registered",
      resource,
      scope: "mcp:tools",
      code_challenge: pkcePair().challenge,
      code_challenge_method: "S256",
      ...user
    }));

    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
  });
});

describe("OAuth refresh_token grant", () => {
  async function issueRefreshToken(): Promise<{ clientId: string; refreshToken: string; resource: string }> {
    const resource = await canonicalResource();
    const clientId = await registerClient();
    const user = await registerUser();
    const { verifier, challenge } = pkcePair();
    const code = await authorize({ clientId, resource, challenge, ...user });
    const { body } = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource
    });
    return { clientId, refreshToken: body.refresh_token as string, resource };
  }

  it("exchanges a refresh token for a new access token", async (t) => {
    if (!(await requireHarness(t))) return;

    const { clientId, refreshToken } = await issueRefreshToken();
    const { status, body } = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(typeof body.access_token, "string");
    assert.equal(body.token_type, "bearer");
    assert.equal(body.scope, "mcp:tools");
  });

  it("rotates the refresh token and revokes the one just spent", async (t) => {
    if (!(await requireHarness(t))) return;

    const { clientId, refreshToken } = await issueRefreshToken();
    const first = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const rotated = first.body.refresh_token;
    assert.equal(typeof rotated, "string", "refresh grant must return a rotated token");
    assert.notEqual(rotated, refreshToken, "the rotated token must differ from the one spent");

    // Replaying the spent token must fail, otherwise rotation buys nothing.
    const replay = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");

    // The rotated token must itself still work.
    const second = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rotated as string
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
  });

  it("rejects an unknown refresh token", async (t) => {
    if (!(await requireHarness(t))) return;

    const clientId = await registerClient();
    const { status, body } = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: randomBytes(32).toString("hex")
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_grant");
  });

  it("rejects a refresh token presented by a different client", async (t) => {
    if (!(await requireHarness(t))) return;

    const { refreshToken } = await issueRefreshToken();
    const otherClientId = await registerClient();
    const { status, body } = await token({
      grant_type: "refresh_token",
      client_id: otherClientId,
      refresh_token: refreshToken
    });
    assert.equal(status, 401);
    assert.equal(body.error, "invalid_client");
  });

  it("requires a refresh token and a client_id", async (t) => {
    if (!(await requireHarness(t))) return;

    const clientId = await registerClient();
    const missingToken = await token({ grant_type: "refresh_token", client_id: clientId });
    assert.equal(missingToken.status, 400);
    assert.equal(missingToken.body.error, "invalid_request");

    const missingClient = await token({ grant_type: "refresh_token", refresh_token: "x" });
    assert.equal(missingClient.status, 401);
    assert.equal(missingClient.body.error, "invalid_client");
  });

  // Only one scope (mcp:tools) exists today, so a genuine narrowing case cannot
  // be expressed; this covers the rejection path only.
  it("rejects a scope the original grant did not include", async (t) => {
    if (!(await requireHarness(t))) return;

    const { clientId, refreshToken } = await issueRefreshToken();
    const { status, body } = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      scope: "mcp:tools admin:everything"
    });
    assert.equal(status, 400);
    assert.ok(
      body.error === "invalid_scope" || body.error === "invalid_grant",
      `expected a scope rejection, got ${JSON.stringify(body)}`
    );
  });
});
