import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ARTIFACTS_DB_HOST ||= "127.0.0.1";
process.env.ARTIFACTS_DB_PORT ||= "5432";
process.env.ARTIFACTS_DB_NAME ||= "workbench-artifacts-test";
process.env.ARTIFACTS_DB_USER ||= "workbench-artifacts-test";
process.env.ARTIFACTS_DB_PASSWORD ||= "workbench-artifacts-test";

const {
  ArtifactMaintenanceNotFoundError,
  InvalidArtifactMaintenanceQueueCursorError,
  createArtifactMaintenanceFlagsStore
} = await import("../maintenanceFlagsStore.js");

type QueryCall = { sql: string; values?: unknown[] };

function mockPool(
  handler: (sql: string, values: unknown[] | undefined, calls: QueryCall[]) => Promise<unknown[]> | unknown[]
) {
  const calls: QueryCall[] = [];
  return {
    calls,
    pool: {
      async query<Row = never>(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: await handler(sql, values, calls) as Row[] };
      }
    }
  };
}

function joinedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "flag-1",
    artifact_item_id: "item-1",
    project_id: "project-1",
    reason: "conflict",
    note: "review it",
    status: "open",
    flagged_by: "agent@example.com",
    flagged_at: "2026-07-19T01:00:00.000Z",
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    artifact_project_name: "Project One",
    artifact_title: "Skill",
    artifact_path: "skills/skill.md",
    artifact_kind: "note",
    artifact_version: 4,
    ...overrides
  };
}

describe("Artifact maintenance flags store", () => {
  it("returns an owner-scoped typed 404 when the Artifact item is missing", async () => {
    const { pool, calls } = mockPool(() => []);
    const store = createArtifactMaintenanceFlagsStore(pool);

    await assert.rejects(
      () => store.flagArtifactItem("Owner-A", "item-other-owner", {
        reason: "manual",
        flaggedBy: "actor"
      }),
      (error: unknown) => error instanceof ArtifactMaintenanceNotFoundError
        && error.status === 404
        && error.code === "ARTIFACT_ITEM_NOT_FOUND"
    );
    assert.deepEqual(calls[0]?.values, ["item-other-owner", "owner-a"]);
  });

  it("retries a raced unique insert as an idempotent open-flag update", async () => {
    let updateCount = 0;
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes("FROM artifact_items")) return [{ id: "item-1", project_id: "project-1" }];
      if (sql.includes("UPDATE artifact_maintenance_flags")) {
        updateCount += 1;
        return updateCount === 1 ? [] : [{ id: "flag-1" }];
      }
      if (sql.includes("INSERT INTO artifact_maintenance_flags")) {
        throw Object.assign(new Error("unique"), { code: "23505" });
      }
      if (sql.includes("LEFT JOIN artifact_items")) return [joinedRow({ reason: "manual", note: "latest" })];
      return [];
    });
    const store = createArtifactMaintenanceFlagsStore(pool);

    const result = await store.flagArtifactItem("OWNER-A", "item-1", {
      reason: "manual",
      note: "latest",
      flaggedBy: "actor"
    });

    assert.equal(result.id, "flag-1");
    assert.equal(result.reason, "manual");
    assert.equal(updateCount, 2);
    assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO artifact_maintenance_flags")).length, 1);
    const retry = calls.filter((call) => call.sql.includes("UPDATE artifact_maintenance_flags")).at(-1);
    assert.deepEqual(retry?.values, ["item-1", "owner-a", "project-1", "manual", "latest", "actor"]);
  });

  it("resolves without deleting audit history and preserves deleted-item snapshot metadata", async () => {
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes("UPDATE artifact_maintenance_flags")) return [{ id: "flag-1" }];
      if (sql.includes("LEFT JOIN artifact_items")) {
        return [joinedRow({
          status: "resolved",
          resolved_by: "reviewer",
          resolved_at: "2026-07-19T02:00:00.000Z",
          resolution_note: "fixed",
          artifact_project_name: null,
          artifact_title: null,
          artifact_path: null,
          artifact_kind: null,
          artifact_version: null
        })];
      }
      return [];
    });
    const store = createArtifactMaintenanceFlagsStore(pool);

    const result = await store.resolveArtifactFlag("owner-a", "item-1", {
      resolvedBy: "reviewer",
      note: "fixed"
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.artifact.projectId, "project-1");
    assert.equal(result.artifact.title, "(deleted artifact)");
    assert.equal(result.artifact.path, "");
    assert.equal(calls.some((call) => /DELETE\s+FROM/i.test(call.sql)), false);
  });

  it("returns queue fallbacks, extra Artifact fields, keyset cursors, and totals before reason filtering", async () => {
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes("GROUP BY f.reason")) {
        return [{ reason: "conflict", count: "2" }, { reason: "manual", count: "3" }];
      }
      if (sql.includes("ORDER BY f.flagged_at DESC")) {
        return [
          {
            flag_id: "flag-2",
            artifact_item_id: "deleted-item",
            project_id: "project-1",
            reason: "conflict",
            note: null,
            flagged_by: "actor",
            flagged_at: "2026-07-19T03:00:00.000Z",
            project_name: null,
            title: null,
            path: null,
            artifact_kind: null,
            version: null
          },
          {
            flag_id: "flag-1",
            artifact_item_id: "item-1",
            project_id: "project-1",
            reason: "conflict",
            note: "review",
            flagged_by: "actor",
            flagged_at: "2026-07-19T02:00:00.000Z",
            project_name: "Project One",
            title: "Skill",
            path: "skills/skill.md",
            artifact_kind: "note",
            version: 4
          }
        ];
      }
      return [];
    });
    const store = createArtifactMaintenanceFlagsStore(pool);

    const result = await store.listArtifactMaintenanceQueue("owner-a", {
      projectId: "project-1",
      reason: "conflict",
      limit: 1
    });

    assert.deepEqual(result.totals.byReason, { conflict: 2, manual: 3 });
    assert.deepEqual(result.items[0], {
      id: "artifact:deleted-item",
      kind: "artifact",
      projectId: "project-1",
      projectName: "project-1",
      resourceId: "deleted-item",
      title: "(deleted artifact)",
      excerpt: "conflict",
      reasons: ["conflict"],
      updatedAt: "2026-07-19T03:00:00.000Z",
      suggestedActions: ["resolve"],
      path: "",
      flaggedBy: "actor",
      flaggedAt: "2026-07-19T03:00:00.000Z"
    });
    assert.ok(result.nextCursor);
    const totalsCall = calls.find((call) => call.sql.includes("GROUP BY f.reason"));
    const pageCall = calls.find((call) => call.sql.includes("ORDER BY f.flagged_at DESC"));
    assert.deepEqual(totalsCall?.values, ["owner-a", "project-1"]);
    assert.deepEqual(pageCall?.values, ["owner-a", "project-1", "conflict", 2]);
  });

  it("rejects malformed queue cursors before querying queue rows", async () => {
    const { pool } = mockPool((sql) => sql.includes("GROUP BY f.reason") ? [] : []);
    const store = createArtifactMaintenanceFlagsStore(pool);
    await assert.rejects(
      () => store.listArtifactMaintenanceQueue("owner-a", { cursor: "not+base64" }),
      (error: unknown) => error instanceof InvalidArtifactMaintenanceQueueCursorError
        && error.code === "INVALID_CURSOR"
    );
  });
});
