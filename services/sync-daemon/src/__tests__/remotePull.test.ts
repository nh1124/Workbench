import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  closeManifestStore,
  getMeta,
  listConflicts,
  openManifestStore,
  readManifestFromStore,
  setMeta,
  upsertRemoteResource,
  upsertResource,
  type ManifestStore
} from "../manifestStore.js";
import {
  pullRemoteArtifactSyncState,
  type DaemonConfig,
  type DaemonState
} from "../index.js";

const tempRoots: string[] = [];
const originalFetch = globalThis.fetch;

function checksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createState(): Promise<{ root: string; store: ManifestStore; state: DaemonState }> {
  const root = await mkdtemp(join(tmpdir(), "workbench-sync-remote-"));
  tempRoots.push(root);
  await mkdir(join(root, ".workbench"), { recursive: true });
  const store = openManifestStore(root);
  const config: DaemonConfig = {
    coreUrl: "http://core.test",
    syncRoot: root,
    downloadsDir: join(root, "downloads"),
    deviceId: "test-device",
    clientName: "test daemon",
    syncRootId: "test-root",
    syncRootLabel: "Test Sync",
    intervalMs: 5000,
    httpPort: 0,
    maxSyncFileBytes: 1024 * 1024,
    watchEnabled: false,
    watchDebounceMs: 100
  };
  return {
    root,
    store,
    state: {
      config,
      manifestStore: store,
      identity: {
        localClientId: "client-1",
        localClientToken: "token-1",
        deviceId: "test-device",
        syncRootId: "test-root"
      },
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("remote artifact pull reconciliation", () => {
  it("bootstraps from the artifact snapshot and persists the drained cursor", async () => {
    const { root, store, state } = await createState();
    const calls: string[] = [];
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks") {
          return jsonResponse({
            generatedAt: "2026-06-16T00:00:00.000Z",
            domains: {
              projects: {
                items: [
                  {
                    id: "project-1",
                    name: "Remote Project",
                    status: "active",
                    updatedAt: "2026-06-16T00:00:00.000Z"
                  }
                ],
                nextCursor: "project-cursor-2"
              },
              notes: [
                {
                  id: "core-note-1",
                  projectId: "project-1",
                  title: "Core Note",
                  content: "cached"
                }
              ],
              artifacts: [
                {
                  id: "note-1",
                  kind: "note",
                  title: "Remote",
                  path: "docs/remote.md",
                  contentMarkdown: "# Remote\n"
                }
              ],
              tasks: [
                {
                  id: "task-1",
                  title: "Remote Task",
                  status: "todo",
                  projectId: "project-1"
                }
              ]
            }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=projects&cursor=project-cursor-2&limit=100") {
          return jsonResponse({
            generatedAt: "2026-06-16T00:00:01.000Z",
            domains: {
              projects: {
                items: [
                  {
                    id: "project-2",
                    name: "Remote Project 2",
                    status: "draft",
                    updatedAt: "2026-06-16T00:00:01.000Z"
                  }
                ]
              }
            }
          });
        }
        if (url === "http://core.test/api/sync/pull?limit=500") {
          return jsonResponse({
            events: [
              {
                cursor: "7",
                domain: "artifacts",
                resourceId: "note-1",
                action: "update",
                createdAt: "2026-06-15T23:59:59.000Z",
                payload: {
                  resource: {
                    id: "note-1",
                    kind: "note",
                    path: "docs/remote.md",
                    contentMarkdown: "# Older event\n"
                  }
                }
              }
            ],
            nextCursor: "7"
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.deepEqual(calls, [
        "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks",
        "http://core.test/api/sync/snapshot?domains=projects&cursor=project-cursor-2&limit=100",
        "http://core.test/api/sync/pull?limit=500"
      ]);
      assert.equal(await readFile(join(root, "docs", "remote.md"), "utf8"), "# Remote\n");
      const manifest = readManifestFromStore(store);
      assert.equal(manifest.remoteResources?.find((item) => item.domain === "projects")?.resourceId, "project-1");
      assert.equal(manifest.remoteResources?.some((item) => item.domain === "projects" && item.resourceId === "project-2"), true);
      assert.equal(manifest.remoteResources?.find((item) => item.domain === "notes")?.resourceId, "core-note-1");
      assert.equal(manifest.remoteResources?.find((item) => item.domain === "tasks")?.resourceId, "task-1");
      assert.equal(getMeta(store, "remoteSyncCursor"), "7");
      assert.equal(getMeta(store, "remoteArtifactCursor"), "7");
      assert.ok(getMeta(store, "lastRemotePullAt"));
    } finally {
      closeManifestStore(store);
    }
  });

  it("stores non-artifact incremental sync events in the remote resource cache", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "50");
      upsertRemoteResource(store, {
        domain: "tasks",
        resourceId: "task-existing",
        payload: {
          id: "task-existing",
          title: "Cached Task",
          status: "todo"
        },
        lastSyncedAt: "2026-06-16T00:00:00.000Z"
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        assert.equal(String(input), "http://core.test/api/sync/pull?cursor=50&limit=100");
        return jsonResponse({
          events: [
            {
              cursor: "51",
              domain: "projects",
              resourceId: "project-2",
              action: "update",
              version: 3,
              createdAt: "2026-06-16T00:05:00.000Z",
              payload: {
                resource: {
                  id: "project-2",
                  name: "Changed Project",
                  status: "active"
                }
              }
            },
            {
              cursor: "52",
              domain: "tasks",
              resourceId: "task-existing",
              action: "update",
              version: 6,
              createdAt: "2026-06-16T00:06:30.000Z",
              payload: {
                source: "sync-push",
                relation: "pin",
                pinned: true
              }
            },
            {
              cursor: "53",
              domain: "notes",
              resourceId: "note-deleted",
              action: "delete",
              version: 4,
              createdAt: "2026-06-16T00:06:00.000Z",
              payload: {
                deleted: true
              }
            },
            {
              cursor: "54",
              domain: "tasks",
              resourceId: "task-from-self",
              action: "update",
              version: 5,
              createdAt: "2026-06-16T00:07:00.000Z",
              payload: {
                localClientId: "client-1",
                resource: {
                  id: "task-from-self",
                  title: "Skip self"
                }
              }
            }
          ],
          nextCursor: "54"
        });
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      const manifest = readManifestFromStore(store);
      const project = manifest.remoteResources?.find((item) => item.domain === "projects" && item.resourceId === "project-2");
      const existingTask = manifest.remoteResources?.find((item) => item.domain === "tasks" && item.resourceId === "task-existing");
      const deletedNote = manifest.remoteResources?.find((item) => item.domain === "notes" && item.resourceId === "note-deleted");
      assert.equal(project?.version, 3);
      assert.equal(project?.payload.name, "Changed Project");
      assert.equal(existingTask?.version, 6);
      assert.equal(existingTask?.payload.title, "Cached Task");
      assert.equal(existingTask?.payload.pinned, true);
      assert.equal(deletedNote?.deleted, true);
      assert.equal(manifest.remoteResources?.some((item) => item.resourceId === "task-from-self"), false);
      assert.equal(getMeta(store, "remoteSyncCursor"), "54");
      assert.equal(getMeta(store, "remoteArtifactCursor"), "54");
    } finally {
      closeManifestStore(store);
    }
  });

  it("falls back to artifact-only bootstrap when all-domain snapshots are unavailable", async () => {
    const { root, store, state } = await createState();
    const calls: string[] = [];
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks") {
          return new Response("Projects service is not configured", { status: 500 });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=artifacts") {
          return jsonResponse({
            generatedAt: "2026-06-16T00:00:00.000Z",
            domains: {
              artifacts: [
                {
                  id: "fallback-note",
                  kind: "note",
                  title: "Fallback",
                  path: "fallback.md",
                  contentMarkdown: "# Fallback\n"
                }
              ]
            }
          });
        }
        if (url === "http://core.test/api/sync/pull?limit=500") {
          return jsonResponse({ events: [], nextCursor: "9" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.deepEqual(calls, [
        "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks",
        "http://core.test/api/sync/snapshot?domains=artifacts",
        "http://core.test/api/sync/pull?limit=500"
      ]);
      assert.equal(await readFile(join(root, "fallback.md"), "utf8"), "# Fallback\n");
      assert.equal(getMeta(store, "remoteSyncCursor"), "9");
    } finally {
      closeManifestStore(store);
    }
  });

  it("applies incremental remote notes when the local path is clean", async () => {
    const { root, store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "10");
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal((init?.headers as Record<string, string>)["x-workbench-local-client-id"], "client-1");
        assert.equal((init?.headers as Record<string, string>)["x-workbench-local-client-token"], "token-1");
        assert.equal(String(input), "http://core.test/api/sync/pull?cursor=10&limit=100");
        return jsonResponse({
          events: [
            {
              cursor: "11",
              domain: "artifacts",
              resourceId: "note-remote",
              action: "create",
              createdAt: "2026-06-16T00:01:00.000Z",
              payload: {
                resource: {
                  id: "note-remote",
                  kind: "note",
                  title: "Remote",
                  path: "remote.md",
                  contentMarkdown: "# Remote\n"
                }
              }
            }
          ],
          nextCursor: "11"
        });
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.equal(await readFile(join(root, "remote.md"), "utf8"), "# Remote\n");
      const manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.[0].relativePath, "remote.md");
      assert.equal(manifest.resources?.[0].resourceId, "note-remote");
      assert.equal(manifest.resources?.[0].dirty, false);
      assert.equal(manifest.outbox?.length, 0);
      assert.equal(getMeta(store, "remoteArtifactCursor"), "11");
    } finally {
      closeManifestStore(store);
    }
  });

  it("fetches small remote file blobs when event content is not embedded", async () => {
    const { root, store, state } = await createState();
    const calls: string[] = [];
    try {
      setMeta(store, "remoteArtifactCursor", "20");
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "http://core.test/api/sync/pull?cursor=20&limit=100") {
          return jsonResponse({
            events: [
              {
                cursor: "21",
                domain: "artifacts",
                resourceId: "file-remote",
                action: "update",
                createdAt: "2026-06-16T00:02:00.000Z",
                payload: {
                  resource: {
                    id: "file-remote",
                    kind: "file",
                    title: "asset.txt",
                    path: "assets/asset.txt",
                    mimeType: "text/plain",
                    sizeBytes: 5
                  }
                }
              }
            ],
            nextCursor: "21"
          });
        }
        if (url === "http://core.test/api/sync/blobs/artifact%3Afile-remote") {
          return new Response(Buffer.from("asset"), {
            status: 200,
            headers: {
              "Content-Type": "text/plain",
              "Content-Length": "5"
            }
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.deepEqual(calls, [
        "http://core.test/api/sync/pull?cursor=20&limit=100",
        "http://core.test/api/sync/blobs/artifact%3Afile-remote"
      ]);
      assert.equal(await readFile(join(root, "assets", "asset.txt"), "utf8"), "asset");
      assert.equal(readManifestFromStore(store).resources?.[0].checksum, checksum("asset"));
    } finally {
      closeManifestStore(store);
    }
  });

  it("opens a conflict instead of overwriting dirty local artifact work", async () => {
    const { root, store, state } = await createState();
    try {
      await writeFile(join(root, "remote.md"), "# Local edit\n", "utf8");
      upsertResource(store, {
        relativePath: "remote.md",
        domain: "artifacts",
        kind: "note",
        resourceId: "note-remote",
        checksum: checksum("# Synced\n"),
        sizeBytes: 9,
        dirty: false
      });
      setMeta(store, "remoteArtifactCursor", "30");
      globalThis.fetch = (async () => jsonResponse({
        events: [
          {
            cursor: "31",
            domain: "artifacts",
            resourceId: "note-remote",
            action: "update",
            createdAt: "2026-06-16T00:03:00.000Z",
            payload: {
              resource: {
                id: "note-remote",
                kind: "note",
                title: "Remote",
                path: "remote.md",
                contentMarkdown: "# Remote edit\n"
              }
            }
          }
        ],
        nextCursor: "31"
      })) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.equal(await readFile(join(root, "remote.md"), "utf8"), "# Local edit\n");
      const conflicts = listConflicts(store, { status: "open" });
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].relativePath, "remote.md");
      assert.match(conflicts[0].errorMessage, /unsynced local file state/);
      assert.equal(getMeta(store, "remoteArtifactCursor"), "31");
    } finally {
      closeManifestStore(store);
    }
  });

  it("applies remote folder deletes only when tracked contents are clean", async () => {
    const { root, store, state } = await createState();
    try {
      await mkdir(join(root, "docs", "sub"), { recursive: true });
      await writeFile(join(root, "docs", "sub", "remote.md"), "# Synced\n", "utf8");
      upsertResource(store, {
        relativePath: "docs/sub/remote.md",
        domain: "artifacts",
        kind: "note",
        resourceId: "note-child",
        checksum: checksum("# Synced\n"),
        sizeBytes: Buffer.byteLength("# Synced\n", "utf8"),
        dirty: false
      });
      setMeta(store, "remoteArtifactCursor", "35");
      globalThis.fetch = (async () => jsonResponse({
        events: [
          {
            cursor: "36",
            domain: "artifacts",
            resourceId: "folder-remote",
            action: "delete",
            createdAt: "2026-06-16T00:03:30.000Z",
            payload: {
              resource: {
                id: "folder-remote",
                kind: "folder",
                path: "docs"
              },
              deleted: true
            }
          }
        ],
        nextCursor: "36"
      })) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      await assert.rejects(readFile(join(root, "docs", "sub", "remote.md"), "utf8"));
      assert.equal(readManifestFromStore(store).resources?.length, 0);
      assert.equal(listConflicts(store, { status: "open" }).length, 0);
      assert.equal(getMeta(store, "remoteArtifactCursor"), "36");
    } finally {
      closeManifestStore(store);
    }
  });

  it("opens a conflict instead of applying remote folder deletes over untracked local files", async () => {
    const { root, store, state } = await createState();
    try {
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "local.txt"), "local-only", "utf8");
      setMeta(store, "remoteArtifactCursor", "37");
      globalThis.fetch = (async () => jsonResponse({
        events: [
          {
            cursor: "38",
            domain: "artifacts",
            resourceId: "folder-remote",
            action: "delete",
            createdAt: "2026-06-16T00:03:40.000Z",
            payload: {
              resource: {
                id: "folder-remote",
                kind: "folder",
                path: "docs"
              },
              deleted: true
            }
          }
        ],
        nextCursor: "38"
      })) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.equal(await readFile(join(root, "docs", "local.txt"), "utf8"), "local-only");
      const conflicts = listConflicts(store, { status: "open" });
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].relativePath, "docs");
      assert.match(conflicts[0].errorMessage, /untracked local files/);
      assert.equal(getMeta(store, "remoteArtifactCursor"), "38");
    } finally {
      closeManifestStore(store);
    }
  });

  it("ignores remote paths under the daemon metadata directory", async () => {
    const { root, store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "40");
      globalThis.fetch = (async () => jsonResponse({
        events: [
          {
            cursor: "41",
            domain: "artifacts",
            resourceId: "bad-note",
            action: "create",
            createdAt: "2026-06-16T00:04:00.000Z",
            payload: {
              resource: {
                id: "bad-note",
                kind: "note",
                title: "Bad",
                path: ".workbench/evil.md",
                contentMarkdown: "nope"
              }
            }
          }
        ],
        nextCursor: "41"
      })) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      const manifest = readManifestFromStore(store);
      assert.equal(manifest.resources?.length, 0);
      await assert.rejects(readFile(join(root, ".workbench", "evil.md"), "utf8"));
      assert.equal(getMeta(store, "remoteArtifactCursor"), "41");
    } finally {
      closeManifestStore(store);
    }
  });
});
