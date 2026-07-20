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

function publicationFrom(payload: Record<string, unknown>, id = "publication-1") {
  return {
    id,
    sourceKind: payload.sourceKind,
    sourceId: payload.sourceId,
    targetKind: payload.targetKind,
    targetId: payload.targetId,
    targetRef: payload.targetRef,
    contentHash: payload.contentHash,
    provenance: payload.provenance,
    createdAt: "2026-07-20T00:00:00.000Z"
  };
}

function unexpected(): Promise<never> {
  return Promise.reject(new Error("Unexpected export dependency call"));
}

describe("Core Analyser export orchestration", () => {
  it("deduplicates an identical second Note export and records UI provenance with the target ref", async () => {
    let existingPublication: ReturnType<typeof publicationFrom> | undefined;
    let noteCreates = 0;
    let publicationRecords = 0;
    let notePayload: Record<string, unknown> | undefined;
    let recordedPayload: Record<string, unknown> | undefined;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(),
        getProposal: unexpected,
        findPublication: async () => ({ publication: existingPublication ?? null }),
        recordPublication: async (_token: string, payload: unknown) => {
          publicationRecords += 1;
          recordedPayload = payload as Record<string, unknown>;
          existingPublication = publicationFrom(recordedPayload);
          return { publication: existingPublication, created: true };
        }
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
    assert.equal(publicationRecords, 1);
    assert.equal(notePayload?.title, "Weekly Focus");
    assert.equal(notePayload?.projectId, "project-1");
    assert.match(String(notePayload?.content), /^# Weekly Focus\n\nWeekly progress/);
    assert.match(String(notePayload?.content), /- notes\/note\/note-evidence \(notes\/evidence\.md\)/);
    assert.match(String(notePayload?.content), new RegExp(`Exported from Analyser summary ${summaryId}$`));
    assert.equal(recordedPayload?.provenance, "ui");
    assert.deepEqual(recordedPayload?.targetRef, {
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
        recordPublication: fail
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
    const contentHashes: string[] = [];
    let targetNumber = 0;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(body),
        getProposal: unexpected,
        findPublication: async (_token: string, query: unknown) => {
          contentHashes.push(String((query as { contentHash: string }).contentHash));
          return { publication: null };
        },
        recordPublication: async (_token: string, payload: unknown) => ({
          publication: publicationFrom(payload as Record<string, unknown>, `publication-${targetNumber}`),
          created: true
        })
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

    assert.equal(contentHashes.length, 2);
    assert.match(contentHashes[0] ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(contentHashes[0], contentHashes[1]);
  });

  it("applies the default Artifact markdown path and records it in targetRef", async () => {
    let artifactPayload: Record<string, unknown> | undefined;
    let recordedPayload: Record<string, unknown> | undefined;
    const deps = {
      analyserClient: {
        getSummary: async () => summary(),
        getProposal: unexpected,
        findPublication: async () => ({ publication: null }),
        recordPublication: async (_token: string, payload: unknown) => {
          recordedPayload = payload as Record<string, unknown>;
          return { publication: publicationFrom(recordedPayload), created: true };
        }
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
    assert.deepEqual(recordedPayload?.targetRef, {
      service: "artifacts",
      resourceType: "artifact_item",
      resourceId: "artifact-export-1",
      pathSnapshot: artifactPayload?.path
    });
  });
});
