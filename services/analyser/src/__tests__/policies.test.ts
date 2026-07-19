import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AUTOMATION_POLICY, DEFAULT_COLLECTION_SETTINGS } from "../types.js";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const {
  getEffectiveAutomationPolicyWithPool,
  getEffectiveCollectionSettingsWithPool,
  upsertAutomationPolicyWithPool,
  upsertCollectionPolicyWithPool
} = await import("../stores/policies.js");

type Result = { rows: unknown[]; rowCount?: number };
type Call = { text: string; values?: unknown[] };

function fakePool(responses: Result[]) {
  const calls: Call[] = [];
  const pool = {
    calls,
    async query<Row = never>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return (responses.shift() ?? { rows: [] }) as { rows: Row[]; rowCount?: number };
    },
    async connect() {
      return {
        query: pool.query,
        release() { /* fake client */ }
      };
    }
  };
  return pool;
}

describe("analyser collection policies", () => {
  it("returns defaults when no policy rows exist", async () => {
    const result = await getEffectiveCollectionSettingsWithPool(fakePool([{ rows: [] }]), "owner-1");
    assert.deepEqual(result, { settings: DEFAULT_COLLECTION_SETTINGS });
    assert.notEqual(result.settings, DEFAULT_COLLECTION_SETTINGS);
  });

  it("merges an owner default and deep-merges retention days", async () => {
    const result = await getEffectiveCollectionSettingsWithPool(fakePool([{ rows: [{
      machine_id: null,
      settings_json: { mcpAccess: "off", projectAllow: ["project-a"], retentionDays: { mcp_access: 12 } },
      version: 3
    }] }]), "owner-1");
    assert.equal(result.settings.mcpAccess, "off");
    assert.deepEqual(result.settings.projectAllow, ["project-a"]);
    assert.equal(result.settings.retentionDays.mcp_access, 12);
    assert.equal(result.settings.retentionDays.ui_access, 30);
    assert.equal(result.ownerVersion, 3);
  });

  it("applies a machine override after the owner default and replaces arrays", async () => {
    const result = await getEffectiveCollectionSettingsWithPool(fakePool([{ rows: [
      { machine_id: null, settings_json: { projectAllow: ["owner-project"], retentionDays: { pc_activity: 14 } }, version: 2 },
      { machine_id: "machine-1", settings_json: { projectAllow: ["machine-project"], retentionDays: { local_file: 5 } }, version: 4 }
    ] }]), "owner-1", "machine-1");
    assert.deepEqual(result.settings.projectAllow, ["machine-project"]);
    assert.equal(result.settings.retentionDays.pc_activity, 14);
    assert.equal(result.settings.retentionDays.local_file, 5);
    assert.equal(result.machineVersion, 4);
  });

  it("rejects unknown fields before querying", async () => {
    const pool = fakePool([]);
    await assert.rejects(
      upsertCollectionPolicyWithPool(pool, "owner-1", { settings: { unknown: true }, updatedBy: "user" }),
      (error: unknown) => (error as { status: number; code: string }).status === 400
        && (error as { code: string }).code === "INVALID_SETTINGS"
    );
    assert.equal(pool.calls.length, 0);
  });

  it("reports a machine policy version conflict", async () => {
    const pool = fakePool([{ rows: [{ exists: 1 }] }, { rows: [] }]);
    await assert.rejects(
      upsertCollectionPolicyWithPool(pool, "owner-1", {
        machineId: "machine-1",
        settings: { uiAccess: "off" },
        expectedVersion: 2,
        updatedBy: "user"
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "VERSION_CONFLICT"
    );
  });
});

describe("analyser automation policies", () => {
  it("returns the default and validates full replacements", async () => {
    const policy = await getEffectiveAutomationPolicyWithPool(fakePool([{ rows: [] }]), "owner-1");
    assert.deepEqual(policy, DEFAULT_AUTOMATION_POLICY);

    const invalidPool = fakePool([]);
    await assert.rejects(
      upsertAutomationPolicyWithPool(invalidPool, "owner-1", {
        policy: { enabled: true },
        updatedBy: "user"
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 400
        && (error as { code: string }).code === "INVALID_POLICY"
    );
  });

  it("stores a validated full replacement", async () => {
    const replacement = { ...DEFAULT_AUTOMATION_POLICY, enabled: false, allowedOperationKinds: ["artifact_move"] as const };
    const pool = fakePool([{ rows: [{
      policy_json: replacement,
      version: 2,
      updated_by: "user",
      updated_at: "2026-07-20T00:00:00.000Z"
    }] }]);
    const saved = await upsertAutomationPolicyWithPool(pool, "owner-1", {
      policy: replacement,
      expectedVersion: 1,
      updatedBy: "user"
    });
    assert.deepEqual(saved.policy, replacement);
    assert.match(pool.calls[0].text, /ON CONFLICT \(service_account_id\) DO UPDATE/);
  });
});
