import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const { listSyncEventsScopedWithPool } = await import("../syncStore.js");
const {
  pullSyncChangesWithPool,
  SyncConsumerScopeMismatchError
} = await import("../syncChanges.js");

type QueryCall = {
  text: string;
  values?: unknown[];
};

function normalizedSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function eventRow(
  id: string,
  payload: Record<string, unknown> = {},
  aggregate: { scannedCount?: string; scannedMax?: string } = {}
): Record<string, unknown> {
  return {
    scanned_count: aggregate.scannedCount ?? "1",
    scanned_max: aggregate.scannedMax ?? id,
    id,
    user_id: "user-1",
    domain: "artifacts",
    resource_id: `item-${id}`,
    action: "update",
    version: 2,
    payload_json: payload,
    project_id: "project-1",
    resource_type: "note",
    path: "skills/example.md",
    previous_path: null,
    created_at: "2026-07-19T00:00:00.000Z",
    resource_deleted_at: null
  };
}

function singleResultPool(calls: QueryCall[], rows: Record<string, unknown>[] = [eventRow("1")]) {
  return {
    async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
      calls.push({ text: normalizedSql(text), values });
      return { rows: rows as Row[] };
    }
  };
}

describe("scoped sync event SQL", () => {
  it("filters projectId with envelope and payload fallbacks while retaining unknown events", async () => {
    const calls: QueryCall[] = [];
    await listSyncEventsScopedWithPool(singleResultPool(calls), "user-1", "0", 5, {
      projectId: "project-1"
    });

    assert.match(calls[0].text, /WITH scanned AS/);
    assert.match(calls[0].text, /COALESCE\(s\.project_id, s\.payload_json->'resource'->>'projectId', CASE WHEN s\.domain = 'project_context' THEN s\.resource_id END\)/);
    assert.match(calls[0].text, /COALESCE\(.+\) IS NULL OR COALESCE\(.+\) = \$5/);
    assert.deepEqual(calls[0].values, ["user-1", 0, 50, 5, "project-1"]);
  });

  it("matches every known path candidate and escapes LIKE metacharacters", async () => {
    const calls: QueryCall[] = [];
    await listSyncEventsScopedWithPool(singleResultPool(calls), "user-1", "3", 5, {
      pathPrefix: "skills/100%_done\\"
    });

    assert.match(calls[0].text, /s\.path LIKE \$5 ESCAPE '\\'/);
    assert.match(calls[0].text, /s\.previous_path LIKE \$5 ESCAPE '\\'/);
    assert.match(calls[0].text, /s\.payload_json->'resource'->>'path' LIKE \$5 ESCAPE '\\'/);
    assert.match(calls[0].text, /s\.path IS NULL AND s\.previous_path IS NULL AND s\.payload_json->'resource'->>'path' IS NULL/);
    assert.equal(calls[0].values?.[4], "skills/100\\%\\_done\\\\%");
  });

  it("filters resource types with unknown inclusion and actions strictly", async () => {
    const calls: QueryCall[] = [];
    await listSyncEventsScopedWithPool(singleResultPool(calls), "user-1", undefined, 5, {
      resourceTypes: ["note", "folder"],
      actions: ["update", "delete"]
    });

    assert.match(calls[0].text, /COALESCE\(s\.resource_type, s\.payload_json->'resource'->>'kind'\) IS NULL/);
    assert.match(calls[0].text, /COALESCE\(s\.resource_type, s\.payload_json->'resource'->>'kind'\) = ANY\(\$5::text\[\]\)/);
    assert.match(calls[0].text, /s\.action = ANY\(\$6::text\[\]\)/);
    assert.deepEqual(calls[0].values?.slice(4), [["note", "folder"], ["update", "delete"]]);
  });

  it("combines multiple scope filters with AND", async () => {
    const calls: QueryCall[] = [];
    await listSyncEventsScopedWithPool(singleResultPool(calls), "user-1", "4", 5, {
      domains: ["artifacts"],
      projectId: "project-1",
      pathPrefix: "skills/",
      resourceTypes: ["note"],
      actions: ["update"]
    });

    assert.match(calls[0].text, /s\.domain = ANY\(\$5::text\[\]\) AND \(COALESCE/);
    assert.match(calls[0].text, /\$6\) AND \( \(s\.path IS NULL/);
    assert.match(calls[0].text, /LIKE \$7 ESCAPE '\\' .+ AND \(COALESCE/);
    assert.match(calls[0].text, /ANY\(\$8::text\[\]\)\) AND s\.action = ANY\(\$9::text\[\]\)/);
    assert.deepEqual(calls[0].values?.slice(4), [
      ["artifacts"], "project-1", "skills/%", ["note"], ["update"]
    ]);
  });

  it("advances to scanned_max when fewer matches than the page limit", async () => {
    const calls: QueryCall[] = [];
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        if (text.includes("WITH scanned")) return { rows: [] };
        return { rows: [{ scanned_count: "10", scanned_max: "20" } as Row] };
      }
    };

    const result = await listSyncEventsScopedWithPool(pool, "user-1", "10", 5, { projectId: "other" });
    assert.deepEqual(result.events, []);
    assert.equal(result.nextCursor, "20");
    assert.equal(result.scannedThrough, "20");
    assert.equal(calls.length, 2);
    assert.match(calls[1].text, /SELECT COUNT\(\*\)::text AS scanned_count, MAX\(id\)::text AS scanned_max/);
    assert.deepEqual(calls[1].values, ["user-1", 10, 50]);
  });

  it("stops nextCursor at the last matched id when the page limit is reached", async () => {
    const rows = [
      eventRow("11", {}, { scannedCount: "10", scannedMax: "99" }),
      eventRow("12", {}, { scannedCount: "10", scannedMax: "99" })
    ];
    const result = await listSyncEventsScopedWithPool(singleResultPool([], rows), "user-1", "10", 2, {});
    assert.equal(result.nextCursor, "12");
    assert.equal(result.scannedThrough, "99");
  });

  it("leaves nextCursor undefined when nothing was scanned", async () => {
    let queryCount = 0;
    const pool = {
      async query<Row>(text: string): Promise<{ rows: Row[] }> {
        queryCount += 1;
        return text.includes("WITH scanned")
          ? { rows: [] }
          : { rows: [{ scanned_count: "0", scanned_max: null } as Row] };
      }
    };

    const result = await listSyncEventsScopedWithPool(pool, "user-1", "7", 5, {});
    assert.equal(result.nextCursor, undefined);
    assert.equal(result.scannedThrough, "7");
    assert.equal(queryCount, 2);
  });

  it("clamps scanLimit to ten pages with a 2000-row cap", async () => {
    const calls: QueryCall[] = [];
    await listSyncEventsScopedWithPool(singleResultPool(calls), "user-1", "0", 5, {});
    await listSyncEventsScopedWithPool(singleResultPool(calls), "user-1", "0", 300, {});
    assert.equal(calls[0].values?.[2], 50);
    assert.equal(calls[1].values?.[2], 2000);
  });
});

