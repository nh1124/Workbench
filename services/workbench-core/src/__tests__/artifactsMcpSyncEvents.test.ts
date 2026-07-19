import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ||= "http://wbs.test";
process.env.PROJECTS_SERVICE_URL ||= "http://projects.test";
process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const { registerArtifactsTools } = await import("../mcp/registerArtifactsTools.js");

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
}>;

function resultBody(result: Awaited<ReturnType<ToolHandler>>): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("Artifact MCP sync events", () => {
  it("records create, move/update, and delete envelopes without making recording authoritative", async () => {
    const handlers = new Map<string, ToolHandler>();
    const events: Array<{
      userId: string;
      domain: string;
      resourceId: string;
      action: string;
      payload: Record<string, unknown>;
      metadata: Record<string, unknown> | undefined;
    }> = [];
    let failRecording = false;
    let createCount = 0;

    const before = {
      id: "note-1",
      projectId: "project-1",
      kind: "note" as const,
      title: "Skill note",
      path: "skills/old.md",
      version: 1,
      contentMarkdown: "old"
    };
    const updated = {
      ...before,
      path: "skills/new.md",
      contentMarkdown: "new"
    };

    const fakeServer = {
      registerTool(name: string, _definition: unknown, handler: ToolHandler): void {
        handlers.set(name, handler);
      }
    };
    const fakeRunWithAuthContext = async <T>(
      _accessToken: string,
      operation: (context: { userId: string; username: string }) => Promise<T>
    ): Promise<T> => operation({ userId: "user-1", username: "owner" });

    registerArtifactsTools(fakeServer as never, {
      accessToken: "token",
      dependencies: {
        runWithAuthContext: fakeRunWithAuthContext,
        artifactsClient: {
          async createFolder() {
            createCount += 1;
            return {
              id: `folder-${createCount}`,
              projectId: "project-1",
              kind: "folder",
              path: `skills-${createCount}`
            };
          },
          async getItem() {
            return before;
          },
          async updateItem() {
            return updated;
          }
        },
        async listArtifactProjectIdsBestEffort() {
          return ["project-1"];
        },
        async maintainArtifactIndexBestEffort() {},
        async reconcileArtifactMutationBestEffort() {},
        async recordProjectContextInvalidationsBestEffort() {},
        async removeArtifactItemWithProjectCleanup() {
          return {
            rootArtifactItemId: "note-1",
            items: [{ item: before, links: [] }]
          };
        },
        async recordSyncEvent(userId, domain, resourceId, action, payload = {}, metadata) {
          if (failRecording) throw new Error("sync unavailable");
          events.push({ userId, domain, resourceId, action, payload, metadata });
          return {
            cursor: String(events.length),
            userId,
            domain,
            resourceId,
            action,
            version: 1,
            payload,
            ...metadata,
            createdAt: "2026-07-19T00:00:00.000Z"
          };
        }
      }
    });

    const createdResult = await handlers.get("artifacts.folder.create")?.({ path: "skills" });
    assert.ok(createdResult);
    assert.deepEqual(resultBody(createdResult), {
      id: "folder-1", projectId: "project-1", kind: "folder", path: "skills-1"
    });

    const updatedResult = await handlers.get("artifacts.item.update")?.({
      id: "note-1", path: "skills/new.md", contentMarkdown: "new"
    });
    assert.ok(updatedResult);
    assert.deepEqual(resultBody(updatedResult), updated);

    const deletedResult = await handlers.get("artifacts.item.delete")?.({ id: "note-1" });
    assert.ok(deletedResult);
    assert.deepEqual(resultBody(deletedResult), { status: "ok" });

    assert.equal(events.length, 3);
    assert.deepEqual(events[0], {
      userId: "user-1",
      domain: "artifacts",
      resourceId: "folder-1",
      action: "create",
      payload: {
        source: "core-mcp",
        resource: { id: "folder-1", projectId: "project-1", kind: "folder", path: "skills-1" }
      },
      metadata: { projectId: "project-1", resourceType: "folder", path: "skills-1" }
    });
    assert.deepEqual(events[1]?.metadata, {
      projectId: "project-1",
      resourceType: "note",
      path: "skills/new.md",
      previousPath: "skills/old.md"
    });
    assert.deepEqual((events[1]?.payload.resource as Record<string, unknown>).contentMarkdown, "new");
    assert.deepEqual(events[2], {
      userId: "user-1",
      domain: "artifacts",
      resourceId: "note-1",
      action: "delete",
      payload: { source: "core-mcp", deleted: true },
      metadata: { projectId: "project-1", resourceType: "note", path: "skills/old.md" }
    });

    failRecording = true;
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const unaffected = await handlers.get("artifacts.folder.create")?.({ path: "another" });
      assert.ok(unaffected);
      assert.deepEqual(resultBody(unaffected), {
        id: "folder-2", projectId: "project-1", kind: "folder", path: "skills-2"
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(events.length, 3);
  });
});
