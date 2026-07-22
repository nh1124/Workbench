import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalyserServiceError } from "../serviceError.js";
import { observationInputSchema, type ObservationInput } from "../types.js";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const { aggregateActivityWithPool, ingestObservationsWithPool, pullObservationsAfterWithPool } = await import("../stores/observations.js");

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

function fakeMachineIngestPool(knownIds: string[]) {
  const calls: Call[] = [];
  return {
    calls,
    async query<Row = never>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (/FROM analyser_machines/.test(text)) {
        const requestedIds = (values?.[1] ?? []) as string[];
        return { rows: requestedIds.filter((id) => knownIds.includes(id)).map((id) => ({ id })) } as { rows: Row[] };
      }
      if (/FROM analyser_collection_policies/.test(text)) return { rows: [] } as { rows: Row[] };
      if (/INSERT INTO analyser_observations/.test(text)) {
        return { rows: [{ id: "observation-1" }], rowCount: 1 } as { rows: Row[]; rowCount: number };
      }
      throw new Error(`Unexpected query: ${text}`);
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
  it("rejects an unknown context machine before policy lookup or insert", async () => {
    const machineId = "11111111-1111-4111-8111-111111111111";
    const pool = fakeMachineIngestPool([]);

    await assert.rejects(
      () => ingestObservationsWithPool(pool, "owner-1", [input()], { machineId }),
      (error: unknown) => {
        assert.ok(error instanceof AnalyserServiceError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "MACHINE_UNKNOWN");
        return true;
      }
    );

    assert.equal(pool.calls.length, 1);
    assert.match(pool.calls[0].text, /FROM analyser_machines/);
    assert.equal(pool.calls.some((call) => /INSERT INTO analyser_observations/.test(call.text)), false);
  });

  it("stores a known context machine id", async () => {
    const machineId = "22222222-2222-4222-8222-222222222222";
    const pool = fakeMachineIngestPool([machineId]);

    const result = await ingestObservationsWithPool(pool, "owner-1", [input()], { machineId });

    assert.equal(result.ingested, 1);
    const insert = pool.calls.find((call) => /INSERT INTO analyser_observations/.test(call.text));
    assert.ok(insert);
    const batch = JSON.parse(String(insert.values?.[1])) as Array<{ machineId: string | null }>;
    assert.equal(batch[0].machineId, machineId);
  });

  it("accepts an unknown per-observation machine id as null", async () => {
    const machineId = "33333333-3333-4333-8333-333333333333";
    const pool = fakeMachineIngestPool([]);

    const result = await ingestObservationsWithPool(pool, "owner-1", [input({ machineId })]);

    assert.equal(result.ingested, 1);
    const insert = pool.calls.find((call) => /INSERT INTO analyser_observations/.test(call.text));
    assert.ok(insert);
    const batch = JSON.parse(String(insert.values?.[1])) as Array<{ machineId: string | null }>;
    assert.equal(batch[0].machineId, null);
  });

  it("buckets activity with the requested timezone and defaults to UTC", async () => {
    const tokyoPool = fakePool([{ rows: [] }]);
    await aggregateActivityWithPool(tokyoPool, "owner-1", {
      from: "2026-07-20",
      to: "2026-07-21",
      timezone: "Asia/Tokyo"
    });
    assert.match(tokyoPool.calls[0].text, /AT TIME ZONE/);
    assert.ok(tokyoPool.calls[0].values?.includes("Asia/Tokyo"));

    const utcPool = fakePool([{ rows: [] }]);
    await aggregateActivityWithPool(utcPool, "owner-1", {
      from: "2026-07-20",
      to: "2026-07-21"
    });
    assert.ok(utcPool.calls[0].values?.includes("UTC"));
  });

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

  it("allowlists metadata independently for every observation source", async () => {
    const pool = fakePool([{
      rows: [{
        machine_id: null,
        settings_json: {
          foregroundAppUpload: true,
          windowTitleUpload: true,
          localFileEvents: "metadata",
          localFileUpload: true,
          localRootAllow: ["C:/work"]
        },
        version: 1
      }]
    }, { rows: [], rowCount: 6 }]);
    await ingestObservationsWithPool(pool, "owner-1", [
      input({
        source: "workbench_change",
        dedupeKey: "workbench-metadata",
        metadata: {
          domain: "artifacts", action: "move", resourceType: "artifact", path: "inbox/a.md",
          previousPath: "drafts/a.md", version: 2, content: "drop", prompt: "drop", token: "drop"
        }
      }),
      input({
        source: "mcp_access",
        dedupeKey: "mcp-metadata",
        metadata: {
          tool: "projects.context.get", kind: "read", ok: true, durationMs: 25,
          errorClass: null, documentBody: "drop", requestBody: "drop", apiKey: "drop"
        }
      }),
      input({
        source: "ui_access",
        dedupeKey: "ui-metadata",
        metadata: {
          route: "/projects", method: "GET", kind: "navigation", status: 200, ok: true,
          durationMs: 12, content: "drop", requestBody: "drop", Cookie: "drop"
        }
      }),
      input({
        source: "pc_activity",
        dedupeKey: "pc-metadata",
        metadata: {
          app: "code", idle: false, intervalSeconds: 30, windowTitle: "visible",
          content: "drop", documentBody: "drop", password: "drop"
        }
      }),
      input({
        source: "local_file",
        dedupeKey: "file-metadata",
        metadata: {
          eventType: "modify", root: "C:/work", relativePath: "src/index.ts",
          mtime: "2026-07-21T03:04:00.000Z", size: 42, content: "drop", prompt: "drop", secret: "drop"
        }
      }),
      input({
        source: "agent_session",
        dedupeKey: "agent-metadata",
        metadata: {
          event: "completed", milestone: "verified", resourceCount: 4,
          content: "drop", requestBody: "drop", credential: "drop"
        }
      })
    ]);

    const batch = JSON.parse(String(pool.calls[1].values?.[1])) as Array<{
      source: ObservationInput["source"];
      metadata: Record<string, unknown>;
    }>;
    assert.deepEqual(Object.fromEntries(batch.map((item) => [item.source, item.metadata])), {
      workbench_change: {
        domain: "artifacts", action: "move", resourceType: "artifact", path: "inbox/a.md",
        previousPath: "drafts/a.md", version: 2
      },
      mcp_access: { tool: "projects.context.get", kind: "read", ok: true, durationMs: 25, errorClass: null },
      ui_access: { route: "/projects", method: "GET", kind: "navigation", status: 200, ok: true, durationMs: 12 },
      pc_activity: { app: "code", idle: false, intervalSeconds: 30, windowTitle: "visible" },
      local_file: {
        eventType: "modify", root: "C:/work", relativePath: "src/index.ts",
        mtime: "2026-07-21T03:04:00.000Z", size: 42
      },
      agent_session: { event: "completed", milestone: "verified", resourceCount: 4 }
    });
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
      metadata: { token: "do-not-store", Cookie: "also-secret", path: "a".repeat(2100), content: "drop" }
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
    assert.equal(String(batch[0].metadata.path).length, 2000);
    assert.equal(batch[0].metadata.content, undefined);
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

describe("analyser routine observation pull", () => {
  function row(seq: number, source: string, actorKind: string, id: string): Record<string, unknown> {
    return {
      seq, id, source, action: "x", actor_kind: actorKind,
      machine_id: null, project_id: null,
      occurred_at: "2026-07-22T00:00:00.000Z", received_at: "2026-07-22T00:00:00.000Z",
      resource_refs: [], metadata: {}, source_event_id: null, dedupe_key: `d-${id}`,
      expires_at: "2026-08-22T00:00:00.000Z"
    };
  }

  it("excludes agent self-access reads but advances the cursor past them", async () => {
    const rows = [
      row(90, "workbench_change", "user", "o1"),   // kept
      row(91, "mcp_access", "agent", "o2"),         // excluded (agent read)
      row(92, "ui_access", "agent", "o3"),          // excluded (agent read)
      row(93, "workbench_change", "agent", "o4"),   // kept (agent write, not an access read)
      row(94, "mcp_access", "user", "o5")           // kept (user read)
    ];
    const pool = fakePool([{ rows }]);
    const result = await pullObservationsAfterWithPool(pool, "owner-1", "89", 200);
    assert.deepEqual(result.items.map((observation) => observation.id), ["o1", "o4", "o5"]);
    // Cursor advances to the last scanned seq so the excluded 91/92 are skipped exactly once.
    assert.equal(result.maxSeq, "94");
  });

  it("advances the cursor even when the whole window is agent self-access", async () => {
    const rows = [row(95, "mcp_access", "agent", "o6"), row(96, "ui_access", "agent", "o7")];
    const pool = fakePool([{ rows }]);
    const result = await pullObservationsAfterWithPool(pool, "owner-1", "94", 200);
    assert.deepEqual(result.items, []);
    assert.equal(result.maxSeq, "96");
  });
});
