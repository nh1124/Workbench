import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observationInputSchema, type ObservationInput } from "../types.js";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const { ingestObservationsWithPool } = await import("../stores/observations.js");

type Result = { rows: unknown[]; rowCount?: number };
type Call = { text: string; values?: unknown[] };

function fakePool(responses: Result[]) {
  const calls: Call[] = [];
  return {
    calls,
    async query<Row = never>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return (responses.shift() ?? { rows: [] }) as { rows: Row[]; rowCount?: number };
    }
  };
}

function input(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    source: "workbench_change",
    action: "updated",
    actorKind: "user",
    occurredAt: "2026-07-20T00:00:00.000Z",
    dedupeKey: "event-1",
    ...overrides
  };
}

describe("analyser observation gating", () => {
  it("rejects pc activity without upload opt-in and local files by default", async () => {
    const pool = fakePool([{ rows: [] }]);
    const result = await ingestObservationsWithPool(pool, "owner-1", [
      input({ source: "pc_activity", dedupeKey: "pc" }),
      input({ source: "local_file", dedupeKey: "file" })
    ]);
    assert.deepEqual(result, { ingested: 0, duplicates: 0, rejected: { pc_activity: 1, local_file: 1 } });
    assert.equal(pool.calls.length, 1);
  });

  it("rejects unknown sources and excludes screenshots at schema level", async () => {
    assert.equal(observationInputSchema.safeParse(input({ source: "screenshots" as ObservationInput["source"] })).success, false);
    const pool = fakePool([{ rows: [] }]);
    const result = await ingestObservationsWithPool(pool, "owner-1", [
      input({ source: "new_source" as ObservationInput["source"] })
    ]);
    assert.deepEqual(result.rejected, { new_source: 1 });
  });

  it("applies the project deny filter", async () => {
    const pool = fakePool([{ rows: [{
      machine_id: null,
      settings_json: { projectDeny: ["project-secret"] },
      version: 1
    }] }]);
    const result = await ingestObservationsWithPool(pool, "owner-1", [input({ projectId: "project-secret" })]);
    assert.deepEqual(result.rejected, { workbench_change: 1 });
    assert.equal(pool.calls.length, 1);
  });

  it("applies local file root allow/deny and exclude-pattern filters", async () => {
    const cases = [
      {
        name: "deny prefix",
        settings: { localRootAllow: ["C:/work"], localRootDeny: ["C:/work/private"] },
        metadata: { root: "C:/work/private/nested", relativePath: "secret.txt" },
        accepted: false
      },
      {
        name: "allow miss",
        settings: { localRootAllow: ["C:/work"] },
        metadata: { root: "C:/other", relativePath: "notes.txt" },
        accepted: false
      },
      {
        name: "exclude pattern",
        settings: { localRootAllow: ["C:/work"], excludePatterns: ["secret\\.txt$"] },
        metadata: { root: "C:/work/project", relativePath: "docs/SECRET.txt" },
        accepted: false
      },
      {
        name: "denied subdirectory via full path",
        settings: { localRootAllow: ["C:/work"], localRootDeny: ["C:/work/private"] },
        metadata: { root: "C:/work", relativePath: "private/secret.txt" },
        accepted: false
      },
      {
        name: "parent traversal",
        settings: { localRootAllow: ["C:/work/public"], localRootDeny: ["C:/work/private"] },
        metadata: { root: "C:/work/public", relativePath: "../private/secret.txt" },
        accepted: false
      },
      {
        name: "empty allow list",
        settings: { localRootAllow: [] },
        metadata: { root: "C:/work", relativePath: "notes.txt" },
        accepted: false
      },
      {
        name: "sibling directory is not a prefix match",
        settings: { localRootAllow: ["C:/workshop"], localRootDeny: ["C:/work"] },
        metadata: { root: "C:/workshop", relativePath: "notes.txt" },
        accepted: true
      },
      {
        name: "allowed root",
        settings: { localRootAllow: ["C:/work"], localRootDeny: ["C:/work/private"], excludePatterns: ["["] },
        metadata: { root: "C:/work/project", relativePath: "src/index.ts" },
        accepted: true
      }
    ];

    for (const testCase of cases) {
      const pool = fakePool([{
        rows: [{
          machine_id: null,
          settings_json: {
            localFileEvents: "metadata",
            localFileUpload: true,
            ...testCase.settings
          },
          version: 1
        }]
      }, ...(testCase.accepted ? [{ rows: [], rowCount: 1 }] : [])]);
      const result = await ingestObservationsWithPool(pool, "owner-1", [input({
        source: "local_file",
        dedupeKey: `file-${testCase.name}`,
        metadata: testCase.metadata
      })]);
      assert.equal(result.ingested, testCase.accepted ? 1 : 0, testCase.name);
      assert.deepEqual(result.rejected, testCase.accepted ? {} : { local_file: 1 }, testCase.name);
    }
  });

  it("allowlists local file metadata while leaving other-source metadata behavior unchanged", async () => {
    const localPool = fakePool([{
      rows: [{
        machine_id: null,
        settings_json: { localFileEvents: "metadata", localFileUpload: true, localRootAllow: ["C:/work"] },
        version: 1
      }]
    }, { rows: [], rowCount: 1 }]);
    await ingestObservationsWithPool(localPool, "owner-1", [input({
      source: "local_file",
      dedupeKey: "file-metadata",
      metadata: {
        eventType: "modify",
        root: "C:/work",
        relativePath: "src/index.ts",
        mtime: "2026-07-21T03:04:00.000Z",
        size: 42,
        content: "must not be stored"
      }
    })]);
    const localBatch = JSON.parse(String(localPool.calls[1].values?.[1])) as Array<{ metadata: Record<string, unknown> }>;
    assert.deepEqual(localBatch[0].metadata, {
      eventType: "modify",
      root: "C:/work",
      relativePath: "src/index.ts",
      mtime: "2026-07-21T03:04:00.000Z",
      size: 42
    });

    const otherPool = fakePool([{ rows: [] }, { rows: [], rowCount: 1 }]);
    await ingestObservationsWithPool(otherPool, "owner-1", [input({
      dedupeKey: "other-metadata",
      metadata: { content: "existing behavior", custom: true }
    })]);
    const otherBatch = JSON.parse(String(otherPool.calls[1].values?.[1])) as Array<{ metadata: Record<string, unknown> }>;
    assert.deepEqual(otherBatch[0].metadata, { content: "existing behavior", custom: true });
  });

  it("strips secret metadata, caps strings, computes retention, and counts dedupe conflicts", async () => {
    const pool = fakePool([
      { rows: [{
        machine_id: null,
        settings_json: { retentionDays: { workbench_change: 2 } },
        version: 1
      }] },
      { rows: [], rowCount: 0 }
    ]);
    const result = await ingestObservationsWithPool(pool, "owner-1", [input({
      metadata: { token: "do-not-store", Cookie: "also-secret", app: "a".repeat(2100), idle: false }
    })]);

    assert.equal(result.ingested, 0);
    assert.equal(result.duplicates, 1);
    assert.match(pool.calls[1].text, /jsonb_to_recordset/);
    assert.match(pool.calls[1].text, /ON CONFLICT \(service_account_id, dedupe_key\) DO NOTHING/);
    const batch = JSON.parse(String(pool.calls[1].values?.[1])) as Array<{
      metadata: Record<string, unknown>;
      expiresAt: string;
    }>;
    assert.equal(batch[0].metadata.token, undefined);
    assert.equal(batch[0].metadata.Cookie, undefined);
    assert.equal(String(batch[0].metadata.app).length, 2000);
    assert.equal(batch[0].expiresAt, "2026-07-22T00:00:00.000Z");
  });

  it("strips window titles from pc activity unless windowTitleUpload is on", async () => {
    const settingsRow = (windowTitleUpload: boolean) => ({ rows: [{
      machine_id: null,
      settings_json: { foregroundAppUpload: true, windowTitleUpload },
      version: 1
    }] });
    const withoutOptIn = fakePool([settingsRow(false), { rows: [], rowCount: 1 }]);
    await ingestObservationsWithPool(withoutOptIn, "owner-1", [input({
      source: "pc_activity", dedupeKey: "pc", metadata: { app: "code", windowTitle: "secret doc" }
    })]);
    const stripped = JSON.parse(String(withoutOptIn.calls[1].values?.[1])) as Array<{ metadata: Record<string, unknown> }>;
    assert.equal(stripped[0].metadata.windowTitle, undefined);
    assert.equal(stripped[0].metadata.app, "code");

    const withOptIn = fakePool([settingsRow(true), { rows: [], rowCount: 1 }]);
    await ingestObservationsWithPool(withOptIn, "owner-1", [input({
      source: "pc_activity", dedupeKey: "pc", metadata: { app: "code", windowTitle: "visible" }
    })]);
    const kept = JSON.parse(String(withOptIn.calls[1].values?.[1])) as Array<{ metadata: Record<string, unknown> }>;
    assert.equal(kept[0].metadata.windowTitle, "visible");
  });

  it("applies local file root allow/deny and exclude-pattern filters", async () => {
    const pool = fakePool([
      { rows: [{
        machine_id: null,
        settings_json: {
          localFileEvents: "metadata",
          localFileUpload: true,
          localRootAllow: ["/allowed", "/denied"],
          localRootDeny: ["/denied"],
          excludePatterns: ["\\.tmp$", "["]
        },
        version: 1
      }] },
      { rows: [{ id: "observation-1" }], rowCount: 1 }
    ]);
    const result = await ingestObservationsWithPool(pool, "owner-1", [
      input({ source: "local_file", dedupeKey: "denied", metadata: { root: "/denied", relativePath: "secret.txt" } }),
      input({ source: "local_file", dedupeKey: "not-allowed", metadata: { root: "/other", relativePath: "note.txt" } }),
      input({ source: "local_file", dedupeKey: "excluded", metadata: { root: "/allowed", relativePath: "cache.tmp" } }),
      input({ source: "local_file", dedupeKey: "allowed", metadata: { root: "/allowed", relativePath: "src/index.ts" } })
    ]);

    assert.deepEqual(result, { ingested: 1, duplicates: 0, rejected: { local_file: 3 } });
    const batch = JSON.parse(String(pool.calls[1].values?.[1])) as Array<{ dedupeKey: string }>;
    assert.deepEqual(batch.map((item) => item.dedupeKey), ["allowed"]);
  });

  it("allowlists local file metadata fields", async () => {
    const pool = fakePool([
      { rows: [{
        machine_id: null,
        settings_json: { localFileEvents: "metadata", localFileUpload: true, localRootAllow: ["/allowed"] },
        version: 1
      }] },
      { rows: [{ id: "observation-1" }], rowCount: 1 }
    ]);
    await ingestObservationsWithPool(pool, "owner-1", [input({
      source: "local_file",
      dedupeKey: "file",
      metadata: {
        eventType: "modified",
        root: "/allowed",
        relativePath: "src/index.ts",
        mtime: "2026-07-21T00:00:00.000Z",
        size: 42,
        content: "must not persist",
        prompt: "must not persist"
      }
    })]);

    const batch = JSON.parse(String(pool.calls[1].values?.[1])) as Array<{ metadata: Record<string, unknown> }>;
    assert.deepEqual(batch[0].metadata, {
      eventType: "modified",
      root: "/allowed",
      relativePath: "src/index.ts",
      mtime: "2026-07-21T00:00:00.000Z",
      size: 42
    });
  });

  it("drops an input with an invalid resource reference", async () => {
    const pool = fakePool([{ rows: [] }]);
    const invalid = input({ resourceRefs: [{ service: "core", resourceType: "note", resourceId: "" }] });
    const result = await ingestObservationsWithPool(pool, "owner-1", [invalid]);
    assert.deepEqual(result.rejected, { workbench_change: 1 });
  });
});
