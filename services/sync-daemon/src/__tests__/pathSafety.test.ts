import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  closeManifestStore,
  openManifestStore,
  upsertResource,
  type ManifestStore
} from "../manifestStore.js";
import {
  createLocalArtifactFile,
  createLocalArtifactFolder,
  createLocalArtifactNote,
  decodeLocalItemId,
  normalizeSha256Checksum,
  normalizeRelativePath,
  resolveSyncRootRelativePath,
  sanitizeFileName,
  updateLocalArtifactItem,
  type DaemonConfig,
  type DaemonState
} from "../index.js";

const tempRoots: string[] = [];

async function createState(): Promise<{ root: string; store: ManifestStore; state: DaemonState }> {
  const root = await mkdtemp(join(tmpdir(), "workbench-sync-path-safety-"));
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

function localId(kind: "folder" | "note" | "file", relativePath: string): string {
  return `local-${kind}:${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

function isInside(root: string, candidate: string): boolean {
  const rel = normalizeRelativePath(relative(resolve(root), resolve(candidate)));
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("sync-daemon path safety", () => {
  it("normalizes local job download checksum headers", () => {
    const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert.equal(normalizeSha256Checksum(`sha256:${digest}`), digest);
    assert.equal(normalizeSha256Checksum(digest.toUpperCase()), digest);
    assert.equal(normalizeSha256Checksum(undefined), undefined);
    assert.throws(() => normalizeSha256Checksum("sha256:not-a-digest"), /Invalid local job download checksum header/);
  });

  it("preserves normal relative paths while rejecting traversal, absolute, metadata, temp, and reserved paths", async () => {
    const { root, store, state } = await createState();
    try {
      assert.equal(
        resolveSyncRootRelativePath(state.config, "docs\\notes\\brief.md"),
        join(root, "docs", "notes", "brief.md")
      );
      assert.equal(
        resolveSyncRootRelativePath(state.config, "docs/normal file.txt"),
        join(root, "docs", "normal file.txt")
      );

      const rejected = [
        "../outside.md",
        "docs/../../outside.md",
        "..\\outside.md",
        "/etc/passwd",
        "\\Windows\\System32\\drivers\\etc\\hosts",
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        "C:/Windows/System32/drivers/etc/hosts",
        "C:Windows\\System32\\drivers\\etc\\hosts",
        "//server/share/file.txt",
        ".workbench",
        ".workbench/manifest.sqlite",
        "draft.tmp",
        "draft.temp",
        "draft.part",
        "draft.crdownload",
        "~$draft.docx",
        "CON",
        "aux.txt",
        "docs/NUL.md",
        "COM1/report.txt"
      ];

      for (const pathValue of rejected) {
        assert.equal(resolveSyncRootRelativePath(state.config, pathValue), undefined, pathValue);
      }

      assert.equal(normalizeRelativePath("C:\\temp\\escape.txt"), "C:/temp/escape.txt");
      assert.equal(resolveSyncRootRelativePath(state.config, normalizeRelativePath("C:\\temp\\escape.txt")), undefined);
    } finally {
      closeManifestStore(store);
    }
  });

  it("does not resolve traversal hidden in encoded local item ids", async () => {
    const { store, state } = await createState();
    try {
      const encoded = localId("note", "../outside.md");
      const decoded = decodeLocalItemId(encoded);
      assert.deepEqual(decoded, { kind: "note", relativePath: "../outside.md" });
      assert.equal(resolveSyncRootRelativePath(state.config, decoded.relativePath), undefined);
    } finally {
      closeManifestStore(store);
    }
  });

  it("keeps job download filenames inside downloads or sync-root targets after sanitizing hostile names", async () => {
    const { root, store, state } = await createState();
    try {
      const hostileNames = [
        "../outside.txt",
        "..\\outside.txt",
        "/tmp/outside.txt",
        "\\Windows\\system32\\outside.txt",
        "C:\\Windows\\system32\\outside.txt",
        "C:/Windows/system32/outside.txt",
        "C:Windows\\system32\\outside.txt",
        "//server/share/outside.txt",
        "CON",
        "aux.txt"
      ];

      for (const raw of hostileNames) {
        const filename = sanitizeFileName(raw);
        assert.equal(filename.includes("/"), false, raw);
        assert.equal(filename.includes("\\"), false, raw);
        assert.equal(/^[A-Za-z]:/.test(filename), false, raw);

        const downloadsPath = join(state.config.downloadsDir, filename);
        const syncPath = join(state.config.syncRoot, filename);
        assert.equal(isInside(state.config.downloadsDir, downloadsPath), true, raw);
        assert.equal(isInside(state.config.syncRoot, syncPath), true, raw);
      }

      assert.equal(isInside(state.config.syncRoot, join(root, "safe.txt")), true);
      assert.equal(isInside(state.config.syncRoot, join(dirname(root), "outside.txt")), false);
    } finally {
      closeManifestStore(store);
    }
  });

  it("rejects unsafe create and update materialization paths without writing outside the sync root", async () => {
    const { root, store, state } = await createState();
    const outsideFile = join(dirname(root), "outside-workbench-sync-path-safety.md");
    const outsideDir = join(dirname(root), "outside-workbench-sync-path-safety");
    try {
      await rm(outsideFile, { force: true });
      await rm(outsideDir, { recursive: true, force: true });

      await assert.rejects(
        () => createLocalArtifactFolder(state, { path: "../outside-workbench-sync-path-safety" }),
        /Invalid artifact folder path/
      );
      await assert.rejects(
        () => createLocalArtifactNote(state, { path: "../outside-workbench-sync-path-safety.md", contentMarkdown: "nope" }),
        /Invalid artifact note path/
      );
      await assert.rejects(
        () => createLocalArtifactFile(state, {
          directoryPath: "../outside-workbench-sync-path-safety",
          filename: "asset.txt",
          contentBase64: Buffer.from("nope", "utf8").toString("base64")
        }),
        /Invalid artifact file path/
      );

      const created = await createLocalArtifactNote(state, {
        path: "safe.md",
        contentMarkdown: "# Safe\n"
      });
      await assert.rejects(
        () => updateLocalArtifactItem(state, created.id, {
          path: "C:\\outside-workbench-sync-path-safety.md",
          contentMarkdown: "# Nope\n"
        }),
        /Invalid artifact note path/
      );

      upsertResource(store, {
        relativePath: "../outside-workbench-sync-path-safety.md",
        domain: "artifacts",
        kind: "note",
        resourceId: "artifact-traversal",
        dirty: false
      });
      assert.equal(resolveSyncRootRelativePath(state.config, "../outside-workbench-sync-path-safety.md"), undefined);
      assert.equal(existsSync(outsideFile), false);
      assert.equal(existsSync(outsideDir), false);
    } finally {
      await rm(outsideFile, { force: true });
      await rm(outsideDir, { recursive: true, force: true });
      closeManifestStore(store);
    }
  });
});
