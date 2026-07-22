import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ||= "http://wbs.test";
process.env.ANALYSER_SERVICE_URL ||= "http://analyser.test";
process.env.INTERNAL_API_KEY_ANALYSER ||= "analyser-test-key";

const { exportAnalyserRecord } = await import("../analyserExport.js");
const { InternalServiceError } = await import("../internalClients.js");
type AnalyserExportDependencies = import("../analyserExport.js").AnalyserExportDependencies;

const summaryId = "11111111-1111-4111-8111-111111111111";
const proposalId = "22222222-2222-4222-8222-222222222222";
const authContext = { accessToken: "caller-token" };

function summary(bodyMarkdown = "Weekly progress") {
  return {
    id: summaryId,
    title: "Weekly Focus",
    bodyMarkdown,
    evidenceRefs: [{
      service: "notes",
      resourceType: "note",
      resourceId: "note-evidence",
      pathSnapshot: "notes/evidence.md"
    }]
  };
}

function proposal(status: "open" | "approved" | "executed" = "approved") {
  return {
    id: proposalId,
    title: "Organize Artifacts",
    bodyMarkdown: "Move the durable reference.",
    evidenceRefs: [],
    status
  };
}

type FakePublication = {
  id: string;
  sourceKind: string;
  sourceId: string;
  targetKind: string;
  targetId: string;
  targetRef?: unknown;
  contentHash: string;
  provenance: string;
  createdAt: string;
};

function unexpected(): Promise<never> {
  return Promise.reject(new Error("Unexpected export dependency call"));
}

/** Mirrors the real analyser publications store's reserve/finalize/find semantics
 * (unique on sourceKind+sourceId+targetKind+contentHash; target_id "" until finalized)
 * closely enough to exercise the Core export orchestration's dedupe and race handling. */
function fakePublicationsStore() {
  const rows: FakePublication[] = [];
  let nextId = 1;
  const keyOf = (row: Pick<FakePublication, "sourceKind" | "sourceId" | "targetKind" | "contentHash">): string =>
    `${row.sourceKind}|${row.sourceId}|${row.targetKind}|${row.contentHash}`;

  return {
    rows,
    reservePublication: async (_token: string, payload: unknown) => {
      const input = payload as Pick<FakePublication, "sourceKind" | "sourceId" | "targetKind" | "contentHash" | "provenance">;
      const existing = rows.find((row) => keyOf(row) === keyOf(input));
      if (existing) return { publication: existing, reserved: false };
      const created: FakePublication = {
        id: `publication-${nextId++}`,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        targetKind: input.targetKind,
        targetId: "",
        contentHash: input.contentHash,
        provenance: input.provenance,
        createdAt: "2026-07-20T00:00:00.000Z"
      };
      rows.push(created);
      return { publication: created, reserved: true };
    },
    finalizePublication: async (_token: string, id: string, payload: unknown) => {
      const input = payload as { targetId: string; targetRef?: unknown };
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.targetId !== "") throw new Error("cannot finalize");
      row.targetId = input.targetId;
      row.targetRef = input.targetRef;
      return row;
    },
    findPublication: async (_token: string, query: unknown) => {
      const input = query as Pick<FakePublication, "sourceKind" | "sourceId" | "targetKind" | "contentHash">;
      const found = rows.find((row) => keyOf(row) === keyOf(input));
      return { publication: found ?? null };
    }
  };
}

function fakeArtifactExportDependencies() {
  const store = fakePublicationsStore();
  const artifactPayloads: Array<Record<string, unknown>> = [];
  const deps = {
    analyserClient: {
      getSummary: async () => summary(),
      getProposal: unexpected,
      ...store
    },
    notesClient: { create: unexpected },
    artifactsClient: {
      createNote: async (_token: string, payload: unknown) => {
        const artifactPayload = payload as Record<string, unknown>;
        artifactPayloads.push(artifactPayload);
        return { id: `artifact-export-${artifactPayloads.length}`, path: artifactPayload.path };
      }
    }
  } as AnalyserExportDependencies;
  return { store, artifactPayloads, deps };
}

