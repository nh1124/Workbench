import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  handleLocalProjectContextWrite,
  type DaemonConfig,
  type DaemonState
} from "../index.js";
import {
  closeManifestStore,
  getRemoteResource,
  openManifestStore,
  readManifestFromStore,
  type ManifestStore
} from "../manifestStore.js";
import {
  cacheProjectContextSnapshot,
  getLocalProjectBrief,
  listLocalProjectMemories,
  listLocalProjectRelations,
  LocalProjectContextError
} from "../projectContextCache.js";

const roots: string[] = [];

async function createState(): Promise<{ store: ManifestStore; state: DaemonState }> {
  const root = await mkdtemp(join(tmpdir(), "workbench-project-context-writes-"));
  roots.push(root);
  await mkdir(join(root, ".workbench"), { recursive: true });
  const store = openManifestStore(root);
  const config: DaemonConfig = {
    coreUrl: "http://127.0.0.1:1",
    syncRoot: root,
    downloadsDir: join(root, "downloads"),
    deviceId: "test-device",
    clientName: "test daemon",
    syncRootId: "test-root",
    syncRootLabel: "Test Sync",
    intervalMs: 5000,
    httpPort: 0,
    maxSyncFileBytes: 10 * 1024 * 1024,
    watchEnabled: false,
    watchDebounceMs: 100
  };
  return {
    store,
    state: {
      config,
      manifestStore: store,
      processedJobs: 0,
      outboxPending: 0,
      outboxFailed: 0,
      conflictsOpen: 0,
      watcherActive: false,
      tickRunning: false,
      tickQueued: false
    }
  };
}

