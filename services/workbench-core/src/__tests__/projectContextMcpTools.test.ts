import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.PROJECTS_SERVICE_URL ||= "http://projects.test";
process.env.JWT_SECRET ||= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ||= "workbench-test";
process.env.JWT_EXPIRY_SECONDS ||= "3600";
process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test";
process.env.CORE_DB_USER ||= "workbench-test";
process.env.CORE_DB_PASSWORD ||= "workbench-test";
process.env.INTERNAL_API_KEY_NOTES ||= "test-internal-key";
process.env.INTERNAL_API_KEY_ARTIFACTS ||= "test-internal-key";
process.env.INTERNAL_API_KEY_TASKS ||= "test-internal-key";
process.env.INTERNAL_API_KEY_IMAGES ||= "test-internal-key";
process.env.INTERNAL_API_KEY_MINDMAPS ||= "test-internal-key";

const [{ registerProjectContextTools }, { registerArtifactsTools }, { registerMindmapTools }, readModels] = await Promise.all([
  import("../mcp/registerProjectContextTools.js"),
  import("../mcp/registerArtifactsTools.js"),
  import("../mcp/registerMindmapTools.js"),
  import("../mcp/projectContextReadModels.js")
]);

describe("Project context MCP contract", () => {
  it("registers every frozen Project and Artifact membership tool", () => {
    const names = new Set<string>();
    const fakeServer = {
      registerTool(name: string): void {
        names.add(name);
      }
    };

    registerProjectContextTools(fakeServer as never, { accessToken: "unused" });
    registerArtifactsTools(fakeServer as never, { accessToken: "unused" });
    registerMindmapTools(fakeServer as never, { accessToken: "unused" });

    const expected = [
      "projects.context.get",
      "projects.brief.get",
      "projects.brief.update",
      "projects.memory.list",
      "projects.memory.append",
      "projects.memory.update",
      "projects.memory.archive",
      "projects.index.search",
      "projects.index.rebuild",
      "mindmaps.list",
      "mindmaps.get",
      "mindmaps.create",
      "mindmaps.update",
      "mindmaps.delete",
      "mindmaps.export",
      "mindmaps.artifact.save",
      "mindmaps.projectIndex.rebuild",
      "artifacts.item.projects.list",
      "artifacts.item.projects.link",
      "artifacts.item.projects.unlink",
      "projects.delete.preview",
      "projects.relations.list",
      "projects.relations.add",
      "projects.relations.update",
      "projects.relations.remove",
      "projects.links.list",
      "projects.links.add",
      "projects.links.remove"
    ];

    for (const name of expected) assert.equal(names.has(name), true, `missing MCP tool ${name}`);
  });

  it("projects compact read models while retaining authority and provenance", () => {
    const memoryPage = readModels.memoryListMcpReadProjection({
      items: [{
        id: "memory-1",
        projectId: "project-1",
        kind: "decision",
        bodyMarkdown: "Use stable ids",
        authority: "agent_observed",
        sourceService: "notes",
        sourceResourceType: "note",
        sourceResourceId: "note-1",
        confidence: 0.8,
        status: "active",
        createdByKind: "agent",
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:00:00.000Z",
        ownerAccountId: "must-not-leak",
        internalDebug: { raw: true }
      }],
      nextCursor: "cursor-2",
      totalCount: 999
    });
    const memory = (memoryPage.items as Array<Record<string, unknown>>)[0];
    assert.equal(memory?.authority, "agent_observed");
    assert.equal(memory?.sourceResourceId, "note-1");
    assert.equal(memory?.confidence, 0.8);
    assert.equal("ownerAccountId" in (memory ?? {}), false);
    assert.deepEqual(Object.keys(memoryPage).sort(), ["items", "nextCursor"]);

    const context = readModels.projectContextMcpReadProjection({
      project: {
        id: "project-1",
        name: "Project",
        description: "",
        status: "active",
        ownerAccountId: "must-not-leak",
        updatedAt: "2026-06-23T00:00:00.000Z"
      },
      links: [{
        id: "link-1",
        projectId: "project-1",
        targetService: "notes",
        targetResourceType: "note",
        targetResourceId: "note-1",
        relationType: "reference",
        titleSnapshot: "Live title",
        targetResolution: "live",
        targetBody: "must-not-leak"
      }],
      truncation: { maxChars: 12_000, truncatedSections: [] },
      internalBudgetTrace: ["must-not-leak"]
    });
    const projectedProject = context.project as Record<string, unknown>;
    const projectedLink = (context.links as Array<Record<string, unknown>>)[0];
    assert.equal("ownerAccountId" in projectedProject, false);
    assert.equal(projectedLink?.targetResolution, "live");
    assert.equal("targetBody" in (projectedLink ?? {}), false);
  });

  it("fails closed instead of turning malformed upstream read pages into authoritative empties", () => {
    for (const projection of [
      readModels.memoryListMcpReadProjection,
      readModels.indexListMcpReadProjection,
      readModels.relationListMcpReadProjection,
      readModels.linkListMcpReadProjection
    ]) {
      assert.throws(
        () => projection({ nextCursor: "misleading" }),
        (error: unknown) => error instanceof readModels.ProjectContextReadModelError
      );
      for (const nextCursor of ["", " cursor-1", "cursor-1 ", 42]) {
        assert.throws(
          () => projection({ items: [], nextCursor }),
          (error: unknown) => error instanceof readModels.ProjectContextReadModelError
        );
      }
    }
    assert.throws(
      () => readModels.projectContextMcpReadProjection({ project: {}, truncation: {} }),
      (error: unknown) => error instanceof readModels.ProjectContextReadModelError
    );
    assert.throws(
      () => readModels.projectContextMcpReadProjection({
        project: {
          id: "project-1",
          name: "Project",
          status: "active",
          updatedAt: "2026-06-23T00:00:00.000Z"
        },
        memories: {},
        truncation: { maxChars: 12_000, truncatedSections: [] }
      }),
      (error: unknown) => error instanceof readModels.ProjectContextReadModelError
    );
  });

  it("accepts intentionally empty index summaries but rejects missing summaryText", () => {
    const emptySummaryEntry = readModels.indexMcpReadProjection({
      id: "index-1",
      projectId: "project-1",
      sourceService: "artifacts",
      resourceType: "artifact_item",
      resourceId: "artifact-1",
      associationKind: "primary",
      title: "Artifact",
      summaryText: "",
      summarySource: "generated",
      sourceUpdatedAt: "2026-06-23T00:00:00.000Z",
      indexedAt: "2026-06-23T00:00:00.000Z"
    });
    assert.equal(emptySummaryEntry.summaryText, "");

    assert.throws(
      () => readModels.indexMcpReadProjection({
        id: "index-1",
        projectId: "project-1",
        sourceService: "artifacts",
        resourceType: "artifact_item",
        resourceId: "artifact-1",
        associationKind: "primary",
        title: "Artifact",
        summarySource: "generated",
        sourceUpdatedAt: "2026-06-23T00:00:00.000Z",
        indexedAt: "2026-06-23T00:00:00.000Z"
      }),
      (error: unknown) => error instanceof readModels.ProjectContextReadModelError
    );
  });

  it("documents guards and side effects on every Project-context mutation tool", () => {
    const definitions = new Map<string, { description?: string }>();
    const fakeServer = {
      registerTool(name: string, definition: { description?: string }): void {
        definitions.set(name, definition);
      }
    };
    registerProjectContextTools(fakeServer as never, { accessToken: "unused" });
    registerArtifactsTools(fakeServer as never, { accessToken: "unused" });

    const mutations = [
      "projects.brief.update",
      "projects.memory.append",
      "projects.memory.update",
      "projects.memory.archive",
      "projects.index.rebuild",
      "projects.relations.add",
      "projects.relations.update",
      "projects.relations.remove",
      "projects.links.add",
      "projects.links.remove",
      "artifacts.item.projects.link",
      "artifacts.item.projects.unlink"
    ];
    for (const name of mutations) {
      assert.match(definitions.get(name)?.description ?? "", /invalidat/i, `${name} must disclose invalidation`);
    }
    assert.match(definitions.get("projects.brief.update")?.description ?? "", /expectedVersion/);
    assert.match(definitions.get("projects.relations.update")?.description ?? "", /expectedVersion/);
    assert.match(definitions.get("projects.links.remove")?.description ?? "", /keep the Artifact intact/i);
    assert.match(definitions.get("artifacts.item.projects.unlink")?.description ?? "", /Primary membership.*guarded/i);
  });
});
