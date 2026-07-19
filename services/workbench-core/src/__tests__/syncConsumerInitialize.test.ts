import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const {
  getConsumerStateWithPool,
  initializeSyncConsumerWithPool,
  normalizeSyncConsumerScope,
  SyncConsumerCursorInputError,
  SyncConsumerScopeConflictError
} = await import("../syncConsumerCursorsStore.js");

type QueryCall = {
  text: string;
  values?: unknown[];
};

function normalizedSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("sync consumer initialization", () => {
  it("atomically captures the owner stream head for a fresh scoped consumer", async () => {
    const calls: QueryCall[] = [];
    const initializedAt = "2026-07-19T01:02:03.000Z";
    const scope = {
      projectId: "project-1",
      domains: ["notes", "notes"],
      resourceTypes: ["note", "note"],
      actions: ["update", "update"]
    };
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        return { rows: [{
          cursor: "812",
          scope_json: {
            projectId: "project-1",
            domains: ["notes"],
            resourceTypes: ["note"],
            actions: ["update"]
          },
          initialized_at: initializedAt
        } as Row] };
      }
    };

    const result = await initializeSyncConsumerWithPool(pool, "user-1", {
      consumer: " agent-skills ",
      startAt: "current",
      scope
    });

    assert.deepEqual(result, {
      consumer: "agent-skills",
      cursor: "812",
      scope: {
        projectId: "project-1",
        domains: ["notes"],
        resourceTypes: ["note"],
        actions: ["update"]
      },
      initializedAt,
      alreadyInitialized: false
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /INSERT INTO sync_consumer_cursors/);
    assert.match(calls[0].text, /SELECT \$1, \$2, COALESCE\(\(SELECT MAX\(id\) FROM sync_events WHERE user_id = \$1\), 0\)::text/);
    assert.match(calls[0].text, /ON CONFLICT \(user_id, consumer_id\) DO NOTHING/);
    assert.match(calls[0].text, /RETURNING cursor, scope_json, initialized_at/);
    assert.deepEqual(calls[0].values, [
      "user-1",
      "agent-skills",
      JSON.stringify({
        projectId: "project-1",
        domains: ["notes"],
        resourceTypes: ["note"],
        actions: ["update"]
      })
    ]);
  });

  it("uses COALESCE so a stream with no events initializes at head zero", async () => {
    const calls: QueryCall[] = [];
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        return { rows: [{
          cursor: "0",
          scope_json: null,
          initialized_at: "2026-07-19T02:00:00.000Z"
        } as Row] };
      }
    };

    const result = await initializeSyncConsumerWithPool(pool, "user-empty", { consumer: "new-agent" });

    assert.equal(result.cursor, "0");
    assert.equal(result.alreadyInitialized, false);
    assert.equal(result.scope, undefined);
    assert.match(calls[0].text, /COALESCE/);
    assert.deepEqual(calls[0].values, ["user-empty", "new-agent", null]);
  });

  it("returns an existing state unchanged when re-initialized without a scope", async () => {
    const calls: QueryCall[] = [];
    const initializedAt = "2026-07-18T00:00:00.000Z";
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        if (text.includes("INSERT INTO sync_consumer_cursors")) return { rows: [] };
        return { rows: [{
          cursor: "41",
          scope_json: { projectId: "project-existing", domains: ["artifacts"] },
          initialized_at: initializedAt
        } as Row] };
      }
    };

    const result = await initializeSyncConsumerWithPool(pool, "user-1", { consumer: "existing-agent" });

    assert.deepEqual(result, {
      consumer: "existing-agent",
      cursor: "41",
      scope: { projectId: "project-existing", domains: ["artifacts"] },
      initializedAt,
      alreadyInitialized: true
    });
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => /\bUPDATE\b/.test(call.text)), false);
    assert.deepEqual(calls.map((call) => call.values?.slice(0, 2)), [
      ["user-1", "existing-agent"],
      ["user-1", "existing-agent"]
    ]);
  });

  it("rejects a different re-initialization scope without updating existing state", async () => {
    const calls: QueryCall[] = [];
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        if (text.includes("INSERT INTO sync_consumer_cursors")) return { rows: [] };
        return { rows: [{
          cursor: "73",
          scope_json: null,
          initialized_at: "2026-07-17T00:00:00.000Z"
        } as Row] };
      }
    };

    await assert.rejects(
      initializeSyncConsumerWithPool(pool, "user-1", {
        consumer: "existing-agent",
        scope: { projectId: "project-different" }
      }),
      (error) => error instanceof SyncConsumerScopeConflictError
        && error.status === 409
        && error.code === "SYNC_CONSUMER_SCOPE_CONFLICT"
    );
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => /\bUPDATE\b/.test(call.text)), false);
  });

  it("accepts a deep-equal normalized scope on idempotent re-initialization", async () => {
    const calls: QueryCall[] = [];
    const storedScope = {
      projectId: "project-1",
      pathPrefix: "skills/",
      domains: ["artifacts", "notes"],
      resourceTypes: ["note"],
      actions: ["create", "update"]
    };
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        if (text.includes("INSERT INTO sync_consumer_cursors")) return { rows: [] };
        return { rows: [{
          cursor: "99",
          scope_json: storedScope,
          initialized_at: "2026-07-16T00:00:00.000Z"
        } as Row] };
      }
    };

    const result = await initializeSyncConsumerWithPool(pool, "user-1", {
      consumer: "existing-agent",
      scope: {
        actions: ["create", "update", "create"],
        resourceTypes: ["note", "note"],
        domains: ["artifacts", "notes", "artifacts"],
        pathPrefix: " skills/ ",
        projectId: " project-1 "
      }
    });

    assert.equal(result.alreadyInitialized, true);
    assert.deepEqual(result.scope, storedScope);
    assert.equal(calls.some((call) => /\bUPDATE\b/.test(call.text)), false);
  });

  it("rejects unsupported start positions before querying", async () => {
    let queryCalls = 0;
    const pool = {
      async query<Row>(): Promise<{ rows: Row[] }> {
        queryCalls += 1;
        return { rows: [] };
      }
    };

    for (const startAt of ["later", "0"]) {
      await assert.rejects(
        initializeSyncConsumerWithPool(pool, "user-1", { consumer: "agent", startAt }),
        (error) => error instanceof SyncConsumerCursorInputError
          && error.message === 'only startAt "current" is supported'
      );
    }
    assert.equal(queryCalls, 0);
  });

  it("requires an explicit consumer instead of using the legacy default", async () => {
    let queryCalls = 0;
    const pool = {
      async query<Row>(): Promise<{ rows: Row[] }> {
        queryCalls += 1;
        return { rows: [] };
      }
    };

    await assert.rejects(
      initializeSyncConsumerWithPool(pool, "user-1", { consumer: undefined }),
      (error) => error instanceof SyncConsumerCursorInputError && error.message === "consumer is required"
    );
    assert.equal(queryCalls, 0);
  });

  it("strictly validates and normalizes optional scopes", () => {
    assert.equal(normalizeSyncConsumerScope(undefined), undefined);
    assert.equal(normalizeSyncConsumerScope(null), undefined);
    assert.equal(normalizeSyncConsumerScope({}), undefined);
    assert.deepEqual(normalizeSyncConsumerScope({
      projectId: " project-1 ",
      pathPrefix: " skills/ ",
      domains: ["notes", "notes"],
      resourceTypes: [" note ", "note"],
      actions: ["upsert", "upsert"]
    }), {
      projectId: "project-1",
      pathPrefix: "skills/",
      domains: ["notes"],
      resourceTypes: ["note"],
      actions: ["upsert"]
    });

    const invalidScopes = [
      "notes",
      [],
      { unknown: "value" },
      { projectId: " " },
      { pathPrefix: "" },
      { domains: ["bogus"] },
      { domains: [""] },
      { resourceTypes: [" "] },
      { actions: ["merge"] },
      { actions: [""] }
    ];
    for (const scope of invalidScopes) {
      assert.throws(
        () => normalizeSyncConsumerScope(scope),
        (error) => error instanceof SyncConsumerCursorInputError
      );
    }
  });

  it("parameterizes every initialization and state query with the owner user id", async () => {
    const calls: QueryCall[] = [];
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        if (text.includes("INSERT INTO sync_consumer_cursors")) return { rows: [] };
        return { rows: [{ cursor: "7", scope_json: null, initialized_at: null } as Row] };
      }
    };

    await initializeSyncConsumerWithPool(pool, "owner-user", { consumer: "agent" });
    await getConsumerStateWithPool(pool, "owner-user", "agent");

    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.values?.[0], "owner-user");
      assert.match(call.text, /user_id = \$1/);
    }
    assert.deepEqual(calls[0].values, ["owner-user", "agent", null]);
    assert.deepEqual(calls[1].values, ["owner-user", "agent"]);
    assert.deepEqual(calls[2].values, ["owner-user", "agent"]);
  });
});
