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
  process.env.WORKBENCH_MAINTENANCE_BRIEF_MAX_CHARS = "2000";
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
  const otherHeaders = { authorization: `Bearer ${otherToken}`, "content-type": "application/json" };
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
    const invalidIndexMode = await fetch(`${base}/projects/${project.id}/index-entries?mode=some`, { headers });
    assert.equal(invalidIndexMode.status, 400);
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
      headers: otherHeaders,
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
    }, otherHeaders);

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

    const healthyBriefProjectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Healthy brief maintenance project" })
    });
    const healthyBriefProject = await healthyBriefProjectResponse.json() as { id: string };
    const healthyBriefResponse = await fetch(`${base}/projects/${healthyBriefProject.id}/brief`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ contentMarkdown: "h".repeat(100), expectedVersion: 0, updatedByKind: "user" })
    });
    assert.equal(healthyBriefResponse.status, 200);

    const oversizedBriefProjectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Oversized brief maintenance project" })
    });
    const oversizedBriefProject = await oversizedBriefProjectResponse.json() as { id: string };
    const oversizedBriefResponse = await fetch(`${base}/projects/${oversizedBriefProject.id}/brief`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ contentMarkdown: "x".repeat(2001), expectedVersion: 0, updatedByKind: "agent" })
    });
    assert.equal(oversizedBriefResponse.status, 200);

    const briefQueueResponse = await fetch(`${base}/maintenance/brief-queue?projectId=${queueProject.id}`, { headers });
    assert.equal(briefQueueResponse.status, 200);
    const briefQueue = await briefQueueResponse.json() as {
      items: Array<{ kind: string; projectId: string; reasons: string[]; suggestedActions: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.equal(briefQueue.items.length, 1);
    assert.equal(briefQueue.items[0]?.kind, "brief");
    assert.equal(briefQueue.items[0]?.projectId, queueProject.id);
    assert.deepEqual(briefQueue.items[0]?.reasons, ["brief_unmaintained"]);
    assert.deepEqual(briefQueue.items[0]?.suggestedActions, ["update_brief"]);
    assert.equal(briefQueue.totals.byReason.brief_unmaintained, 1);

    const oversizedBriefQueueResponse = await fetch(
      `${base}/maintenance/brief-queue?projectId=${oversizedBriefProject.id}&reason=brief_oversized`,
      { headers }
    );
    assert.equal(oversizedBriefQueueResponse.status, 200);
    const oversizedBriefQueue = await oversizedBriefQueueResponse.json() as {
      items: Array<{ projectId: string; reasons: string[]; suggestedActions: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.equal(oversizedBriefQueue.items.length, 1);
    assert.equal(oversizedBriefQueue.items[0]?.projectId, oversizedBriefProject.id);
    assert.deepEqual(oversizedBriefQueue.items[0]?.reasons, ["brief_oversized"]);
    assert.deepEqual(oversizedBriefQueue.items[0]?.suggestedActions, ["slim_brief"]);
    assert.equal(oversizedBriefQueue.totals.byReason.brief_oversized, 1);

    const healthyBriefQueueResponse = await fetch(`${base}/maintenance/brief-queue?projectId=${healthyBriefProject.id}`, { headers });
    assert.equal(healthyBriefQueueResponse.status, 200);
    const healthyBriefQueue = await healthyBriefQueueResponse.json() as {
      items: Array<{ projectId: string; reasons: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.deepEqual(healthyBriefQueue.items, []);
    assert.equal(healthyBriefQueue.totals.byReason.brief_unmaintained, undefined);
    assert.equal(healthyBriefQueue.totals.byReason.brief_oversized, undefined);

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

    const readMarkActiveResourceId = `read-active-${Date.now()}`;
    const readMarkDeletedResourceId = `read-deleted-${Date.now()}`;
    const readMarkOtherResourceId = `read-other-${Date.now()}`;
    const readMarkActiveResponse = await fetch(`${base}/projects/${queueProject.id}/index-entries/upsert`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceService: "artifacts",
        resourceType: "note",
        resourceId: readMarkActiveResourceId,
        associationKind: "primary",
        title: "Read mark active",
        summaryText: "active read mark target",
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z"
      })
    });
    const readMarkActive = await readMarkActiveResponse.json() as { id: string };
    const readMarkDeletedResponse = await fetch(`${base}/projects/${queueProject.id}/index-entries/upsert`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceService: "artifacts",
        resourceType: "note",
        resourceId: readMarkDeletedResourceId,
        associationKind: "primary",
        title: "Read mark deleted",
        summaryText: "deleted read mark target",
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z"
      })
    });
    const readMarkDeleted = await readMarkDeletedResponse.json() as { id: string };
    await fetch(`${base}/projects/${queueProject.id}/index-entries/tombstone`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceService: "artifacts",
        resourceType: "note",
        resourceId: readMarkDeletedResourceId
      })
    });
    const readMarkOtherResponse = await fetch(`${base}/projects/${otherQueueProject.id}/index-entries/upsert`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({
        sourceService: "artifacts",
        resourceType: "note",
        resourceId: readMarkOtherResourceId,
        associationKind: "primary",
        title: "Read mark other owner",
        summaryText: "other owner read mark target",
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z"
      })
    });
    const readMarkOther = await readMarkOtherResponse.json() as { id: string };
    const readMarkResponse = await fetch(`${base}/maintenance/index-read-marks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        marks: [
          { sourceService: "artifacts", resourceId: readMarkActiveResourceId },
          { sourceService: "artifacts", resourceId: readMarkDeletedResourceId },
          { sourceService: "artifacts", resourceId: readMarkOtherResourceId }
        ],
        readAt: "2026-07-01T00:00:00.000Z"
      })
    });
    assert.equal(readMarkResponse.status, 200);
    assert.deepEqual(await readMarkResponse.json(), { updated: 1 });
    const readMarks = await db.getProjectsPool().query<{ id: string; last_read_at: string | null }>(
      `SELECT id, last_read_at::text FROM project_index_entries WHERE id = ANY($1::text[]) ORDER BY id`,
      [[readMarkActive.id, readMarkDeleted.id, readMarkOther.id]]
    );
    const readMarkMap = new Map(readMarks.rows.map((row) => [row.id, row.last_read_at]));
    assert.ok(readMarkMap.get(readMarkActive.id));
    assert.equal(readMarkMap.get(readMarkDeleted.id), null);
    assert.equal(readMarkMap.get(readMarkOther.id), null);

    const unusedResourceId = `unused-${Date.now()}`;
    const recentReadResourceId = `recent-read-${Date.now()}`;
    const unusedResponse = await fetch(`${base}/projects/${queueProject.id}/index-entries/upsert`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceService: "artifacts",
        resourceType: "note",
        resourceId: unusedResourceId,
        associationKind: "primary",
        title: "Unused index entry",
        summaryText: "old and unread",
        sourceUpdatedAt: "2025-01-01T00:00:00.000Z"
      })
    });
    const unusedEntry = await unusedResponse.json() as { id: string };
    const recentReadResponse = await fetch(`${base}/projects/${queueProject.id}/index-entries/upsert`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceService: "artifacts",
        resourceType: "note",
        resourceId: recentReadResourceId,
        associationKind: "primary",
        title: "Recently read old index entry",
        summaryText: "old but read recently",
        sourceUpdatedAt: "2025-01-01T00:00:00.000Z"
      })
    });
    const recentReadEntry = await recentReadResponse.json() as { id: string };
    await db.getProjectsPool().query(
      `UPDATE project_index_entries
       SET indexed_at = NOW() - INTERVAL '120 days',
           source_updated_at = NOW() - INTERVAL '130 days',
           last_read_at = NULL
       WHERE id = $1`,
      [unusedEntry.id]
    );
    await db.getProjectsPool().query(
      `UPDATE project_index_entries
       SET indexed_at = NOW() - INTERVAL '120 days',
           source_updated_at = NOW() - INTERVAL '130 days',
           last_read_at = NOW() - INTERVAL '1 day'
       WHERE id = $1`,
      [recentReadEntry.id]
    );
    const unusedQueueResponse = await fetch(`${base}/maintenance/index-drift?projectId=${queueProject.id}&reason=unused`, { headers });
    assert.equal(unusedQueueResponse.status, 200);
    const unusedQueue = await unusedQueueResponse.json() as {
      items: Array<{ resourceId: string; reasons: string[]; suggestedActions: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.ok(unusedQueue.items.some((item) =>
      item.resourceId === unusedEntry.id &&
      item.reasons.includes("unused") &&
      item.suggestedActions.includes("review_relevance")
    ));
    assert.ok(!unusedQueue.items.some((item) => item.resourceId === recentReadEntry.id));
    assert.equal(unusedQueue.totals.byReason.unused, 1);

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

    const confirmQueueMemory = await postMemory(queueProject.id, {
      kind: "fact",
      bodyMarkdown: "P2 confirm queue memory",
      authority: "agent_observed",
      lifecycleState: "raw",
      reviewAfter: "2099-01-01T00:00:00.000Z",
      reviewReason: "manual",
      createdByKind: "agent"
    });
    const confirmQueueBeforeResponse = await fetch(`${base}/maintenance/memory-queue?projectId=${queueProject.id}`, { headers });
    const confirmQueueBefore = await confirmQueueBeforeResponse.json() as { items: Array<{ resourceId: string }> };
    assert.ok(confirmQueueBefore.items.some((item) => item.resourceId === confirmQueueMemory.id));
    const confirmResponse = await fetch(`${base}/project-memories/${confirmQueueMemory.id}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });
    assert.equal(confirmResponse.status, 200);
    const confirmed = await confirmResponse.json() as {
      authority: string;
      lifecycleState: string;
      lastConfirmedAt: string | null;
      reviewReason: string | null;
      reviewAfter: string | null;
    };
    assert.equal(confirmed.authority, "user_confirmed");
    assert.equal(confirmed.lifecycleState, "verified");
    assert.ok(confirmed.lastConfirmedAt);
    assert.equal(confirmed.reviewReason, null);
    assert.equal(confirmed.reviewAfter, null);
    const confirmQueueAfterResponse = await fetch(`${base}/maintenance/memory-queue?projectId=${queueProject.id}`, { headers });
    const confirmQueueAfter = await confirmQueueAfterResponse.json() as { items: Array<{ resourceId: string }> };
    assert.ok(!confirmQueueAfter.items.some((item) => item.resourceId === confirmQueueMemory.id));

    const ttlMemory = await postMemory(queueProject.id, {
      kind: "fact",
      bodyMarkdown: "P2 confirm TTL memory",
      authority: "agent_observed",
      lifecycleState: "raw",
      createdByKind: "agent"
    });
    const confirmWithTtlResponse = await fetch(`${base}/project-memories/${ttlMemory.id}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewAfter: "2099-02-01T00:00:00.000Z" })
    });
    assert.equal(confirmWithTtlResponse.status, 200);
    const confirmedWithTtl = await confirmWithTtlResponse.json() as { lifecycleState: string; reviewAfter: string | null };
    assert.equal(confirmedWithTtl.lifecycleState, "verified");
    assert.equal(confirmedWithTtl.reviewAfter, "2099-02-01T00:00:00.000Z");

    const archivedMemory = await postMemory(queueProject.id, {
      kind: "fact",
      bodyMarkdown: "P2 archived confirm memory",
      authority: "user_confirmed",
      createdByKind: "user"
    });
    const archiveMemoryResponse = await fetch(`${base}/project-memories/${archivedMemory.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "archived" })
    });
    assert.equal(archiveMemoryResponse.status, 200);
    const archivedConfirmResponse = await fetch(`${base}/project-memories/${archivedMemory.id}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });
    assert.equal(archivedConfirmResponse.status, 409);

    const snoozeMemory = await postMemory(queueProject.id, {
      kind: "observation",
      bodyMarkdown: "P2 snooze memory",
      authority: "agent_observed",
      lifecycleState: "raw",
      reviewReason: "manual",
      createdByKind: "agent"
    });
    const snoozeResponse = await fetch(`${base}/project-memories/${snoozeMemory.id}/snooze`, {
      method: "POST",
      headers,
      body: JSON.stringify({ until: "2099-03-01T00:00:00.000Z" })
    });
    assert.equal(snoozeResponse.status, 200);
    const snoozed = await snoozeResponse.json() as {
      authority: string;
      lifecycleState: string;
      lastConfirmedAt: string | null;
      reviewReason: string | null;
      reviewAfter: string | null;
    };
    assert.equal(snoozed.authority, "agent_observed");
    assert.equal(snoozed.lifecycleState, "raw");
    assert.equal(snoozed.lastConfirmedAt, null);
    assert.equal(snoozed.reviewReason, "manual");
    assert.equal(snoozed.reviewAfter, "2099-03-01T00:00:00.000Z");
    const pastSnoozeResponse = await fetch(`${base}/project-memories/${snoozeMemory.id}/snooze`, {
      method: "POST",
      headers,
      body: JSON.stringify({ until: "2000-01-01T00:00:00.000Z" })
    });
    assert.equal(pastSnoozeResponse.status, 400);

    const flagMemory = await postMemory(queueProject.id, {
      kind: "decision",
      bodyMarkdown: "P2 flag memory",
      authority: "user_confirmed",
      lifecycleState: "verified",
      reviewAfter: "2099-04-01T00:00:00.000Z",
      createdByKind: "user"
    });
    const flagResponse = await fetch(`${base}/project-memories/${flagMemory.id}/flag`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "conflict", note: "duplicate with source" })
    });
    assert.equal(flagResponse.status, 200);
    const flagged = await flagResponse.json() as {
      authority: string;
      lifecycleState: string;
      reviewReason: string | null;
      reviewAfter: string | null;
      note?: string;
    };
    assert.equal(flagged.authority, "user_confirmed");
    assert.equal(flagged.lifecycleState, "verified");
    assert.equal(flagged.reviewReason, "conflict");
    assert.equal(flagged.reviewAfter, "2099-04-01T00:00:00.000Z");
    assert.equal(flagged.note, "duplicate with source");

    const ownerOnlyMemory = await postMemory(queueProject.id, {
      kind: "fact",
      bodyMarkdown: "P2 owner scoped memory",
      authority: "agent_observed",
      lifecycleState: "raw",
      createdByKind: "agent"
    });
    const otherConfirmResponse = await fetch(`${base}/project-memories/${ownerOnlyMemory.id}/confirm`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({})
    });
    assert.equal(otherConfirmResponse.status, 404);
    const otherSnoozeResponse = await fetch(`${base}/project-memories/${ownerOnlyMemory.id}/snooze`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ until: "2099-05-01T00:00:00.000Z" })
    });
    assert.equal(otherSnoozeResponse.status, 404);
    const otherFlagResponse = await fetch(`${base}/project-memories/${ownerOnlyMemory.id}/flag`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ reason: "manual" })
    });
    assert.equal(otherFlagResponse.status, 404);

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
