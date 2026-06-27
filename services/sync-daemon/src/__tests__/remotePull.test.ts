import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  closeManifestStore,
  getMeta,
  getRemoteResource,
  listConflicts,
  openManifestStore,
  readManifestFromStore,
  setMeta,
  upsertRemoteResource,
  upsertResource,
  type ManifestStore
} from "../manifestStore.js";
import {
  PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY,
  PROJECT_CONTEXT_SUPPORTED_META_KEY
} from "../projectContextCache.js";
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

function projectContextSnapshot(projectId: string, fetchedAt = "2026-06-21T00:00:00.000Z") {
  return {
    schemaVersion: 1,
    projectId,
    fetchedAt,
    baselineCursor: "50",
    complete: true,
    counts: { memories: 1, relations: 0 },
    context: {
      project: { id: projectId, name: `Snapshot ${projectId}`, status: "active", updatedAt: fetchedAt },
      brief: { projectId, contentMarkdown: `# ${projectId}`, version: 1, updatedByKind: "user", updatedAt: fetchedAt },
      memories: [
        {
          id: `memory-${projectId}`,
          projectId,
          kind: "decision",
          bodyMarkdown: `Memory for ${projectId}`,
          authority: "user_confirmed",
          status: "active",
          createdAt: fetchedAt,
          updatedAt: fetchedAt
        }
      ],
      relations: []
    }
  };
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
              notes: {
                items: [
                  {
                    id: "core-note-1",
                    projectId: "project-1",
                    title: "Core Note",
                    content: "cached"
                  }
                ],
                nextCursor: "note-cursor-2"
              },
              artifacts: {
                items: [
                  {
                    id: "note-1",
                    kind: "note",
                    title: "Remote",
                    path: "docs/remote.md",
                    contentMarkdown: "# Remote\n"
                  }
                ],
                nextCursor: "artifact-cursor-2"
              },
              tasks: {
                items: [
                  {
                    id: "task-1",
                    title: "Remote Task",
                    status: "todo",
                    projectId: "project-1"
                  }
                ],
                nextCursor: "task-cursor-2"
              }
            }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=artifacts&cursor=artifact-cursor-2&limit=100") {
          return jsonResponse({
            generatedAt: "2026-06-16T00:00:04.000Z",
            domains: {
              artifacts: {
                items: [
                  {
                    id: "note-2",
                    kind: "note",
                    title: "Remote More",
                    path: "docs/more.md",
                    contentMarkdown: "# More\n"
                  }
                ]
              }
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
        if (url === "http://core.test/api/sync/snapshot?domains=notes&cursor=note-cursor-2&limit=100") {
          return jsonResponse({
            generatedAt: "2026-06-16T00:00:02.000Z",
            domains: {
              notes: {
                items: [
                  {
                    id: "core-note-2",
                    projectId: "project-2",
                    title: "Core Note 2",
                    content: "cached page 2"
                  }
                ]
              }
            }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=tasks&cursor=task-cursor-2&limit=100") {
          return jsonResponse({
            generatedAt: "2026-06-16T00:00:03.000Z",
            domains: {
              tasks: {
                items: [
                  {
                    id: "task-2",
                    title: "Remote Task 2",
                    status: "todo",
                    projectId: "project-2"
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
        "http://core.test/api/sync/snapshot?domains=artifacts&cursor=artifact-cursor-2&limit=100",
        "http://core.test/api/sync/snapshot?domains=projects&cursor=project-cursor-2&limit=100",
        "http://core.test/api/sync/snapshot?domains=notes&cursor=note-cursor-2&limit=100",
        "http://core.test/api/sync/snapshot?domains=tasks&cursor=task-cursor-2&limit=100",
        "http://core.test/api/sync/pull?limit=500"
      ]);
      assert.equal(await readFile(join(root, "docs", "remote.md"), "utf8"), "# Remote\n");
      assert.equal(await readFile(join(root, "docs", "more.md"), "utf8"), "# More\n");
      const manifest = readManifestFromStore(store);
      assert.equal(manifest.remoteResources?.find((item) => item.domain === "projects")?.resourceId, "project-1");
      assert.equal(manifest.remoteResources?.some((item) => item.domain === "projects" && item.resourceId === "project-2"), true);
      assert.equal(manifest.remoteResources?.find((item) => item.domain === "notes")?.resourceId, "core-note-1");
      assert.equal(manifest.remoteResources?.some((item) => item.domain === "notes" && item.resourceId === "core-note-2"), true);
      assert.equal(manifest.remoteResources?.find((item) => item.domain === "tasks")?.resourceId, "task-1");
      assert.equal(manifest.remoteResources?.some((item) => item.domain === "tasks" && item.resourceId === "task-2"), true);
      assert.equal(getMeta(store, "remoteSyncCursor"), "7");
      assert.equal(getMeta(store, "remoteArtifactCursor"), "7");
      assert.equal(getMeta(store, "remoteArtifactSnapshotComplete"), "1");
      assert.ok(getMeta(store, "lastRemotePullAt"));
    } finally {
      closeManifestStore(store);
    }
  });

  it("stores non-artifact incremental sync events in the remote resource cache", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "50");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
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

  it("does not replace a cached Project with a legacy brief event", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "60");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-brief-safe",
        version: 7,
        payload: {
          id: "project-brief-safe",
          name: "Project cache must survive",
          description: "Base Project data",
          status: "active"
        }
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        assert.equal(String(input), "http://core.test/api/sync/pull?cursor=60&limit=100");
        return jsonResponse({
          events: [
            {
              cursor: "61",
              domain: "projects",
              resourceId: "project-brief-safe",
              action: "update",
              version: 8,
              createdAt: "2026-06-16T00:08:00.000Z",
              payload: {
                source: "core-api",
                relation: "brief",
                resource: {
                  projectId: "project-brief-safe",
                  contentMarkdown: "# This is a brief, not a Project",
                  version: 3
                }
              }
            }
          ],
          nextCursor: "61"
        });
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      const project = readManifestFromStore(store).remoteResources?.find(
        (item) => item.domain === "projects" && item.resourceId === "project-brief-safe"
      );
      assert.equal(project?.version, 7);
      assert.equal(project?.payload.name, "Project cache must survive");
      assert.equal(project?.payload.contentMarkdown, undefined);
      assert.equal(getMeta(store, "remoteSyncCursor"), "61");
      assert.equal(getMeta(store, "remoteArtifactCursor"), "61");
    } finally {
      closeManifestStore(store);
    }
  });

  it("ignores legacy context fake Project ids while applying normal CRUD and default events", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "70");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-normal",
        version: 1,
        payload: { id: "project-normal", name: "Before", status: "active" }
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        assert.equal(String(input), "http://core.test/api/sync/pull?cursor=70&limit=100");
        return jsonResponse({
          events: [
            {
              cursor: "71",
              domain: "projects",
              resourceId: "memory-fake-project",
              action: "update",
              version: 1,
              payload: { relation: "memory", patch: { bodyMarkdown: "not a Project" } }
            },
            {
              cursor: "72",
              domain: "projects",
              resourceId: "relation-fake-project",
              action: "update",
              version: 1,
              payload: { relation: "project-relation", patch: { note: "not a Project" } }
            },
            {
              cursor: "73",
              domain: "projects",
              resourceId: "index-fake-project",
              action: "update",
              version: 1,
              payload: { relation: "index", action: "rebuild" }
            },
            {
              cursor: "74",
              domain: "projects",
              resourceId: "membership-fake-project",
              action: "update",
              version: 1,
              payload: { relation: "project-membership", artifactItemId: "artifact-1" }
            },
            {
              cursor: "75",
              domain: "projects",
              resourceId: "project-normal",
              action: "update",
              version: 2,
              payload: {
                resource: { id: "project-normal", name: "After", status: "active" }
              }
            },
            {
              cursor: "76",
              domain: "projects",
              resourceId: "project-created",
              action: "create",
              version: 1,
              payload: {
                resource: { id: "project-created", name: "Created", status: "draft" }
              }
            },
            {
              cursor: "77",
              domain: "projects",
              resourceId: "project-normal",
              action: "update",
              version: 3,
              payload: {
                relation: "default",
                patch: { isUserDefault: true }
              }
            }
          ],
          nextCursor: "77"
        });
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      const projects = readManifestFromStore(store).remoteResources?.filter((item) => item.domain === "projects") ?? [];
      assert.equal(projects.some((item) => item.resourceId === "memory-fake-project"), false);
      assert.equal(projects.some((item) => item.resourceId === "relation-fake-project"), false);
      assert.equal(projects.some((item) => item.resourceId === "index-fake-project"), false);
      assert.equal(projects.some((item) => item.resourceId === "membership-fake-project"), false);
      assert.equal(projects.find((item) => item.resourceId === "project-normal")?.payload.name, "After");
      assert.equal(projects.find((item) => item.resourceId === "project-normal")?.payload.isUserDefault, true);
      assert.equal(projects.find((item) => item.resourceId === "project-created")?.payload.name, "Created");
      assert.equal(getMeta(store, "remoteSyncCursor"), "77");
      assert.equal(getMeta(store, "remoteArtifactCursor"), "77");
    } finally {
      closeManifestStore(store);
    }
  });

  it("unwraps Core Project default selection events and updates cached default flags", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "80");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-previous-default",
        version: 2,
        payload: {
          id: "project-previous-default",
          name: "Previous default",
          status: "active",
          isUserDefault: true
        }
      });
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-next-default",
        version: 3,
        payload: {
          id: "project-next-default",
          name: "Cached name",
          description: "Preserve cached fields omitted by the selection event",
          status: "draft",
          isUserDefault: false
        }
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        assert.equal(String(input), "http://core.test/api/sync/pull?cursor=80&limit=100");
        return jsonResponse({
          events: [
            {
              cursor: "81",
              domain: "projects",
              resourceId: "project-next-default",
              action: "update",
              version: 4,
              createdAt: "2026-06-16T00:09:00.000Z",
              payload: {
                source: "core-api",
                relation: "default",
                projectId: "project-next-default",
                resource: {
                  project: {
                    id: "project-next-default",
                    name: "Selected Project",
                    status: "active",
                    isUserDefault: true,
                    updatedAt: "2026-06-16T00:08:59.000Z"
                  },
                  source: "user"
                }
              }
            }
          ],
          nextCursor: "81"
        });
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      const projects = readManifestFromStore(store).remoteResources?.filter((item) => item.domain === "projects") ?? [];
      const previous = projects.find((item) => item.resourceId === "project-previous-default");
      const selected = projects.find((item) => item.resourceId === "project-next-default");
      assert.equal(previous?.payload.isUserDefault, false);
      assert.equal(selected?.payload.isUserDefault, true);
      assert.equal(selected?.payload.name, "Selected Project");
      assert.equal(selected?.payload.description, "Preserve cached fields omitted by the selection event");
      assert.equal(selected?.payload.project, undefined);
      assert.equal(selected?.payload.source, undefined);
      assert.equal(selected?.version, 4);
      assert.equal(getMeta(store, "remoteSyncCursor"), "81");
      assert.equal(getMeta(store, "remoteArtifactCursor"), "81");
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
      assert.equal(getMeta(store, "remoteArtifactSnapshotComplete"), "1");
    } finally {
      closeManifestStore(store);
    }
  });

  it("applies incremental remote notes when the local path is clean", async () => {
    const { root, store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "10");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
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
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
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

  it("rejects remote file blobs when the Core checksum header does not match", async () => {
    const { root, store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "25");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://core.test/api/sync/pull?cursor=25&limit=100") {
          return jsonResponse({
            events: [
              {
                cursor: "26",
                domain: "artifacts",
                resourceId: "file-bad-checksum",
                action: "update",
                createdAt: "2026-06-16T00:02:30.000Z",
                payload: {
                  resource: {
                    id: "file-bad-checksum",
                    kind: "file",
                    title: "asset.txt",
                    path: "assets/bad.txt",
                    mimeType: "text/plain",
                    sizeBytes: 5
                  }
                }
              }
            ],
            nextCursor: "26"
          });
        }
        if (url === "http://core.test/api/sync/blobs/artifact%3Afile-bad-checksum") {
          return new Response(Buffer.from("asset"), {
            status: 200,
            headers: {
              "Content-Type": "text/plain",
              "Content-Length": "5",
              "X-Workbench-Content-Checksum": `sha256:${"0".repeat(64)}`
            }
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await assert.rejects(() => pullRemoteArtifactSyncState(state), /Download checksum mismatch/);
      await assert.rejects(readFile(join(root, "assets", "bad.txt"), "utf8"));
      assert.equal(readManifestFromStore(store).resources?.length ?? 0, 0);
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
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
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
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
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
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
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
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
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

  it("preserves existing context cache when an old Core omits project_context capability", async () => {
    const { store, state } = await createState();
    try {
      upsertRemoteResource(store, {
        domain: "project_context",
        resourceId: "project-cached",
        payload: projectContextSnapshot("project-cached")
      });
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "project-cached",
        payload: { id: "project-cached", name: "Cached Project", status: "active" }
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:00.000Z",
            domains: { projects: { items: [] } }
          });
        }
        if (url === "http://core.test/api/sync/pull?limit=500") {
          return jsonResponse({ events: [], nextCursor: "9" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.ok(getRemoteResource(store, "project_context", "project-cached"));
      assert.equal(getMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY), "0");
      assert.equal(getMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY), undefined);
      assert.equal(getMeta(store, "remoteSyncCursor"), "9");
    } finally {
      closeManifestStore(store);
    }
  });

  it("detects and bootstraps Project context when upgrading an existing daemon cache", async () => {
    const { store, state } = await createState();
    const calls: string[] = [];
    try {
      setMeta(store, "remoteArtifactCursor", "100");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:00.000Z",
            baselineCursor: "150",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: { projects: { items: [{ id: "project-1", name: "Project One", status: "active" }] } }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=project_context&limit=100&baselineCursor=150") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:01.000Z",
            baselineCursor: "150",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: {
              project_context: {
                items: [{ ...projectContextSnapshot("project-1"), baselineCursor: "150" }]
              }
            }
          });
        }
        if (url === "http://core.test/api/sync/pull?cursor=150&limit=500") {
          return jsonResponse({ events: [], nextCursor: "150" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.deepEqual(calls, [
        "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks",
        "http://core.test/api/sync/snapshot?domains=project_context&limit=100&baselineCursor=150",
        "http://core.test/api/sync/pull?cursor=150&limit=500"
      ]);
      assert.equal(getMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY), "1");
      assert.equal(getMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY), "1");
      assert.equal(getMeta(store, "remoteSyncCursor"), "150");
      assert.ok(getRemoteResource(store, "project_context", "project-1"));
    } finally {
      closeManifestStore(store);
    }
  });

  it("pins the first baseline across paged context bootstrap and prunes only stale context and legacy fake Projects", async () => {
    const { store, state } = await createState();
    const calls: string[] = [];
    try {
      upsertRemoteResource(store, {
        domain: "project_context",
        resourceId: "project-stale",
        payload: projectContextSnapshot("project-stale")
      });
      upsertRemoteResource(store, {
        domain: "projects",
        resourceId: "memory-fake-project",
        payload: { id: "memory-fake-project", contentMarkdown: "legacy brief payload" }
      });
      upsertRemoteResource(store, {
        domain: "notes",
        resourceId: "note-preserved",
        payload: { id: "note-preserved", title: "Preserve other domains" }
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:00.000Z",
            baselineCursor: "50",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: {
              projects: {
                items: [
                  { id: "project-1", name: "Project One", status: "active" },
                  { id: "project-2", name: "Project Two", status: "active" }
                ]
              }
            }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=project_context&limit=100&baselineCursor=50") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:01.000Z",
            baselineCursor: "50",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: {
              project_context: {
                items: [projectContextSnapshot("project-1")],
                nextCursor: "context-page-2"
              }
            }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=project_context&cursor=context-page-2&limit=100&baselineCursor=50") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:02.000Z",
            baselineCursor: "50",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: { project_context: { items: [projectContextSnapshot("project-2")] } }
          });
        }
        if (url === "http://core.test/api/sync/pull?cursor=50&limit=500") {
          return jsonResponse({
            events: [
              {
                cursor: "51",
                domain: "project_context",
                resourceId: "project-1",
                action: "update",
                version: 3,
                createdAt: "2026-06-21T00:00:03.000Z",
                payload: { schemaVersion: 1, kind: "invalidate", projectId: "project-1", changed: ["brief"] }
              }
            ],
            nextCursor: "51"
          });
        }
        if (url === "http://core.test/api/sync/project-context/project-1") {
          return jsonResponse(projectContextSnapshot("project-1", "2026-06-21T00:00:04.000Z"));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.deepEqual(calls, [
        "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks",
        "http://core.test/api/sync/snapshot?domains=project_context&limit=100&baselineCursor=50",
        "http://core.test/api/sync/snapshot?domains=project_context&cursor=context-page-2&limit=100&baselineCursor=50",
        "http://core.test/api/sync/pull?cursor=50&limit=500",
        "http://core.test/api/sync/project-context/project-1"
      ]);
      assert.equal(getMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY), "1");
      assert.equal(getMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY), "1");
      assert.equal(getMeta(store, "projectContextBaselineCursor"), "50");
      assert.equal(getRemoteResource(store, "project_context", "project-stale"), undefined);
      assert.equal(getRemoteResource(store, "projects", "memory-fake-project"), undefined);
      assert.ok(getRemoteResource(store, "notes", "note-preserved"));
      assert.equal(getRemoteResource(store, "project_context", "project-1")?.version, 3);
      assert.equal(getMeta(store, "remoteSyncCursor"), "51");
    } finally {
      closeManifestStore(store);
    }
  });

  it("refetches invalidations and applies delete, duplicate, out-of-order, and self events safely", async () => {
    const { store, state } = await createState();
    let detailFetches = 0;
    try {
      setMeta(store, "remoteArtifactCursor", "100");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "1");
      setMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, "1");
      upsertRemoteResource(store, {
        domain: "project_context",
        resourceId: "project-1",
        version: 5,
        payload: projectContextSnapshot("project-1")
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://core.test/api/sync/pull?cursor=100&limit=100") {
          const invalidate = (version: number, localClientId?: string) => ({
            domain: "project_context",
            resourceId: "project-1",
            action: "update",
            version,
            createdAt: `2026-06-21T00:00:${String(version).padStart(2, "0")}.000Z`,
            payload: {
              schemaVersion: 1,
              kind: "invalidate",
              projectId: "project-1",
              changed: ["memory"],
              ...(localClientId ? { localClientId } : {})
            }
          });
          return jsonResponse({
            events: [
              invalidate(6),
              invalidate(6),
              invalidate(5),
              invalidate(7, "client-1"),
              {
                cursor: "108",
                domain: "project_context",
                resourceId: "project-1",
                action: "delete",
                version: 8,
                createdAt: "2026-06-21T00:00:08.000Z",
                payload: { schemaVersion: 1, projectId: "project-1", deleted: true }
              },
              invalidate(7)
            ],
            nextCursor: "108"
          });
        }
        if (url === "http://core.test/api/sync/project-context/project-1") {
          detailFetches += 1;
          return jsonResponse(projectContextSnapshot("project-1", "2026-06-21T00:00:06.000Z"));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      const resource = getRemoteResource(store, "project_context", "project-1");
      assert.equal(detailFetches, 1);
      assert.equal(resource?.deleted, true);
      assert.equal(resource?.version, 8);
      assert.equal(getMeta(store, "remoteSyncCursor"), "108");
    } finally {
      closeManifestStore(store);
    }
  });

  it("fails closed on a malformed paged context snapshot without publishing partial rows", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "1");
      setMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, "1");
      upsertRemoteResource(store, {
        domain: "project_context",
        resourceId: "project-old",
        version: 9,
        payload: projectContextSnapshot("project-old")
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://core.test/api/sync/snapshot?domains=projects%2Cnotes%2Cartifacts%2Ctasks") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:00.000Z",
            baselineCursor: "50",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: { projects: { items: [{ id: "project-new", name: "New Project", status: "active" }] } }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=project_context&limit=100&baselineCursor=50") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:01.000Z",
            baselineCursor: "50",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: {
              project_context: {
                items: [projectContextSnapshot("project-new")],
                nextCursor: "page-2"
              }
            }
          });
        }
        if (url === "http://core.test/api/sync/snapshot?domains=project_context&cursor=page-2&limit=100&baselineCursor=50") {
          return jsonResponse({
            generatedAt: "2026-06-21T00:00:02.000Z",
            baselineCursor: "50",
            supportedDomains: ["projects", "notes", "artifacts", "tasks", "project_context"],
            domains: { project_context: { items: "not-an-array" } }
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () => pullRemoteArtifactSyncState(state),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT"
      );

      assert.equal(getRemoteResource(store, "project_context", "project-new"), undefined);
      assert.equal(getRemoteResource(store, "project_context", "project-old")?.version, 9);
      assert.equal(getMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY), "1");
      assert.equal(getMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY), "1");
    } finally {
      closeManifestStore(store);
    }
  });

  it("rejects a mismatched detail refetch without overwriting another Project cache row", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "100");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "1");
      setMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, "1");
      upsertRemoteResource(store, {
        domain: "project_context",
        resourceId: "project-1",
        version: 5,
        payload: projectContextSnapshot("project-1")
      });
      upsertRemoteResource(store, {
        domain: "project_context",
        resourceId: "project-2",
        version: 11,
        payload: projectContextSnapshot("project-2", "2026-06-21T00:00:02.000Z")
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://core.test/api/sync/pull?cursor=100&limit=100") {
          return jsonResponse({
            events: [{
              domain: "project_context",
              resourceId: "project-1",
              action: "update",
              version: 6,
              payload: { schemaVersion: 1, kind: "invalidate", projectId: "project-1", changed: ["brief"] }
            }],
            nextCursor: "101"
          });
        }
        if (url === "http://core.test/api/sync/project-context/project-1") {
          return jsonResponse(projectContextSnapshot("project-2", "2026-06-21T00:00:09.000Z"));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () => pullRemoteArtifactSyncState(state),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT"
      );
      assert.equal(getRemoteResource(store, "project_context", "project-1")?.version, 5);
      assert.equal(getRemoteResource(store, "project_context", "project-2")?.version, 11);
      assert.equal(
        getRemoteResource(store, "project_context", "project-2")?.payload.fetchedAt,
        "2026-06-21T00:00:02.000Z"
      );
      assert.equal(getMeta(store, "remoteSyncCursor"), undefined);
    } finally {
      closeManifestStore(store);
    }
  });

  it("does not apply an unknown context schema and requests a safe full rescan", async () => {
    const { store, state } = await createState();
    try {
      setMeta(store, "remoteArtifactCursor", "100");
      setMeta(store, "remoteArtifactSnapshotComplete", "1");
      setMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY, "1");
      setMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, "1");
      setMeta(store, "projectContextBaselineCursor", "50");
      upsertRemoteResource(store, {
        domain: "project_context",
        resourceId: "project-1",
        version: 5,
        payload: projectContextSnapshot("project-1")
      });
      state.tickRunning = true;

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://core.test/api/sync/pull?cursor=100&limit=100") {
          return jsonResponse({
            events: [{
              domain: "project_context",
              resourceId: "project-1",
              action: "update",
              version: 6,
              payload: { schemaVersion: 2, kind: "invalidate", projectId: "project-1", changed: ["memory"] }
            }],
            nextCursor: "101"
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      await pullRemoteArtifactSyncState(state);

      assert.equal(getRemoteResource(store, "project_context", "project-1")?.version, 5);
      assert.equal(getMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY), undefined);
      assert.equal(getMeta(store, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY), undefined);
      assert.equal(getMeta(store, "projectContextBaselineCursor"), undefined);
      assert.equal(getMeta(store, "remoteArtifactSnapshotComplete"), undefined);
      assert.equal(state.tickQueued, true);
    } finally {
      state.tickRunning = false;
      closeManifestStore(store);
    }
  });
});
