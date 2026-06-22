import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.PROJECTS_SERVICE_URL ||= "http://projects.test";
process.env.INTERNAL_API_KEY_NOTES ||= "notes-test-key";
process.env.INTERNAL_API_KEY_ARTIFACTS ||= "artifacts-test-key";
process.env.INTERNAL_API_KEY_TASKS ||= "tasks-test-key";
process.env.INTERNAL_API_KEY_IMAGES ||= "images-test-key";
process.env.JWT_SECRET ||= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ||= "workbench-test";
process.env.JWT_EXPIRY_SECONDS ||= "3600";
process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

let server: Server;
let baseUrl: string;

describe("Project context sync HTTP authentication", () => {
  before(async () => {
    const { app } = await import("../httpServer.js");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("rejects detail and snapshot reads without local-client or bearer credentials", async () => {
    const [detail, snapshot] = await Promise.all([
      fetch(`${baseUrl}/api/sync/project-context/project-1`),
      fetch(`${baseUrl}/api/sync/snapshot?domains=project_context`)
    ]);

    assert.equal(detail.status, 401);
    assert.deepEqual(await detail.json(), { message: "Missing local client credentials" });
    assert.equal(snapshot.status, 401);
    assert.deepEqual(await snapshot.json(), { message: "Missing local client credentials" });
  });

  it("rejects an invalid bearer before calling Projects or capturing a baseline", async () => {
    const response = await fetch(`${baseUrl}/api/sync/project-context/project-1`, {
      headers: { Authorization: "Bearer definitely-not-a-jwt" }
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "Invalid or expired token" });
  });
});
