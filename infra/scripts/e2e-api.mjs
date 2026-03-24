import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const args = new Set(process.argv.slice(2));
const resetDb = !args.has("--no-reset-db");
const keepServices = args.has("--keep-services");
const teardownDb = args.has("--teardown-db");

const coreBaseUrl = process.env.E2E_CORE_URL ?? "http://127.0.0.1:4100";
const notesBaseUrl = process.env.E2E_NOTES_URL ?? "http://127.0.0.1:4101";
const artifactsBaseUrl = process.env.E2E_ARTIFACTS_URL ?? "http://127.0.0.1:4102";
const tasksBaseUrl = process.env.E2E_TASKS_URL ?? "http://127.0.0.1:4103";
const projectsBaseUrl = process.env.E2E_PROJECTS_URL ?? "http://127.0.0.1:4104";

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const WARN = "\x1b[33mWARN\x1b[0m";

function logStep(message) {
  console.log(`\n[STEP] ${message}`);
}

function trimBody(text, max = 280) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

async function readEnvFile(relativePath) {
  const abs = path.join(ROOT, relativePath);
  const text = await fs.readFile(abs, "utf8");
  return parseEnv(text);
}

function spawnShell(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: ROOT,
      shell: true,
      stdio: "inherit",
      ...options
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed (${code}): ${command}`));
      }
    });
  });
}

function startServices() {
  const child = spawn("npm run dev:services", {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[services] ${chunk.toString()}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[services] ${chunk.toString()}`);
  });

  return child;
}

async function stopServices(child) {
  if (!child || child.killed) return;

  if (process.platform === "win32") {
    await spawnShell(`taskkill /PID ${child.pid} /T /F`).catch(() => undefined);
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForHealth(url, timeoutMs = 120000) {
  const started = Date.now();
  let lastError = "";

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(1000);
  }

  throw new Error(`Health check timeout for ${url} (${lastError})`);
}

async function request(method, url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  if (options.body !== undefined) {
    if (typeof options.body === "string") {
      body = options.body;
    } else {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      body = JSON.stringify(options.body);
    }
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: options.redirect ?? "follow"
  });

  const text = await response.text();
  let json;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    text,
    json,
    headers: response.headers
  };
}

function base64UrlSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function ensure(condition, message, detail, state) {
  if (condition) {
    state.passes += 1;
    console.log(`${PASS} ${message}`);
    return;
  }

  state.failures += 1;
  console.error(`${FAIL} ${message}`);
  if (detail) {
    console.error(`       ${detail}`);
  }
}

function warn(message, detail, state) {
  state.warnings += 1;
  console.warn(`${WARN} ${message}`);
  if (detail) {
    console.warn(`       ${detail}`);
  }
}

function expectStatus(result, expected, label, state) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  const ok = expectedList.includes(result.status);
  ensure(
    ok,
    `${label} -> status ${result.status}`,
    ok ? undefined : `expected ${expectedList.join("/")} body=${trimBody(result.text)}`,
    state
  );
  return ok;
}

function createMockAuthServer() {
  const users = new Map();
  let loginAttempts = 0;
  let registerAttempts = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "invalid json" }));
        return;
      }
    }

    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (req.method === "POST" && req.url === "/auth/login") {
      loginAttempts += 1;
      const stored = users.get(username);
      if (!stored || stored !== password) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "invalid credentials" }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          accessToken: `login-token-${loginAttempts}`,
          refreshToken: `login-refresh-${loginAttempts}`
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/auth/register") {
      registerAttempts += 1;
      if (users.has(username)) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "already exists" }));
        return;
      }

      users.set(username, password);
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          accessToken: `register-token-${registerAttempts}`,
          refreshToken: `register-refresh-${registerAttempts}`
        })
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        stats: () => ({ loginAttempts, registerAttempts }),
        close: () =>
          new Promise((resClose) => {
            server.close(() => resClose());
          })
      });
    });
  });
}

async function deleteNotesServiceAccount(coreUserId) {
  const notesEnv = await readEnvFile("services/notes/.env");
  const { Pool } = await import("pg");
  const pool = new Pool({
    host: notesEnv.NOTES_DB_HOST,
    port: Number(notesEnv.NOTES_DB_PORT),
    database: notesEnv.NOTES_DB_NAME,
    user: notesEnv.NOTES_DB_USER,
    password: notesEnv.NOTES_DB_PASSWORD
  });

  try {
    await pool.query("DELETE FROM service_accounts WHERE core_user_id = $1", [coreUserId]);
  } finally {
    await pool.end();
  }
}

