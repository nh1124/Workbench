import assert from "node:assert/strict";
import test from "node:test";

const runIntegration = process.env.RUN_PROJECTS_DB_TESTS === "1";

test("Projects HTTP context routes return owner-scoped 404, 409 and 400 responses", { skip: !runIntegration }, async () => {
  process.env.PROJECTS_DB_HOST ??= "127.0.0.1";
  process.env.PROJECTS_DB_PORT ??= "5546";
  process.env.PROJECTS_DB_NAME ??= "projects_db";
  process.env.PROJECTS_DB_USER ??= "projects_user";
  process.env.PROJECTS_DB_PASSWORD ??= "projects_pass";
  process.env.PROJECTS_SERVICE_HOST ??= "127.0.0.1";
  process.env.PROJECTS_SERVICE_PORT ??= "4104";
  process.env.JWT_SECRET ??= "test-projects-jwt-secret";
  process.env.JWT_ISSUER ??= "workbench-core";
  process.env.INTERNAL_API_KEY ??= "test-internal-key";
  const [{ app }, jwt, db] = await Promise.all([import("../httpServer.js"), import("jsonwebtoken"), import("../db.js")]);
  const owner = `http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await db.upsertServiceAccount(owner, owner);
  const token = jwt.default.sign({ sub: owner, username: owner, tokenUse: "access" }, process.env.JWT_SECRET, {
    algorithm: "HS256", issuer: process.env.JWT_ISSUER
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const createdResponse = await fetch(`${base}/projects`, { method: "POST", headers, body: JSON.stringify({ name: "HTTP project" }) });
    const project = await createdResponse.json() as { id: string };
    const updated = await fetch(`${base}/projects/${project.id}/brief`, {
      method: "PUT", headers, body: JSON.stringify({ contentMarkdown: "brief", expectedVersion: 0, updatedByKind: "user" })
    });
    assert.equal(updated.status, 200);
    const conflict = await fetch(`${base}/projects/${project.id}/brief`, {
      method: "PUT", headers, body: JSON.stringify({ contentMarkdown: "stale", expectedVersion: 0, updatedByKind: "agent" })
    });
    assert.equal(conflict.status, 409);
    const invalidTimestampCursor = Buffer.from(JSON.stringify({ t: "not-a-timestamp", id: "cursor-id" }), "utf8").toString("base64url");
    const cursorRoutePaths = [
      "/projects",
      "/projects/search?query=HTTP",
      `/projects/${project.id}/links`,
      "/project-links?targetService=artifacts&targetResourceType=artifact_item&targetResourceId=artifact-a",
      `/projects/${project.id}/memories`,
      `/projects/${project.id}/index-entries`,
      `/projects/${project.id}/relations`
    ];
    const withCursor = (path: string, cursorQuery: string) => `${path}${path.includes("?") ? "&" : "?"}${cursorQuery}`;
    const invalidCursorPaths = cursorRoutePaths.flatMap((path) => [
      withCursor(path, `cursor=${invalidTimestampCursor}`),
      withCursor(path, "cursor=first&cursor=second")
    ]);
    for (const path of invalidCursorPaths) {
      const invalidCursor = await fetch(`${base}${path}`, { headers });
      assert.equal(invalidCursor.status, 400, path);
      assert.equal((await invalidCursor.json() as { code?: string }).code, "INVALID_CURSOR", path);
    }
    const missing = await fetch(`${base}/projects/missing/brief`, { headers });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.getProjectsPool().query(`DELETE FROM projects WHERE owner_account_id = $1`, [owner]);
    await db.getProjectsPool().query(`DELETE FROM service_accounts WHERE core_user_id = $1`, [owner]);
    await db.getProjectsPool().end();
  }
});
