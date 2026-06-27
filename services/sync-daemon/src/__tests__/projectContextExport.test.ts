import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  exportProjectContext,
  ProjectContextExportError,
  PROJECT_CONTEXT_EXPORT_CODES,
  type ProjectContextExportSnapshot
} from "../projectContextExport.js";

const PROJECT_ID = "project/alpha";
const EXPORT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-06-23T12:34:56.000Z";

function fixture(): ProjectContextExportSnapshot {
  return {
    schemaVersion: 1,
    packageType: "workbench.project-context-export",
    generatedAt: "2026-06-23T00:00:00.000Z",
    complete: true,
    project: {
      id: PROJECT_ID,
      name: "Alpha",
      description: "Project description",
      status: "active",
      updatedAt: "2026-06-23T00:00:00.000Z",
      ownerAccountId: "must-not-leak"
    },
    brief: {
      projectId: PROJECT_ID,
      contentMarkdown: "Brief body",
      version: 7,
      updatedAt: "2026-06-23T00:00:00.000Z",
      owner_account_id: "must-not-leak"
    },
    memories: [
      {
        id: "memory-b",
        projectId: PROJECT_ID,
        kind: "fact",
        bodyMarkdown: "B",
        authority: "agent_observed",
        status: "active",
        createdAt: "2026-06-23T02:00:00.000Z",
        updatedAt: "2026-06-23T02:00:00.000Z"
      },
      {
        id: "memory-a",
        projectId: PROJECT_ID,
        kind: "decision",
        bodyMarkdown: "A",
        authority: "user_confirmed",
        status: "active",
        createdAt: "2026-06-23T01:00:00.000Z",
        updatedAt: "2026-06-23T01:00:00.000Z"
      }
    ],
    relations: [{
      id: "relation-1",
      sourceProjectId: PROJECT_ID,
      targetProjectId: "project-beta",
      relationType: "reference",
      updatedAt: "2026-06-23T00:00:00.000Z"
    }],
    links: [{
      id: "link-1",
      projectId: PROJECT_ID,
      targetService: "notes",
      targetResourceType: "note",
      targetResourceId: "note-1",
      relationType: "reference",
      linkedAt: "2026-06-23T00:00:00.000Z"
    }],
    indexEntries: [{
      id: "index-1",
      projectId: PROJECT_ID,
      sourceService: "artifacts",
      resourceType: "artifact_item",
      resourceId: "artifact-1",
      associationKind: "primary",
      path: "alpha.md",
      title: "Alpha",
      summaryText: "",
      summarySource: "generated",
      sourceUpdatedAt: "2026-06-23T00:00:00.000Z",
      indexedAt: "2026-06-23T00:00:00.000Z"
    }],
    generatedSummary: {
      id: "summary-1",
      projectId: PROJECT_ID,
      summaryText: "Summary",
      source: "generated",
      updatedAt: "2026-06-23T00:00:00.000Z",
      ownerAccountId: "must-not-leak"
    },
    counts: {
      memories: 2,
      relations: 1,
      links: 1,
      indexEntries: 1
    }
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function jsonlIds(text: string): string[] {
  assert.ok(text.endsWith("\n"));
  return text.trimEnd().split("\n").filter(Boolean).map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    return String(record.id);
  });
}

describe("Project context export writer", () => {
  it("fetches a fresh live Core export and writes a deterministic local package", async () => {
    const root = await mkdtemp(join(tmpdir(), "workbench-project-context-export-"));
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers)
      });
      return new Response(JSON.stringify(fixture()), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    try {
      const result = await exportProjectContext(
        { coreUrl: "http://core.test", syncRoot: root },
        { localClientId: "client-1", localClientToken: "token-1" },
        PROJECT_ID,
        {
          exportId: EXPORT_ID,
          now: () => new Date(CREATED_AT),
          fetchImpl
        }
      );

      assert.equal(requests[0]?.url, "http://core.test/api/sync/projects/project%2Falpha/context-export");
      assert.equal(requests[0]?.headers.get("x-workbench-local-client-id"), "client-1");
      assert.equal(requests[0]?.headers.get("x-workbench-local-client-token"), "token-1");
      assert.deepEqual(result.snapshot, `snapshots/${EXPORT_ID}`);

      const projectSegment = Buffer.from(PROJECT_ID, "utf8").toString("base64url");
      const projectRoot = join(root, ".workbench", "project-context", projectSegment);
      const snapshotRoot = join(projectRoot, "snapshots", EXPORT_ID);
      const manifest = await readJson(join(snapshotRoot, "manifest.json"));
      const current = await readJson(join(projectRoot, "current.json"));
      assert.equal(manifest.projectId, PROJECT_ID);
      assert.equal(manifest.importPolicy, "unsupported");
      assert.equal((manifest.files as Record<string, Record<string, unknown>>)["index.jsonl"].authoritative, false);
      assert.equal((manifest.files as Record<string, Record<string, unknown>>)["index.jsonl"].importPolicy, "ignore");
      assert.equal(current.exportId, EXPORT_ID);
      assert.equal(current.snapshot, `snapshots/${EXPORT_ID}`);

      const memoryText = await readFile(join(snapshotRoot, "memory.jsonl"), "utf8");
      assert.deepEqual(jsonlIds(memoryText), ["memory-a", "memory-b"]);
      const summaryText = await readFile(join(snapshotRoot, "summary.json"), "utf8");
      const projectMarkdown = await readFile(join(snapshotRoot, "PROJECT.md"), "utf8");
      assert.match(projectMarkdown, /# Alpha/);
      assert.equal(summaryText.includes("ownerAccountId"), false);
      assert.equal((await readFile(join(snapshotRoot, "PROJECT.md"), "utf8")).includes("must-not-leak"), false);
      assert.ok(summaryText.endsWith("\n"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards Core export limits without writing a local package", async () => {
    const root = await mkdtemp(join(tmpdir(), "workbench-project-context-export-limit-"));
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      code: PROJECT_CONTEXT_EXPORT_CODES.limitExceeded,
      message: "too large"
    }), {
      status: 413,
      headers: { "Content-Type": "application/json" }
    });
    try {
      await assert.rejects(
        () => exportProjectContext(
          { coreUrl: "http://core.test", syncRoot: root },
          { localClientId: "client-1", localClientToken: "token-1" },
          PROJECT_ID,
          { exportId: EXPORT_ID, fetchImpl }
        ),
        (error: unknown) => error instanceof ProjectContextExportError
          && error.code === PROJECT_CONTEXT_EXPORT_CODES.limitExceeded
          && error.status === 413
      );
      await assert.rejects(readFile(join(root, ".workbench", "project-context")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects cross-Project export rows before writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "workbench-project-context-export-cross-project-"));
    const badFixture = fixture();
    badFixture.memories = [{ ...badFixture.memories[0], projectId: "other-project" }];
    badFixture.counts = { ...badFixture.counts, memories: 1 };
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(badFixture), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    try {
      await assert.rejects(
        () => exportProjectContext(
          { coreUrl: "http://core.test", syncRoot: root },
          { localClientId: "client-1", localClientToken: "token-1" },
          PROJECT_ID,
          { exportId: EXPORT_ID, fetchImpl }
        ),
        (error: unknown) => error instanceof ProjectContextExportError
          && error.code === PROJECT_CONTEXT_EXPORT_CODES.unavailable
          && error.status === 503
      );
      await assert.rejects(readFile(join(root, ".workbench", "project-context")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
