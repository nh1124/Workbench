import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const { recordUsageEventBestEffort, summarizeUsageWithPool } = await import("../usageEventsStore.js");

test("usage recording failures are swallowed", async () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    recordUsageEventBestEffort({
      userId: "user-1",
      eventType: "index_search",
      queryText: "missing",
      hitCount: 0
    }, async () => {
      throw new Error("insert failed");
    });
    await waitImmediate();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
});

test("summarizeUsage aggregates truncations, zero-hit queries and top resources", async () => {
  const pool = {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("event_type = 'context_truncation'") && sql.includes("COUNT(*)::text AS count") && !sql.includes("jsonb_array_elements_text")) {
        return { rows: [{ count: "3" }] as T[] };
      }
      if (sql.includes("jsonb_array_elements_text")) {
        return { rows: [
          { section: "index", count: "2" },
          { section: "memory", count: "1" }
        ] as T[] };
      }
      if (sql.includes("hit_count = 0")) {
        return { rows: [
          { query_text: "missing topic", count: "4" },
          { query_text: "empty result", count: "2" }
        ] as T[] };
      }
      if (sql.includes("event_type = 'resource_read'")) {
        return { rows: [
          { source_service: "artifacts", resource_type: "note", resource_id: "artifact-1", count: "5" },
          { source_service: "notes", resource_type: "note", resource_id: "note-1", count: "3" }
        ] as T[] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const summary = await summarizeUsageWithPool(
    pool,
    "user-1",
    "2026-06-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );

  assert.equal(summary.since, "2026-06-01T00:00:00.000Z");
  assert.equal(summary.until, "2026-07-01T00:00:00.000Z");
  assert.equal(summary.truncation.count, 3);
  assert.deepEqual(summary.truncation.bySection, [
    { section: "index", count: 2 },
    { section: "memory", count: 1 }
  ]);
  assert.deepEqual(summary.zeroHitQueries, [
    { queryText: "missing topic", count: 4 },
    { queryText: "empty result", count: 2 }
  ]);
  assert.deepEqual(summary.topResources, [
    { sourceService: "artifacts", resourceType: "note", resourceId: "artifact-1", count: 5 },
    { sourceService: "notes", resourceType: "note", resourceId: "note-1", count: 3 }
  ]);
});
