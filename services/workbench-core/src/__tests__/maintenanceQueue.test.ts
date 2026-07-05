import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { z } from "zod";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ||= "http://wbs.test";
process.env.PROJECTS_SERVICE_URL ||= "http://projects.test";
process.env.INTERNAL_API_KEY_NOTES ||= "notes-test-key";
process.env.INTERNAL_API_KEY_ARTIFACTS ||= "artifacts-test-key";
process.env.INTERNAL_API_KEY_TASKS ||= "tasks-test-key";
process.env.INTERNAL_API_KEY_IMAGES ||= "images-test-key";
process.env.INTERNAL_API_KEY_MINDMAPS ||= "mindmaps-test-key";
process.env.INTERNAL_API_KEY_WBS ||= "wbs-test-key";
process.env.JWT_SECRET ||= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ||= "workbench-test";
process.env.JWT_EXPIRY_SECONDS ||= "3600";
process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const [
  { aggregateMaintenanceQueue },
  { registerMaintenanceTools },
  { registerProjectContextTools },
  { registerNotesTools },
  { registerProjectsTools },
  { registerArtifactsTools },
  { registerTasksTools },
  { registerDeepResearchTools },
  { registerImageTools },
  { registerMindmapTools },
  { registerWbsTools }
] = await Promise.all([
  import("../maintenanceQueue.js"),
  import("../mcp/registerMaintenanceTools.js"),
  import("../mcp/registerProjectContextTools.js"),
  import("../mcp/registerNotesTools.js"),
  import("../mcp/registerProjectsTools.js"),
  import("../mcp/registerArtifactsTools.js"),
  import("../mcp/registerTasksTools.js"),
  import("../mcp/registerDeepResearchTools.js"),
  import("../mcp/registerImageTools.js"),
  import("../mcp/registerMindmapTools.js"),
  import("../mcp/registerWbsTools.js")
]);

type Kind = "memory" | "note" | "brief" | "index_drift";
type Page = {
  items: unknown[];
  nextCursor?: string;
  totals: { byReason: Record<string, number> };
};

let server: Server | undefined;

function item(kind: Kind, id: string, updatedAt: string, reasons: string[] = ["raw"]): Record<string, unknown> {
  return {
    id: `${kind}:${id}`,
    kind,
    projectId: "project-1",
    projectName: "Project",
    resourceId: id,
    title: id,
    excerpt: id,
    reasons,
    updatedAt,
    suggestedActions: ["confirm"]
  };
}

function emptyPage(totals: Record<string, number> = {}): Page {
  return { items: [], totals: { byReason: totals } };
}

function makeSources(pages: Record<Kind, Record<string, Page>>) {
  const calls: Array<{ kind: Kind; options: Record<string, unknown> }> = [];
  const sources = Object.fromEntries((["memory", "note", "brief", "index_drift"] as Kind[]).map((kind) => [
    kind,
    async (_token: string, options: { cursor?: string } = {}) => {
      calls.push({ kind, options: { ...options } });
      return pages[kind][options.cursor ?? "start"] ?? emptyPage();
    }
  ])) as Record<Kind, (token: string, options?: Record<string, unknown>) => Promise<unknown>>;
  return { calls, sources };
}

