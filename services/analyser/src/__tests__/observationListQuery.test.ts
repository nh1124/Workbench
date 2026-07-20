import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYSER_SKIP_BOOTSTRAP = "1";
process.env.ANALYSER_SERVICE_PORT ??= "4109";
process.env.ANALYSER_SERVICE_HOST ??= "127.0.0.1";
process.env.JWT_SECRET ??= "test-secret";
process.env.JWT_ISSUER ??= "workbench-core";
process.env.INTERNAL_API_KEY_ANALYSER ??= "test-key";
process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const { observationListQuerySchema } = await import("../httpServer.js");

describe("observationListQuerySchema from/to coercion", () => {
  it("widens bare calendar dates to inclusive day boundaries (UI period presets)", () => {
    const parsed = observationListQuerySchema.parse({ from: "2026-07-14", to: "2026-07-20", limit: 50 });
    assert.equal(parsed.from, "2026-07-14T00:00:00.000Z");
    assert.equal(parsed.to, "2026-07-20T23:59:59.999Z");
  });

  it("still accepts full ISO datetimes unchanged (agent callers)", () => {
    const parsed = observationListQuerySchema.parse({
      from: "2026-07-14T09:30:00.000Z",
      to: "2026-07-20T18:00:00.000Z"
    });
    assert.equal(parsed.from, "2026-07-14T09:30:00.000Z");
    assert.equal(parsed.to, "2026-07-20T18:00:00.000Z");
  });

  it("rejects a garbage date string", () => {
    assert.equal(observationListQuerySchema.safeParse({ from: "last-week" }).success, false);
  });

  it("enforces from <= to after coercion", () => {
    assert.equal(observationListQuerySchema.safeParse({ from: "2026-07-20", to: "2026-07-14" }).success, false);
  });
});
