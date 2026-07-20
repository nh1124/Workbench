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
process.env.ANALYSER_SERVICE_URL ||= "http://analyser.test";
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
process.env.INTERNAL_API_KEY_ANALYSER ||= "test-internal-key";

const { registerAnalyserTools } = await import("../mcp/registerAnalyserTools.js");

const FROZEN_TOOL_NAMES = [
  "analyser.status.get",
  "analyser.settings.get",
  "analyser.observations.list",
  "analyser.observations.pull",
  "analyser.routines.list",
  "analyser.routines.claim",
  "analyser.routines.heartbeat",
  "analyser.routines.complete",
  "analyser.routines.fail",
  "analyser.summaries.list",
  "analyser.summaries.get",
  "analyser.summaries.upsert",
  "analyser.proposals.list",
  "analyser.proposals.get",
  "analyser.proposals.create",
  "analyser.proposals.update",
  "analyser.operations.record",
  "analyser.publications.record"
] as const;

const READ_TOOL_NAMES = new Set([
  "analyser.status.get",
  "analyser.settings.get",
  "analyser.observations.list",
  "analyser.routines.list",
  "analyser.summaries.list",
  "analyser.summaries.get",
  "analyser.proposals.list",
  "analyser.proposals.get"
]);

const IDEMPOTENT_WRITE_TOOL_NAMES = new Set([
  "analyser.routines.heartbeat",
  "analyser.summaries.upsert",
  "analyser.operations.record",
  "analyser.publications.record"
]);

type ToolDefinition = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodTypeAny | z.ZodRawShape;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

type ToolResult = { content: Array<{ type: "text"; text: string }> };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;
type CapturedTool = { definition: ToolDefinition; handler: ToolHandler };

function captureTools(dependencies?: Record<string, unknown>): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const fakeServer = {
    registerTool(name: string, definition: ToolDefinition, handler: ToolHandler): void {
      tools.set(name, { definition, handler });
    }
  };
  registerAnalyserTools(fakeServer as never, {
    accessToken: "test-token",
    dependencies
  } as never);
  return tools;
}

function schemaFor(tools: Map<string, CapturedTool>, name: string): z.ZodTypeAny {
  const schema = tools.get(name)?.definition.inputSchema;
  assert.ok(schema instanceof z.ZodType, `${name} must use a Zod schema`);
  return schema;
}

function testDependencies(analyserClient: Record<string, unknown>): Record<string, unknown> {
  return {
    analyserClient,
    requireAnalyserConfigured: () => undefined,
    ensureAnalyserAccountProvisioned: async () => undefined,
    runWithAuthContext: async <T>(
      _token: string,
      operation: (context: { userId: string; username: string }) => Promise<T>
    ): Promise<T> => operation({ userId: "user-1", username: "owner" })
  };
}

