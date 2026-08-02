import assert from "node:assert/strict";
import { LeaseRegistry } from "../leases.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  closeManifestStore,
  markOutboxFailed,
  openManifestStore,
  readManifestFromStore,
  recordConflict,
  upsertRemoteResource,
  upsertResource,
  type ManifestStore
} from "../manifestStore.js";
import {
  createLocalProject,
  createLocalNote,
  createLocalArtifactFile,
  createLocalArtifactFolder,
  createLocalArtifactNote,
  createLocalTask,
  createLocalTaskAttachment,
  addLocalTaskToToday,
  createLocalTaskSubtask,
  deleteLocalTaskSubtask,
  deleteLocalTaskAttachment,
  deleteLocalProject,
  deleteLocalNote,
  deleteLocalArtifactItem,
  deleteLocalTask,
  exportLocalTasksCsv,
  existingClientOpWriteResult,
  getLocalArtifactItemById,
  importLocalTasksCsv,
  listLocalArtifactItems,
  localScheduleCalendar,
  localTaskSchedule,
  localTaskHistory,
  localTodayTasks,
  patchLocalArtifactNoteContent,
  scanSyncFolder,
  setLocalDefaultProject,
  setLocalTaskPin,
  recordLocalTaskOccurrence,
  runWithClientOpId,
  removeLocalTaskFromToday,
  removeLocalTaskScheduleItem,
  updateLocalTaskScheduleItem,
  updateLocalTaskSubtask,
  updateLocalProject,
  updateLocalNote,
  updateLocalArtifactNoteSection,
  updateLocalArtifactItem,
  updateLocalTask,
  type DaemonConfig,
  type DaemonState
} from "../index.js";

const tempRoots: string[] = [];

function checksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createState(): Promise<{ root: string; store: ManifestStore; state: DaemonState }> {
  const root = await mkdtemp(join(tmpdir(), "workbench-sync-recovery-"));
  tempRoots.push(root);
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
    root,
    store,
    state: {
      config,
      manifestStore: store,
      leases: new LeaseRegistry(),
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

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("sync folder recovery", () => {
  it("cancels an unsynced create when the local file disappears before push", async () => {
    const { root, store, state } = await createState();
    try {
      const notePath = join(root, "draft.md");
      await writeFile(notePath, "# Draft\n", "utf8");
      await scanSyncFolder(state);

      let manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 1);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].status, "pending");
      assert.equal(manifest.outbox?.[0].action, "create");

      await unlink(notePath);
      await scanSyncFolder(state);

      manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 0);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].status, "superseded");
      assert.match(manifest.outbox?.[0].lastError ?? "", /removed before sync completed/);
      assert.equal(state.outboxPending, 0);
    } finally {
      closeManifestStore(store);
    }
  });

  it("builds local artifact facade items from manifest resources", async () => {
    const { root, store, state } = await createState();
    try {
      const notePath = join(root, "docs", "brief.md");
      const filePath = join(root, "docs", "asset.txt");
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(notePath, "# Brief\nLocal note\n", "utf8");
      await writeFile(filePath, "asset", "utf8");

      await scanSyncFolder(state);

      const items = await listLocalArtifactItems(state, { includeContent: true });
      const folder = items.find((item) => item.kind === "folder" && item.path === "docs");
      const note = items.find((item) => item.kind === "note" && item.path === "docs/brief.md");
      const file = items.find((item) => item.kind === "file" && item.path === "docs/asset.txt");

      assert.equal(folder?.title, "docs");
      assert.equal(note?.title, "brief");
      assert.equal(note?.contentMarkdown, "# Brief\nLocal note\n");
      assert.equal(file?.mimeType, "text/plain");

      assert.ok(note?.id);
      const loaded = await getLocalArtifactItemById(state, note.id, { includeContent: true });
      assert.equal(loaded?.path, "docs/brief.md");
      assert.equal(loaded?.contentMarkdown, "# Brief\nLocal note\n");
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local note facade writes into the outbox", async () => {
    const { root, store, state } = await createState();
    try {
      const created = await createLocalArtifactNote(state, {
        title: "Local Draft",
        contentMarkdown: "# Local\n"
      });
      assert.equal(created.kind, "note");
      assert.equal(created.path, "Local Draft.md");
      assert.equal(await readFile(join(root, "Local Draft.md"), "utf8"), "# Local\n");

      let manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 1);
      assert.equal(manifest.resources?.[0].dirty, true);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].action, "create");
      assert.equal(manifest.outbox?.[0].status, "pending");

      const updated = await updateLocalArtifactItem(state, created.id, {
        title: "Renamed Draft",
        contentMarkdown: "# Changed\n"
      });
      assert.equal(updated?.path, "Renamed Draft.md");
      assert.equal(await readFile(join(root, "Renamed Draft.md"), "utf8"), "# Changed\n");

      manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 1);
      assert.equal(manifest.resources?.[0].relativePath, "Renamed Draft.md");
      assert.deepEqual(manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort(), [
        "create:pending",
        "create:superseded"
      ]);

      assert.ok(updated?.id);
      assert.equal(await deleteLocalArtifactItem(state, updated.id), true);
      manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 0);
      assert.deepEqual(manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort(), [
        "create:superseded",
        "create:superseded"
      ]);
    } finally {
      closeManifestStore(store);
    }
  });

  it("threads a UI client operation id into the outbox and reuses the first POST result", async () => {
    const { store, state } = await createState();
    try {
      const clientOpId = "2fd4016a-8dff-4c3b-a7c8-d475cb038840";
      const created = await runWithClientOpId(clientOpId, () => createLocalNote(state, {
        title: "One logical write",
        content: "Created once"
      }));

      let manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].clientOpId, clientOpId);

      // This is the same lookup the HTTP route performs before invoking a local mutation again.
      const duplicate = existingClientOpWriteResult(state, clientOpId);
      assert.ok(duplicate);
      assert.deepEqual(duplicate.result, created);

      manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.remoteResources?.filter((item) => item.domain === "notes").length, 1);
    } finally {
      closeManifestStore(store);
    }
  });

  it("creates local artifact folders as sync-root directories", async () => {
    const { store, state } = await createState();
    try {
      const created = await createLocalArtifactFolder(state, {
        path: "docs/Empty Folder",
        title: "Empty Folder"
      });

      assert.equal(created.kind, "folder");
      assert.equal(created.path, "docs/Empty Folder");
      assert.equal(created.parentPath, "docs");

      const items = await listLocalArtifactItems(state);
      assert.ok(items.some((item) => item.kind === "folder" && item.path === "docs"));
      assert.ok(items.some((item) => item.kind === "folder" && item.path === "docs/Empty Folder"));

      const manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 1);
      assert.equal(manifest.resources?.[0].kind, "folder");
      assert.equal(manifest.resources?.[0].relativePath, "docs/Empty Folder");
      assert.equal(manifest.resources?.[0].dirty, true);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].action, "create");
      assert.equal(manifest.outbox?.[0].payload.kind, "folder");
      assert.equal(manifest.outbox?.[0].payload.path, "docs/Empty Folder");
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues empty folders discovered by sync scans", async () => {
    const { root, store, state } = await createState();
    try {
      await mkdir(join(root, "empty"), { recursive: true });
      await scanSyncFolder(state);

      const manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 1);
      assert.equal(manifest.resources?.[0].kind, "folder");
      assert.equal(manifest.resources?.[0].relativePath, "empty");
      assert.equal(manifest.resources?.[0].dirty, true);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].action, "create");
      assert.equal(manifest.outbox?.[0].payload.kind, "folder");
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues one folder delete for tracked folder trees removed locally", async () => {
    const { root, store, state } = await createState();
    try {
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "remote.md"), "# Remote\n", "utf8");
      upsertResource(store, {
        relativePath: "docs",
        domain: "artifacts",
        kind: "folder",
        resourceId: "folder-docs",
        dirty: false
      });
      upsertResource(store, {
        relativePath: "docs/remote.md",
        domain: "artifacts",
        kind: "note",
        resourceId: "note-docs",
        checksum: checksum("# Remote\n"),
        sizeBytes: Buffer.byteLength("# Remote\n", "utf8"),
        dirty: false
      });

      await rm(join(root, "docs"), { recursive: true, force: true });
      await scanSyncFolder(state);

      const manifest = readManifestFromStore(store);
      const pending = manifest.outbox?.filter((item) => item.status === "pending") ?? [];
      assert.equal(pending.length, 1);
      assert.equal(pending[0].relativePath, "docs");
      assert.equal(pending[0].action, "delete");
      assert.equal(pending[0].payload.kind, "folder");
      assert.equal(state.outboxPending, 1);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local file uploads into the outbox", async () => {
    const { root, store, state } = await createState();
    try {
      const uploaded = await createLocalArtifactFile(state, {
        directoryPath: "uploads",
        filename: "asset.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("uploaded", "utf8").toString("base64")
      });

      assert.equal(uploaded.kind, "file");
      assert.equal(uploaded.path, "uploads/asset.txt");
      assert.equal(await readFile(join(root, "uploads", "asset.txt"), "utf8"), "uploaded");

      const manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 1);
      assert.equal(manifest.resources?.[0].kind, "file");
      assert.equal(manifest.resources?.[0].dirty, true);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].action, "create");
      assert.equal(manifest.outbox?.[0].payload.kind, "file");
      assert.equal(manifest.outbox?.[0].payload.filename, "asset.txt");
      assert.equal(manifest.outbox?.[0].payload.directoryPath, "uploads");
      assert.equal(manifest.outbox?.[0].payload.contentBase64, Buffer.from("uploaded", "utf8").toString("base64"));

      const items = await listLocalArtifactItems(state);
      assert.ok(items.some((item) => item.kind === "folder" && item.path === "uploads"));
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local note domain creates and updates into the outbox cache", async () => {
    const { store, state } = await createState();
    try {
      const created = await createLocalNote(state, {
        title: "Offline Note",
        content: "draft",
        projectId: "project-1",
        projectName: "Project 1",
        tags: ["offline"]
      });
      const id = String(created.id);
      assert.ok(id.startsWith("local-note-"));

      const updated = await updateLocalNote(state, id, {
        content: "edited",
        tags: ["offline", "edited"]
      });
      assert.equal(updated?.content, "edited");

      const manifest = readManifestFromStore(store);
      const outbox = manifest.outbox ?? [];
      assert.deepEqual(outbox.map((item) => `${item.domain}:${item.action}:${item.status}`).sort(), [
        "notes:create:pending",
        "notes:create:superseded"
      ]);
      const cached = manifest.remoteResources?.find((item) => item.domain === "notes" && item.resourceId === id);
      assert.equal(cached?.payload.title, "Offline Note");
      assert.equal(cached?.payload.content, "edited");
      assert.deepEqual(cached?.payload.tags, ["offline", "edited"]);
      assert.equal(state.outboxPending, 1);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local project domain creates and updates into the outbox cache", async () => {
    const { store, state } = await createState();
    try {
      const created = await createLocalProject(state, {
        name: "Offline Project",
        description: "draft",
        status: "draft"
      });
      const id = String(created.id);
      assert.ok(id.startsWith("local-project-"));

      const updated = await updateLocalProject(state, id, {
        description: "edited",
        status: "active"
      });
      assert.equal(updated?.description, "edited");
      assert.equal(updated?.status, "active");

      const manifest = readManifestFromStore(store);
      const outbox = manifest.outbox ?? [];
      assert.deepEqual(outbox.map((item) => `${item.domain}:${item.action}:${item.status}`).sort(), [
        "projects:create:pending",
        "projects:create:superseded"
      ]);
      const cached = manifest.remoteResources?.find((item) => item.domain === "projects" && item.resourceId === id);
      assert.equal(cached?.payload.name, "Offline Project");
      assert.equal(cached?.payload.description, "edited");
      assert.equal(cached?.payload.status, "active");
      assert.equal(state.outboxPending, 1);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues existing cached project updates and deletes into the outbox", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-1",
        version: 4,
        payload: {
          id: "project-1",
          name: "Remote Project",
          description: "old",
          status: "active",
          isUserDefault: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const updated = await updateLocalProject(state, "project-1", { name: "Renamed Project" });
      assert.equal(updated?.name, "Renamed Project");
      const deleted = await deleteLocalProject(state, "project-1");
      assert.equal(deleted, true);

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort(), [
        "delete:pending",
        "update:superseded"
      ]);
      const cached = manifest.remoteResources?.find((item) => item.domain === "projects" && item.resourceId === "project-1");
      assert.equal(cached?.deleted, true);
      assert.equal(cached?.payload.deleted, true);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local project default changes and updates cached default flags", async () => {
    const { store, state } = await createState();
    try {
      for (const project of [
        { id: "project-1", name: "Project 1", isUserDefault: true },
        { id: "project-2", name: "Project 2", isUserDefault: false }
      ]) {
        upsertRemoteResource(store, {
          domain: "projects",
          resourceId: project.id,
          version: 1,
          payload: {
            ...project,
            description: "",
            status: "active",
            createdAt: "2026-06-17T00:00:00.000Z",
            updatedAt: "2026-06-17T00:00:00.000Z"
          },
          updatedAt: "2026-06-17T00:00:00.000Z",
          lastSyncedAt: "2026-06-17T00:00:00.000Z"
        });
      }

      const selection = await setLocalDefaultProject(state, "project-2");
      assert.equal((selection?.project as Record<string, unknown> | undefined)?.id, "project-2");
      assert.equal(selection?.source, "user");

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((item) => `${item.domain}:${item.action}:${item.status}:${item.payload.relation}`).sort(), [
        "projects:update:pending:default"
      ]);
      const project1 = manifest.remoteResources?.find((item) => item.domain === "projects" && item.resourceId === "project-1");
      const project2 = manifest.remoteResources?.find((item) => item.domain === "projects" && item.resourceId === "project-2");
      assert.equal(project1?.payload.isUserDefault, false);
      assert.equal(project2?.payload.isUserDefault, true);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local task domain creates and updates into the outbox cache", async () => {
    const { store, state } = await createState();
    try {
      const created = await createLocalTask(state, {
        title: "Offline Task",
        notes: "draft",
        context: "project-1",
        contextName: "Project 1",
        status: "todo",
        baseLoadScore: 4,
        recurrence: "ONCE"
      });
      const id = String(created.id);
      assert.ok(id.startsWith("local-task-"));

      const updated = await updateLocalTask(state, id, {
        notes: "edited",
        status: "done",
        baseLoadScore: 6
      });
      assert.equal(updated?.notes, "edited");
      assert.equal(updated?.status, "done");
      assert.equal(updated?.baseLoadScore, 6);

      const manifest = readManifestFromStore(store);
      const outbox = manifest.outbox ?? [];
      assert.deepEqual(outbox.map((item) => `${item.domain}:${item.action}:${item.status}`).sort(), [
        "tasks:create:pending",
        "tasks:create:superseded"
      ]);
      const cached = manifest.remoteResources?.find((item) => item.domain === "tasks" && item.resourceId === id);
      assert.equal(cached?.payload.title, "Offline Task");
      assert.equal(cached?.payload.notes, "edited");
      assert.equal(cached?.payload.status, "done");
      assert.equal(state.outboxPending, 1);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues existing cached task updates and deletes into the outbox", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 5,
        payload: {
          id: "task-1",
          title: "Remote Task",
          notes: "old",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 5,
          recurrence: "ONCE",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const updated = await updateLocalTask(state, "task-1", { title: "Renamed Task" });
      assert.equal(updated?.title, "Renamed Task");
      const deleted = await deleteLocalTask(state, "task-1");
      assert.equal(deleted, true);

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort(), [
        "delete:pending",
        "update:superseded"
      ]);
      const cached = manifest.remoteResources?.find((item) => item.domain === "tasks" && item.resourceId === "task-1");
      assert.equal(cached?.deleted, true);
      assert.equal(cached?.payload.deleted, true);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local task pin changes and updates cached pins", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Pinned Task",
          notes: "",
          context: "project-1",
          contextName: "Project 1",
          status: "todo",
          isPinned: false,
          isLocked: false,
          baseLoadScore: 5,
          recurrence: "ONCE",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const result = await setLocalTaskPin(state, "task-1", true);
      assert.deepEqual(result, { taskId: "task-1", pinned: true });

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((item) => `${item.domain}:${item.action}:${item.status}:${item.payload.relation}`).sort(), [
        "tasks:update:pending:pin"
      ]);
      const cached = manifest.remoteResources?.find((item) => item.domain === "tasks" && item.resourceId === "task-1");
      assert.equal(cached?.payload.isPinned, true);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local task today and schedule item changes into the outbox cache", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Scheduled Task",
          notes: "",
          context: "project-1",
          contextName: "Project 1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 5,
          recurrence: "ONCE",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const item = await addLocalTaskToToday(state, "task-1", {
        scheduledDate: "2026-06-18",
        occurrenceDate: "2026-06-18",
        startTime: "09:00"
      });
      const scheduleId = Number(item?.id);
      assert.ok(scheduleId < 0);

      const updated = await updateLocalTaskScheduleItem(state, scheduleId, {
        startTime: "10:00",
        endTime: "11:00"
      });
      assert.equal(updated?.startTime, "10:00");

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((entry) => `${entry.domain}:${entry.action}:${entry.status}:${entry.payload.relation}`).sort(), [
        "tasks:create:pending:today",
        "tasks:create:superseded:today"
      ]);
      const cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      const scheduleItems = cached?.payload.scheduleItems as Array<Record<string, unknown>>;
      assert.equal(scheduleItems.length, 1);
      assert.equal(scheduleItems[0].startTime, "10:00");

      const removed = await removeLocalTaskScheduleItem(state, scheduleId);
      assert.equal(removed, true);
      const afterRemove = readManifestFromStore(store);
      const afterCached = afterRemove.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      assert.deepEqual(afterCached?.payload.scheduleItems, []);
      assert.equal(afterRemove.outbox?.filter((entry) => entry.status === "pending").length, 0);
    } finally {
      closeManifestStore(store);
    }
  });

  it("upserts local Today membership by occurrence natural key", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Recurring Scheduled Task",
          notes: "",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 3,
          recurrence: "WEEKLY",
          mon: true,
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const first = await addLocalTaskToToday(state, "task-1", {
        scheduledDate: "2026-06-20",
        occurrenceDate: "2026-06-22",
        startTime: "09:00"
      });
      const second = await addLocalTaskToToday(state, "task-1", {
        scheduledDate: "2026-06-20",
        occurrenceDate: "2026-06-22",
        startTime: "10:00",
        endTime: "11:00"
      });

      assert.equal(second?.id, first?.id);
      const manifest = readManifestFromStore(store);
      const cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      const scheduleItems = cached?.payload.scheduleItems as Array<Record<string, unknown>>;
      assert.equal(scheduleItems.length, 1);
      assert.equal(scheduleItems[0].occurrenceDate, "2026-06-22");
      assert.equal(scheduleItems[0].scheduledDate, "2026-06-20");
      assert.equal(scheduleItems[0].startTime, "10:00");
      assert.equal(scheduleItems[0].endTime, "11:00");

      const todayRows = localTodayTasks(state, "2026-06-20");
      assert.equal(todayRows.length, 1);
      assert.equal(todayRows[0].scheduleId, first?.id);
      assert.equal(todayRows[0].occurrenceDate, "2026-06-22");
      assert.equal(todayRows[0].scheduledDate, "2026-06-20");

      const calendarRows = localScheduleCalendar(state, "2026-06-20", "2026-06-20")[0].items as Array<Record<string, unknown>>;
      assert.equal(calendarRows.length, 1);
      assert.equal(calendarRows[0].scheduleId, first?.id);
      assert.equal(calendarRows[0].occurrenceDate, "2026-06-22");
      assert.equal(calendarRows[0].scheduledDate, "2026-06-20");

      const scheduleRows = localTaskSchedule(state, "2026-06-20", "2026-06-20")[0].tasks as Array<Record<string, unknown>>;
      assert.equal(scheduleRows.length, 1);
      assert.equal(scheduleRows[0].scheduleId, first?.id);
      assert.equal(scheduleRows[0].occurrenceDate, "2026-06-22");
      assert.equal(scheduleRows[0].scheduledDate, "2026-06-20");

      const pending = manifest.outbox?.filter((entry) => entry.status === "pending") ?? [];
      assert.equal(pending.length, 1);
      assert.equal(pending[0].payload.taskId, "task-1");
      assert.equal(pending[0].payload.scheduleId, first?.id);
      assert.equal(pending[0].payload.occurrenceDate, "2026-06-22");
      assert.equal(pending[0].payload.scheduledDate, "2026-06-20");
    } finally {
      closeManifestStore(store);
    }
  });

  it("merges local schedule item updates that collide on occurrence natural key", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Recurring Scheduled Task",
          notes: "",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 3,
          recurrence: "WEEKLY",
          mon: true,
          active: true,
          scheduleItems: [
            {
              id: 101,
              scheduleId: 101,
              taskId: "task-1",
              scheduledDate: "2026-06-20",
              occurrenceDate: "2026-06-22",
              startTime: "09:00"
            },
            {
              id: 102,
              scheduleId: 102,
              taskId: "task-1",
              scheduledDate: "2026-06-20",
              occurrenceDate: "2026-06-23",
              startTime: "13:00"
            }
          ],
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const updated = await updateLocalTaskScheduleItem(state, 102, {
        scheduledDate: "2026-06-20",
        occurrenceDate: "2026-06-22",
        startTime: "15:00",
        endTime: "16:00"
      });

      assert.equal(updated?.id, 101);
      assert.equal(updated?.scheduleId, 101);

      const manifest = readManifestFromStore(store);
      const cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      const scheduleItems = cached?.payload.scheduleItems as Array<Record<string, unknown>>;
      assert.equal(scheduleItems.length, 1);
      assert.equal(scheduleItems[0].id, 101);
      assert.equal(scheduleItems[0].occurrenceDate, "2026-06-22");
      assert.equal(scheduleItems[0].scheduledDate, "2026-06-20");
      assert.equal(scheduleItems[0].startTime, "15:00");
      assert.equal(scheduleItems[0].endTime, "16:00");

      const todayRows = localTodayTasks(state, "2026-06-20");
      assert.equal(todayRows.length, 1);
      assert.equal(todayRows[0].scheduleId, 101);
      assert.equal(todayRows[0].occurrenceDate, "2026-06-22");

      const pending = manifest.outbox?.filter((entry) => entry.status === "pending") ?? [];
      assert.deepEqual(pending.map((entry) => `${entry.action}:${entry.payload.scheduleId}:${entry.payload.relation}`).sort(), [
        "delete:102:scheduleItem",
        "update:101:scheduleItem"
      ]);
    } finally {
      closeManifestStore(store);
    }
  });

  it("removes only the exact local Today occurrence when occurrenceDate is provided", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Repeated Occurrence Task",
          notes: "",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 4,
          recurrence: "EVERY_N_DAYS",
          intervalDays: 1,
          anchorDate: "2026-06-17",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z",
          scheduleItems: [
            {
              id: 41,
              scheduleId: 41,
              taskId: "task-1",
              occurrenceDate: "2026-06-18",
              scheduledDate: "2026-06-20",
              startTime: "09:00",
              createdAt: "2026-06-17T00:00:00.000Z",
              updatedAt: "2026-06-17T00:00:00.000Z"
            },
            {
              id: 42,
              scheduleId: 42,
              taskId: "task-1",
              occurrenceDate: "2026-06-19",
              scheduledDate: "2026-06-20",
              startTime: "10:00",
              createdAt: "2026-06-17T00:00:00.000Z",
              updatedAt: "2026-06-17T00:00:00.000Z"
            }
          ]
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const removed = await removeLocalTaskFromToday(state, "task-1", "2026-06-20", "2026-06-18");
      assert.equal(removed?.removed, 1);

      const manifest = readManifestFromStore(store);
      const cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      const scheduleItems = cached?.payload.scheduleItems as Array<Record<string, unknown>>;
      assert.equal(scheduleItems.length, 1);
      assert.equal(scheduleItems[0].scheduleId, 42);
      assert.equal(scheduleItems[0].occurrenceDate, "2026-06-19");

      const todayRows = localTodayTasks(state, "2026-06-20");
      assert.equal(todayRows.length, 1);
      assert.equal(todayRows[0].scheduleId, 42);
      assert.equal(todayRows[0].occurrenceDate, "2026-06-19");

      const pending = manifest.outbox?.filter((entry) => entry.status === "pending") ?? [];
      assert.equal(pending.length, 1);
      assert.equal(pending[0].action, "delete");
      assert.equal(pending[0].payload.scheduleId, 41);
      assert.equal(pending[0].payload.scheduledDate, "2026-06-20");
      assert.equal(pending[0].payload.occurrenceDate, "2026-06-18");
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local task occurrence changes into the outbox cache", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Occurrence Task",
          notes: "",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 5,
          recurrence: "ONCE",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const result = await recordLocalTaskOccurrence(state, "task-1", {
        operation: "complete",
        targetDate: "2026-06-18",
        status: "done"
      });
      assert.deepEqual(result, { taskId: "task-1", targetDate: "2026-06-18", status: "done" });

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((entry) => `${entry.domain}:${entry.action}:${entry.status}:${entry.payload.relation}:${entry.payload.operation}`), [
        "tasks:update:pending:occurrence:complete"
      ]);
      const cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      assert.equal(cached?.payload.status, "done");
      assert.equal((cached?.payload.occurrenceActions as Array<Record<string, unknown>>).length, 1);
      assert.deepEqual(localTaskHistory(state, "task-1").map((entry) => `${entry.taskId}:${entry.targetDate}:${entry.status}`), [
        "task-1:2026-06-18:done"
      ]);
    } finally {
      closeManifestStore(store);
    }
  });

  it("records recurring occurrence completion without changing task-wide status", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Daily Recurring Task",
          notes: "",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 5,
          recurrence: "EVERY_N_DAYS",
          intervalDays: 1,
          anchorDate: "2026-06-17",
          startTime: "08:00",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const result = await recordLocalTaskOccurrence(state, "task-1", {
        operation: "complete",
        targetDate: "2026-06-18",
        status: "done"
      });
      assert.deepEqual(result, { taskId: "task-1", targetDate: "2026-06-18", status: "done" });

      const manifest = readManifestFromStore(store);
      const cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      assert.equal(cached?.payload.status, "todo");
      const actions = cached?.payload.occurrenceActions as Array<Record<string, unknown>>;
      assert.equal(actions.length, 1);
      assert.equal(actions[0].occurrenceDate, "2026-06-18");
      assert.equal(actions[0].targetDate, "2026-06-18");
      assert.equal(actions[0].status, "done");

      const pending = manifest.outbox?.filter((entry) => entry.status === "pending") ?? [];
      assert.equal(pending.length, 1);
      assert.equal(pending[0].payload.taskId, "task-1");
      assert.equal(pending[0].payload.occurrenceDate, "2026-06-18");
      assert.equal(pending[0].payload.targetDate, "2026-06-18");

      const scheduleRows = localTaskSchedule(state, "2026-06-18", "2026-06-18")[0].tasks as Array<Record<string, unknown>>;
      assert.equal(scheduleRows.length, 1);
      assert.equal(scheduleRows[0].status, "done");
      assert.equal(scheduleRows[0].occurrenceDate, "2026-06-18");
      assert.equal(scheduleRows[0].scheduledDate, "2026-06-18");

      const calendarRows = localScheduleCalendar(state, "2026-06-18", "2026-06-18")[0].items as Array<Record<string, unknown>>;
      assert.equal(calendarRows.length, 1);
      assert.equal(calendarRows[0].status, "done");
      assert.equal(calendarRows[0].occurrenceDate, "2026-06-18");
      assert.equal(calendarRows[0].scheduledDate, "2026-06-18");
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local task subtask changes into the outbox cache", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Subtask Task",
          notes: "",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 5,
          recurrence: "ONCE",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const subtask = await createLocalTaskSubtask(state, "task-1", "2026-06-18", { title: "Draft subtask" });
      const subtaskId = String(subtask?.id);
      assert.ok(subtaskId.startsWith("local-subtask-"));

      const updated = await updateLocalTaskSubtask(state, "task-1", "2026-06-18", subtaskId, {
        title: "Edited subtask",
        isDone: true
      });
      assert.equal(updated?.title, "Edited subtask");
      assert.equal(updated?.isDone, true);

      let manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((entry) => `${entry.domain}:${entry.action}:${entry.status}:${entry.payload.relation}`).sort(), [
        "tasks:create:pending:subtask",
        "tasks:create:superseded:subtask"
      ]);
      let cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      assert.equal((cached?.payload.subtasks as Array<Record<string, unknown>>)[0].title, "Edited subtask");

      const deleted = await deleteLocalTaskSubtask(state, "task-1", "2026-06-18", subtaskId);
      assert.equal(deleted, true);
      manifest = readManifestFromStore(store);
      cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      assert.deepEqual(cached?.payload.subtasks, []);
      assert.equal(manifest.outbox?.filter((entry) => entry.status === "pending").length, 0);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues local task attachment changes into the outbox cache", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-1",
        version: 2,
        payload: {
          id: "task-1",
          title: "Attachment Task",
          notes: "",
          context: "project-1",
          status: "todo",
          isLocked: false,
          baseLoadScore: 5,
          recurrence: "ONCE",
          active: true,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const contentBase64 = Buffer.from("attachment body", "utf8").toString("base64");
      const attachment = await createLocalTaskAttachment(state, "task-1", {
        filename: "brief.txt",
        mimeType: "text/plain",
        contentBase64
      });
      const attachmentId = String(attachment?.id);
      assert.ok(attachmentId.startsWith("local-attachment-"));

      let manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((entry) => `${entry.domain}:${entry.action}:${entry.status}:${entry.payload.relation}`), [
        "tasks:create:pending:attachment"
      ]);
      let cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      const attachments = cached?.payload.attachments as Array<Record<string, unknown>>;
      assert.equal(attachments[0].filename, "brief.txt");
      assert.equal(attachments[0].contentBase64, contentBase64);

      const deleted = await deleteLocalTaskAttachment(state, "task-1", attachmentId);
      assert.equal(deleted, true);
      manifest = readManifestFromStore(store);
      cached = manifest.remoteResources?.find((entry) => entry.domain === "tasks" && entry.resourceId === "task-1");
      assert.deepEqual(cached?.payload.attachments, []);
      assert.equal(manifest.outbox?.filter((entry) => entry.status === "pending").length, 0);
    } finally {
      closeManifestStore(store);
    }
  });

  it("exports and imports local task CSV through the daemon cache", async () => {
    const { store, state } = await createState();
    try {
      const created = await createLocalTask(state, {
        title: "CSV Task",
        context: "project-1",
        notes: "export me",
        recurrence: "MONTHLY_NTH_WEEKDAY",
        nthInMonth: 1,
        weekdayMon1: 0
      });
      assert.ok(String(created.id).startsWith("local-task-"));

      const csv = exportLocalTasksCsv(state);
      assert.match(csv, /task_name,context,base_load_score/);
      assert.match(csv, /CSV Task,project-1/);
      const [headerLine = "", firstTaskLine = ""] = csv.split("\n");
      const exportedRecord = Object.fromEntries(
        headerLine.split(",").map((header, index) => [header, firstTaskLine.split(",")[index] ?? ""])
      );
      assert.equal(exportedRecord.weekday_mon1, "7");

      const imported = await importLocalTasksCsv(state, [
        "task_name,context,base_load_score,active,rule_type,nth_in_month,weekday_mon1,notes",
        "Imported Task,project-2,3,true,MONTHLY_NTH_WEEKDAY,2,7,hello"
      ].join("\n"));
      assert.equal(imported, 1);

      const manifest = readManifestFromStore(store);
      const cachedTasks = manifest.remoteResources?.filter((entry) => entry.domain === "tasks") ?? [];
      assert.equal(cachedTasks.length, 2);
      const importedTask = cachedTasks.find((entry) => entry.payload.title === "Imported Task");
      assert.ok(importedTask);
      assert.equal(importedTask.payload.weekdayMon1, 0);
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues existing cached note updates and deletes into the outbox", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "notes",
        resourceId: "note-1",
        version: 3,
        payload: {
          id: "note-1",
          title: "Remote Note",
          content: "old",
          projectId: "project-1",
          tags: [],
          updatedAt: "2026-06-17T00:00:00.000Z"
        },
        updatedAt: "2026-06-17T00:00:00.000Z",
        lastSyncedAt: "2026-06-17T00:00:00.000Z"
      });

      const updated = await updateLocalNote(state, "note-1", { title: "Renamed", content: "new" });
      assert.equal(updated?.title, "Renamed");
      const deleted = await deleteLocalNote(state, "note-1");
      assert.equal(deleted, true);

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort(), [
        "delete:pending",
        "update:superseded"
      ]);
      const cached = manifest.remoteResources?.find((item) => item.domain === "notes" && item.resourceId === "note-1");
      assert.equal(cached?.deleted, true);
      assert.equal(cached?.payload.deleted, true);
    } finally {
      closeManifestStore(store);
    }
  });

  it("applies local markdown content patches and section updates", async () => {
    const { root, store, state } = await createState();
    try {
      const initial = "# Title\nold body\n\n## Details\nfirst line\n\n## Other\nkeep\n";
      const created = await createLocalArtifactNote(state, {
        title: "Patch Target",
        contentMarkdown: initial
      });

      const start = initial.indexOf("old body");
      const patched = await patchLocalArtifactNoteContent(state, created.id, {
        expectedVersion: 1,
        operations: [
          { type: "replace", start, end: start + "old body".length, text: "new body" }
        ]
      });
      assert.equal(patched?.contentMarkdown?.includes("new body"), true);

      const sectioned = await updateLocalArtifactNoteSection(state, created.id, {
        heading: "Details",
        level: 2,
        mode: "appendBody",
        contentMarkdown: "second line"
      });
      assert.equal(
        await readFile(join(root, "Patch Target.md"), "utf8"),
        "# Title\nnew body\n\n## Details\nfirst line\n\nsecond line\n## Other\nkeep\n"
      );
      assert.equal(sectioned?.contentMarkdown?.includes("second line"), true);

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort(), [
        "create:pending",
        "create:superseded",
        "create:superseded"
      ]);
      const pending = manifest.outbox?.find((item) => item.status === "pending");
      assert.equal(
        pending?.payload.contentMarkdown,
        "# Title\nnew body\n\n## Details\nfirst line\n\nsecond line\n## Other\nkeep\n"
      );
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues existing local file changes as update operations", async () => {
    const { root, store, state } = await createState();
    try {
      const filePath = join(root, "asset.txt");
      await writeFile(filePath, "old", "utf8");
      upsertResource(store, {
        relativePath: "asset.txt",
        domain: "artifacts",
        kind: "file",
        resourceId: "cloud-file-1",
        checksum: checksum("old"),
        sizeBytes: 3,
        dirty: false
      });

      await writeFile(filePath, "new", "utf8");
      await scanSyncFolder(state);

      const manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].action, "update");
      assert.equal(manifest.outbox?.[0].resourceId, "cloud-file-1");
      assert.equal(manifest.outbox?.[0].payload.kind, "file");
    } finally {
      closeManifestStore(store);
    }
  });

  it("queues a clean tracked local file move as one update", async () => {
    const { root, store, state } = await createState();
    try {
      const oldPath = join(root, "asset.txt");
      const newPath = join(root, "docs", "renamed.txt");
      await writeFile(oldPath, "same-content", "utf8");
      await mkdir(join(root, "docs"), { recursive: true });
      upsertResource(store, {
        relativePath: "asset.txt",
        domain: "artifacts",
        kind: "file",
        resourceId: "cloud-file-rename",
        checksum: checksum("same-content"),
        sizeBytes: Buffer.byteLength("same-content"),
        dirty: false
      });

      await rename(oldPath, newPath);
      await scanSyncFolder(state);

      const manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.length, 2);
      const fileUpdate = manifest.outbox?.find((item) => item.relativePath === "docs/renamed.txt");
      const folderCreate = manifest.outbox?.find((item) => item.relativePath === "docs");
      assert.equal(fileUpdate?.action, "update");
      assert.equal(fileUpdate?.resourceId, "cloud-file-rename");
      assert.equal(fileUpdate?.payload.kind, "file");
      assert.equal(fileUpdate?.payload.path, "docs/renamed.txt");
      assert.equal("contentBase64" in fileUpdate!.payload, false);
      assert.equal(folderCreate?.action, "create");
      assert.equal(folderCreate?.payload.kind, "folder");
      assert.equal(manifest.resources?.length, 2);
      const fileResource = manifest.resources?.find((item) => item.relativePath === "docs/renamed.txt");
      const folderResource = manifest.resources?.find((item) => item.relativePath === "docs");
      assert.equal(fileResource?.resourceId, "cloud-file-rename");
      assert.equal(fileResource?.dirty, true);
      assert.equal(folderResource?.kind, "folder");
      assert.equal(folderResource?.dirty, true);
      assert.equal(state.outboxPending, 2);
    } finally {
      closeManifestStore(store);
    }
  });

  it("keeps delete and creates when local rename candidates are ambiguous", async () => {
    const { root, store, state } = await createState();
    try {
      const oldPath = join(root, "asset.txt");
      await writeFile(oldPath, "same-content", "utf8");
      upsertResource(store, {
        relativePath: "asset.txt",
        domain: "artifacts",
        kind: "file",
        resourceId: "cloud-file-ambiguous",
        checksum: checksum("same-content"),
        sizeBytes: Buffer.byteLength("same-content"),
        dirty: false
      });

      await unlink(oldPath);
      await writeFile(join(root, "copy-a.txt"), "same-content", "utf8");
      await writeFile(join(root, "copy-b.txt"), "same-content", "utf8");
      await scanSyncFolder(state);

      const manifest = readManifestFromStore(store);
      assert.deepEqual(manifest.outbox?.map((item) => item.action).sort(), ["create", "create", "delete"]);
      assert.equal(manifest.outbox?.some((item) => item.action === "update"), false);
      const deleteItem = manifest.outbox?.find((item) => item.action === "delete");
      assert.equal(deleteItem?.relativePath, "asset.txt");
      assert.equal(deleteItem?.resourceId, "cloud-file-ambiguous");
      assert.equal(state.outboxPending, 3);
    } finally {
      closeManifestStore(store);
    }
  });

  it("replaces a pending delete when the local file reappears", async () => {
    const { root, store, state } = await createState();
    try {
      upsertResource(store, {
        relativePath: "remote-note.md",
        domain: "artifacts",
        kind: "note",
        resourceId: "artifact-note-1",
        checksum: checksum("# Remote\n"),
        sizeBytes: 9,
        dirty: false
      });

      await scanSyncFolder(state);
      let manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].action, "delete");
      assert.equal(manifest.outbox?.[0].status, "pending");

      await writeFile(join(root, "remote-note.md"), "# Restored\n", "utf8");
      await scanSyncFolder(state);

      manifest = readManifestFromStore(store);
      const statuses = manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort();
      assert.deepEqual(statuses, ["delete:superseded", "update:pending"]);
      const resource = manifest.resources?.find((item) => item.relativePath === "remote-note.md");
      assert.equal(resource?.resourceId, "artifact-note-1");
      assert.equal(resource?.dirty, true);
      assert.equal(resource?.checksum, checksum("# Restored\n"));
      assert.equal(state.outboxPending, 1);
    } finally {
      closeManifestStore(store);
    }
  });

  it("auto-resolves a conflict when its failed outbox item is superseded", async () => {
    const { root, store, state } = await createState();
    try {
      upsertResource(store, {
        relativePath: "conflicted.md",
        domain: "artifacts",
        kind: "note",
        resourceId: "artifact-note-conflict",
        checksum: checksum("# Remote\n"),
        sizeBytes: 9,
        dirty: false
      });

      await scanSyncFolder(state);
      let manifest = readManifestFromStore(store);
      const deleteItem = manifest.outbox?.[0];
      assert.equal(deleteItem?.action, "delete");
      assert.equal(deleteItem?.status, "pending");

      markOutboxFailed(store, deleteItem.id, "Cloud rejected delete", new Date().toISOString());
      recordConflict(store, {
        outboxId: deleteItem.id,
        clientOpId: deleteItem.clientOpId,
        relativePath: deleteItem.relativePath,
        domain: deleteItem.domain,
        action: deleteItem.action,
        resourceId: deleteItem.resourceId,
        payload: deleteItem.payload,
        errorMessage: "Cloud rejected delete"
      });

      manifest = readManifestFromStore(store);
      assert.equal(manifest.conflicts?.[0].status, "open");

      await writeFile(join(root, "conflicted.md"), "# Local restored\n", "utf8");
      await scanSyncFolder(state);

      manifest = readManifestFromStore(store);
      const supersededDelete = manifest.outbox?.find((item) => item.id === deleteItem.id);
      assert.equal(supersededDelete?.status, "superseded");
      assert.equal(manifest.conflicts?.[0].status, "resolved");
      assert.equal(manifest.conflicts?.[0].resolution, "close");
      assert.match(manifest.conflicts?.[0].resolutionNote ?? "", /pending delete was superseded/);
      assert.equal(state.conflictsOpen, 0);
    } finally {
      closeManifestStore(store);
    }
  });

  it("supersedes a stale pending update when the file changes again before push", async () => {
    const { root, store, state } = await createState();
    try {
      upsertResource(store, {
        relativePath: "note.md",
        domain: "artifacts",
        kind: "note",
        resourceId: "artifact-note-2",
        checksum: checksum("# Before\n"),
        sizeBytes: 9,
        dirty: false
      });

      await writeFile(join(root, "note.md"), "# First edit\n", "utf8");
      await scanSyncFolder(state);
      let manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.length, 1);
      assert.equal(manifest.outbox?.[0].action, "update");
      assert.equal(manifest.outbox?.[0].status, "pending");

      await writeFile(join(root, "note.md"), "# Second edit\n", "utf8");
      await scanSyncFolder(state);

      manifest = readManifestFromStore(store);
      const statuses = manifest.outbox?.map((item) => `${item.action}:${item.status}`).sort();
      assert.deepEqual(statuses, ["update:pending", "update:superseded"]);
      const pending = manifest.outbox?.find((item) => item.status === "pending");
      assert.equal(pending?.payload.contentMarkdown, "# Second edit\n");
      const resource = manifest.resources?.find((item) => item.relativePath === "note.md");
      assert.equal(resource?.checksum, checksum("# Second edit\n"));
      assert.equal(state.outboxPending, 1);
    } finally {
      closeManifestStore(store);
    }
  });
});
