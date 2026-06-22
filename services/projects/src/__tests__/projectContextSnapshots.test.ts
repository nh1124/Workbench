import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.PROJECTS_DB_HOST ||= "127.0.0.1";
process.env.PROJECTS_DB_PORT ||= "5432";
process.env.PROJECTS_DB_NAME ||= "workbench-test-unused";
process.env.PROJECTS_DB_USER ||= "workbench-test-unused";
process.env.PROJECTS_DB_PASSWORD ||= "workbench-test-unused";

const {
  getProjectContextExportSnapshotWithPool,
  getProjectSyncContextSnapshotWithPool,
  ProjectContextSnapshotLimitError
} = await import("../projectContextSnapshotsStore.js");
const { getProjectRelationWithQuery } = await import("../projectRelationsStore.js");

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-02T00:00:00.000Z";

function projectRow() {
  return {
    id: "project-1", name: "Project", description: "description", status: "active",
    owner_account_id: "owner-a", is_fallback_default: false, is_user_default: true,
    created_at: t0, updated_at: t1
  };
}

function memoryRow(id: string, createdAt: string, status: "active" | "archived" = "active") {
  return {
    id, project_id: "project-1", kind: "decision", body_markdown: id, authority: "user_confirmed",
    source_service: null, source_resource_type: null, source_resource_id: null, confidence: null,
    status, supersedes_id: null, created_by_kind: "user", created_at: createdAt, updated_at: createdAt
  };
}

function relationRow(id: string, source: string, target: string) {
  return {
    id, source_project_id: source, target_project_id: target, relation_type: "related",
    directionality: "directed", note: id, origin: "manual", strength: null,
    created_by_kind: "user", version: 1, created_at: t0, updated_at: t1
  };
}

function queryTag(sql: string): string | undefined {
  return sql.match(/project_context_snapshot:([a-z_]+)/)?.[1];
}

