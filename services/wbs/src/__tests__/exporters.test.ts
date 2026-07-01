import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { buildWbsExport } from "../exporters.js";
import type { WbsItemRecord, WbsPlanRecord } from "../types.js";

function plan(): WbsPlanRecord {
  return {
    id: "plan-1",
    ownerCoreUserId: "user-1",
    title: "Launch Plan",
    description: "A small launch WBS",
    settings: {},
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  };
}

function item(partial: Partial<WbsItemRecord>): WbsItemRecord {
  return {
    id: partial.id ?? "item-1",
    ownerCoreUserId: "user-1",
    planId: "plan-1",
    code: partial.code ?? "1",
    title: partial.title ?? "Work",
    description: partial.description ?? "",
    sortOrder: partial.sortOrder ?? 1000,
    status: partial.status ?? "todo",
    metadata: {},
    version: partial.version ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial
  };
}

describe("WBS exports", () => {
  it("builds Mindmap-like export content for markdown, csv, and json", () => {
    const items = [
      item({ id: "scope", code: "1", title: "Scope", effortHours: 2, rollup: { effortHours: 5, progress: 60, itemCount: 2, doneCount: 1 } }),
      item({ id: "api", parentId: "scope", code: "1.1", title: "API", sortOrder: 1000, status: "done", effortHours: 3 })
    ];

    const markdown = buildWbsExport(plan(), items, [], "markdown");
    assert.equal(markdown.filename, "launch-plan.md");
    assert.equal(markdown.mimeType, "text/markdown; charset=utf-8");
    assert.match(markdown.contentText, /Source service: wbs/);
    assert.match(markdown.contentText, /- 1 Scope/);
    assert.equal(Buffer.from(markdown.contentBase64, "base64").toString("utf8"), markdown.contentText);

    const csv = buildWbsExport(plan(), items, [], "csv");
    assert.equal(csv.filename, "launch-plan.csv");
    assert.match(csv.contentText, /Code,Title,Parent Code/);
    assert.match(csv.contentText, /1.1,API,1/);

    const json = buildWbsExport(plan(), items, [], "json");
    const parsed = JSON.parse(json.contentText) as { sourceService?: string; sourcePlanId?: string; sourceVersion?: number };
    assert.deepEqual(
      { sourceService: parsed.sourceService, sourcePlanId: parsed.sourcePlanId, sourceVersion: parsed.sourceVersion },
      { sourceService: "wbs", sourcePlanId: "plan-1", sourceVersion: 3 }
    );
  });
});
