import assert from "node:assert/strict";
import test from "node:test";

const runIntegration = process.env.RUN_NOTES_DB_TESTS === "1";

function configureEnvironment(): void {
  const defaults: Record<string, string> = {
    NOTES_DB_HOST: "127.0.0.1",
    NOTES_DB_PORT: "5547",
    NOTES_DB_NAME: "notes_db",
    NOTES_DB_USER: "notes_user",
    NOTES_DB_PASSWORD: "notes_pass",
    NOTES_SERVICE_HOST: "127.0.0.1",
    NOTES_SERVICE_PORT: "4103",
    JWT_SECRET: "test-notes-jwt-secret",
    JWT_ISSUER: "workbench-core",
    INTERNAL_API_KEY: "test-internal-key"
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
}

test("Notes maintenance queue is owner-scoped and derives lifecycle reasons", { skip: !runIntegration }, async () => {
  configureEnvironment();
  const [{ app }, jwt, db] = await Promise.all([import("../httpServer.js"), import("jsonwebtoken"), import("../db.js")]);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = `notes-a-${suffix}`;
  const otherOwner = `notes-b-${suffix}`;
  await db.upsertServiceAccount(owner, owner);
  await db.upsertServiceAccount(otherOwner, otherOwner);
  const jwtSecret = process.env.JWT_SECRET ?? "";
  const jwtIssuer = process.env.JWT_ISSUER ?? "";
  const token = jwt.default.sign({ sub: owner, username: owner, tokenUse: "access" }, jwtSecret, {
    algorithm: "HS256",
    issuer: jwtIssuer
  });
  const otherToken = jwt.default.sign({ sub: otherOwner, username: otherOwner, tokenUse: "access" }, jwtSecret, {
    algorithm: "HS256",
    issuer: jwtIssuer
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const otherHeaders = { authorization: `Bearer ${otherToken}`, "content-type": "application/json" };
  const projectId = `notes-project-${suffix}`;

  async function createNote(
    body: Record<string, unknown>,
    authHeaders = headers
  ): Promise<{ id: string; lifecycleState?: string; reviewAfter?: string | null; reviewReason?: string | null }> {
    const response = await fetch(`${base}/notes`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        title: "Maintenance note",
        content: "Maintenance queue note content",
        projectId,
        projectName: "Notes Project",
        ...body
      })
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ id: string; lifecycleState?: string; reviewReason?: string | null }>;
  }

  try {
    const rawNote = await createNote({ title: "Raw note", lifecycleState: "raw" });
    assert.equal(rawNote.lifecycleState, "raw");
    const expiredNote = await createNote({ title: "Expired note", reviewAfter: "2000-01-01T00:00:00.000Z" });
    const manualCandidate = await createNote({ title: "Manual note" });
    const manualPatchResponse = await fetch(`${base}/notes/${manualCandidate.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ reviewReason: "manual" })
    });
    assert.equal(manualPatchResponse.status, 200);
    const manualNote = await manualPatchResponse.json() as { id: string; reviewReason: string | null };
    assert.equal(manualNote.reviewReason, "manual");
    const futureVerifiedNote = await createNote({
      title: "Future verified note",
      lifecycleState: "verified",
      reviewAfter: "2099-01-01T00:00:00.000Z"
    });
    const otherOwnerNote = await createNote({
      title: "Other owner raw note",
      lifecycleState: "raw"
    }, otherHeaders);

    const queueResponse = await fetch(`${base}/maintenance/note-queue?projectId=${projectId}&limit=2`, { headers });
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json() as {
      items: Array<{ resourceId: string; reasons: string[] }>;
      nextCursor?: string;
      totals: { byReason: Record<string, number> };
    };
    assert.equal(queue.items.length, 2);
    assert.ok(queue.nextCursor);
    assert.equal(queue.totals.byReason.raw, 1);
    assert.equal(queue.totals.byReason.expired, 1);
    assert.equal(queue.totals.byReason.manual, 1);
    const page2Response = await fetch(
      `${base}/maintenance/note-queue?projectId=${projectId}&cursor=${encodeURIComponent(queue.nextCursor ?? "")}`,
      { headers }
    );
    const page2 = await page2Response.json() as { items: Array<{ resourceId: string; reasons: string[] }> };
    const queuedIds = [...queue.items, ...page2.items].map((item) => item.resourceId);
    assert.ok(queuedIds.includes(rawNote.id));
    assert.ok(queuedIds.includes(expiredNote.id));
    assert.ok(queuedIds.includes(manualNote.id));
    assert.ok(!queuedIds.includes(futureVerifiedNote.id));

    const manualFilterResponse = await fetch(`${base}/maintenance/note-queue?projectId=${projectId}&reason=manual`, { headers });
    const manualFilter = await manualFilterResponse.json() as {
      items: Array<{ resourceId: string; reasons: string[] }>;
      totals: { byReason: Record<string, number> };
    };
    assert.deepEqual(manualFilter.items.map((item) => item.resourceId), [manualNote.id]);
    assert.deepEqual(manualFilter.items[0]?.reasons, ["manual"]);
    assert.equal(manualFilter.totals.byReason.manual, 1);

    const ownerQueueResponse = await fetch(`${base}/maintenance/note-queue`, { headers });
    const ownerQueue = await ownerQueueResponse.json() as { items: Array<{ resourceId: string }> };
    assert.ok(!ownerQueue.items.some((item) => item.resourceId === otherOwnerNote.id));

    const confirmQueueNote = await createNote({
      title: "P2 confirm queue note",
      lifecycleState: "raw",
      reviewAfter: "2099-01-01T00:00:00.000Z",
      reviewReason: "manual"
    });
    const confirmQueueBeforeResponse = await fetch(`${base}/maintenance/note-queue?projectId=${projectId}`, { headers });
    const confirmQueueBefore = await confirmQueueBeforeResponse.json() as { items: Array<{ resourceId: string }> };
    assert.ok(confirmQueueBefore.items.some((item) => item.resourceId === confirmQueueNote.id));
    const confirmResponse = await fetch(`${base}/notes/${confirmQueueNote.id}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });
    assert.equal(confirmResponse.status, 200);
    const confirmed = await confirmResponse.json() as {
      lifecycleState: string;
      lastConfirmedAt: string | null;
      reviewReason: string | null;
      reviewAfter: string | null;
    };
    assert.equal(confirmed.lifecycleState, "curated");
    assert.ok(confirmed.lastConfirmedAt);
    assert.equal(confirmed.reviewReason, null);
    assert.equal(confirmed.reviewAfter, null);
    const confirmQueueAfterResponse = await fetch(`${base}/maintenance/note-queue?projectId=${projectId}`, { headers });
    const confirmQueueAfter = await confirmQueueAfterResponse.json() as { items: Array<{ resourceId: string }> };
    assert.ok(!confirmQueueAfter.items.some((item) => item.resourceId === confirmQueueNote.id));

    const confirmTtlNote = await createNote({ title: "P2 confirm TTL note", lifecycleState: "raw" });
    const confirmTtlResponse = await fetch(`${base}/notes/${confirmTtlNote.id}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ lifecycleState: "verified", reviewAfter: "2099-02-01T00:00:00.000Z" })
    });
    assert.equal(confirmTtlResponse.status, 200);
    const confirmedTtl = await confirmTtlResponse.json() as { lifecycleState: string; reviewAfter: string | null };
    assert.equal(confirmedTtl.lifecycleState, "verified");
    assert.equal(confirmedTtl.reviewAfter, "2099-02-01T00:00:00.000Z");

    const snoozeNote = await createNote({
      title: "P2 snooze note",
      lifecycleState: "raw",
      reviewReason: "manual"
    });
    const snoozeResponse = await fetch(`${base}/notes/${snoozeNote.id}/snooze`, {
      method: "POST",
      headers,
      body: JSON.stringify({ until: "2099-03-01T00:00:00.000Z" })
    });
    assert.equal(snoozeResponse.status, 200);
    const snoozed = await snoozeResponse.json() as {
      lifecycleState: string;
      lastConfirmedAt: string | null;
      reviewReason: string | null;
      reviewAfter: string | null;
    };
    assert.equal(snoozed.lifecycleState, "raw");
    assert.equal(snoozed.lastConfirmedAt, null);
    assert.equal(snoozed.reviewReason, "manual");
    assert.equal(snoozed.reviewAfter, "2099-03-01T00:00:00.000Z");
    const pastSnoozeResponse = await fetch(`${base}/notes/${snoozeNote.id}/snooze`, {
      method: "POST",
      headers,
      body: JSON.stringify({ until: "2000-01-01T00:00:00.000Z" })
    });
    assert.equal(pastSnoozeResponse.status, 400);

    const flagNote = await createNote({
      title: "P2 flag note",
      lifecycleState: "verified",
      reviewAfter: "2099-04-01T00:00:00.000Z"
    });
    const flagResponse = await fetch(`${base}/notes/${flagNote.id}/flag`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "conflict", note: "needs merge" })
    });
    assert.equal(flagResponse.status, 200);
    const flagged = await flagResponse.json() as {
      lifecycleState: string;
      reviewReason: string | null;
      reviewAfter: string | null;
      note?: string;
    };
    assert.equal(flagged.lifecycleState, "verified");
    assert.equal(flagged.reviewReason, "conflict");
    assert.equal(flagged.reviewAfter, "2099-04-01T00:00:00.000Z");
    assert.equal(flagged.note, "needs merge");

    const ownerOnlyNote = await createNote({ title: "P2 owner scoped note", lifecycleState: "raw" });
    const otherConfirmResponse = await fetch(`${base}/notes/${ownerOnlyNote.id}/confirm`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({})
    });
    assert.equal(otherConfirmResponse.status, 404);
    const otherSnoozeResponse = await fetch(`${base}/notes/${ownerOnlyNote.id}/snooze`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ until: "2099-05-01T00:00:00.000Z" })
    });
    assert.equal(otherSnoozeResponse.status, 404);
    const otherFlagResponse = await fetch(`${base}/notes/${ownerOnlyNote.id}/flag`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ reason: "manual" })
    });
    assert.equal(otherFlagResponse.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.getNotesPool().query(`DELETE FROM notes WHERE owner_username = ANY($1::text[])`, [[owner, otherOwner]]);
    await db.getNotesPool().query(`DELETE FROM service_accounts WHERE core_user_id = ANY($1::text[])`, [[owner, otherOwner]]);
    await db.getNotesPool().end();
  }
});