function createPool(options: { owner?: string; counts?: Partial<Record<string, number>>; rollbackFails?: boolean } = {}) {
  const calls: string[] = [];
  let released = 0;
  let poolQueries = 0;
  const rowsByTag: Record<string, unknown[]> = {
    project: options.owner === "owner-b" ? [] : [projectRow()],
    brief: [],
    memories: [memoryRow("memory-z", t1), memoryRow("memory-a", t0), memoryRow("memory-archived", t1, "archived")],
    relations: [relationRow("relation-z", "project-2", "project-1"), relationRow("relation-a", "project-1", "project-2")],
    links: [
      { id: "link-z", project_id: "project-1", target_service: "notes", target_resource_type: "note", target_resource_id: "n2", relation_type: "reference", title_snapshot: null, summary_snapshot: null, linked_at: t1, metadata_json: {} },
      { id: "link-a", project_id: "project-1", target_service: "artifacts", target_resource_type: "file", target_resource_id: "a1", relation_type: "reference", title_snapshot: null, summary_snapshot: null, linked_at: t0, metadata_json: {} }
    ],
    index: [
      { id: "index-z", project_id: "project-1", source_service: "notes", resource_type: "note", resource_id: "n2", association_kind: "primary", association_id: null, path: "z", title: "z", summary_text: "z", summary_source: "deterministic", source_version: null, content_hash: null, source_updated_at: t1, indexed_at: t1, metadata_json: {} },
      { id: "index-ordinal-accent", project_id: "project-1", source_service: "artifacts", resource_type: "file", resource_id: "accent", association_kind: "primary", association_id: null, path: "ä", title: "accent", summary_text: "accent", summary_source: "deterministic", source_version: null, content_hash: null, source_updated_at: t0, indexed_at: t0, metadata_json: {} },
      { id: "index-empty", project_id: "project-1", source_service: "artifacts", resource_type: "file", resource_id: "empty", association_kind: "primary", association_id: null, path: "", title: "empty", summary_text: "empty", summary_source: "deterministic", source_version: null, content_hash: null, source_updated_at: t0, indexed_at: t0, metadata_json: {} },
      { id: "index-a", project_id: "project-1", source_service: "artifacts", resource_type: "file", resource_id: "a1", association_kind: "primary", association_id: null, path: "a", title: "a", summary_text: "a", summary_source: "deterministic", source_version: null, content_hash: null, source_updated_at: t0, indexed_at: t0, metadata_json: {} },
      { id: "index-null", project_id: "project-1", source_service: "artifacts", resource_type: "file", resource_id: "null", association_kind: "primary", association_id: null, path: null, title: "null", summary_text: "null", summary_source: "deterministic", source_version: null, content_hash: null, source_updated_at: t0, indexed_at: t0, metadata_json: {} },
      { id: "index-ordinal-z", project_id: "project-1", source_service: "artifacts", resource_type: "file", resource_id: "ordinal-z", association_kind: "primary", association_id: null, path: "z", title: "ordinal-z", summary_text: "ordinal-z", summary_source: "deterministic", source_version: null, content_hash: null, source_updated_at: t0, indexed_at: t0, metadata_json: {} }
    ],
    summary: [{ id: "summary-1", project_id: "project-1", summary_text: "summary", source: "rule", updated_at: t1 }]
  };
  const defaultCounts: Record<string, number> = {
    memories: 2,
    relations: 2,
    memories_export: 3,
    relations_export: 2,
    links_export: 2,
    index_export: 6
  };
  const client = {
    async query<Row>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> {
      const compact = sql.replace(/\s+/g, " ").trim();
      calls.push(compact);
      if (compact.startsWith("BEGIN") || compact === "COMMIT") return { rows: [] };
      if (compact === "ROLLBACK") {
        if (options.rollbackFails) throw new Error("rollback failed");
        return { rows: [] };
      }
      const tag = queryTag(sql);
      assert.ok(tag, `Missing query tag: ${compact}`);
      if (tag.endsWith("_count")) {
        const key = tag.slice(0, -"_count".length);
        return { rows: [{ count: options.counts?.[key] ?? defaultCounts[key] ?? 0 } as Row] };
      }
      if (tag === "project") {
        assert.deepEqual(values, ["project-1", options.owner ?? "owner-a"]);
      }
      let rows = rowsByTag[tag] ?? [];
      if (tag === "memories" && sql.includes("status = 'active'")) {
        rows = rows.filter((row) => (row as { status?: string }).status === "active");
      }
      return { rows: rows as Row[] };
    },
    release() {
      released += 1;
    }
  };
  return {
    pool: {
      async connect() { return client; },
      async query() { poolQueries += 1; throw new Error("Pool query must not be used"); }
    },
    calls,
    stats: () => ({ released, poolQueries })
  };
}