function pullPool(
  state: Record<string, unknown> | undefined,
  rows: Record<string, unknown>[],
  calls: QueryCall[]
) {
  return {
    async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
      const sql = normalizedSql(text);
      calls.push({ text: sql, values });
      if (sql.includes("FROM sync_consumer_cursors")) {
        return { rows: (state ? [state] : []) as Row[] };
      }
      if (sql.includes("WITH scanned AS")) return { rows: rows as Row[] };
      if (sql.includes("FROM sync_events e")) return { rows: rows as Row[] };
      if (sql.includes("SELECT COUNT(*)::text AS scanned_count")) {
        return { rows: [{ scanned_count: "0", scanned_max: null } as Row] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

describe("scoped sync changes pull", () => {
  it("replaces contentMarkdown with contentLength without mutating the source payload", async () => {
    const sourcePayload = {
      resource: { id: "item-1", contentMarkdown: "hello世界" },
      patch: { title: "new" }
    };
    const result = await pullSyncChangesWithPool(
      pullPool(undefined, [eventRow("8", sourcePayload)], []),
      "user-1",
      { projectId: "project-1", includeContent: false }
    );

    assert.deepEqual(result.events[0].payload.resource, { id: "item-1", contentLength: 7 });
    assert.deepEqual(sourcePayload.resource, { id: "item-1", contentMarkdown: "hello世界" });
    assert.deepEqual(result.events[0].payload.patch, { title: "new" });
  });

  it("removes payload.patch when includePatch is false", async () => {
    const sourcePayload = { resource: { contentMarkdown: "body" }, patch: { title: "new" } };
    const result = await pullSyncChangesWithPool(
      pullPool(undefined, [eventRow("8", sourcePayload)], []),
      "user-1",
      { projectId: "project-1", includePatch: false }
    );

    assert.equal("patch" in result.events[0].payload, false);
    assert.deepEqual(sourcePayload.patch, { title: "new" });
    assert.deepEqual(result.events[0].payload.resource, { contentMarkdown: "body" });
  });

  it("keeps content and patch by default", async () => {
    const sourcePayload = { resource: { contentMarkdown: "body" }, patch: { title: "new" } };
    const result = await pullSyncChangesWithPool(
      pullPool(undefined, [eventRow("8", sourcePayload)], []),
      "user-1",
      { projectId: "project-1" }
    );

    assert.deepEqual(result.events[0].payload, sourcePayload);
  });

  it("uses the exact legacy listing shape when no new option is supplied", async () => {
    const calls: QueryCall[] = [];
    const result = await pullSyncChangesWithPool(
      pullPool(undefined, [eventRow("8")], calls),
      "user-1",
      { domains: ["artifacts"], limit: 5 }
    );

    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[1].text, /WITH scanned AS/);
    assert.match(calls[1].text, /AND \(\$4::text\[\] IS NULL OR e\.domain = ANY\(\$4::text\[\]\)\)/);
    assert.deepEqual(calls[1].values, ["user-1", 0, 5, ["artifacts"]]);
    assert.deepEqual(Object.keys(result), ["consumer", "cursor", "events", "nextCursor"]);
    assert.equal(result.appliedScope, undefined);
    assert.equal(result.scannedThrough, undefined);
  });

  it("applies a stored bound scope, accepts deep-equal filters, and rejects conflicts", async () => {
    const state = {
      cursor: "7",
      scope_json: { projectId: "project-1", resourceTypes: ["note"] },
      initialized_at: "2026-07-19T00:00:00.000Z"
    };
    const noArgCalls: QueryCall[] = [];
    const noArg = await pullSyncChangesWithPool(
      pullPool(state, [eventRow("8")], noArgCalls), "user-1", {}
    );
    assert.deepEqual(noArg.appliedScope, { projectId: "project-1", resourceTypes: ["note"] });
    assert.equal(noArg.scannedThrough, "8");
    assert.match(noArgCalls[1].text, /WITH scanned AS/);

    const equal = await pullSyncChangesWithPool(
      pullPool(state, [eventRow("8")], []),
      "user-1",
      { projectId: " project-1 ", resourceTypes: ["note", "note"] }
    );
    assert.deepEqual(equal.appliedScope, { projectId: "project-1", resourceTypes: ["note"] });

    const conflictCalls: QueryCall[] = [];
    await assert.rejects(
      pullSyncChangesWithPool(
        pullPool(state, [eventRow("8")], conflictCalls),
        "user-1",
        { projectId: "project-2", resourceTypes: ["note"] }
      ),
      (error) => error instanceof SyncConsumerScopeMismatchError
        && error.status === 400
        && error.code === "SYNC_CONSUMER_SCOPE_MISMATCH"
    );
    assert.equal(conflictCalls.length, 1);
  });

  it("merges domains into scopes and rejects conflicts with bound domains", async () => {
    const unbound = await pullSyncChangesWithPool(
      pullPool(undefined, [eventRow("8")], []),
      "user-1",
      { projectId: "project-1", domains: ["notes", "artifacts"] }
    );
    assert.deepEqual(unbound.appliedScope, {
      projectId: "project-1",
      domains: ["artifacts", "notes"]
    });

    const state = {
      cursor: "7",
      scope_json: { projectId: "project-1", domains: ["artifacts"] },
      initialized_at: "2026-07-19T00:00:00.000Z"
    };
    const equal = await pullSyncChangesWithPool(
      pullPool(state, [eventRow("8")], []),
      "user-1",
      { projectId: "project-1", domains: ["artifacts"] }
    );
    assert.deepEqual(equal.appliedScope, { projectId: "project-1", domains: ["artifacts"] });

    await assert.rejects(
      pullSyncChangesWithPool(
        pullPool(state, [eventRow("8")], []),
        "user-1",
        { domains: ["notes"] }
      ),
      (error) => error instanceof SyncConsumerScopeMismatchError
        && error.code === "SYNC_CONSUMER_SCOPE_MISMATCH"
    );
  });
});
