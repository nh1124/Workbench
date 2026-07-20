import assert from "node:assert/strict";
import test from "node:test";

const runIntegration = process.env.RUN_NOTES_DB_TESTS === "1";

function configureEnvironment(): void {
  const defaults = {
    NOTES_DB_HOST: "127.0.0.1",
    NOTES_DB_PORT: "5547",
    NOTES_DB_NAME: "notes_db",
    NOTES_DB_USER: "notes_user",
    NOTES_DB_PASSWORD: "notes_pass",
    NOTES_SERVICE_HOST: "127.0.0.1",
    NOTES_SERVICE_PORT: "4105",
    JWT_SECRET: "test-notes-jwt-secret",
    JWT_ISSUER: "workbench-core",
    INTERNAL_API_KEY: "test-internal-key"
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
}

test("Notes CRUD remains owner-scoped after lifecycle removal", { skip: !runIntegration }, async () => {
  configureEnvironment();
  const [{ app }, jwt, db] = await Promise.all([import("../httpServer.js"), import("jsonwebtoken"), import("../db.js")]);
  const owner = `notes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const otherOwner = `${owner}-other`;
  await db.upsertServiceAccount(owner, owner);
  await db.upsertServiceAccount(otherOwner, otherOwner);
  const token = jwt.default.sign({ sub: owner, username: owner, tokenUse: "access" }, process.env.JWT_SECRET as string, {
    algorithm: "HS256", issuer: process.env.JWT_ISSUER
  });
  const otherToken = jwt.default.sign({ sub: otherOwner, username: otherOwner, tokenUse: "access" }, process.env.JWT_SECRET as string, {
    algorithm: "HS256", issuer: process.env.JWT_ISSUER
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const otherHeaders = { authorization: `Bearer ${otherToken}`, "content-type": "application/json" };
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const createResponse = await fetch(`${base}/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Note", content: "body", projectId: "project-1", tags: ["one"] })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as { id: string; title: string; content: string; tags: string[] };
    assert.equal(created.title, "Note");
    assert.deepEqual(created.tags, ["one"]);
    assert.equal((await fetch(`${base}/notes/${created.id}`, { headers: otherHeaders })).status, 404);

    const updateResponse = await fetch(`${base}/notes/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Updated", content: "new body" })
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json() as { title: string; content: string };
    assert.equal(updated.title, "Updated");
    assert.equal(updated.content, "new body");
    assert.equal((await fetch(`${base}/notes/${created.id}`, { method: "DELETE", headers })).status, 204);
    assert.equal((await fetch(`${base}/notes/${created.id}`, { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.getNotesPool().query(`DELETE FROM notes WHERE owner_username = ANY($1::text[])`, [[owner, otherOwner]]);
    await db.getNotesPool().query(`DELETE FROM service_accounts WHERE core_user_id = ANY($1::text[])`, [[owner, otherOwner]]);
    await db.getNotesPool().end();
  }
});
