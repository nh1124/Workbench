import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  closeManifestStore,
  markOutboxFailed,
  openManifestStore,
  readManifestFromStore,
  recordConflict,
  upsertResource,
  type ManifestStore
} from "../manifestStore.js";
import {
  createLocalArtifactFile,
  createLocalArtifactFolder,
  createLocalArtifactNote,
  deleteLocalArtifactItem,
  getLocalArtifactItemById,
  listLocalArtifactItems,
  patchLocalArtifactNoteContent,
  scanSyncFolder,
  updateLocalArtifactNoteSection,
  updateLocalArtifactItem,
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
      assert.equal(manifest.resources?.length, 0);
      assert.equal(manifest.outbox?.length, 0);
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
