import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const {
  acquireMaintenanceLeaseWithPool,
  MaintenanceLeaseHeldError,
  MaintenanceLeaseInputError,
  MaintenanceLeaseNotHeldError,
  releaseMaintenanceLeaseWithPool,
  renewMaintenanceLeaseWithPool
} = await import("../maintenanceLeasesStore.js");
const { registerMaintenanceTools } = await import("../mcp/registerMaintenanceTools.js");

type QueryCall = { text: string; values?: unknown[] };

function normalizedSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("maintenance leases store", () => {
  it("atomically acquires with the default TTL and permits same-holder extension", async () => {
    const calls: QueryCall[] = [];
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        return { rows: [{
          key: "weekly-sweep",
          holder: "runner-1",
          expires_at: new Date("2026-07-19T03:30:00.000Z"),
          acquired_at: "2026-07-19T03:00:00.000Z",
          renewed_at: new Date("2026-07-19T03:05:00.000Z")
        } as Row] };
      }
    };

    const result = await acquireMaintenanceLeaseWithPool(pool, "user-1", {
      key: " weekly-sweep ",
      holder: " runner-1 "
    });

    assert.deepEqual(result, {
      key: "weekly-sweep",
      holder: "runner-1",
      expiresAt: "2026-07-19T03:30:00.000Z",
      acquiredAt: "2026-07-19T03:00:00.000Z",
      renewedAt: "2026-07-19T03:05:00.000Z"
    });
    assert.deepEqual(calls[0].values, ["user-1", "weekly-sweep", "runner-1", 1800]);
    assert.match(calls[0].text, /INSERT INTO maintenance_leases \(user_id, key, holder, expires_at, acquired_at, renewed_at\)/);
    assert.match(calls[0].text, /ON CONFLICT \(user_id, key\) DO UPDATE SET/);
    assert.match(calls[0].text, /maintenance_leases\.holder = EXCLUDED\.holder AND maintenance_leases\.expires_at > NOW\(\)/);
    assert.match(calls[0].text, /WHERE maintenance_leases\.holder = EXCLUDED\.holder OR maintenance_leases\.expires_at <= NOW\(\)/);
    assert.match(calls[0].text, /make_interval\(secs => \$4\)/);
  });

  it("returns a 409 held error when another holder owns an unexpired lease", async () => {
    const pool = { async query<Row>(): Promise<{ rows: Row[] }> { return { rows: [] }; } };

    await assert.rejects(
      acquireMaintenanceLeaseWithPool(pool, "user-1", { key: "weekly-sweep", holder: "runner-2" }),
      (error) => error instanceof MaintenanceLeaseHeldError
        && error.status === 409
        && error.code === "MAINTENANCE_LEASE_HELD"
        && !error.message.includes("runner-2")
    );
  });

  it("renews only a matching holder's unexpired lease", async () => {
    const calls: QueryCall[] = [];
    const pool = {
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
        calls.push({ text: normalizedSql(text), values });
        return { rows: [{
          key: "weekly-sweep",
          holder: "runner-1",
          expires_at: "2026-07-19T04:00:00.000Z",
          acquired_at: "2026-07-19T03:00:00.000Z",
          renewed_at: "2026-07-19T03:30:00.000Z"
        } as Row] };
      }
    };

    await renewMaintenanceLeaseWithPool(pool, "user-renew", {
      key: "weekly-sweep",
      holder: "runner-1",
      ttlSeconds: 3600
    });

    assert.deepEqual(calls[0].values, ["user-renew", "weekly-sweep", "runner-1", 3600]);
    assert.match(calls[0].text, /WHERE user_id = \$1 AND key = \$2 AND holder = \$3 AND expires_at > NOW\(\)/);

    await assert.rejects(
      renewMaintenanceLeaseWithPool({ async query<Row>() { return { rows: [] as Row[] }; } }, "user-renew", {
        key: "weekly-sweep",
        holder: "runner-2"
      }),
      (error) => error instanceof MaintenanceLeaseNotHeldError
        && error.status === 409
        && error.code === "MAINTENANCE_LEASE_NOT_HELD"
    );
  });

  it("returns released:false when no matching lease exists", async () => {
    const calls: QueryCall[] = [];
    const result = await releaseMaintenanceLeaseWithPool({
      async query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
        calls.push({ text: normalizedSql(text), values });
        return { rows: [], rowCount: 0 };
      }
    }, "user-release", { key: "weekly-sweep", holder: "runner-1" });

    assert.deepEqual(result, { released: false });
    assert.deepEqual(calls[0].values, ["user-release", "weekly-sweep", "runner-1"]);
    assert.match(calls[0].text, /DELETE FROM maintenance_leases WHERE user_id = \$1 AND key = \$2 AND holder = \$3/);
  });

  it("rejects invalid keys, holders, and TTLs before querying", async () => {
    let queryCount = 0;
    const pool = {
      async query<Row>(): Promise<{ rows: Row[] }> {
        queryCount += 1;
        return { rows: [] };
      }
    };
    const invalidInputs = [
      { key: "", holder: "runner" },
      { key: "x".repeat(101), holder: "runner" },
      { key: "lease", holder: " " },
      { key: "lease", holder: "x".repeat(101) },
      { key: "lease", holder: "runner", ttlSeconds: 0 },
      { key: "lease", holder: "runner", ttlSeconds: 86401 },
      { key: "lease", holder: "runner", ttlSeconds: 1.5 }
    ];

    for (const input of invalidInputs) {
      await assert.rejects(
        acquireMaintenanceLeaseWithPool(pool, "user-1", input),
        (error) => error instanceof MaintenanceLeaseInputError
          && error.status === 400
          && error.code === "MAINTENANCE_LEASE_INPUT_INVALID"
      );
    }
    assert.equal(queryCount, 0);
  });
});

