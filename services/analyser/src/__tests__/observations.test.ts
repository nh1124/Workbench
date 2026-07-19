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

  it("drops an input with an invalid resource reference", async () => {
    const pool = fakePool([{ rows: [] }]);
    const invalid = input({ resourceRefs: [{ service: "core", resourceType: "note", resourceId: "" }] });
    const result = await ingestObservationsWithPool(pool, "owner-1", [invalid]);
    assert.deepEqual(result.rejected, { workbench_change: 1 });
  });
});
