import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityAggregateSql, decodeDerivedCursor, decodeSummaryCursor, encodeCursor } from "../queries.js";
import { derivedCreateSchema, machineRegisterSchema, sampleIngestSchema, summaryIngestSchema } from "../types.js";

describe("insights input validation", () => {
  it("accepts valid domain payloads", () => {
    const machineId = "123e4567-e89b-42d3-a456-426614174000";
    assert.equal(machineRegisterSchema.safeParse({ machineKey: "stable-pc-id", platform: "windows" }).success, true);
    assert.equal(sampleIngestSchema.safeParse({ machineId, samples: [{
      sampledAt: "2026-07-11T01:02:03.000Z", processName: "code.exe", windowTitle: "Workbench"
    }] }).success, true);
    assert.equal(summaryIngestSchema.safeParse({ machineId, summaries: [{
      summaryDate: "2026-07-11", summaryMarkdown: "# Day", generatedAt: "2026-07-11T23:00:00.000Z",
      metricsJson: { activeSeconds: 10, categories: { development: 10 } }
    }] }).success, true);
    assert.equal(derivedCreateSchema.safeParse({
      observedDate: "2026-07-11", kind: "pattern", title: "Focus block", contentMarkdown: "Observed"
    }).success, true);
  });
  it("enforces ingest batch limits and date formats", () => {
    const machineId = "123e4567-e89b-42d3-a456-426614174000";
    const samples = Array.from({ length: 501 }, (_, index) => ({
      sampledAt: new Date(index * 1000).toISOString(), processName: "app", windowTitle: "title"
    }));
    assert.equal(sampleIngestSchema.safeParse({ machineId, samples }).success, false);
    assert.equal(derivedCreateSchema.safeParse({
      observedDate: "07/11/2026", kind: "pattern", title: "x", contentMarkdown: "x"
    }).success, false);
    assert.equal(derivedCreateSchema.safeParse({
      observedDate: "2026-02-30", kind: "pattern", title: "x", contentMarkdown: "x"
    }).success, false);
  });
});

describe("insights query helpers", () => {
  it("round-trips both keyset cursor shapes", () => {
    const summary = { summaryDate: "2026-07-11", machineId: "123e4567-e89b-42d3-a456-426614174000" };
    const derived = { createdAt: "2026-07-11T12:00:00.000Z", id: "123e4567-e89b-42d3-a456-426614174001" };
    assert.deepEqual(decodeSummaryCursor(encodeCursor(summary)), summary);
    assert.deepEqual(decodeDerivedCursor(encodeCursor(derived)), derived);
  });
  it("builds owner-scoped JSONB aggregation in SQL", () => {
    assert.match(activityAggregateSql, /s\.service_account_id = \$1/);
    assert.match(activityAggregateSql, /jsonb_each\(COALESCE\(metrics_json->'categories'/);
    assert.match(activityAggregateSql, /jsonb_each\(COALESCE\(metrics_json->'apps'/);
    assert.match(activityAggregateSql, /contextSwitches/);
    assert.match(activityAggregateSql, /FILTER \(WHERE machine_id IS NOT NULL\)/);
  });
});
