import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { upsertCondition } from "../lbs/conditionsStore.js";
import { DEFAULT_LBS_CONFIG, getConfig } from "../lbs/configStore.js";
import { upsertExecution } from "../lbs/executionsStore.js";
import type { LbsStoreDatabase } from "../lbs/storeUtils.js";

const __filename = fileURLToPath(import.meta.url);
const srcDir = path.resolve(path.dirname(__filename), "..");

function fakeDatabase(
  handler: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number | null }
): LbsStoreDatabase {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      const result = handler(sql, values);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    }
  } as LbsStoreDatabase;
}

describe("LBS stores", () => {
  it("keeps every mutation owner-scoped", () => {
    const storeFiles = [
      "definitionsStore.ts",
      "exceptionsStore.ts",
      "executionsStore.ts",
      "conditionsStore.ts",
      "configStore.ts"
    ];

    for (const file of storeFiles) {
      const source = readFileSync(path.join(srcDir, "lbs", file), "utf8");
      const sqlTemplates = [...source.matchAll(/`((?:INSERT INTO|UPDATE|DELETE FROM)[\s\S]*?)`/g)]
        .map((match) => match[1]);
      assert.ok(sqlTemplates.length > 0, `${file} should contain mutation SQL`);
      for (const sql of sqlTemplates) {
        if (sql.startsWith("INSERT INTO")) {
          assert.match(sql, /owner_username/, `${file} INSERT must write the owner`);
        }
        if (sql.startsWith("UPDATE") || sql.startsWith("DELETE FROM")) {
          assert.match(sql, /WHERE[\s\S]*owner_username\s*=\s*\$1/, `${file} mutation must predicate on owner_username`);
        }
        if (/ON CONFLICT/.test(sql)) {
          assert.match(sql, /ON CONFLICT \(owner_username,/, `${file} upsert conflict identity must include owner_username`);
        }
      }
    }
  });

  it("upserts executions on the owner/task/date identity", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let id = 1;
    const db = fakeDatabase((sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [{
          id: id++, owner_username: values[0], task_id: values[1], target_date: values[2],
          status: values[3], progress: values[4], actual_time: values[5], created_at: "2026-07-13T00:00:00.000Z"
        }]
      };
    });

    await upsertExecution("  Owner-A  ", {
      taskId: "task-1", targetDate: "2026-07-13", status: "done", progress: 100
    }, db);
    const updated = await upsertExecution("owner-a", {
      taskId: "task-1", targetDate: "2026-07-13", status: "skipped", progress: 25, actualTime: 10
    }, db);

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /ON CONFLICT \(owner_username, task_id, target_date\)/);
    assert.deepEqual(calls[1].values.slice(0, 3), ["owner-a", "task-1", "2026-07-13"]);
    assert.equal(updated.status, "skipped");
    assert.equal(updated.progress, 25);
  });

  it("clamps both daily fatigue values to the 0..5 range", async () => {
    let captured: unknown[] = [];
    const db = fakeDatabase((_sql, values) => {
      captured = values;
      return {
        rows: [{
          owner_username: values[0], target_date: values[1], cognitive_fatigue: values[2],
          physical_fatigue: values[3], note: values[4], updated_at: "2026-07-13T00:00:00.000Z"
        }]
      };
    });

    const condition = await upsertCondition("OWNER", "2026-07-13", {
      cognitiveFatigue: 12, physicalFatigue: -3, note: "clamped"
    }, db);

    assert.deepEqual(captured, ["owner", "2026-07-13", 5, 0, "clamped"]);
    assert.equal(condition.cognitive_fatigue, 5);
    assert.equal(condition.physical_fatigue, 0);
  });

  it("merges owner overrides over the Python-compatible config defaults", async () => {
    const db = fakeDatabase(() => ({
      rows: [
        { key: "ALPHA", value: "0.25" },
        { key: "CAP", value: "12" },
        { key: "UNKNOWN", value: "999" }
      ]
    }));

    assert.deepEqual(await getConfig("Owner", db), {
      ...DEFAULT_LBS_CONFIG,
      ALPHA: 0.25,
      CAP: 12
    });
    assert.deepEqual(DEFAULT_LBS_CONFIG, { ALPHA: 0.1, BETA: 1.2, SWITCH_COST: 0.5, CAP: 8 });
  });
});