function contextSnapshot(projectId: string, relationTargetId = "project-2") {
  const relation = {
    id: "relation-1",
    version: 3,
    sourceProjectId: "project-1",
    targetProjectId: relationTargetId,
    relationType: "related",
    directionality: "directed",
    note: "Existing relation",
    origin: "manual",
    createdByKind: "user",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
  return {
    schemaVersion: 1,
    projectId,
    fetchedAt: "2026-07-16T00:00:00.000Z",
    baselineCursor: "80",
    complete: true,
    counts: { memories: projectId === "project-1" ? 1 : 0, relations: 1 },
    context: {
      project: { id: projectId, name: projectId, status: "active" },
      brief: {
        projectId,
        contentMarkdown: "# Existing",
        version: 4,
        updatedByKind: "user",
        updatedAt: "2026-07-15T00:00:00.000Z"
      },
      memories: projectId === "project-1" ? [{
        id: "memory-1",
        projectId,
        kind: "decision",
        bodyMarkdown: "Existing memory",
        authority: "user_confirmed",
        status: "active",
        lifecycleState: "triaged",
        createdByKind: "user",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z"
      }] : [],
      relations: [relation]
    }
  };
}

function cancelScheduledTick(state: DaemonState): void {
  if (state.tickTimer) clearTimeout(state.tickTimer);
  state.tickTimer = undefined;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("local Project context offline writes", () => {
  it("queues a D-E2-001 brief update and reads back the optimistic version", async () => {
    const { store, state } = await createState();
    try {
      cacheProjectContextSnapshot(store, contextSnapshot("project-1"));
      const response = await handleLocalProjectContextWrite(
        state,
        "/api/projects/project-1/brief",
        "PUT",
        { contentMarkdown: "# Offline brief", expectedVersion: 4 }
      );
      cancelScheduledTick(state);

      assert.equal(response.statusCode, 200);
      assert.equal(response.body?.contentMarkdown, "# Offline brief");
      assert.equal(response.body?.version, 5);
      assert.equal(getLocalProjectBrief(store, "project-1").contentMarkdown, "# Offline brief");
      assert.equal(getLocalProjectBrief(store, "project-1").version, 5);

      const outbox = readManifestFromStore(store).outbox ?? [];
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].domain, "project_context");
      assert.equal(outbox[0].action, "update");
      assert.equal(outbox[0].resourceId, "project-1");
      assert.deepEqual(outbox[0].payload, {
        relation: "brief",
        contentMarkdown: "# Offline brief",
        expectedVersion: 4
      });
      assert.equal(getRemoteResource(store, "project_context", "project-1")?.payload.pendingLocalOps, true);
    } finally {
      cancelScheduledTick(state);
      closeManifestStore(store);
    }
  });

  it("returns 201 for a temp memory, echoes it into the list, and queues the REST body", async () => {
    const { store, state } = await createState();
    try {
      cacheProjectContextSnapshot(store, contextSnapshot("project-1"));
      const response = await handleLocalProjectContextWrite(
        state,
        "/api/projects/project-1/memories",
        "POST",
        { kind: "fact", bodyMarkdown: "Captured while offline", confidence: 0.8 }
      );
      cancelScheduledTick(state);

      assert.equal(response.statusCode, 201);
      assert.match(String(response.body?.id), /^local-/);
      assert.equal(response.body?.status, "active");
      assert.equal(response.body?.lifecycleState, "triaged");
      assert.equal(response.body?.authority, "user_confirmed");
      assert.ok(listLocalProjectMemories(store, "project-1").items.some((item) => item.id === response.body?.id));

      const item = (readManifestFromStore(store).outbox ?? [])[0];
      assert.equal(item.action, "create");
      assert.equal(item.resourceId, "project-1");
      assert.deepEqual(item.payload, {
        kind: "fact",
        bodyMarkdown: "Captured while offline",
        confidence: 0.8,
        relation: "memory"
      });
    } finally {
      cancelScheduledTick(state);
      closeManifestStore(store);
    }
  });

  it("rejects temp memory chaining with 409 and unknown memory ids with 404", async () => {
    const { store, state } = await createState();
    try {
      cacheProjectContextSnapshot(store, contextSnapshot("project-1"));
      await assert.rejects(
        handleLocalProjectContextWrite(
          state,
          "/api/project-memories/local-memory-1",
          "PATCH",
          { bodyMarkdown: "Cannot chain" }
        ),
        (error: unknown) => error instanceof LocalProjectContextError
          && error.status === 409
          && error.code === "LOCAL_PENDING_RESOURCE"
      );
      await assert.rejects(
        handleLocalProjectContextWrite(
          state,
          "/api/project-memories/memory-unknown",
          "PATCH",
          { bodyMarkdown: "Missing" }
        ),
        (error: unknown) => error instanceof LocalProjectContextError
          && error.status === 404
          && error.code === "PROJECT_MEMORY_NOT_FOUND"
      );
      assert.equal((readManifestFromStore(store).outbox ?? []).length, 0);
    } finally {
      cancelScheduledTick(state);
      closeManifestStore(store);
    }
  });

  it("queues a relation delete and removes it from both cached endpoint contexts", async () => {
    const { store, state } = await createState();
    try {
      cacheProjectContextSnapshot(store, contextSnapshot("project-1"));
      cacheProjectContextSnapshot(store, contextSnapshot("project-2"));
      const response = await handleLocalProjectContextWrite(
        state,
        "/api/project-relations/relation-1",
        "DELETE",
        {}
      );
      cancelScheduledTick(state);

      assert.equal(response.statusCode, 204);
      assert.equal(response.body, undefined);
      assert.equal(listLocalProjectRelations(store, "project-1").items.length, 0);
      assert.equal(listLocalProjectRelations(store, "project-2").items.length, 0);
      const item = (readManifestFromStore(store).outbox ?? [])[0];
      assert.equal(item.domain, "project_context");
      assert.equal(item.action, "delete");
      assert.equal(item.resourceId, "project-1");
      assert.deepEqual(item.payload, { relation: "relation", relationId: "relation-1" });
    } finally {
      cancelScheduledTick(state);
      closeManifestStore(store);
    }
  });

  it("keeps writes read-only when the project context snapshot is absent", async () => {
    const { store, state } = await createState();
    try {
      await assert.rejects(
        handleLocalProjectContextWrite(
          state,
          "/api/projects/project-1/brief",
          "PUT",
          { contentMarkdown: "No cache", expectedVersion: 0 }
        ),
        (error: unknown) => error instanceof LocalProjectContextError
          && error.status === 503
          && error.code === "LOCAL_PROJECT_CONTEXT_READ_ONLY"
      );
    } finally {
      cancelScheduledTick(state);
      closeManifestStore(store);
    }
  });
});
