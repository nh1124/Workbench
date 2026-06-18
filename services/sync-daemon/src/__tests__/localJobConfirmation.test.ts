import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  closeManifestStore,
  openManifestStore,
  type ManifestStore
} from "../manifestStore.js";
import {
  listPendingLocalJobConfirmations,
  localJobRequiresConfirmation,
  parseLocalJobConfirmationPolicy,
  processJob,
  type DaemonConfig,
  type DaemonState,
  type LocalJob
} from "../index.js";

const tempRoots: string[] = [];

async function createState(policy: DaemonConfig["localJobConfirmationPolicy"]): Promise<{
  root: string;
  store: ManifestStore;
  state: DaemonState;
}> {
  const root = await mkdtemp(join(tmpdir(), "workbench-local-job-confirmation-"));
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
    watchDebounceMs: 100,
    localJobConfirmationPolicy: policy
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

function job(target: LocalJob["target"]): LocalJob {
  return {
    id: `job-${target}`,
    kind: "download_artifact",
    target,
    status: "claimed",
    payload: {
      artifactItemId: "artifact-1",
      filename: "../unsafe name.md"
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

describe("local job confirmation policy", () => {
  it("parses policy values", () => {
    assert.equal(parseLocalJobConfirmationPolicy(undefined), "off");
    assert.equal(parseLocalJobConfirmationPolicy("off"), "off");
    assert.equal(parseLocalJobConfirmationPolicy("downloads"), "downloads");
    assert.equal(parseLocalJobConfirmationPolicy("outside-sync-folder"), "downloads");
    assert.equal(parseLocalJobConfirmationPolicy("all"), "all");
    assert.equal(parseLocalJobConfirmationPolicy("1"), "all");
  });

  it("requires confirmation based on target and configured policy", () => {
    const downloadsJob = job("downloads");
    const syncFolderJob = job("sync-folder");

    assert.equal(localJobRequiresConfirmation({} as DaemonConfig, downloadsJob), false);
    assert.equal(localJobRequiresConfirmation({ localJobConfirmationPolicy: "downloads" } as DaemonConfig, downloadsJob), true);
    assert.equal(localJobRequiresConfirmation({ localJobConfirmationPolicy: "downloads" } as DaemonConfig, syncFolderJob), false);
    assert.equal(localJobRequiresConfirmation({ localJobConfirmationPolicy: "all" } as DaemonConfig, syncFolderJob), true);
  });

  it("queues downloads jobs for approval without downloading when policy requires it", async () => {
    const { root, store, state } = await createState("downloads");
    try {
      const result = await processJob(state, job("downloads"));
      const pending = listPendingLocalJobConfirmations(state);

      assert.equal(result, undefined);
      assert.equal(state.processedJobs, 0);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.jobId, "job-downloads");
      assert.equal(pending[0]?.target, "downloads");
      assert.equal(pending[0]?.destinationRoot, join(root, "downloads"));
      assert.equal(pending[0]?.requestedFilename, ".._unsafe name.md");
    } finally {
      closeManifestStore(store);
    }
  });
});
