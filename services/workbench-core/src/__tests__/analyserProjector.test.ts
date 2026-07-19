import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ??= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ??= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ??= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ??= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ??= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ??= "http://wbs.test";
process.env.ANALYSER_SERVICE_URL ??= "http://analyser.test";
process.env.INTERNAL_API_KEY_ANALYSER ??= "analyser-test-key";
process.env.CORE_DB_HOST ??= "127.0.0.1";
process.env.CORE_DB_PORT ??= "5432";
process.env.CORE_DB_NAME ??= "workbench-test-unused";
process.env.CORE_DB_USER ??= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ??= "workbench-test-unused";

const { ANALYSER_PROJECTOR_CONSUMER, projectSyncEventsForUser } = await import("../analyserProjector.js");
type AnalyserProjectorDeps = import("../analyserProjector.js").AnalyserProjectorDeps;
type SyncEvent = import("../syncStore.js").SyncEvent;

function event(cursor: string, overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    cursor,
    userId: "user-1",
    domain: "notes",
    resourceId: `note-${cursor}`,
    action: "update",
    version: 7,
    payload: { contentMarkdown: "must not leave Core", nested: { secret: true } },
    projectId: "project-1",
    resourceType: "note",
    path: `notes/${cursor}.md`,
    previousPath: `drafts/${cursor}.md`,
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  };
}

function deps(overrides: Partial<AnalyserProjectorDeps> = {}): Partial<AnalyserProjectorDeps> {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected projector dependency call");
  };
  return {
    getEffectiveSettings: async () => ({ settings: { workbenchChanges: "metadata" } }),
    ingestObservations: unexpected,
    initializeSyncConsumer: async () => ({
      consumer: ANALYSER_PROJECTOR_CONSUMER,
      cursor: "0",
      alreadyInitialized: true
    }),
    getConsumerState: async () => ({ cursor: "0" }),
    pullSyncChanges: unexpected,
    commitConsumerCursor: unexpected,
    getLatestSyncCursor: unexpected,
    ...overrides
  };
}

describe("Core analyser projector", () => {
  it("forwards only allowlisted metadata and derives event identity from the cursor", async () => {
    const calls: string[] = [];
    let ingestBody: { coreUserId: string; observations: unknown[] } | undefined;
    let committed: unknown;
    const result = await projectSyncEventsForUser("user-1", { deps: deps({
      pullSyncChanges: async () => ({
        consumer: ANALYSER_PROJECTOR_CONSUMER,
        cursor: "0",
        events: [event("42")],
        nextCursor: "42"
      }),
      ingestObservations: async (body) => {
        calls.push("ingest");
        ingestBody = body;
        return { ingested: 1, duplicates: 0, rejected: {} };
      },
      commitConsumerCursor: (async (userId, consumer, cursor) => {
        calls.push("commit");
        committed = { userId, consumer, cursor };
        return {} as never;
      }) as AnalyserProjectorDeps["commitConsumerCursor"]
    }) });

    assert.deepEqual(result, { projected: 1, duplicates: 0, rejected: 0, batches: 1 });
    assert.deepEqual(calls, ["ingest", "commit"]);
    assert.deepEqual(committed, { userId: "user-1", consumer: ANALYSER_PROJECTOR_CONSUMER, cursor: "42" });
    assert.ok(ingestBody);
    const projected = ingestBody.observations[0] as Record<string, unknown>;
    assert.equal(Object.hasOwn(projected, "payload"), false);
    assert.deepEqual(projected, {
      source: "workbench_change",
      action: "notes.update",
      actorKind: "user",
      projectId: "project-1",
      occurredAt: "2026-07-20T00:00:00.000Z",
      resourceRefs: [{
        service: "notes",
        resourceType: "note",
        resourceId: "note-42",
        pathSnapshot: "notes/42.md"
      }],
      metadata: {
        domain: "notes",
        action: "update",
        resourceType: "note",
        path: "notes/42.md",
        previousPath: "drafts/42.md",
        version: 7
      },
      sourceEventId: "42",
      dedupeKey: "workbench_change:42"
    });
  });

  it("does not commit the cursor when ingest fails", async () => {
    let commits = 0;
    await assert.rejects(
      projectSyncEventsForUser("user-1", { deps: deps({
        pullSyncChanges: async () => ({
          consumer: ANALYSER_PROJECTOR_CONSUMER,
          cursor: "0",
          events: [event("5")]
        }),
        ingestObservations: async () => { throw new Error("analyser unavailable"); },
        commitConsumerCursor: (async () => {
          commits += 1;
          return {} as never;
        }) as AnalyserProjectorDeps["commitConsumerCursor"]
      }) }),
      /analyser unavailable/
    );
    assert.equal(commits, 0);
  });

  it("fast-forwards without ingest when workbench change collection is off", async () => {
    let committed: unknown;
    const result = await projectSyncEventsForUser("user-1", { deps: deps({
      getEffectiveSettings: async () => ({ settings: { workbenchChanges: "off" } }),
      getLatestSyncCursor: async () => "99",
      commitConsumerCursor: (async (userId, consumer, cursor) => {
        committed = { userId, consumer, cursor };
        return {} as never;
      }) as AnalyserProjectorDeps["commitConsumerCursor"]
    }) });
    assert.deepEqual(result, { projected: 0, skipped: true });
    assert.deepEqual(committed, { userId: "user-1", consumer: ANALYSER_PROJECTOR_CONSUMER, cursor: "99" });
  });

  it("continues full batches and stops after a short batch", async () => {
    const pullCursors: unknown[] = [];
    const commits: unknown[] = [];
    let ingests = 0;
    const result = await projectSyncEventsForUser("user-1", {
      batchSize: 2,
      maxBatches: 5,
      deps: deps({
        pullSyncChanges: async (_userId, options) => {
          pullCursors.push(options?.cursor);
          return options?.cursor === "0"
            ? {
                consumer: ANALYSER_PROJECTOR_CONSUMER,
                cursor: "0",
                events: [event("1"), event("2")],
                nextCursor: "2"
              }
            : {
                consumer: ANALYSER_PROJECTOR_CONSUMER,
                cursor: "2",
                events: [event("3")],
                nextCursor: "3"
              };
        },
        ingestObservations: async () => {
          ingests += 1;
          return ingests === 1
            ? { ingested: 2, duplicates: 0, rejected: {} as Record<string, number> }
            : { ingested: 0, duplicates: 1, rejected: { workbench_change: 0 } };
        },
        commitConsumerCursor: (async (_userId, _consumer, cursor) => {
          commits.push(cursor);
          return {} as never;
        }) as AnalyserProjectorDeps["commitConsumerCursor"]
      })
    });
    assert.deepEqual(result, { projected: 2, duplicates: 1, rejected: 0, batches: 2 });
    assert.deepEqual(pullCursors, ["0", "2"]);
    assert.deepEqual(commits, ["2", "3"]);
  });
});
