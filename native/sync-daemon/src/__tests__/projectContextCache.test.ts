import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  closeManifestStore,
  markRemoteResourceDeleted,
  openManifestStore,
  setMeta,
  upsertRemoteResource,
  type ManifestStore
} from "../manifestStore.js";
import {
  cacheProjectContextSnapshot,
  getLocalProjectBrief,
  getLocalProjectContext,
  listLocalProjectMemories,
  listLocalProjectRelations,
  LocalProjectContextError,
  removeStaleProjectContextRows
} from "../projectContextCache.js";

const roots: string[] = [];

async function createStore(): Promise<ManifestStore> {
  const root = await mkdtemp(join(tmpdir(), "workbench-project-context-"));
  roots.push(root);
  await mkdir(join(root, ".workbench"), { recursive: true });
  return openManifestStore(root);
}

function contextSnapshot(projectId = "project-1", fetchedAt = "2026-06-21T00:00:00.000Z") {
  return {
    schemaVersion: 1,
    projectId,
    fetchedAt,
    baselineCursor: "40",
    complete: true,
    counts: { memories: 3, relations: 2 },
    context: {
      project: {
        id: projectId,
        name: "Snapshot name",
        description: "Snapshot description",
        status: "active",
        updatedAt: "2026-06-20T00:00:00.000Z"
      },
      brief: {
        projectId,
        contentMarkdown: "# Rules\nKeep provenance.",
        version: 4,
        updatedByKind: "user",
        updatedAt: "2026-06-20T12:00:00.000Z"
      },
      memories: [
        {
          id: "memory-3",
          projectId,
          kind: "decision",
          bodyMarkdown: "Use the stable API",
          authority: "user_confirmed",
          status: "active",
          updatedAt: "2026-06-21T03:00:00.000Z"
        },
        {
          id: "memory-2",
          projectId,
          kind: "pitfall",
          bodyMarkdown: "Never infer membership",
          authority: "agent_observed",
          status: "active",
          updatedAt: "2026-06-21T02:00:00.000Z"
        },
        {
          id: "memory-1",
          projectId,
          kind: "decision",
          bodyMarkdown: "Use explicit memberships",
          authority: "agent_observed",
          status: "active",
          updatedAt: "2026-06-21T01:00:00.000Z"
        }
      ],
      relations: [
        {
          id: "relation-2",
          sourceProjectId: projectId,
          targetProjectId: "project-3",
          relationType: "supports",
          version: 2,
          updatedAt: "2026-06-21T02:00:00.000Z"
        },
        {
          id: "relation-1",
          sourceProjectId: projectId,
          targetProjectId: "project-2",
          relationType: "related",
          version: 1,
          updatedAt: "2026-06-21T01:00:00.000Z"
        }
      ]
    }
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("local Project context cache", () => {
  it("accepts complete snapshots and overlays the current Project cache record", async () => {
    const store = await createStore();
    try {
      cacheProjectContextSnapshot(store, contextSnapshot(), { version: 7 });
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-1",
        version: 9,
        payload: {
          id: "project-1",
          name: "Renamed Project",
          description: "Current description",
          status: "archived",
          updatedAt: "2026-06-21T04:00:00.000Z"
        }
      });

      const context = getLocalProjectContext(store, "project-1", {
        include: ["brief", "memory", "relations"],
        maxChars: 50_000
      });
      const project = context.project as Record<string, unknown>;
      const localCache = context.localCache as Record<string, unknown>;
      assert.equal(project.name, "Renamed Project");
      assert.equal(project.status, "archived");
      assert.equal(localCache.snapshotComplete, true);
      assert.equal(localCache.fetchedAt, "2026-06-21T00:00:00.000Z");
      assert.deepEqual((context.truncation as { truncatedSections: string[] }).truncatedSections, []);
      assert.equal(getLocalProjectBrief(store, "project-1").version, 4);
    } finally {
      closeManifestStore(store);
    }
  });

  it("filters and pages active memory while preserving authority and freshness", async () => {
    const store = await createStore();
    try {
      cacheProjectContextSnapshot(store, contextSnapshot());
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-1",
        payload: { id: "project-1", name: "Project", status: "active" }
      });

      const first = listLocalProjectMemories(store, "project-1", {
        kind: "decision",
        authority: "agent_observed",
        q: "membership",
        limit: 1
      });
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0].id, "memory-1");
      assert.equal(first.items[0].authority, "agent_observed");
      assert.equal(first.localCache.snapshotComplete, true);

      const relationPage = listLocalProjectRelations(store, "project-1", { limit: 1 });
      assert.equal(relationPage.items[0].id, "relation-2");
      assert.ok(relationPage.nextCursor);
      const relationNext = listLocalProjectRelations(store, "project-1", {
        limit: 1,
        cursor: relationPage.nextCursor
      });
      assert.equal(relationNext.items[0].id, "relation-1");

      for (const invalidCursor of [
        "not*base64url",
        `${relationPage.nextCursor}=`,
        Buffer.from(JSON.stringify({
          t: "2026-06-21T02:00:00.000Z",
          id: "relation-2",
          extra: true
        }), "utf8").toString("base64url"),
        Buffer.from(JSON.stringify({
          t: "2026-06-21T02:00:00Z",
          id: "relation-2"
        }), "utf8").toString("base64url"),
        Buffer.from(JSON.stringify({
          t: " 2026-06-21T02:00:00.000Z ",
          id: "relation-2"
        }), "utf8").toString("base64url")
      ]) {
        assert.throws(
          () => listLocalProjectRelations(store, "project-1", { cursor: invalidCursor }),
          (error: unknown) => error instanceof LocalProjectContextError
            && error.status === 400
            && error.code === "INVALID_CURSOR"
        );
      }

      assert.throws(
        () => listLocalProjectMemories(store, "project-1", { status: "archived" }),
        (error: unknown) => error instanceof LocalProjectContextError
          && error.code === "LOCAL_PROJECT_CONTEXT_SECTION_UNAVAILABLE"
      );
    } finally {
      closeManifestStore(store);
    }
  });

  it("reports unavailable E1 sections and applies the caller character budget", async () => {
    const store = await createStore();
    try {
      const snapshot = contextSnapshot();
      snapshot.context.memories[0].bodyMarkdown = "x".repeat(10_000);
      cacheProjectContextSnapshot(store, snapshot);
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-1",
        payload: { id: "project-1", name: "Project", description: "", status: "active" }
      });

      const context = getLocalProjectContext(store, "project-1", { maxChars: 1_500 });
      const truncation = context.truncation as { maxChars: number; truncatedSections: string[] };
      assert.equal(truncation.maxChars, 1_500);
      assert.ok(truncation.truncatedSections.includes("memory"));
      assert.ok(truncation.truncatedSections.includes("summary"));
      assert.ok(truncation.truncatedSections.includes("index"));
      assert.ok(truncation.truncatedSections.includes("links"));
      assert.ok(JSON.stringify(context).length <= 1_500);
    } finally {
      closeManifestStore(store);
    }
  });

  it("orders pagination ties with deterministic code-unit ordering", async () => {
    const store = await createStore();
    try {
      const snapshot = contextSnapshot();
      snapshot.context.relations[0].id = "ä-relation";
      snapshot.context.relations[1].id = "z-relation";
      snapshot.context.relations[1].updatedAt = snapshot.context.relations[0].updatedAt;
      cacheProjectContextSnapshot(store, snapshot);

      const first = listLocalProjectRelations(store, "project-1", { limit: 1 });
      assert.equal(first.items[0].id, "ä-relation");
      const second = listLocalProjectRelations(store, "project-1", { limit: 1, cursor: first.nextCursor });
      assert.equal(second.items[0].id, "z-relation");
    } finally {
      closeManifestStore(store);
    }
  });

  it("rejects incomplete snapshots and removes stale context rows without touching other domains", async () => {
    const store = await createStore();
    try {
      assert.throws(
        () => cacheProjectContextSnapshot(store, { ...contextSnapshot(), complete: false }),
        (error: unknown) => error instanceof LocalProjectContextError
          && error.code === "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT"
      );
      cacheProjectContextSnapshot(store, contextSnapshot("project-1"));
      cacheProjectContextSnapshot(store, contextSnapshot("project-stale"));
      upsertRemoteResource(store, {
        domain: "notes",
        resourceId: "note-1",
        payload: { id: "note-1", title: "Keep me" }
      });

      assert.deepEqual(removeStaleProjectContextRows(store, new Set(["project-1"])), ["project-stale"]);
      assert.equal(listLocalProjectMemories(store, "project-1").items.length, 3);
      assert.throws(
        () => listLocalProjectMemories(store, "project-stale"),
        (error: unknown) => error instanceof LocalProjectContextError
      );
    } finally {
      closeManifestStore(store);
    }
  });

  it("rejects cross-Project rows and treats a tombstoned base Project as deleted", async () => {
    const store = await createStore();
    try {
      const wrongMemory = contextSnapshot();
      wrongMemory.context.memories[0].projectId = "project-other";
      assert.throws(
        () => cacheProjectContextSnapshot(store, wrongMemory),
        (error: unknown) => error instanceof LocalProjectContextError
          && error.code === "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT"
      );

      cacheProjectContextSnapshot(store, contextSnapshot());
      markRemoteResourceDeleted(store, {
        domain: "projects",
        resourceId: "project-1",
        version: 2,
        deletedAt: "2026-06-21T05:00:00.000Z"
      });
      assert.throws(
        () => getLocalProjectBrief(store, "project-1"),
        (error: unknown) => error instanceof LocalProjectContextError
          && error.status === 404
          && error.code === "PROJECT_NOT_FOUND"
      );
    } finally {
      closeManifestStore(store);
    }
  });

  it("preserves a previously complete cached snapshot when capability is unavailable", async () => {
    const store = await createStore();
    try {
      cacheProjectContextSnapshot(store, contextSnapshot());
      setMeta(store, "projectContextSupported", "0");
      const brief = getLocalProjectBrief(store, "project-1");
      assert.equal(brief.version, 4);
      assert.equal((brief.localCache as Record<string, unknown>).snapshotComplete, true);
    } finally {
      closeManifestStore(store);
    }
  });
});
