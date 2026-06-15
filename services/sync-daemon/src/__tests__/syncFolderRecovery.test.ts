import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
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
import { scanSyncFolder, type DaemonConfig, type DaemonState } from "../index.js";

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