describe("Analyser MCP contract", () => {
  it("registers exactly the frozen 18-tool public surface", () => {
    const tools = captureTools();
    assert.deepEqual([...tools.keys()], [...FROZEN_TOOL_NAMES]);
    assert.equal(tools.size, 18);
    for (const [name, { definition }] of tools) {
      assert.match(name, /^analyser(?:\.[a-z_]+)+$/);
      assert.ok(definition.description?.trim(), `${name} must have an agent-facing description`);
      assert.equal(definition.description?.includes("\n"), false);
    }
  });

  it("marks only the eight pure reads as read-only and declares closed-world write safety", () => {
    const tools = captureTools();
    for (const [name, { definition }] of tools) {
      const annotations = definition.annotations;
      assert.ok(annotations, `${name} must have annotations`);
      assert.equal(annotations.openWorldHint, false, `${name} must be closed-world`);
      if (READ_TOOL_NAMES.has(name)) {
        assert.equal(annotations.readOnlyHint, true, `${name} must be read-only`);
        assert.notEqual(annotations.destructiveHint, true);
      } else {
        assert.notEqual(annotations.readOnlyHint, true, `${name} must be a write`);
        assert.equal(annotations.destructiveHint, false, `${name} must be non-destructive`);
        assert.equal(
          annotations.idempotentHint === true,
          IDEMPOTENT_WRITE_TOOL_NAMES.has(name),
          `${name} has the wrong idempotency annotation`
        );
      }
    }
  });

  it("uses the read-only effective settings endpoint", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const tools = captureTools(testDependencies({
      async getEffectiveSettings(...args: unknown[]) {
        calls.push({ method: "getEffectiveSettings", args });
        return { effective: true };
      },
      async getSettings(...args: unknown[]) {
        calls.push({ method: "getSettings", args });
        return { effective: false };
      }
    }));
    const machineId = "123e4567-e89b-42d3-a456-426614174000";

    await tools.get("analyser.settings.get")?.handler({ machineId });

    assert.deepEqual(calls, [{
      method: "getEffectiveSettings",
      args: ["test-token", { machineId }]
    }]);
  });

  it("uses a strict discriminated union for proposal updates", () => {
    const tools = captureTools();
    const schema = schemaFor(tools, "analyser.proposals.update");
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const operationId = "123e4567-e89b-42d3-a456-426614174001";

    assert.equal(schema.safeParse({
      id,
      action: "update_content",
      title: "Updated proposal",
      expectedVersion: 1
    }).success, true);
    assert.equal(schema.safeParse({
      id,
      action: "mark_executed",
      operationId,
      expectedVersion: 1
    }).success, true);
    assert.equal(schema.safeParse({
      id,
      action: "update_content",
      title: "Mixed branch",
      operationId,
      expectedVersion: 1
    }).success, false);
    assert.equal(schema.safeParse({
      id,
      action: "mark_executed",
      operationId,
      title: "Mixed branch",
      expectedVersion: 1
    }).success, false);
    assert.equal(schema.safeParse({
      id,
      action: "approve",
      expectedVersion: 1
    }).success, false);
  });

  it("rejects caller-supplied publication provenance and always records agent provenance", async () => {
    const calls: unknown[][] = [];
    const tools = captureTools(testDependencies({
      async recordPublication(...args: unknown[]) {
        calls.push(args);
        return { created: true };
      }
    }));
    const schema = schemaFor(tools, "analyser.publications.record");
    const input = {
      sourceKind: "summary",
      sourceId: "summary-1",
      targetKind: "note",
      targetId: "note-1",
      contentHash: "01234567abcdef"
    };

    assert.equal(schema.safeParse(input).success, true);
    assert.equal(schema.safeParse({ ...input, provenance: "ui" }).success, false);
    await tools.get("analyser.publications.record")?.handler(input);

    assert.deepEqual(calls, [["test-token", { ...input, provenance: "agent" }]]);
  });

  it("forwards routine claim, complete, and fail path arguments correctly", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const tools = captureTools(testDependencies({
      async claimRoutine(...args: unknown[]) {
        calls.push({ method: "claimRoutine", args });
        return { claim: null };
      },
      async completeRun(...args: unknown[]) {
        calls.push({ method: "completeRun", args });
        return { status: "completed" };
      },
      async failRun(...args: unknown[]) {
        calls.push({ method: "failRun", args });
        return { status: "failed" };
      }
    }));
    const runId = "123e4567-e89b-42d3-a456-426614174000";

    await tools.get("analyser.routines.claim")?.handler({
      key: "daily-summary",
      holder: "agent-1",
      leaseSeconds: 120
    });
    await tools.get("analyser.routines.complete")?.handler({ runId, holder: "agent-1" });
    await tools.get("analyser.routines.fail")?.handler({
      runId,
      holder: "agent-1",
      errorSummary: "temporary failure"
    });

    assert.deepEqual(calls, [
      {
        method: "claimRoutine",
        args: ["test-token", { key: "daily-summary", holder: "agent-1", leaseSeconds: 120 }]
      },
      {
        method: "completeRun",
        args: ["test-token", runId, { holder: "agent-1" }]
      },
      {
        method: "failRun",
        args: ["test-token", runId, { holder: "agent-1", errorSummary: "temporary failure" }]
      }
    ]);
  });

  it("keeps analyser provisioning and MCP registrations wired", () => {
    const __filename = fileURLToPath(import.meta.url);
    const sourceRoot = path.resolve(path.dirname(__filename), "..");
    const adapter = readFileSync(path.join(sourceRoot, "mcp", "registerAnalyserTools.ts"), "utf8");
    const httpServer = readFileSync(path.join(sourceRoot, "httpServer.ts"), "utf8");
    const stdioServer = readFileSync(path.join(sourceRoot, "mcpServer.ts"), "utf8");

    assert.match(adapter, /await ensureAccountProvisioned\(authContext\)/);
    assert.match(adapter, /throw new Error\("Analyser service is not configured"\)/);
    assert.match(httpServer, /registerAnalyserTools\(server, injectedContext\)/);
    assert.match(stdioServer, /registerAnalyserTools\(server, ctx\)/);
  });
});
