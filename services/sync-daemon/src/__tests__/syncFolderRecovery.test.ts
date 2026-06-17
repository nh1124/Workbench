import assert from "node:assert/strict";
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
  deleteLocalProject,
  deleteLocalNote,
  deleteLocalArtifactItem,
  deleteLocalTask,
  getLocalArtifactItemById,
  listLocalArtifactItems,
  patchLocalArtifactNoteContent,
  scanSyncFolder,
  setLocalDefaultProject,
  setLocalTaskPin,
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