describe("Core Analyser export orchestration", () => {
  it("deduplicates an identical second Note export and records UI provenance with the target ref", async () => {
    const store = fakePublicationsStore();
    let noteCreates = 0;
    let notePayload: Record<string, unknown> | undefined;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(),
        getProposal: unexpected,
        ...store
      },
      notesClient: {
        create: async (_token: string, payload: unknown) => {
          noteCreates += 1;
          notePayload = payload as Record<string, unknown>;
          return { id: "note-export-1" };
        }
      },
      artifactsClient: { createNote: unexpected }
    } as AnalyserExportDependencies;

    const input = { sourceKind: "summary", sourceId: summaryId, targetKind: "note", projectId: "project-1" } as const;
    const first = await exportAnalyserRecord(authContext, input, deps);
    const second = await exportAnalyserRecord(authContext, input, deps);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.target.id, "note-export-1");
    assert.equal(noteCreates, 1);
    assert.equal(store.rows.length, 1);
    assert.equal(notePayload?.title, "Weekly Focus");
    assert.equal(notePayload?.projectId, "project-1");
    assert.match(String(notePayload?.content), /^# Weekly Focus\n\nWeekly progress/);
    assert.match(String(notePayload?.content), /- notes\/note\/note-evidence \(notes\/evidence\.md\)/);
    assert.match(String(notePayload?.content), new RegExp(`Exported from Analyser summary ${summaryId}$`));
    assert.equal(store.rows[0]?.provenance, "ui");
    assert.deepEqual(store.rows[0]?.targetRef, {
      service: "notes",
      resourceType: "note",
      resourceId: "note-export-1"
    });
  });

  it("rejects an open proposal before publication lookup or target creation", async () => {
    let downstreamCalls = 0;
    const fail = async (): Promise<never> => {
      downstreamCalls += 1;
      throw new Error("must not be called");
    };
    const deps = {
      analyserClient: {
        getSummary: fail,
        getProposal: async () => proposal("open"),
        findPublication: fail,
        reservePublication: fail,
        finalizePublication: fail
      },
      notesClient: { create: fail },
      artifactsClient: { createNote: fail }
    } as AnalyserExportDependencies;

    await assert.rejects(
      exportAnalyserRecord(authContext, {
        sourceKind: "proposal",
        sourceId: proposalId,
        targetKind: "note",
        projectId: "project-1"
      }, deps),
      (error: unknown) => error instanceof InternalServiceError
        && error.status === 409
        && error.body.includes("ANALYSER_PROPOSAL_NOT_DURABLE")
    );
    assert.equal(downstreamCalls, 0);
  });

  it("changes the publication content hash when the source body changes", async () => {
    let body = "First body";
    const store = fakePublicationsStore();
    let targetNumber = 0;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(body),
        getProposal: unexpected,
        ...store
      },
      notesClient: {
        create: async () => ({ id: `note-${++targetNumber}` })
      },
      artifactsClient: { createNote: unexpected }
    } as AnalyserExportDependencies;

    await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "note",
      projectId: "project-1"
    }, deps);
    body = "Second body";
    await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "note",
      projectId: "project-1"
    }, deps);

    assert.equal(store.rows.length, 2);
    const [first, second] = store.rows;
    assert.match(first?.contentHash ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(first?.contentHash, second?.contentHash);
  });

  it("applies the default Artifact markdown path and records it in targetRef", async () => {
    const store = fakePublicationsStore();
    let artifactPayload: Record<string, unknown> | undefined;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(),
        getProposal: unexpected,
        ...store
      },
      notesClient: { create: unexpected },
      artifactsClient: {
        createNote: async (_token: string, payload: unknown) => {
          artifactPayload = payload as Record<string, unknown>;
          return { id: "artifact-export-1", path: artifactPayload.path };
        }
      }
    } as AnalyserExportDependencies;

    const result = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-1"
    }, deps);

    assert.match(String(artifactPayload?.path), /^analyser\/exports\/\d{4}-\d{2}-\d{2}-weekly-focus\.md$/);
    assert.equal(artifactPayload?.projectId, "project-1");
    assert.equal(artifactPayload?.title, "Weekly Focus");
    assert.match(String(artifactPayload?.contentMarkdown), /## Evidence/);
    assert.equal(result.target.kind, "artifact");
    assert.deepEqual(store.rows[0]?.targetRef, {
      service: "artifacts",
      resourceType: "artifact_item",
      resourceId: "artifact-export-1",
      pathSnapshot: artifactPayload?.path
    });
  });

  it("creates distinct Artifacts for identical content exported to different Projects", async () => {
    const { store, artifactPayloads, deps } = fakeArtifactExportDependencies();
    const first = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-1",
      path: "reports/weekly.md"
    }, deps);
    const second = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-2",
      path: "reports/weekly.md"
    }, deps);

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.target.id, second.target.id);
    assert.equal(artifactPayloads.length, 2);
    assert.equal(store.rows.length, 2);
  });

  it("creates distinct Artifacts for identical content exported to different paths", async () => {
    const { store, artifactPayloads, deps } = fakeArtifactExportDependencies();
    const first = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-1",
      path: "reports/weekly.md"
    }, deps);
    const second = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-1",
      path: "archive/weekly.md"
    }, deps);

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.target.id, second.target.id);
    assert.equal(artifactPayloads.length, 2);
    assert.equal(store.rows.length, 2);
  });

  it("deduplicates identical Artifact exports to the same destination", async () => {
    const { store, artifactPayloads, deps } = fakeArtifactExportDependencies();
    const input = {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-1",
      path: "reports/weekly.md"
    } as const;
    const first = await exportAnalyserRecord(authContext, input, deps);
    const second = await exportAnalyserRecord(authContext, input, deps);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.target.id, first.target.id);
    assert.equal(artifactPayloads.length, 1);
    assert.equal(store.rows.length, 1);
  });

  it("deduplicates structurally equivalent Artifact paths", async () => {
    const { store, artifactPayloads, deps } = fakeArtifactExportDependencies();
    const first = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-1",
      path: " ./reports//weekly.md/ "
    }, deps);
    const second = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "artifact",
      projectId: "project-1",
      path: "\\reports\\weekly.md"
    }, deps);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.target.id, first.target.id);
    assert.equal(artifactPayloads.length, 1);
    assert.equal(artifactPayloads[0]?.path, "./reports//weekly.md/");
    assert.equal(store.rows.length, 1);
  });

  it("creates distinct Notes for identical content exported to different Projects", async () => {
    const store = fakePublicationsStore();
    let noteCreates = 0;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(),
        getProposal: unexpected,
        ...store
      },
      notesClient: {
        create: async () => ({ id: `note-${++noteCreates}` })
      },
      artifactsClient: { createNote: unexpected }
    } as AnalyserExportDependencies;

    const first = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "note",
      projectId: "project-1"
    }, deps);
    const second = await exportAnalyserRecord(authContext, {
      sourceKind: "summary",
      sourceId: summaryId,
      targetKind: "note",
      projectId: "project-2"
    }, deps);

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.target.id, second.target.id);
    assert.equal(noteCreates, 2);
    assert.equal(store.rows.length, 2);
  });

  it("does not create a duplicate target when two identical exports race concurrently", async () => {
    const store = fakePublicationsStore();
    let noteCreates = 0;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(),
        getProposal: unexpected,
        ...store
      },
      notesClient: {
        create: async () => {
          noteCreates += 1;
          // Simulate the winner's create taking a moment, during which the loser's
          // reserve call arrives and must NOT also create a Note.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { id: "note-race-winner" };
        }
      },
      artifactsClient: { createNote: unexpected }
    } as AnalyserExportDependencies;

    const input = { sourceKind: "summary", sourceId: summaryId, targetKind: "note", projectId: "project-1" } as const;
    const [first, second] = await Promise.all([
      exportAnalyserRecord(authContext, input, deps),
      exportAnalyserRecord(authContext, input, deps)
    ]);

    assert.equal(noteCreates, 1);
    assert.equal(store.rows.length, 1);
    const outcomes = [first, second].sort((a, b) => Number(b.created) - Number(a.created));
    assert.equal(outcomes[0]?.created, true);
    assert.equal(outcomes[1]?.created, false);
    assert.equal(outcomes[0]?.target.id, "note-race-winner");
    assert.equal(outcomes[1]?.target.id, "note-race-winner");
  });
});
