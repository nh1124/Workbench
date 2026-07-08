import assert from "node:assert/strict";
import test from "node:test";
import { budgetProjectContext, clampContextMaxChars } from "../projectContextBudget.js";
import { InvalidCursorError, parseCursor, toCursor } from "../projectCursor.js";
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
  assert.ok(JSON.stringify(first).length <= first.truncation.maxChars);
});

test("higher priority sections consume budget before lower priority sections", () => {
  const output = budgetProjectContext(fixture(), 1_000);
  assert.ok(output.brief);
  assert.ok((output.memories?.length ?? 0) > 0);
  assert.equal(output.indexEntries, undefined);
});

test("oversized Project metadata is compacted explicitly within the hard budget", () => {
  const input = fixture();
  input.project.id = "f93462e0-05a6-4df7-8a44-fb3cc340f599";
  input.project.ownerAccountId = "7e3046c7-97c7-45f6-93fd-338c8e88da57";
  input.project.createdAt = "2026-06-19T08:15:30.000Z";
  input.project.updatedAt = "2026-06-21T03:42:10.000Z";
  input.project.isFallbackDefault = false;
  input.project.isUserDefault = true;
  input.project.name = `Long Project ${"n".repeat(1_200)}`;
  input.project.description = `Long description ${"d".repeat(4_000)}`;

  const output = budgetProjectContext(input, 1_000);

  assert.ok(JSON.stringify(output).length <= 1_000);
  assert.equal(output.project.id, input.project.id);
  assert.equal(output.project.ownerAccountId, input.project.ownerAccountId);
  assert.equal(output.project.status, input.project.status);
  assert.equal(output.project.createdAt, input.project.createdAt);
  assert.equal(output.project.updatedAt, input.project.updatedAt);
  assert.equal(output.project.isFallbackDefault, input.project.isFallbackDefault);
  assert.equal(output.project.isUserDefault, input.project.isUserDefault);
  assert.ok(Number.isFinite(Date.parse(output.project.createdAt)));
  assert.ok(Number.isFinite(Date.parse(output.project.updatedAt)));
  assert.match(`${output.project.name}${output.project.description}`, /… \[truncated\]/);
  assert.ok(output.truncation.truncatedSections.includes("brief"));
  assert.ok(output.truncation.truncatedSections.includes("memory"));
});

test("final truncation metadata is reserved before accepting section items", () => {
  const input = fixture();
  input.generatedSummary = {
    id: "summary-1",
    projectId: input.project.id,
    summaryText: "s".repeat(2_000),
    source: "rule-based",
    updatedAt: timestamp
  };
  input.relations = Array.from({ length: 6 }, (_, index) => ({
    id: `r${index}`,
    sourceProjectId: input.project.id,
    targetProjectId: `target-${index}`,
    relationType: "related" as const,
    directionality: "directed" as const,
    note: "r".repeat(300),
    origin: "manual" as const,
    createdByKind: "user" as const,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  input.links = Array.from({ length: 6 }, (_, index) => ({
    id: `l${index}`,
    projectId: input.project.id,
    targetService: "artifacts",
    targetResourceType: "artifact_item",
    targetResourceId: `a${index}`,
    relationType: "secondary_membership",
    titleSnapshot: "l".repeat(300),
    linkedAt: timestamp,
    metadataJson: {}
  }));

  const output = budgetProjectContext(input, 1_000);

  assert.ok(JSON.stringify(output).length <= output.truncation.maxChars);
  assert.deepEqual(
    output.truncation.truncatedSections,
    ["memory", "index", "relations", "summary", "links"]
  );
  assert.ok((output.memories?.length ?? 0) > 0);
  assert.equal(output.indexEntries, undefined);
});

test("cursor parser preserves emitted cursors and rejects malformed ordering data", () => {
  const cursorTimestamp = "2026-06-22T01:02:03.456Z";
  const cursor = toCursor(cursorTimestamp, "resource-id");
  assert.deepEqual(parseCursor(cursor), { t: cursorTimestamp, id: "resource-id" });

  const legacyCursor = Buffer.from(JSON.stringify({ t: cursorTimestamp, id: "legacy-id" }), "utf8").toString("base64url");
  assert.deepEqual(parseCursor(legacyCursor), { t: cursorTimestamp, id: "legacy-id" });

  const invalidPayloads = [
    "not-a-cursor",
    `${cursor}!`,
    Buffer.from("not-json", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify([cursorTimestamp, "resource-id"]), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ id: "resource-id" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: cursorTimestamp }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: "not-a-timestamp", id: "resource-id" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: "0", id: "resource-id" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026-06-22", id: "resource-id" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026-06-22T01:02:03.456", id: "resource-id" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026/06/22 01:02:03", id: "resource-id" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: cursorTimestamp, id: 42 }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ t: cursorTimestamp, id: "resource-id", extra: true }), "utf8").toString("base64url")
  ];
  for (const invalid of invalidPayloads) {
    assert.throws(() => parseCursor(invalid), InvalidCursorError);
  }
  assert.equal(parseCursor(undefined), undefined);
});

test("project index search query options normalize NFKC tokens and default to any mode", async () => {
  process.env.PROJECTS_DB_HOST ??= "127.0.0.1";
  process.env.PROJECTS_DB_PORT ??= "5546";
  process.env.PROJECTS_DB_NAME ??= "projects_db";
  process.env.PROJECTS_DB_USER ??= "projects_user";
  process.env.PROJECTS_DB_PASSWORD ??= "projects_pass";

  const { projectIndexStoreTestHooks } = await import("../projectIndexStore.js");

  assert.deepEqual(
    projectIndexStoreTestHooks.normalizeProjectIndexQuery("  Ｊｅｒｅｍｙ　６月末  "),
    ["Jeremy", "6月末"]
  );
  assert.deepEqual(projectIndexStoreTestHooks.normalizeProjectIndexQuery("　　"), []);
  assert.equal(projectIndexStoreTestHooks.normalizeProjectIndexSearchMode(undefined), "any");
  assert.equal(projectIndexStoreTestHooks.normalizeProjectIndexSearchMode("all"), "all");
});
