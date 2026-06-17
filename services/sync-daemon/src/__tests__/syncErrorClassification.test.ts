import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { classifySyncError } from "../index.js";
import {
  closeManifestStore,
  enqueueOutbox,
  markOutboxFailed,
  openManifestStore,
  readManifestFromStore,
  recordConflict,
  resolveConflict
} from "../manifestStore.js";

const tempRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workbench-sync-errors-"));
  await mkdir(join(root, ".workbench"), { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("sync error classification", () => {
  it("classifies version conflicts, network failures, and path rejections", () => {
    assert.deepEqual(classifySyncError({
      code: "SYNC_VERSION_CONFLICT",
      message: "Sync resource version conflict"
    }), {
      errorMessage: "Sync resource version conflict",
      errorCode: "SYNC_VERSION_CONFLICT",
      errorCategory: "version_conflict",
      retryable: false
    });

    const network = classifySyncError(new Error("fetch failed: ECONNREFUSED"));
    assert.equal(network.errorCategory, "network");
    assert.equal(network.retryable, true);

    const path = classifySyncError({
      code: "SYNC_REMOTE_PATH_UNSAFE",
      message: "Remote path resolves outside the sync root."
    });
    assert.equal(path.errorCategory, "path_rejection");
    assert.equal(path.retryable, false);
  });

  it("persists outbox and conflict error metadata in the manifest database", async () => {
    const root = await createRoot();
    const store = openManifestStore(root);
    try {
      const item = enqueueOutbox(store, {
        relativePath: "note.md",
        domain: "artifacts",
        action: "update",
        resourceId: "artifact-note-1",
        payload: { kind: "note", contentMarkdown: "# Local\n" }
      });
      const now = new Date().toISOString();
      const metadata = {
        errorCode: "SYNC_VERSION_CONFLICT",
        errorCategory: "version_conflict" as const,
        retryable: false
      };

      markOutboxFailed(store, item.id, "Sync resource version conflict", now, metadata);
      const conflict = recordConflict(store, {
        outboxId: item.id,
        clientOpId: item.clientOpId,
        relativePath: item.relativePath,
        domain: item.domain,
        action: item.action,
        resourceId: item.resourceId,
        payload: item.payload,
        errorMessage: "Sync resource version conflict",
        ...metadata
      });

      let manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.[0].errorCode, "SYNC_VERSION_CONFLICT");
      assert.equal(manifest.outbox?.[0].errorCategory, "version_conflict");
      assert.equal(manifest.outbox?.[0].retryable, false);
      assert.equal(manifest.conflicts?.[0].id, conflict.id);
      assert.equal(manifest.conflicts?.[0].errorCode, "SYNC_VERSION_CONFLICT");
      assert.equal(manifest.conflicts?.[0].errorCategory, "version_conflict");
      assert.equal(manifest.conflicts?.[0].retryable, false);

      resolveConflict(store, conflict.id, "retry");
      manifest = readManifestFromStore(store);
      assert.equal(manifest.outbox?.[0].status, "pending");
      assert.equal(manifest.outbox?.[0].errorCode, undefined);
      assert.equal(manifest.outbox?.[0].errorCategory, undefined);
      assert.equal(manifest.outbox?.[0].retryable, undefined);
    } finally {
      closeManifestStore(store);
    }
  });
});
