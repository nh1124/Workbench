import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ||= "http://wbs.test";
process.env.PROJECTS_SERVICE_URL ||= "http://projects.test";

const { artifactsClient } = await import("../internalClients.js");
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

after(() => {
  globalThis.fetch = originalFetch;
});

describe("internal artifact clients", () => {
  it("live-resolves single artifact item project names and always keeps the projectName key", async () => {
    const projectLookups: string[] = [];

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/item-live") {
        return jsonResponse({ id: "item-live", projectId: "project-a", projectName: "stale name" });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/item-missing") {
        return jsonResponse({ id: "item-missing", projectId: "project-missing", projectName: "stale missing" });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/item-no-project") {
        return jsonResponse({ id: "item-no-project", title: "No project" });
      }
      if (url.origin === "http://projects.test" && url.pathname.startsWith("/projects/")) {
        const projectId = decodeURIComponent(url.pathname.slice("/projects/".length));
        projectLookups.push(projectId);
        if (projectId === "project-a") return jsonResponse({ id: projectId, name: "Project A" });
        return jsonResponse({ message: "missing" }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const live = await artifactsClient.getItem("token", "item-live") as Record<string, unknown>;
    const missing = await artifactsClient.getItem("token", "item-missing") as Record<string, unknown>;
    const noProject = await artifactsClient.getItem("token", "item-no-project") as Record<string, unknown>;

    assert.equal(live.projectName, "Project A");
    assert.equal(missing.projectName, null);
    assert.equal(noProject.projectName, null);
    assert.equal(Object.hasOwn(live, "projectName"), true);
    assert.equal(Object.hasOwn(missing, "projectName"), true);
    assert.equal(Object.hasOwn(noProject, "projectName"), true);
    assert.deepEqual(projectLookups, ["project-a", "project-missing"]);
  });

  it("applies single artifact item project name resolution to mutation responses", async () => {
    const projectLookups: string[] = [];

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/notes") {
        return jsonResponse({ id: "created-note", projectId: "project-a", projectName: "stale name" }, 201);
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/upload") {
        return jsonResponse({ id: "uploaded-file", projectId: "project-missing", projectName: "stale missing" }, 201);
      }
      if (url.origin === "http://projects.test" && url.pathname.startsWith("/projects/")) {
        const projectId = decodeURIComponent(url.pathname.slice("/projects/".length));
        projectLookups.push(projectId);
        if (projectId === "project-a") return jsonResponse({ id: projectId, name: "Project A" });
        return jsonResponse({ message: "missing" }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const created = await artifactsClient.createNote("token", { title: "Note" }) as Record<string, unknown>;
    const uploaded = await artifactsClient.uploadFile("token", {
      filename: "file.txt",
      contentBase64: Buffer.from("file", "utf8").toString("base64")
    }) as Record<string, unknown>;

    assert.equal(created.projectName, "Project A");
    assert.equal(uploaded.projectName, null);
    assert.deepEqual(projectLookups, ["project-a", "project-missing"]);
  });

  it("live-resolves tree project names with one Projects lookup per distinct projectId", async () => {
    const projectLookups = new Map<string, number>();

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree") {
        return jsonResponse([
          { id: "item-1", projectId: "project-a", projectName: "project-a" },
          { id: "item-2", projectId: "project-a", projectName: "stale name" },
          { id: "item-3", projectId: "project-missing", projectName: "project-missing" }
        ]);
      }
      if (url.origin === "http://projects.test" && url.pathname.startsWith("/projects/")) {
        const projectId = decodeURIComponent(url.pathname.slice("/projects/".length));
        projectLookups.set(projectId, (projectLookups.get(projectId) ?? 0) + 1);
        if (projectId === "project-a") {
          return jsonResponse({ id: projectId, name: "Project A" });
        }
        return jsonResponse({ message: "missing" }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await artifactsClient.tree("token") as Array<Record<string, unknown>>;

    assert.deepEqual(result.map((item) => item.projectName), ["Project A", "Project A", null]);
    assert.equal(projectLookups.get("project-a"), 1);
    assert.equal(projectLookups.get("project-missing"), 1);
  });

  it("live-resolves tree list project names and removes unresolved UUID fallbacks", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree/list") {
        return jsonResponse([
          {
            id: "item-1",
            projectId: "123e4567-e89b-12d3-a456-426614174000",
            projectName: "123e4567-e89b-12d3-a456-426614174000"
          }
        ]);
      }
      if (url.origin === "http://projects.test" && url.pathname.startsWith("/projects/")) {
        return jsonResponse({ message: "missing" }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await artifactsClient.treeList("token", {}) as Array<Record<string, unknown>>;

    assert.equal(result[0]?.projectName, null);
  });

  it("calls the Artifact maintenance flag, resolve, and queue routes", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname.endsWith("/resolve")) return jsonResponse({ status: "resolved" });
      if (url.pathname === "/maintenance/artifact-queue") return jsonResponse({ items: [], totals: { byReason: {} } });
      return jsonResponse({ status: "open" });
    };

    await artifactsClient.flagArtifactItemMaintenance("token", "item/1", {
      reason: "conflict",
      flaggedBy: "actor"
    });
    await artifactsClient.resolveArtifactItemMaintenance("token", "item/1", {
      note: "fixed",
      resolvedBy: "actor"
    });
    await artifactsClient.listArtifactMaintenanceQueue("token", {
      projectId: "project-1",
      reason: "manual",
      cursor: "cursor-1",
      limit: 5
    });

    assert.equal(requests[0]?.url.pathname, "/artifacts/items/item%2F1/maintenance-flag");
    assert.equal(requests[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      reason: "conflict",
      flaggedBy: "actor"
    });
    assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer token");
    assert.equal(new Headers(requests[0]?.init?.headers).get("x-workbench-core-mutation"), "1");
    assert.equal(requests[1]?.url.pathname, "/artifacts/items/item%2F1/maintenance-flag/resolve");
    assert.equal(requests[2]?.url.pathname, "/maintenance/artifact-queue");
    assert.deepEqual(Object.fromEntries(requests[2]?.url.searchParams ?? []), {
      projectId: "project-1",
      reason: "manual",
      cursor: "cursor-1",
      limit: "5"
    });
  });
});
