import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const {
  buildProjectContextInvalidationPayload,
  buildProjectContextSyncItem,
  parseProjectContextBaselineCursor,
  projectContextSnapshotPage,
  recordProjectContextInvalidation,
  recordProjectContextInvalidationsBestEffort,
  requireProjectContextEndpoints,
  SYNC_SUPPORTED_DOMAINS
} = await import("../projectContextSync.js");

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Project context sync contract", () => {
  it("builds the frozen invalidation envelope", () => {
    assert.deepEqual(buildProjectContextInvalidationPayload({
      projectId: "project-1",
      changed: ["brief", "brief"],
      entityType: "brief",
      entityId: "project-1",
      source: "core-api"
    }), {
      schemaVersion: 1,
      kind: "invalidate",
      projectId: "project-1",
      changed: ["brief"],
      entityType: "brief",
      entityId: "project-1",
      source: "core-api"
    });
  });

  it("records relation invalidations for both endpoints without duplicates", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await recordProjectContextInvalidationsBestEffort(
      "user-1",
      ["project-a", "project-b", "project-a"],
      {
        changed: ["relation"],
        entityType: "relation",
        entityId: "relation-1",
        source: "core-mcp"
      },
      async (userId, domain, resourceId, action, payload) => {
        calls.push({ userId, domain, resourceId, action, payload });
        return {
          cursor: String(calls.length), userId, domain, resourceId, action,
          version: 1, payload, createdAt: "2026-06-21T00:00:00.000Z"
        };
      }
    );

    assert.deepEqual(calls.map((call) => call.resourceId).sort(), ["project-a", "project-b"]);
    assert.equal(calls.every((call) => call.domain === "project_context"), true);
    assert.equal(calls.every((call) => call.action === "update"), true);
  });

  it("uses the Project id as the resource id for delete invalidations", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await recordProjectContextInvalidation(
      "user-1",
      {
        projectId: "project-delete",
        changed: ["project"],
        entityType: "project",
        entityId: "project-delete",
        source: "sync-push",
        action: "delete"
      },
      async (userId, domain, resourceId, action, payload) => {
        calls.push({ userId, domain, resourceId, action, payload });
        return {
          cursor: "9", userId, domain, resourceId, action,
          version: 1, payload, createdAt: "2026-06-21T00:00:00.000Z"
        };
      }
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      userId: "user-1",
      domain: "project_context",
      resourceId: "project-delete",
      action: "delete",
      payload: {
        schemaVersion: 1,
        kind: "invalidate",
        projectId: "project-delete",
        changed: ["project"],
        entityType: "project",
        entityId: "project-delete",
        source: "sync-push"
      }
    });
  });

  it("keeps invalidation side effects best effort while attempting every Project", async () => {
    const attempted: string[] = [];
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      await recordProjectContextInvalidationsBestEffort(
        "user-1",
        ["project-a", "project-b"],
        {
          changed: ["link"],
          entityType: "link",
          entityId: "link-1",
          source: "core-api"
        },
        async (_userId, _domain, resourceId) => {
          attempted.push(resourceId);
          throw new Error(`failed ${resourceId}`);
        }
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(attempted.sort(), ["project-a", "project-b"]);
  });

  it("builds a complete bounded snapshot item with the retained baseline", () => {
    const item = buildProjectContextSyncItem({
      projectId: "project-1",
      complete: true,
      counts: { memories: 1, relations: 1 },
      project: { id: "project-1", name: "Project" },
      brief: { projectId: "project-1", version: 2, contentMarkdown: "# Brief" },
      memories: [{ id: "memory-1", projectId: "project-1" }],
      relations: [{ id: "relation-1", sourceProjectId: "project-1", targetProjectId: "project-2" }]
    }, "12345", "2026-06-21T00:00:00.000Z");

    assert.equal(item.schemaVersion, 1);
    assert.equal(item.baselineCursor, "12345");
    assert.equal(item.complete, true);
    assert.deepEqual(item.counts, { memories: 1, relations: 1 });
    assert.equal((item.context as { project: { id: string } }).project.id, "project-1");
  });

  it("rejects incomplete items and malformed baselines", () => {
    assert.throws(
      () => buildProjectContextSyncItem({
        projectId: "project-1",
        complete: false,
        counts: { memories: 0, relations: 0 },
        project: { id: "project-1" },
        memories: [],
        relations: []
      }, "0", "2026-06-21T00:00:00.000Z"),
      (error: unknown) => (error as { code?: string }).code === "INVALID_PROJECT_CONTEXT_SYNC_RESPONSE"
    );
    assert.equal(parseProjectContextBaselineCursor("0012"), "0012");
    assert.throws(
      () => parseProjectContextBaselineCursor("not-a-cursor"),
      (error: unknown) => (error as { code?: string }).code === "SYNC_BASELINE_CURSOR_INVALID"
    );
  });

  it("preserves Project pagination cursors and fails closed on malformed pages", () => {
    assert.deepEqual(
      projectContextSnapshotPage({ items: [{ id: "project-1" }], nextCursor: "next-project" }),
      { items: [{ id: "project-1" }], nextCursor: "next-project" }
    );
    for (const malformed of [
      [{ id: "legacy-array" }],
      {},
      { items: [null] },
      { items: [], nextCursor: null },
      { items: [], nextCursor: 12 },
      { items: [], nextCursor: {} },
      { items: [], nextCursor: " " },
      { items: [], nextCursor: " padded " }
    ]) {
      assert.throws(
        () => projectContextSnapshotPage(malformed),
        (error: unknown) => (error as { code?: string }).code === "INVALID_PROJECT_CONTEXT_SYNC_RESPONSE"
      );
    }
  });

  it("requires both relation endpoints before recording invalidations", () => {
    assert.deepEqual(
      requireProjectContextEndpoints({
        id: "relation-1",
        sourceProjectId: "project-a",
        targetProjectId: "project-b"
      }),
      { id: "relation-1", sourceProjectId: "project-a", targetProjectId: "project-b" }
    );
    for (const malformed of [
      { id: "relation-1", sourceProjectId: "project-a" },
      { id: "relation-1", targetProjectId: "project-b" },
      { sourceProjectId: "project-a", targetProjectId: "project-b" }
    ]) {
      assert.throws(
        () => requireProjectContextEndpoints(malformed),
        (error: unknown) => (error as { code?: string }).code === "INVALID_PROJECT_RELATION_RESPONSE"
      );
    }
  });

  it("advertises project_context without changing the legacy domain names", () => {
    assert.deepEqual(SYNC_SUPPORTED_DOMAINS, ["projects", "notes", "artifacts", "tasks", "project_context"]);
  });

  it("keeps HTTP and MCP mutations on the shared adapter with no legacy context events", () => {
    const http = readFileSync(join(sourceRoot, "httpServer.ts"), "utf8");
    const projectMcp = readFileSync(join(sourceRoot, "mcp", "registerProjectContextTools.ts"), "utf8");
    const artifactMcp = readFileSync(join(sourceRoot, "mcp", "registerArtifactsTools.ts"), "utf8");
    const projectsMcp = readFileSync(join(sourceRoot, "mcp", "registerProjectsTools.ts"), "utf8");
    const internalClients = readFileSync(join(sourceRoot, "internalClients.ts"), "utf8");

    assert.match(http, /app\.get\("\/api\/sync\/project-context\/:projectId"/);
    assert.match(http, /supportedDomains: SYNC_SUPPORTED_DOMAINS/);
    assert.match(internalClients, /\/projects\/\$\{encodeURIComponent\(projectId\)\}\/sync-context/);
    assert.match(internalClients, /\/project-relations\/\$\{encodeURIComponent\(relationId\)\}/);
    assert.match(http, /source: "core-api"/);
    assert.match(projectMcp, /source: "core-mcp"/);
    assert.match(artifactMcp, /source: "core-mcp"/);
    assert.match(projectsMcp, /source: "core-mcp"/);
    assert.match(http, /source: "sync-push"/);
    assert.match(http, /projectsClient\.getRelation[\s\S]{0,300}projectsClient\.removeRelation/);
    assert.match(projectMcp, /projectsClient\.getRelation[\s\S]{0,300}projectsClient\.removeRelation/);
    assert.doesNotMatch(
      http,
      /recordSyncEventBestEffort\(authContext\.userId,\s*"projects",[\s\S]{0,400}?relation:\s*"(?:brief|memory|index|project-relation|project-membership)"/
    );
    for (const changed of ["brief", "memory", "relation", "link", "index"] as const) {
      assert.equal(http.includes(`"${changed}"`), true, `missing HTTP ${changed} invalidation wiring`);
      assert.equal(projectMcp.includes(`"${changed}"`), true, `missing MCP ${changed} invalidation wiring`);
    }
    assert.equal(http.includes('"membership"'), true, "missing HTTP membership invalidation wiring");
    assert.equal(artifactMcp.includes('"membership"'), true, "missing Artifact MCP membership invalidation wiring");
    assert.equal(http.includes('"summary"'), true, "missing future summary invalidation wiring");
    assert.match(http, /invalidateProjectContextFromApi\([\s\S]{0,220}?"delete"[\s\S]{0,80}?\);/);
    assert.match(projectsMcp, /invalidateProjectFromMcp\(userId, id, "delete"\)/);

    // The existing projects domain remains exclusively for base Project CRUD
    // and default-selection events. These assertions guard both halves of the
    // compatibility contract: no context-shaped producer returns, while base
    // Project synchronization remains wired for HTTP, MCP, and sync push.
    for (const legacyRelation of ["brief", "memory", "index", "project-relation", "project-membership"] as const) {
      assert.doesNotMatch(
        http,
        new RegExp(`recordSyncEvent(?:BestEffort)?\\([\\s\\S]{0,180}?"projects"[\\s\\S]{0,300}?relation:\\s*"${legacyRelation}"`)
      );
    }
    assert.match(http, /recordSyncEventBestEffort\(authContext\.userId, "projects", projectId, "create"/);
    assert.match(http, /recordSyncEventBestEffort\(authContext\.userId, "projects", projectId, "update", \{[\s\S]{0,120}?relation: "default"/);
    assert.match(http, /recordSyncEventBestEffort\(authContext\.userId, "projects", String\(req\.params\.projectId\), "delete"/);
    assert.match(projectsMcp, /recordSyncEvent\(userId, "projects", projectId, action, payload\)/);
    assert.match(http, /recordSyncEvent\(authContext\.userId, "projects", nextResourceId/);
  });
});
