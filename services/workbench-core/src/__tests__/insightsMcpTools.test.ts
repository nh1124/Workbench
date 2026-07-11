import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { z } from "zod";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ||= "http://wbs.test";
process.env.INSIGHTS_SERVICE_URL ||= "http://insights.test";
process.env.JWT_SECRET ||= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ||= "workbench-test";
process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test";
process.env.CORE_DB_USER ||= "workbench-test";
process.env.CORE_DB_PASSWORD ||= "workbench-test";
process.env.INTERNAL_API_KEY_NOTES ||= "test-internal-key";
process.env.INTERNAL_API_KEY_ARTIFACTS ||= "test-internal-key";
process.env.INTERNAL_API_KEY_TASKS ||= "test-internal-key";
process.env.INTERNAL_API_KEY_IMAGES ||= "test-internal-key";
process.env.INTERNAL_API_KEY_MINDMAPS ||= "test-internal-key";
process.env.INTERNAL_API_KEY_WBS ||= "test-internal-key";
process.env.INTERNAL_API_KEY_INSIGHTS ||= "test-internal-key";

const { registerInsightsTools } = await import("../mcp/registerInsightsTools.js");

type ToolDefinition = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
};

function captureTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const fakeServer = {
    registerTool(name: string, definition: ToolDefinition): void {
      tools.set(name, definition);
    }
  };
  registerInsightsTools(fakeServer as never, { accessToken: "unused" });
  return tools;
}

describe("Insights MCP contract", () => {
  it("registers the six dot-delimited Insights tools", () => {
    const tools = captureTools();
    assert.deepEqual([...tools.keys()], [
      "insights.machines.list",
      "insights.activity.query",
      "insights.summaries.list",
      "insights.summaries.get",
      "insights.derived.ingest",
      "insights.derived.list"
    ]);
    for (const [name, definition] of tools) {
      assert.match(name, /^insights(?:\.[a-z]+)+$/);
      assert.ok(definition.description?.trim(), `${name} must have an agent-facing description`);
      assert.equal(definition.description?.includes("\n"), false);
    }
  });

  it("validates dates, machine ids, limits, and derived payloads", () => {
    const tools = captureTools();
    const activity = z.object(tools.get("insights.activity.query")?.inputSchema ?? {});
    const summaries = z.object(tools.get("insights.summaries.list")?.inputSchema ?? {});
    const getSummary = z.object(tools.get("insights.summaries.get")?.inputSchema ?? {});
    const ingestDerived = z.object(tools.get("insights.derived.ingest")?.inputSchema ?? {});
    const machineId = "123e4567-e89b-42d3-a456-426614174000";

    assert.equal(activity.safeParse({ from: "2026-07-01", to: "2026-07-31", machineId }).success, true);
    assert.equal(activity.safeParse({ from: "2026-02-30", to: "2026-07-31" }).success, false);
    assert.equal(summaries.safeParse({ limit: 200, cursor: "opaque" }).success, true);
    assert.equal(summaries.safeParse({ limit: 201 }).success, false);
    assert.equal(getSummary.safeParse({ machineId, date: "2026-07-11" }).success, true);
    assert.equal(getSummary.safeParse({ machineId: "not-a-uuid", date: "2026-07-11" }).success, false);
    assert.equal(ingestDerived.safeParse({
      machineId,
      observedDate: "2026-07-11",
      kind: "focus_pattern",
      title: "Long focus block",
      contentMarkdown: "Observed locally.",
      payloadJson: { activeSeconds: 3600 }
    }).success, true);
    assert.equal(ingestDerived.safeParse({ observedDate: "2026-07-11", kind: "", title: "x", contentMarkdown: "" }).success, false);
  });

  it("keeps provisioning, configuration guard, and both MCP registrations wired", () => {
    const __filename = fileURLToPath(import.meta.url);
    const sourceRoot = path.resolve(path.dirname(__filename), "..");
    const adapter = readFileSync(path.join(sourceRoot, "mcp", "registerInsightsTools.ts"), "utf8");
    const httpServer = readFileSync(path.join(sourceRoot, "httpServer.ts"), "utf8");
    const stdioServer = readFileSync(path.join(sourceRoot, "mcpServer.ts"), "utf8");

    assert.match(adapter, /await ensureInsightsAccountProvisioned\(authContext\)/);
    assert.match(adapter, /throw new Error\("Insights service is not configured"\)/);
    assert.match(httpServer, /registerInsightsTools\(server, injectedContext\)/);
    assert.match(stdioServer, /registerInsightsTools\(server, ctx\)/);
  });
});
