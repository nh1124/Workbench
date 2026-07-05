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
  process.env.WORKBENCH_MAINTENANCE_UNCONFIRMED_DAYS = "30";
  process.env.WORKBENCH_MAINTENANCE_BRIEF_MIN_CHARS = "80";
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

    const backfillProjectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Backfill maintenance project" })
    });
    const backfillProject = await backfillProjectResponse.json() as { id: string };
    const backfillMemoryResponse = await fetch(`${base}/projects/${backfillProject.id}/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "fact",
        bodyMarkdown: "confirmed fact",
        authority: "user_confirmed",
        createdByKind: "user"
      })
    });
    const backfillMemory = await backfillMemoryResponse.json() as { id: string; lifecycleState: string; lastConfirmedAt: string | null };
    assert.equal(backfillMemory.lifecycleState, "triaged");
    assert.equal(backfillMemory.lastConfirmedAt, null);
    await db.backfillProjectMemoryLifecycle();
    const backfilledListResponse = await fetch(`${base}/projects/${backfillProject.id}/memories`, { headers });
    const backfilledList = await backfilledListResponse.json() as {
      items: Array<{ id: string; lifecycleState: string; lastConfirmedAt: string | null; updatedAt: string }>;
    };
    const backfilled = backfilledList.items.find((item) => item.id === backfillMemory.id);
    assert.equal(backfilled?.lifecycleState, "verified");
    assert.equal(backfilled?.lastConfirmedAt, backfilled?.updatedAt);

    const queueProjectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Maintenance queue project" })
    });
    const queueProject = await queueProjectResponse.json() as { id: string; name: string };
    const otherQueueProjectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Other owner maintenance queue project" })
    });
    const otherQueueProject = await otherQueueProjectResponse.json() as { id: string };
    const postMemory = async (projectId: string, body: Record<string, unknown>, authHeaders = headers) => {
      const response = await fetch(`${base}/projects/${projectId}/memories`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 201);
      return response.json() as Promise<{ id: string }>;
    };
    const rawMemory = await postMemory(queueProject.id, {
      kind: "observation",
      bodyMarkdown: "raw queue memory",
      authority: "user_confirmed",
      lifecycleState: "raw",
      createdByKind: "user"
    });
    const expiredMemory = await postMemory(queueProject.id, {
      kind: "fact",
      bodyMarkdown: "expired queue memory",
      authority: "user_confirmed",
      reviewAfter: "2000-01-01T00:00:00.000Z",
      createdByKind: "user"
    });
    const unconfirmedMemory = await postMemory(queueProject.id, {
      kind: "observation",
      bodyMarkdown: "old agent queue memory",
      authority: "agent_observed",
      createdByKind: "agent"
    });
    await db.getProjectsPool().query(
      `UPDATE project_memory_entries
       SET created_at = NOW() - INTERVAL '45 days',
           updated_at = NOW() - INTERVAL '45 days'
       WHERE id = $1`,
      [unconfirmedMemory.id]
    );
    const futureVerifiedMemory = await postMemory(queueProject.id, {
      kind: "decision",
      bodyMarkdown: "future verified queue memory",
      authority: "user_confirmed",
      lifecycleState: "verified",
      reviewAfter: "2099-01-01T00:00:00.000Z",
      createdByKind: "user"
    });
    const otherOwnerMemory = await postMemory(otherQueueProject.id, {
      kind: "observation",
      bodyMarkdown: "other owner raw queue memory",
      authority: "user_confirmed",
      lifecycleState: "raw",
      createdByKind: "user"
    }, { authorization: `Bearer ${otherToken}`, "content-type": "application/json" });

    const memoryQueueResponse = await fetch(`${base}/maintenance/memory-queue?projectId=${queueProject.id}&limit=2`, { headers });
    assert.equal(memoryQueueResponse.status, 200);
    const memoryQueue = await memoryQueueResponse.json() as {
      items: Array<{ resourceId: string; reasons: string[]; lifecycleState?: string; bodyMarkdown?: string }>;
      nextCursor?: string;
      totals: { byReason: Record<string, number> };
    };
    assert.equal(memoryQueue.items.length, 2);
    assert.ok(memoryQueue.nextCursor);
    assert.equal(memoryQueue.totals.byReason.raw, 1);
    assert.equal(memoryQueue.totals.byReason.expired, 1);
    assert.equal(memoryQueue.totals.byReason.unconfirmed, 1);
    const memoryQueuePage2Response = await fetch(
      `${base}/maintenance/memory-queue?projectId=${queueProject.id}&cursor=${encodeURIComponent(memoryQueue.nextCursor ?? "")}`,
      { headers }
    );
    const memoryQueuePage2 = await memoryQueuePage2Response.json() as { items: Array<{ resourceId: string; reasons: string[] }> };
    const queuedMemoryIds = [...memoryQueue.items, ...memoryQueuePage2.items].map((item) => item.resourceId);
    assert.ok(queuedMemoryIds.includes(rawMemory.id));
    assert.ok(queuedMemoryIds.includes(expiredMemory.id));
    assert.ok(queuedMemoryIds.includes(unconfirmedMemory.id));
    assert.ok(!queuedMemoryIds.includes(futureVerifiedMemory.id));

    const rawFilteredResponse = await fetch(`${base}/maintenance/memory-queue?projectId=${queueProject.id}&reason=raw`, { headers });
    const rawFiltered = await rawFilteredResponse.json() as {
      items: Array<{ resourceId: string; reasons: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.deepEqual(rawFiltered.items.map((item) => item.resourceId), [rawMemory.id]);
    assert.deepEqual(rawFiltered.items[0]?.reasons, ["raw"]);
    assert.equal(rawFiltered.totals.byReason.raw, 1);

    const ownerScopedQueueResponse = await fetch(`${base}/maintenance/memory-queue`, { headers });
    const ownerScopedQueue = await ownerScopedQueueResponse.json() as { items: Array<{ resourceId: string }> };
    assert.ok(!ownerScopedQueue.items.some((item) => item.resourceId === otherOwnerMemory.id));

    const briefQueueResponse = await fetch(`${base}/maintenance/brief-queue?projectId=${queueProject.id}`, { headers });
    assert.equal(briefQueueResponse.status, 200);
    const briefQueue = await briefQueueResponse.json() as {
      items: Array<{ kind: string; projectId: string; reasons: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.equal(briefQueue.items.length, 1);
    assert.equal(briefQueue.items[0]?.kind, "brief");
    assert.equal(briefQueue.items[0]?.projectId, queueProject.id);
    assert.deepEqual(briefQueue.items[0]?.reasons, ["brief_unmaintained"]);
    assert.equal(briefQueue.totals.byReason.brief_unmaintained, 1);

    const archivedProjectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Archived maintenance queue project", status: "archived" })
    });
    const archivedProject = await archivedProjectResponse.json() as { id: string };
    const archivedBriefQueueResponse = await fetch(`${base}/maintenance/brief-queue?projectId=${archivedProject.id}`, { headers });
    assert.equal(archivedBriefQueueResponse.status, 200);
    const archivedBriefQueue = await archivedBriefQueueResponse.json() as {
      items: Array<{ projectId: string }>;
      totals: { byReason: Record<string, number> };
    };
    assert.deepEqual(archivedBriefQueue.items, []);
    assert.equal(archivedBriefQueue.totals.byReason.brief_unmaintained, undefined);

    const driftResponse = await fetch(`${base}/projects/${queueProject.id}/index-entries/upsert`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceService: "artifacts",
        resourceType: "note",
        resourceId: `drift-${Date.now()}`,
        associationKind: "primary",
        title: "Drifting index entry",
        summaryText: "source changed after indexing",
        sourceUpdatedAt: "2099-01-01T00:00:00.000Z"
      })
    });
    const driftingEntry = await driftResponse.json() as { id: string };
    const indexDriftQueueResponse = await fetch(`${base}/maintenance/index-drift?projectId=${queueProject.id}`, { headers });
    assert.equal(indexDriftQueueResponse.status, 200);
    const indexDriftQueue = await indexDriftQueueResponse.json() as {
      items: Array<{ resourceId: string; reasons: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.deepEqual(indexDriftQueue.items.map((item) => item.resourceId), [driftingEntry.id]);
    assert.deepEqual(indexDriftQueue.items[0]?.reasons, ["source_changed"]);
    assert.equal(indexDriftQueue.totals.byReason.source_changed, 1);

    const memoryListResponse = await fetch(`${base}/projects/${queueProject.id}/memories`, { headers });
    const memoryList = await memoryListResponse.json() as {
      items: Array<{ id: string; bodyMarkdown: string; lifecycleState?: string; reviewAfter?: string | null; lastConfirmedAt?: string | null }>;
    };
    const rawListed = memoryList.items.find((item) => item.id === rawMemory.id);
    assert.equal(rawListed?.bodyMarkdown, "raw queue memory");
    assert.equal(rawListed?.lifecycleState, "raw");
    assert.equal(rawListed?.reviewAfter, null);
    assert.equal(rawListed?.lastConfirmedAt, null);
    const contextResponse = await fetch(`${base}/projects/${queueProject.id}/context?include=memory&memoryLimit=10`, { headers });
    const context = await contextResponse.json() as {
      memories?: Array<{ id: string; bodyMarkdown: string; lifecycleState?: string; reviewAfter?: string | null }>;
    };
    assert.ok(context.memories?.some((item) => item.id === rawMemory.id && item.bodyMarkdown === "raw queue memory" && item.lifecycleState === "raw"));

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
