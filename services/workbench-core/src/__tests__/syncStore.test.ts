import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const {
  getLatestSyncCursorWithPool,
  listSyncEventsWithPool,
  recordSyncEventWithPool
} = await import("../syncStore.js");
const {
  commitConsumerCursorWithPool,
  getConsumerCursorWithPool,
  normalizeSyncConsumerId,
  SyncConsumerCursorInputError
} = await import("../syncConsumerCursorsStore.js");
const { parseSyncChangesDomains } = await import("../syncChanges.js");

type QueryCall = {
  text: string;
  values?: unknown[];
};

function normalizedSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("sync event transactions", () => {
  it("captures the latest owner-scoped cursor for snapshot baselines", async () => {
    const calls: QueryCall[] = [];
    const cursor = await getLatestSyncCursorWithPool({
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        return { rows: [{ cursor: "12345" } as Row] };
      }
    }, "user-1");

    assert.equal(cursor, "12345");
    assert.match(calls[0].text, /MAX\(id\)/);
    assert.deepEqual(calls[0].values, ["user-1"]);
  });

  it("uses one checked-out client for the entire transaction", async () => {
    const calls: QueryCall[] = [];
    let connectCalls = 0;
    let releaseCalls = 0;
    let poolQueryCalls = 0;
    const createdAt = "2026-06-21T01:02:03.000Z";
    const client = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
        if (text.includes("INSERT INTO sync_resource_versions")) {
          return { rows: [{ version: 7, deleted_at: null } as Row] };
        }
        if (text.includes("INSERT INTO sync_events")) {
          return {
            rows: [{
              id: "42",
              user_id: "user-1",
              domain: "projects",
              resource_id: "project-1",
              action: "update",
              version: 7,
              payload_json: { source: "test" },
              created_at: createdAt
            } as Row]
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      release(): void {
        releaseCalls += 1;
      }
    };
    const pool = {
      async connect() {
        connectCalls += 1;
        return client;
      },
      async query() {
        poolQueryCalls += 1;
        throw new Error("Pool query must not be used inside a transaction");
      }
    };

    const event = await recordSyncEventWithPool(
      pool,
      "user-1",
      "projects",
      "project-1",
      "update",
      { source: "test" }
    );

    assert.equal(connectCalls, 1);
    assert.equal(poolQueryCalls, 0);
    assert.equal(releaseCalls, 1);
    assert.deepEqual(calls.map((call) => call.text === "BEGIN" || call.text === "COMMIT"
      ? call.text
      : call.text.startsWith("INSERT INTO sync_resource_versions")
        ? "VERSION"
        : "EVENT"), ["BEGIN", "VERSION", "EVENT", "COMMIT"]);
    assert.deepEqual(calls[1].values, ["user-1", "projects", "project-1", "update"]);
    assert.equal(event.cursor, "42");
    assert.equal(event.version, 7);
    assert.deepEqual(event.payload, { source: "test" });
  });

  it("rolls back on the same client and preserves the original error", async () => {
    const originalError = new Error("version update failed");
    const calls: string[] = [];
    let releaseCalls = 0;
    let poolQueryCalls = 0;
    const client = {
      async query<Row>(text: string): Promise<{ rows: Row[] }> {
        calls.push(normalizedSql(text));
        if (text === "BEGIN") return { rows: [] };
        if (text === "ROLLBACK") throw new Error("rollback also failed");
        if (text.includes("INSERT INTO sync_resource_versions")) throw originalError;
        throw new Error(`Unexpected query: ${text}`);
      },
      release(): void {
        releaseCalls += 1;
      }
    };
    const pool = {
      async connect() {
        return client;
      },
      async query() {
        poolQueryCalls += 1;
        throw new Error("Pool query must not be used inside a transaction");
      }
    };

    await assert.rejects(
      recordSyncEventWithPool(pool, "user-1", "projects", "project-1", "update"),
      (error) => error === originalError
    );

    assert.equal(poolQueryCalls, 0);
    assert.equal(releaseCalls, 1);
    assert.deepEqual(calls.map((text) => text.startsWith("INSERT INTO sync_resource_versions") ? "VERSION" : text), [
      "BEGIN",
      "VERSION",
      "ROLLBACK"
    ]);
  });

  it("keeps listSyncEvents backward compatible while accepting an optional domain filter", async () => {
    const calls: QueryCall[] = [];
    const createdAt = "2026-07-06T00:00:00.000Z";
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        return {
          rows: [{
            id: "8",
            user_id: "user-1",
            domain: "notes",
            resource_id: "note-1",
            action: "update",
            version: 3,
            payload_json: { title: "Note" },
            created_at: createdAt,
            resource_deleted_at: null
          } as Row]
        };
      }
    };

    const filtered = await listSyncEventsWithPool(pool, "user-1", "7", 999, ["notes"]);
    assert.equal(filtered.events[0]?.cursor, "8");
    assert.equal(filtered.events[0]?.domain, "notes");
    assert.deepEqual(calls[0].values, ["user-1", 7, 500, ["notes"]]);
    assert.match(calls[0].text, /e\.domain = ANY\(\$4::text\[\]\)/);

    await listSyncEventsWithPool(pool, "user-1", undefined, 10);
    assert.deepEqual(calls[1].values, ["user-1", 0, 10, null]);
  });

  it("normalizes and persists consumer cursors by user and consumer id", async () => {
    assert.equal(normalizeSyncConsumerId(undefined), "maintenance-agent");
    assert.equal(normalizeSyncConsumerId(" agent-a "), "agent-a");
    assert.throws(() => normalizeSyncConsumerId(" "), /consumer/);
    assert.throws(() => normalizeSyncConsumerId("x".repeat(101)), /consumer/);

    const calls: QueryCall[] = [];
    const updatedAt = "2026-07-06T00:00:00.000Z";
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        if (text.includes("INSERT INTO sync_consumer_cursors")) {
          return {
            rows: [{
              user_id: values?.[0],
              consumer_id: values?.[1],
              cursor: values?.[2],
              updated_at: updatedAt
            } as Row]
          };
        }
        return { rows: [{ cursor: "42" } as Row] };
      }
    };

    const committed = await commitConsumerCursorWithPool(pool, "user-1", " agent-a ", " 9 ");
    assert.deepEqual(calls[0].values, ["user-1", "agent-a", "9"]);
    assert.equal(committed.consumerId, "agent-a");
    assert.equal(committed.cursor, "9");
    assert.equal(committed.updatedAt, updatedAt);

    const cursor = await getConsumerCursorWithPool(pool, "user-1", "agent-a");
    assert.equal(cursor, "42");
    assert.deepEqual(calls[1].values, ["user-1", "agent-a"]);
  });

  it("rejects unsupported sync change domains instead of turning typos into empty filters", () => {
    assert.deepEqual(parseSyncChangesDomains("notes, project_context"), ["notes", "project_context"]);
    assert.deepEqual(parseSyncChangesDomains(["notes", "notes", ""]), ["notes"]);
    assert.equal(parseSyncChangesDomains(" , , "), undefined);

    assert.throws(
      () => parseSyncChangesDomains("projcts"),
      (error) => error instanceof SyncConsumerCursorInputError
        && error.message === "unsupported sync domain: projcts"
    );
    assert.throws(
      () => parseSyncChangesDomains("notes,projcts"),
      (error) => error instanceof SyncConsumerCursorInputError
        && error.message === "unsupported sync domain: projcts"
    );
  });
});
