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
});
