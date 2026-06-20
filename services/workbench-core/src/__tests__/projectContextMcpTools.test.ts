import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.PROJECTS_SERVICE_URL ||= "http://projects.test";
process.env.JWT_SECRET ||= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ||= "workbench-test";
process.env.JWT_EXPIRY_SECONDS ||= "3600";
process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test";
process.env.CORE_DB_USER ||= "workbench-test";
process.env.CORE_DB_PASSWORD ||= "workbench-test";

const [{ registerProjectContextTools }, { registerArtifactsTools }] = await Promise.all([
  import("../mcp/registerProjectContextTools.js"),
  import("../mcp/registerArtifactsTools.js")
]);

describe("Project context MCP contract", () => {
  it("registers every frozen Project and Artifact membership tool", () => {
    const names = new Set<string>();
    const fakeServer = {
      registerTool(name: string): void {
        names.add(name);
      }
    };

    registerProjectContextTools(fakeServer as never, { accessToken: "unused" });
    registerArtifactsTools(fakeServer as never, { accessToken: "unused" });

    const expected = [
      "projects.context.get",
      "projects.brief.get",
      "projects.brief.update",
      "projects.memory.list",
      "projects.memory.append",
      "projects.memory.update",
      "projects.memory.archive",
      "projects.index.search",
      "projects.index.rebuild",
      "artifacts.item.projects.list",
      "artifacts.item.projects.link",
      "artifacts.item.projects.unlink",
      "projects.delete.preview",
      "projects.relations.list",
      "projects.relations.add",
      "projects.relations.update",
      "projects.relations.remove",
      "projects.links.list",
      "projects.links.add",
      "projects.links.remove"
    ];

    for (const name of expected) assert.equal(names.has(name), true, `missing MCP tool ${name}`);
  });
});