describe("maintenance lease MCP tools", () => {
  it("registers acquire, renew, and release with bounded schemas and advisory semantics", () => {
    const tools = new Map<string, { inputSchema?: z.ZodRawShape; description?: string }>();
    const fakeServer = {
      registerTool(name: string, definition: { inputSchema?: z.ZodRawShape; description?: string }): void {
        tools.set(name, definition);
      }
    };
    registerMaintenanceTools(fakeServer as never, { accessToken: "unused" });

    const acquire = tools.get("maintenance.lease.acquire");
    const renew = tools.get("maintenance.lease.renew");
    const release = tools.get("maintenance.lease.release");
    assert.ok(acquire);
    assert.ok(renew);
    assert.ok(release);
    assert.match(acquire.description ?? "", /owner-scoped advisory lease/i);
    assert.match(acquire.description ?? "", /idempotent/i);
    assert.match(acquire.description ?? "", /409-style/);
    assert.match(acquire.description ?? "", /expired leases/i);

    const acquireSchema = z.object(acquire.inputSchema ?? {});
    const renewSchema = z.object(renew.inputSchema ?? {});
    const releaseSchema = z.object(release.inputSchema ?? {});
    assert.equal(acquireSchema.safeParse({ key: "lease", holder: "runner" }).success, true);
    assert.equal(renewSchema.safeParse({ key: "lease", holder: "runner", ttlSeconds: 86400 }).success, true);
    assert.equal(acquireSchema.safeParse({ key: "", holder: "runner" }).success, false);
    assert.equal(acquireSchema.safeParse({ key: "lease", holder: "x".repeat(101) }).success, false);
    assert.equal(acquireSchema.safeParse({ key: "lease", holder: "runner", ttlSeconds: 0 }).success, false);
    assert.equal(acquireSchema.safeParse({ key: "lease", holder: "runner", ttlSeconds: 1.5 }).success, false);
    assert.equal(releaseSchema.safeParse({ key: "lease", holder: "runner" }).success, true);
    assert.match(release.description ?? "", /released:false/);
  });
});