describe("Maintenance queue facade", () => {
  after(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  });

  it("rejects unauthenticated HTTP reads", async () => {
    const { app } = await import("../httpServer.js");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/maintenance/queue`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "Missing bearer token" });
  });

  it("merges source pages by updatedAt, sums totals, and resumes with a compound cursor", async () => {
    const { sources } = makeSources({
      memory: {
        start: { items: [item("memory", "memory-new", "2026-07-03T00:00:00.000Z")], nextCursor: "memory-2", totals: { byReason: { raw: 1 } } },
        "memory-2": { items: [item("memory", "memory-old", "2026-07-01T00:00:00.000Z", ["unconfirmed"])], totals: { byReason: { raw: 1 } } }
      },
      note: {
        start: { items: [item("note", "note-new", "2026-07-04T00:00:00.000Z", ["expired"])], totals: { byReason: { expired: 2 } } }
      },
      brief: {
        start: { items: [item("brief", "brief-mid", "2026-07-02T00:00:00.000Z", ["brief_unmaintained"])], totals: { byReason: { brief_unmaintained: 3 } } }
      },
      index_drift: {
        start: emptyPage({ source_changed: 4 })
      }
    });

    const first = await aggregateMaintenanceQueue("token", { limit: 3 }, sources);
    assert.deepEqual(first.items.map((entry) => entry.resourceId), ["note-new", "memory-new", "brief-mid"]);
    assert.deepEqual(first.totals.byReason, { raw: 1, expired: 2, brief_unmaintained: 3, source_changed: 4 });
    assert.ok(first.nextCursor);

    const second = await aggregateMaintenanceQueue("token", { limit: 3, cursor: first.nextCursor }, sources);
    assert.deepEqual(second.items.map((entry) => entry.resourceId), ["memory-old"]);
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(second.totals.byReason, { raw: 1, expired: 2, brief_unmaintained: 3, source_changed: 4 });
  });

  it("passes kind filters and wrapped source cursors through to the selected service", async () => {
    const { calls, sources } = makeSources({
      memory: { start: emptyPage() },
      note: {
        start: { items: [item("note", "note-1", "2026-07-04T00:00:00.000Z", ["expired"])], nextCursor: "note-2", totals: { byReason: { expired: 1 } } },
        "note-2": { items: [item("note", "note-2", "2026-07-03T00:00:00.000Z", ["expired"])], totals: { byReason: { expired: 1 } } }
      },
      brief: { start: emptyPage() },
      index_drift: { start: emptyPage() }
    });

    const first = await aggregateMaintenanceQueue("token", {
      kind: "note",
      reason: "expired",
      projectId: "project-1",
      limit: 1
    }, sources);
    assert.deepEqual(first.items.map((entry) => entry.resourceId), ["note-1"]);
    assert.ok(first.nextCursor);
    assert.deepEqual(calls.map((call) => call.kind), ["note"]);
    assert.deepEqual(calls[0]?.options, { projectId: "project-1", reason: "expired", cursor: undefined, limit: 1 });

    const second = await aggregateMaintenanceQueue("token", {
      kind: "note",
      reason: "expired",
      projectId: "project-1",
      cursor: first.nextCursor,
      limit: 1
    }, sources);
    assert.deepEqual(second.items.map((entry) => entry.resourceId), ["note-2"]);
    assert.equal(calls.at(-1)?.kind, "note");
    assert.equal(calls.at(-1)?.options.cursor, "note-2");
  });

  it("does not call sources that cannot produce the requested reason", async () => {
    const { calls, sources } = makeSources({
      memory: { start: emptyPage() },
      note: { start: emptyPage() },
      brief: { start: emptyPage() },
      index_drift: {
        start: { items: [item("index_drift", "index-1", "2026-07-05T00:00:00.000Z", ["source_changed"])], totals: { byReason: { source_changed: 1 } } }
      }
    });

    const result = await aggregateMaintenanceQueue("token", { reason: "source_changed" }, sources);
    assert.deepEqual(result.items.map((entry) => entry.resourceId), ["index-1"]);
    assert.deepEqual(calls.map((call) => call.kind), ["index_drift"]);
  });
});

describe("Maintenance MCP contract", () => {
  function captureTools(register: (server: never, ctx: { accessToken: string }) => void) {
    const tools = new Map<string, { inputSchema?: z.ZodRawShape; description?: string }>();
    const fakeServer = {
      registerTool(name: string, definition: { inputSchema?: z.ZodRawShape; description?: string }): void {
        tools.set(name, definition);
      }
    };
    register(fakeServer as never, { accessToken: "unused" });
    return tools;
  }

  it("registers maintenance.queue.list with the frozen read schema", () => {
    const tools = captureTools(registerMaintenanceTools);
    const definition = tools.get("maintenance.queue.list");
    assert.ok(definition);
    const schema = z.object(definition.inputSchema ?? {});
    assert.equal(schema.safeParse({ kind: "memory", reason: "raw", projectId: "project-1", cursor: "cursor", limit: 20 }).success, true);
    assert.equal(schema.safeParse({ kind: "task" }).success, false);
    assert.equal(schema.safeParse({ reason: "source_changed" }).success, true);
    assert.equal(schema.safeParse({ reason: "unused" }).success, false);
  });

  it("allows MCP capture lifecycle only as raw or triaged", () => {
    const projectTools = captureTools(registerProjectContextTools);
    const memoryAppend = z.object(projectTools.get("projects.memory.append")?.inputSchema ?? {});
    const baseMemory = { projectId: "project-1", kind: "observation", bodyMarkdown: "Observed fact" };
    assert.equal(memoryAppend.safeParse({ ...baseMemory, lifecycleState: "raw" }).success, true);
    assert.equal(memoryAppend.safeParse({ ...baseMemory, lifecycleState: "triaged" }).success, true);
    assert.equal(memoryAppend.safeParse({ ...baseMemory, lifecycleState: "curated" }).success, false);
    assert.equal(memoryAppend.safeParse({ ...baseMemory, lifecycleState: "verified" }).success, false);

    const noteTools = captureTools(registerNotesTools);
    const noteCreate = z.object(noteTools.get("notes.create")?.inputSchema ?? {});
    const baseNote = { title: "Note", projectId: "project-1" };
    assert.equal(noteCreate.safeParse({ ...baseNote, lifecycleState: "raw" }).success, true);
    assert.equal(noteCreate.safeParse({ ...baseNote, lifecycleState: "triaged" }).success, true);
    assert.equal(noteCreate.safeParse({ ...baseNote, lifecycleState: "verified" }).success, false);
  });

  it("does not expose confirm or snooze MCP tools", () => {
    const names = new Set<string>();
    const fakeServer = {
      registerTool(name: string): void {
        names.add(name);
      }
    };
    const ctx = { accessToken: "unused" };
    registerNotesTools(fakeServer as never, ctx);
    registerArtifactsTools(fakeServer as never, ctx);
    registerTasksTools(fakeServer as never, ctx);
    registerProjectsTools(fakeServer as never, ctx);
    registerProjectContextTools(fakeServer as never, ctx);
    registerMaintenanceTools(fakeServer as never, ctx);
    registerDeepResearchTools(fakeServer as never, ctx);
    registerImageTools(fakeServer as never, ctx);
    registerMindmapTools(fakeServer as never, ctx);
    registerWbsTools(fakeServer as never, ctx);

    assert.equal(names.has("maintenance.queue.list"), true);
    for (const name of names) {
      assert.equal(/\b(confirm|snooze)\b/i.test(name), false, `${name} must not be exposed yet`);
    }
  });
});