describe("Project context snapshots", () => {
  it("scopes direct relation lookup to the owning account", async () => {
    const querySource = {
      async query<Row>(_sql: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        assert.equal(values?.[0], "relation-a");
        return {
          rows: values?.[1] === "owner-a"
            ? [relationRow("relation-a", "project-1", "project-2") as Row]
            : []
        };
      }
    };
    assert.equal((await getProjectRelationWithQuery(querySource, "relation-a", "owner-a"))?.id, "relation-a");
    assert.equal(await getProjectRelationWithQuery(querySource, "relation-a", "owner-b"), undefined);
  });

  it("builds a complete owner-scoped sync snapshot in one read-only repeatable-read transaction", async () => {
    const fake = createPool();
    const snapshot = await getProjectSyncContextSnapshotWithPool(fake.pool, "project-1", "owner-a");

    assert.ok(snapshot);
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.counts, { memories: 2, relations: 2 });
    assert.equal(snapshot.brief.version, 0);
    assert.deepEqual(snapshot.memories.map((item) => item.id), ["memory-a", "memory-z"]);
    assert.deepEqual(snapshot.relations.map((item) => item.id), ["relation-a", "relation-z"]);
    assert.equal(fake.calls[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(fake.calls.at(-1), "COMMIT");
    assert.deepEqual(fake.stats(), { released: 1, poolQueries: 0 });
  });

  it("returns no owner-crossing data and does not query child tables for a missing owner", async () => {
    const fake = createPool({ owner: "owner-b" });
    const snapshot = await getProjectSyncContextSnapshotWithPool(fake.pool, "project-1", "owner-b");

    assert.equal(snapshot, undefined);
    assert.equal(fake.calls.some((sql) => sql.includes("project_context_snapshot:memories")), false);
    assert.deepEqual(fake.stats(), { released: 1, poolQueries: 0 });
    assert.equal(fake.calls.at(-1), "COMMIT");
  });

  it("fails atomically with the stable sync limit code instead of returning a partial snapshot", async () => {
    const fake = createPool({ counts: { memories: 3 }, rollbackFails: true });
    const originalLimit = { memories: 2, relations: 5, rowBytes: 1_000_000, totalBytes: 1_000_000 };
    await assert.rejects(
      getProjectSyncContextSnapshotWithPool(fake.pool, "project-1", "owner-a", originalLimit),
      (error) => error instanceof ProjectContextSnapshotLimitError
        && error.code === "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED"
        && error.status === 413
    );
    assert.equal(fake.calls.at(-1), "ROLLBACK");
    assert.equal(fake.calls.some((sql) => sql.includes("project_context_snapshot:brief")), false);
    assert.deepEqual(fake.stats(), { released: 1, poolQueries: 0 });
  });

  it("builds the complete canonical export with all memory statuses and exact counts", async () => {
    const fake = createPool();
    const snapshot = await getProjectContextExportSnapshotWithPool(fake.pool, "project-1", "owner-a");

    assert.ok(snapshot);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.packageType, "workbench.project-context-export");
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.counts, { memories: 3, relations: 2, links: 2, indexEntries: 6 });
    assert.deepEqual(snapshot.memories.map((item) => item.id), ["memory-a", "memory-archived", "memory-z"]);
    assert.deepEqual(snapshot.relations.map((item) => item.id), ["relation-a", "relation-z"]);
    assert.deepEqual(snapshot.links.map((item) => item.id), ["link-a", "link-z"]);
    assert.deepEqual(snapshot.indexEntries.map((item) => item.id), [
      "index-null",
      "index-empty",
      "index-a",
      "index-ordinal-z",
      "index-ordinal-accent",
      "index-z"
    ]);
    assert.equal(snapshot.generatedSummary?.id, "summary-1");
    assert.equal(fake.calls[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(fake.calls.at(-1), "COMMIT");
    assert.deepEqual(fake.stats(), { released: 1, poolQueries: 0 });
  });

  it("enforces export row-size and count caps with the stable export code", async () => {
    const fake = createPool();
    await assert.rejects(
      getProjectContextExportSnapshotWithPool(fake.pool, "project-1", "owner-a", {
        memories: 10,
        relations: 10,
        links: 10,
        indexEntries: 10,
        rowBytes: 8,
        totalBytes: 1_000_000
      }),
      (error) => error instanceof ProjectContextSnapshotLimitError
        && error.code === "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED"
        && error.status === 413
    );
    assert.equal(fake.calls.at(-1), "ROLLBACK");
    assert.deepEqual(fake.stats(), { released: 1, poolQueries: 0 });
  });

  it("enforces the total serialized export cap without returning partial output", async () => {
    const fake = createPool();
    await assert.rejects(
      getProjectContextExportSnapshotWithPool(fake.pool, "project-1", "owner-a", {
        memories: 10,
        relations: 10,
        links: 10,
        indexEntries: 10,
        rowBytes: 1_000_000,
        totalBytes: 32
      }),
      (error) => error instanceof ProjectContextSnapshotLimitError
        && error.code === "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED"
    );
    assert.equal(fake.calls.at(-1), "ROLLBACK");
    assert.deepEqual(fake.stats(), { released: 1, poolQueries: 0 });
  });
});