async function run() {
  const state = { passes: 0, failures: 0, warnings: 0 };

  const notesEnv = await readEnvFile("services/notes/.env");
  const artifactsEnv = await readEnvFile("services/artifacts/.env");
  const tasksEnv = await readEnvFile("services/tasks/.env");

  if (resetDb) {
    logStep("Reset Docker DB volumes");
    await spawnShell("docker compose down -v --remove-orphans");
  }

  logStep("Start Docker DB containers");
  await spawnShell("docker compose up -d");

  logStep("Start Core + internal services");
  const servicesProc = startServices();

  let mockAuth;

  try {
    logStep("Wait for service health endpoints");
    await waitForHealth(`${coreBaseUrl}/health`);
    await waitForHealth(`${notesBaseUrl}/health`);
    await waitForHealth(`${artifactsBaseUrl}/health`);
    await waitForHealth(`${tasksBaseUrl}/health`);
    await waitForHealth(`${projectsBaseUrl}/health`);

    logStep("Core OAuth metadata for MCP");
    const oauthMetadata = await request("GET", `${coreBaseUrl}/.well-known/oauth-authorization-server`);
    expectStatus(oauthMetadata, 200, "oauth authorization metadata", state);
    const expectedIssuer = `https://${new URL(coreBaseUrl).hostname}`;
    const oauthResource = `${expectedIssuer}/mcp`;
    ensure(oauthMetadata.json?.issuer === expectedIssuer, "oauth metadata issuer", undefined, state);
    ensure(
      oauthMetadata.json?.authorization_endpoint === `${expectedIssuer}/authorize`,
      "oauth metadata authorization endpoint",
      undefined,
      state
    );
    ensure(
      oauthMetadata.json?.token_endpoint === `${expectedIssuer}/oauth/token`,
      "oauth metadata token endpoint",
      undefined,
      state
    );
    ensure(
      Array.isArray(oauthMetadata.json?.grant_types_supported) &&
      oauthMetadata.json?.grant_types_supported.includes("authorization_code"),
      "oauth metadata grant_types includes authorization_code",
      undefined,
      state
    );
    ensure(
      !Array.isArray(oauthMetadata.json?.grant_types_supported) ||
      !oauthMetadata.json?.grant_types_supported.includes("client_credentials"),
      "oauth metadata does not advertise client_credentials",
      undefined,
      state
    );
    ensure(
      Array.isArray(oauthMetadata.json?.code_challenge_methods_supported) &&
      oauthMetadata.json?.code_challenge_methods_supported.includes("S256"),
      "oauth metadata code_challenge_methods includes S256",
      undefined,
      state
    );
    ensure(
      Array.isArray(oauthMetadata.json?.token_endpoint_auth_methods_supported) &&
      oauthMetadata.json?.token_endpoint_auth_methods_supported.includes("none"),
      "oauth metadata supports public clients (auth method none)",
      undefined,
      state
    );

    const oauthUnsupportedGrant = await request("POST", `${coreBaseUrl}/oauth/token`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=password"
    });
    expectStatus(oauthUnsupportedGrant, 400, "oauth unsupported grant rejected", state);
    ensure(
      oauthUnsupportedGrant.json?.error === "unsupported_grant_type",
      "oauth unsupported_grant_type error code",
      undefined,
      state
    );

    const mcpMissingBearer = await request("POST", `${coreBaseUrl}/mcp`, { body: {} });
    expectStatus(mcpMissingBearer, 401, "mcp missing bearer rejected", state);
    const mcpChallengeHeader = mcpMissingBearer.headers.get("www-authenticate") ?? "";
    ensure(
      mcpChallengeHeader.includes("resource_metadata="),
      "mcp 401 includes resource_metadata challenge",
      mcpChallengeHeader,
      state
    );
    ensure(
      mcpChallengeHeader.includes('scope="mcp:tools"'),
      "mcp 401 includes required scope challenge",
      mcpChallengeHeader,
      state
    );

    const stamp = Date.now();
    const userA = `e2e_user_a_${stamp}`;
    const userB = `e2e_user_b_${stamp}`;
    const password = `E2E-Pass-${stamp}`;

    logStep("Core auth + provisioning");
    const registerA = await request("POST", `${coreBaseUrl}/accounts/register`, {
      body: { username: userA, password }
    });
    expectStatus(registerA, 201, "register userA", state);
    const tokenA = registerA.json?.accessToken;
    const userAId = registerA.json?.user?.id;
    ensure(Boolean(tokenA), "register response includes accessToken", undefined, state);

    const provMap = new Map((registerA.json?.provisioning ?? []).map((row) => [row.serviceId, row.status]));
    for (const serviceId of ["notes", "artifacts", "tasks"]) {
      ensure(
        provMap.get(serviceId) === "ok",
        `register provisioning status ok for ${serviceId}`,
        `actual=${provMap.get(serviceId) ?? "missing"}`,
        state
      );
    }

    const loginA = await request("POST", `${coreBaseUrl}/accounts/login`, {
      body: { username: userA, password }
    });
    expectStatus(loginA, 200, "login userA", state);
    const tokenALogin = loginA.json?.accessToken;
    ensure(Boolean(tokenALogin), "login response includes accessToken", undefined, state);

    const meA = await request("GET", `${coreBaseUrl}/auth/me`, { token: tokenALogin });
    expectStatus(meA, 200, "auth/me userA", state);
    ensure(meA.json?.user?.username === userA, "auth/me returns correct username", undefined, state);

    const cimdClientIdUrl = process.env.E2E_CIMD_CLIENT_ID_URL?.trim();
    const cimdRedirectUri = process.env.E2E_CIMD_REDIRECT_URI?.trim();
    if (cimdClientIdUrl && cimdRedirectUri) {
      logStep("OAuth authorization_code + PKCE for MCP");
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = base64UrlSha256(codeVerifier);
      const authorizeGet = await request(
        "GET",
        `${coreBaseUrl}/authorize?response_type=code&client_id=${encodeURIComponent(cimdClientIdUrl)}&redirect_uri=${encodeURIComponent(cimdRedirectUri)}&resource=${encodeURIComponent(oauthResource)}&scope=${encodeURIComponent("mcp:tools")}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&state=e2e-state`
      );
      expectStatus(authorizeGet, 200, "authorize login form displayed", state);
      ensure(
        authorizeGet.text.includes("<form"),
        "authorize endpoint returns html form",
        undefined,
        state
      );

      const authorizePostBody = new URLSearchParams({
        response_type: "code",
        client_id: cimdClientIdUrl,
        redirect_uri: cimdRedirectUri,
        resource: oauthResource,
        scope: "mcp:tools",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: "e2e-state",
        username: userA,
        password
      }).toString();
      const authorizePost = await request("POST", `${coreBaseUrl}/authorize`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: authorizePostBody,
        redirect: "manual"
      });
      expectStatus(authorizePost, 302, "authorize returns redirect with code", state);
      const authorizeLocation = authorizePost.headers.get("location") ?? "";
      ensure(
        authorizeLocation.startsWith(cimdRedirectUri),
        "authorize redirect_uri target",
        authorizeLocation,
        state
      );
      const redirectedUrl = new URL(authorizeLocation);
      const authCode = redirectedUrl.searchParams.get("code") ?? "";
      ensure(Boolean(authCode), "authorize redirect contains code", undefined, state);
      ensure(redirectedUrl.searchParams.get("state") === "e2e-state", "authorize redirect preserves state", undefined, state);

      const oauthAuthCodeTokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cimdClientIdUrl,
        code: authCode,
        code_verifier: codeVerifier,
        redirect_uri: cimdRedirectUri,
        resource: oauthResource
      }).toString();
      const oauthAuthCodeToken = await request("POST", `${coreBaseUrl}/oauth/token`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: oauthAuthCodeTokenBody
      });
      expectStatus(oauthAuthCodeToken, 200, "authorization_code token success", state);
      ensure(
        typeof oauthAuthCodeToken.json?.access_token === "string",
        "authorization_code returns access token",
        undefined,
        state
      );

      const oauthPkceMcpCall = await request("POST", `${coreBaseUrl}/mcp`, {
        token: oauthAuthCodeToken.json?.access_token,
        body: {}
      });
      ensure(
        oauthPkceMcpCall.status !== 401,
        "authorization_code JWT accepted by /mcp auth layer",
        `status=${oauthPkceMcpCall.status} body=${trimBody(oauthPkceMcpCall.text)}`,
        state
      );

      const issueAuthorizationCode = async (stateValue, verifier, username, pass) => {
        const challenge = base64UrlSha256(verifier);
        const authorizeBody = new URLSearchParams({
          response_type: "code",
          client_id: cimdClientIdUrl,
          redirect_uri: cimdRedirectUri,
          resource: oauthResource,
          scope: "mcp:tools",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: stateValue,
          username,
          password: pass
        }).toString();
        const authRes = await request("POST", `${coreBaseUrl}/authorize`, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: authorizeBody,
          redirect: "manual"
        });
        expectStatus(authRes, 302, `authorize code issue (${stateValue})`, state);
        const location = authRes.headers.get("location") ?? "";
        if (!location) return "";
        const parsedLocation = new URL(location);
        return parsedLocation.searchParams.get("code") ?? "";
      };

      const badRedirectVerifier = randomBytes(32).toString("base64url");
      const badRedirectCode = await issueAuthorizationCode("bad-redirect", badRedirectVerifier, userA, password);
      const badRedirectToken = await request("POST", `${coreBaseUrl}/oauth/token`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: cimdClientIdUrl,
          code: badRedirectCode,
          code_verifier: badRedirectVerifier,
          redirect_uri: `${cimdRedirectUri}/wrong`,
          resource: oauthResource
        }).toString()
      });
      expectStatus(badRedirectToken, 400, "authorization_code rejects bad redirect_uri", state);

      const badPkceVerifier = randomBytes(32).toString("base64url");
      const badPkceCode = await issueAuthorizationCode("bad-pkce", badPkceVerifier, userA, password);
      const badPkceToken = await request("POST", `${coreBaseUrl}/oauth/token`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: cimdClientIdUrl,
          code: badPkceCode,
          code_verifier: randomBytes(32).toString("base64url"),
          redirect_uri: cimdRedirectUri,
          resource: oauthResource
        }).toString()
      });
      expectStatus(badPkceToken, 400, "authorization_code rejects bad PKCE verifier", state);

      const cimdVerifier = randomBytes(32).toString("base64url");
      const cimdChallenge = base64UrlSha256(cimdVerifier);
      const cimdAuthorize = await request(
        "GET",
        `${coreBaseUrl}/authorize?response_type=code&client_id=${encodeURIComponent(cimdClientIdUrl)}&redirect_uri=${encodeURIComponent(cimdRedirectUri)}&resource=${encodeURIComponent(oauthResource)}&scope=${encodeURIComponent("mcp:tools")}&code_challenge=${encodeURIComponent(cimdChallenge)}&code_challenge_method=S256&state=cimd-state`
      );
      expectStatus(cimdAuthorize, 200, "URL-based client_id metadata resolution success", state);
    } else {
      warn(
        "URL-based client_id metadata resolution test skipped",
        "Set E2E_CIMD_CLIENT_ID_URL and E2E_CIMD_REDIRECT_URI to enable this check.",
        state
      );
    }

    const badAudienceMcpCall = await request("POST", `${coreBaseUrl}/mcp`, {
      token: tokenALogin,
      body: {}
    });
    expectStatus(badAudienceMcpCall, 401, "mcp rejects token without expected audience", state);

    logStep("Core-managed integration manifests");
    const manifests = await request("GET", `${coreBaseUrl}/integrations/manifests`);
    expectStatus(manifests, 200, "list integration manifests via core", state);
    const manifestIds = new Set((manifests.json ?? []).map((row) => row.id));
    for (const integrationId of ["notes", "artifacts", "tasks"]) {
      ensure(manifestIds.has(integrationId), `core manifest includes ${integrationId}`, undefined, state);
    }

    logStep("Core facade notes CRUD");
    const createNote = await request("POST", `${coreBaseUrl}/api/notes`, {
      token: tokenALogin,
      body: {
        title: "E2E Note",
        content: "hello from e2e",
        projectId: "e2e-project",
        tags: ["e2e"]
      }
    });
    expectStatus(createNote, 201, "create note via core", state);
    const noteId = createNote.json?.id;

    const listNotes = await request("GET", `${coreBaseUrl}/api/notes`, { token: tokenALogin });
    expectStatus(listNotes, 200, "list notes via core", state);
    ensure(Array.isArray(listNotes.json), "notes list response is array", undefined, state);

    const getNote = await request("GET", `${coreBaseUrl}/api/notes/${noteId}`, { token: tokenALogin });
    expectStatus(getNote, 200, "get note via core", state);

    const patchNote = await request("PATCH", `${coreBaseUrl}/api/notes/${noteId}`, {
      token: tokenALogin,
      body: { title: "E2E Note Updated" }
    });
    expectStatus(patchNote, 200, "update note via core", state);

    const unauthNotes = await request("GET", `${coreBaseUrl}/api/notes`);
    expectStatus(unauthNotes, 401, "core notes require bearer", state);

    logStep("Core facade artifacts CRUD");
    const createArtifact = await request("POST", `${coreBaseUrl}/api/artifacts`, {
      token: tokenALogin,
      body: {
        name: "E2E Artifact",
        type: "document",
        description: "artifact body",
        projectId: "e2e-project",
        url: "https://example.com/e2e"
      }
    });
    expectStatus(createArtifact, 201, "create artifact via core", state);
    const artifactId = createArtifact.json?.id;

    const getArtifact = await request("GET", `${coreBaseUrl}/api/artifacts/${artifactId}`, { token: tokenALogin });
    expectStatus(getArtifact, 200, "get artifact via core", state);

    const deleteArtifact = await request("DELETE", `${coreBaseUrl}/api/artifacts/${artifactId}`, { token: tokenALogin });
    expectStatus(deleteArtifact, 204, "delete artifact via core", state);

    logStep("Forged header must not grant cross-user access");
    const registerB = await request("POST", `${coreBaseUrl}/accounts/register`, {
      body: { username: userB, password }
    });
    expectStatus(registerB, 201, "register userB", state);
    const tokenB = registerB.json?.accessToken;

    const crossRead = await request("GET", `${coreBaseUrl}/api/notes/${noteId}`, {
      token: tokenB,
      headers: {
        "x-workbench-username": userA
      }
    });
    expectStatus(crossRead, 404, "userB cannot read userA note even with forged header", state);

    logStep("Direct service auth gate + internal x-api-key gate");
    const notesForgedOnly = await request("GET", `${notesBaseUrl}/notes`, {
      headers: { "x-workbench-username": userA }
    });
    expectStatus(notesForgedOnly, 401, "notes service rejects forged header without bearer", state);

    const notesWithToken = await request("GET", `${notesBaseUrl}/notes`, { token: tokenALogin });
    expectStatus(notesWithToken, 200, "notes service accepts valid bearer", state);

    const notesInternalNoKey = await request("POST", `${notesBaseUrl}/internal/accounts`, {
      body: { coreUserId: `e2e-core-${stamp}-notes`, username: "e2e-notes-user" }
    });
    expectStatus(notesInternalNoKey, 403, "notes internal/accounts rejects missing key", state);

    const notesInternalWrong = await request("POST", `${notesBaseUrl}/internal/accounts`, {
      headers: { "x-api-key": "wrong-key" },
      body: { coreUserId: `e2e-core-${stamp}-notes2`, username: "e2e-notes-user2" }
    });
    expectStatus(notesInternalWrong, 403, "notes internal/accounts rejects invalid key", state);

    const notesInternalOk = await request("POST", `${notesBaseUrl}/internal/accounts`, {
      headers: { "x-api-key": notesEnv.INTERNAL_API_KEY },
      body: { coreUserId: `e2e-core-${stamp}-notes3`, username: "e2e-notes-user3" }
    });
    expectStatus(notesInternalOk, 201, "notes internal/accounts accepts valid x-api-key", state);

    const artifactsNoBearer = await request("GET", `${artifactsBaseUrl}/artifacts`, {
      headers: { "x-workbench-username": userA }
    });
    expectStatus(artifactsNoBearer, 401, "artifacts service rejects forged header", state);

    const artifactsInternalOk = await request("POST", `${artifactsBaseUrl}/internal/accounts`, {
      headers: { "x-api-key": artifactsEnv.INTERNAL_API_KEY },
      body: { coreUserId: `e2e-core-${stamp}-artifacts`, username: "e2e-artifacts-user" }
    });
    expectStatus(artifactsInternalOk, 201, "artifacts internal/accounts accepts valid x-api-key", state);

    const tasksNoBearer = await request("GET", `${tasksBaseUrl}/tasks`);
    expectStatus(tasksNoBearer, 401, "tasks service rejects missing bearer", state);

    const tasksWithBearer = await request("GET", `${tasksBaseUrl}/tasks`, { token: tokenALogin });
    if (tasksWithBearer.status === 200) {
      ensure(true, "tasks service accepts valid bearer", undefined, state);
    } else if (tasksWithBearer.status === 503) {
      warn("tasks business call reachable but LBS upstream unavailable", trimBody(tasksWithBearer.text), state);
    } else {
      ensure(false, "tasks service auth/business call", `status=${tasksWithBearer.status} body=${trimBody(tasksWithBearer.text)}`, state);
    }

    const tasksInternalOk = await request("POST", `${tasksBaseUrl}/internal/accounts`, {
      headers: { "x-api-key": tasksEnv.INTERNAL_API_KEY },
      body: { coreUserId: `e2e-core-${stamp}-tasks`, username: "e2e-tasks-user" }
    });
    expectStatus(tasksInternalOk, 201, "tasks internal/accounts accepts valid x-api-key", state);

    logStep("Integration activate flow (login fallback -> register, then login)");
    mockAuth = await createMockAuthServer();
    const integrationId = `mock-auth-${stamp}`;

    const activate1 = await request("PUT", `${coreBaseUrl}/integrations/configs/${integrationId}`, {
      token: tokenALogin,
      body: {
        enabled: true,
        values: {
          authBaseUrl: mockAuth.baseUrl,
          username: `linked-user-${stamp}`,
          password: `linked-pass-${stamp}`
        }
      }
    });
    expectStatus(activate1, 200, "activate integration first run", state);

    const cfgList1 = await request("GET", `${coreBaseUrl}/integrations/configs`, { token: tokenALogin });
    expectStatus(cfgList1, 200, "list integration configs after first activate", state);

    const cfg1 = (cfgList1.json ?? []).find((row) => row.integrationId === integrationId);
    ensure(Boolean(cfg1), "integration config exists after first activate", undefined, state);
    ensure(Boolean(cfg1?.values?.accessToken), "first activate saved accessToken", undefined, state);
    ensure(Boolean(cfg1?.values?.refreshToken), "first activate saved refreshToken", undefined, state);

    const statsAfterFirst = mockAuth.stats();
    ensure(statsAfterFirst.loginAttempts >= 1, "first activate attempted login", undefined, state);
    ensure(statsAfterFirst.registerAttempts >= 1, "first activate attempted register after login failure", undefined, state);

    const activate2 = await request("PUT", `${coreBaseUrl}/integrations/configs/${integrationId}`, {
      token: tokenALogin,
      body: {
        enabled: true,
        values: {
          authBaseUrl: mockAuth.baseUrl,
          username: `linked-user-${stamp}`,
          password: `linked-pass-${stamp}`
        }
      }
    });
    expectStatus(activate2, 200, "activate integration second run", state);

    const statsAfterSecond = mockAuth.stats();
    ensure(statsAfterSecond.loginAttempts >= 2, "second activate used login path", undefined, state);
    ensure(
      statsAfterSecond.registerAttempts === statsAfterFirst.registerAttempts,
      "second activate did not register again",
      `register attempts changed ${statsAfterFirst.registerAttempts} -> ${statsAfterSecond.registerAttempts}`,
      state
    );

    logStep("Login reprovision safety (recreate missing local account)");
    await deleteNotesServiceAccount(userAId);

    const loginAfterDelete = await request("POST", `${coreBaseUrl}/accounts/login`, {
      body: { username: userA, password }
    });
    expectStatus(loginAfterDelete, 200, "login userA after notes account deletion", state);
    const tokenAfterDelete = loginAfterDelete.json?.accessToken;

    const notesAfterReprovision = await request("GET", `${coreBaseUrl}/api/notes`, { token: tokenAfterDelete });
    expectStatus(notesAfterReprovision, 200, "core notes works after login reprovision", state);

    const deleteNote = await request("DELETE", `${coreBaseUrl}/api/notes/${noteId}`, { token: tokenAfterDelete });
    expectStatus(deleteNote, 204, "delete note via core", state);

    console.log("\n========== E2E API SUMMARY ==========");
    console.log(`Passes:   ${state.passes}`);
    console.log(`Warnings: ${state.warnings}`);
    console.log(`Failures: ${state.failures}`);

    if (state.failures > 0) {
      throw new Error(`E2E API failed with ${state.failures} failing checks.`);
    }
  } finally {
    if (mockAuth) {
      await mockAuth.close();
    }

    if (!keepServices) {
      await stopServices(servicesProc);
    }

    if (teardownDb) {
      await spawnShell("docker compose down -v --remove-orphans").catch(() => undefined);
    }
  }
}

run().catch((error) => {
  console.error(`\n${FAIL} ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
