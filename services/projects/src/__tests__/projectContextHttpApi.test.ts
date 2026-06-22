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
  const otherOwner = `${owner}-other`;
  await db.upsertServiceAccount(owner, owner);
  await db.upsertServiceAccount(otherOwner, otherOwner);
  const token = jwt.default.sign({ sub: owner, username: owner, tokenUse: "access" }, process.env.JWT_SECRET, {
    algorithm: "HS256", issuer: process.env.JWT_ISSUER
  });
  const otherToken = jwt.default.sign({ sub: otherOwner, username: otherOwner, tokenUse: "access" }, process.env.JWT_SECRET, {
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
    const targetResponse = await fetch(`${base}/projects`, { method: "POST", headers, body: JSON.stringify({ name: "HTTP relation target" }) });
    const targetProject = await targetResponse.json() as { id: string };
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

    const relationCreate = await fetch(`${base}/projects/${project.id}/relations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targetProjectId: targetProject.id, relationType: "related", createdByKind: "user" })
    });
    assert.equal(relationCreate.status, 201);
    const relation = await relationCreate.json() as { id: string; sourceProjectId: string; targetProjectId: string };
    const relationRead = await fetch(`${base}/project-relations/${relation.id}`, { headers });
    assert.equal(relationRead.status, 200);
    assert.deepEqual(await relationRead.json(), relation);
    const relationOtherOwner = await fetch(`${base}/project-relations/${relation.id}`, {
      headers: { authorization: `Bearer ${otherToken}` }
    });
    assert.equal(relationOtherOwner.status, 404);

    const syncSnapshotResponse = await fetch(`${base}/projects/${project.id}/sync-context`, { headers });
    assert.equal(syncSnapshotResponse.status, 200);
    const syncSnapshot = await syncSnapshotResponse.json() as { complete: boolean; counts: { relations: number }; relations: unknown[] };
    assert.equal(syncSnapshot.complete, true);
    assert.equal(syncSnapshot.counts.relations, 1);
    assert.equal(syncSnapshot.relations.length, 1);
    const syncOtherOwner = await fetch(`${base}/projects/${project.id}/sync-context`, {
      headers: { authorization: `Bearer ${otherToken}` }
    });
    assert.equal(syncOtherOwner.status, 404);

    const exportSnapshotResponse = await fetch(`${base}/projects/${project.id}/context-export`, { headers });
    assert.equal(exportSnapshotResponse.status, 200);
    const exportSnapshot = await exportSnapshotResponse.json() as { packageType: string; complete: boolean; counts: { relations: number } };
    assert.equal(exportSnapshot.packageType, "workbench.project-context-export");
    assert.equal(exportSnapshot.complete, true);
    assert.equal(exportSnapshot.counts.relations, 1);
    const exportOtherOwner = await fetch(`${base}/projects/${project.id}/context-export`, {
      headers: { authorization: `Bearer ${otherToken}` }
    });
    assert.equal(exportOtherOwner.status, 404);

    const relationDelete = await fetch(`${base}/project-relations/${relation.id}`, { method: "DELETE", headers });
    assert.equal(relationDelete.status, 204);
    assert.equal((await fetch(`${base}/project-relations/${relation.id}`, { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.getProjectsPool().query(`DELETE FROM projects WHERE owner_account_id = ANY($1::text[])`, [[owner, otherOwner]]);
    await db.getProjectsPool().query(`DELETE FROM service_accounts WHERE core_user_id = ANY($1::text[])`, [[owner, otherOwner]]);
    await db.getProjectsPool().end();
  }
});
