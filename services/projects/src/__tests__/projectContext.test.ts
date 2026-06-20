import assert from "node:assert/strict";
import test from "node:test";
import { budgetProjectContext, clampContextMaxChars } from "../projectContextBudget.js";
import type { ProjectContextPack } from "../types.js";

const timestamp = "2026-06-20T00:00:00.000Z";

function fixture(): ProjectContextPack {
  return {
    project: {
      id: "p1", name: "Example", description: "context", status: "active",
      ownerAccountId: "owner", createdAt: timestamp, updatedAt: timestamp
    },
    brief: { projectId: "p1", contentMarkdown: "important rules", version: 1, updatedByKind: "user", updatedAt: timestamp },
    memories: Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`, projectId: "p1", kind: "decision" as const,
      bodyMarkdown: `memory-${index}-${"x".repeat(180)}`, authority: "user_confirmed" as const,
      status: "active" as const, createdByKind: "user" as const, createdAt: timestamp, updatedAt: timestamp
    })),
    indexEntries: Array.from({ length: 4 }, (_, index) => ({
      id: `i${index}`, projectId: "p1", sourceService: "artifacts", resourceType: "note",
      resourceId: `a${index}`, associationKind: "primary" as const, title: `Artifact ${index}`,
      summaryText: "y".repeat(200), summarySource: "deterministic", sourceUpdatedAt: timestamp,
      indexedAt: timestamp, metadataJson: {}
    })),
    relations: [],
    links: [],
    truncation: { maxChars: 12_000, truncatedSections: [] }
  };
}

test("context budget is clamped and deterministic", () => {
  assert.equal(clampContextMaxChars(undefined), 12_000);
  assert.equal(clampContextMaxChars(20), 1_000);
  assert.equal(clampContextMaxChars(100_000), 50_000);
  const first = budgetProjectContext(fixture(), 1_000);
  const second = budgetProjectContext(fixture(), 1_000);
  assert.deepEqual(first, second);
  assert.equal(first.brief?.contentMarkdown, "important rules");
  assert.ok((first.memories?.length ?? 0) < 8);
  assert.ok(first.truncation.truncatedSections.includes("memory"));
  assert.ok(first.truncation.truncatedSections.includes("index"));
});

test("higher priority sections consume budget before lower priority sections", () => {
  const output = budgetProjectContext(fixture(), 1_000);
  assert.ok(output.brief);
  assert.ok((output.memories?.length ?? 0) > 0);
  assert.equal(output.indexEntries, undefined);
});
