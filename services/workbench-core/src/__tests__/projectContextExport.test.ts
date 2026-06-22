import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const { buildProjectContextExportResponse } = await import("../projectContextExport.js");

type JsonRecord = Record<string, unknown>;

function fixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packageType: "workbench.project-context-export",
    generatedAt: "2026-06-23T00:00:00.000Z",
    complete: true,
    project: {
      id: "project-1", name: "Project", status: "active", updatedAt: "2026-06-23T00:00:00.000Z",
      ownerAccountId: "owner-secret"
    },
    brief: {
      projectId: "project-1", contentMarkdown: "# Brief", version: 1,
      updatedAt: "2026-06-23T00:00:00.000Z", metadata: { owner_account_id: "nested-secret" }
    },
    memories: [{
      id: "memory-1", projectId: "project-1", kind: "decision", bodyMarkdown: "Decision",
      authority: "user_confirmed", status: "active", createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z", ownerAccountId: "secret"
    }],
    relations: [],
    links: [],
    indexEntries: [],
    generatedSummary: null,
    counts: { memories: 1, relations: 0, links: 0, indexEntries: 0 }
  };
}

describe("Project context export facade", () => {
  it("accepts a complete live snapshot and recursively removes owner identity", () => {
    const result = buildProjectContextExportResponse(fixture(), "project-1");
    assert.equal(result.packageType, "workbench.project-context-export");
    assert.equal(JSON.stringify(result).includes("owner-secret"), false);
    assert.equal(JSON.stringify(result).includes("nested-secret"), false);
    assert.equal(JSON.stringify(result).includes("ownerAccountId"), false);
    assert.equal(JSON.stringify(result).includes("owner_account_id"), false);
  });

  it("fails closed on mismatched, partial, or non-canonical snapshots", () => {
    const cases = [
      { ...fixture(), complete: false },
      { ...fixture(), generatedAt: "not-a-timestamp" },
      { ...fixture(), counts: { memories: 2, relations: 0, links: 0, indexEntries: 0 } },
      { ...fixture(), project: { id: "project-other" } },
      { ...fixture(), brief: { foo: true } },
      { ...fixture(), memories: [null] },
      { ...fixture(), memories: [{ ...(fixture().memories as JsonRecord[])[0], projectId: "project-other" }] },
      { ...fixture(), relations: [{
        id: "relation-1", sourceProjectId: "project-a", targetProjectId: "project-b", relationType: "related",
        version: 1, createdAt: "2026-06-23T00:00:00.000Z", updatedAt: "2026-06-23T00:00:00.000Z"
      }], counts: { memories: 1, relations: 1, links: 0, indexEntries: 0 } },
      { ...fixture(), links: [{ projectId: "project-other" }], counts: { memories: 1, relations: 0, links: 1, indexEntries: 0 } },
      { ...fixture(), generatedSummary: {} }
    ];
    for (const value of cases) {
      assert.throws(
        () => buildProjectContextExportResponse(value, "project-1"),
        (error: unknown) => (error as { code?: string }).code === "PROJECT_CONTEXT_EXPORT_UNAVAILABLE"
      );
    }
  });
});
