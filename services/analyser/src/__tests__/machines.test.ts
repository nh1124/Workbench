import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const { registerMachineWithPool, touchMachineWithPool } = await import("../stores/machines.js");

type Call = { text: string; values?: unknown[] };

function fakePool(responses: Array<{ rows: unknown[]; rowCount?: number }>): { calls: Call[]; query<Row = never>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number }> } {
  const calls: Call[] = [];
  return {
    calls,
    async query<Row = never>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const response = responses.shift() ?? { rows: [] };
      return response as { rows: Row[]; rowCount?: number };
    }
  };
}

describe("analyser machines store", () => {
  it("registers with an owner-scoped upsert and maps ISO timestamps", async () => {
    const pool = fakePool([{ rows: [{
      id: "machine-1",
      machine_key: "laptop",
      display_name: "Laptop",
      platform: "win32",
      registered_at: "2026-07-20T00:00:00.000Z",
      last_seen_at: "2026-07-20T01:00:00.000Z"
    }] }]);
    const machine = await registerMachineWithPool(pool, "owner-1", {
      machineKey: "laptop",
      displayName: "Laptop",
      platform: "win32"
    });

    assert.match(pool.calls[0].text, /ON CONFLICT \(service_account_id, machine_key\) DO UPDATE/);
    assert.match(pool.calls[0].text, /COALESCE\(EXCLUDED\.display_name/);
    assert.deepEqual(pool.calls[0].values, ["owner-1", "laptop", "Laptop", "win32"]);
    assert.equal(machine.lastSeenAt, "2026-07-20T01:00:00.000Z");
  });

  it("returns MACHINE_NOT_FOUND when touching an unknown machine", async () => {
    const pool = fakePool([{ rows: [] }]);
    await assert.rejects(
      touchMachineWithPool(pool, "owner-1", "missing"),
      (error: unknown) => {
        assert.equal((error as { status: number }).status, 404);
        assert.equal((error as { code: string }).code, "MACHINE_NOT_FOUND");
        return true;
      }
    );
  });
});
