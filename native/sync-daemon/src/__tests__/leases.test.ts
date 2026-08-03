import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEASE_IDLE_GRACE_MS,
  LEASE_TTL_MS,
  LeaseRegistry,
  LeaseValidationError,
  normalizeClientId
} from "../leases.js";

/** A registry whose clock the test drives, so nothing has to sleep. */
function registryWithClock() {
  let now = 1_000_000;
  const registry = new LeaseRegistry(() => now);
  return {
    registry,
    advance(ms: number) {
      now += ms;
    }
  };
}

describe("lease registry", () => {
  it("counts a registered client once, however many times it heartbeats", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "tasks-100" });
    advance(1000);
    const second = registry.register({ clientId: "tasks-100" });

    assert.equal(second.leaseCount, 1);
    assert.equal(registry.count, 1);
  });

  it("keeps the refreshed client alive past the original expiry", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "tasks-100" });
    advance(LEASE_TTL_MS - 1);
    registry.register({ clientId: "tasks-100" });
    advance(LEASE_TTL_MS - 1);

    assert.equal(registry.sweep(), 0);
    assert.equal(registry.count, 1);
  });

  it("releases a lease", () => {
    const { registry } = registryWithClock();
    registry.register({ clientId: "notes-1" });
    assert.equal(registry.release("notes-1").leaseCount, 0);
  });

  it("accepts a release for a client it has never heard of", () => {
    // A client whose lease already expired still has to be able to exit cleanly.
    const { registry } = registryWithClock();
    assert.equal(registry.release("ghost-1").leaseCount, 0);
  });

  it("sweeps only the leases past their ttl", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "stale-1" });
    advance(LEASE_TTL_MS + 1);
    registry.register({ clientId: "fresh-1" });

    assert.equal(registry.sweep(), 1);
    assert.deepEqual(
      registry.list().items.map((item) => item.clientId),
      ["fresh-1"]
    );
  });

  it("reports the clients holding it open", () => {
    const { registry } = registryWithClock();
    registry.register({ clientId: "artifacts-7", variant: "artifacts", pid: 7 });

    const listing = registry.list();
    assert.equal(listing.count, 1);
    assert.equal(listing.items[0].variant, "artifacts");
    assert.equal(listing.items[0].pid, 7);
  });

  it("rejects an unusable client id", () => {
    assert.throws(() => normalizeClientId(""), LeaseValidationError);
    assert.throws(() => normalizeClientId("   "), LeaseValidationError);
    assert.throws(() => normalizeClientId(42), LeaseValidationError);
    assert.throws(() => normalizeClientId("x".repeat(201)), LeaseValidationError);
    assert.equal(normalizeClientId("  tasks-1  "), "tasks-1");
  });
});

describe("idle shutdown", () => {
  it("never fires while the feature is off", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "tasks-1" });
    registry.release("tasks-1");
    advance(LEASE_IDLE_GRACE_MS * 10);

    assert.equal(registry.shouldExitWhenIdle(false), false);
  });

  it("never fires for a daemon nothing ever connected to", () => {
    // Started by hand or by a script: exiting before a client can register would be useless.
    const { registry, advance } = registryWithClock();
    advance(LEASE_IDLE_GRACE_MS * 10);

    assert.equal(registry.shouldExitWhenIdle(true), false);
  });

  it("waits out the grace period so an app restart does not take the daemon with it", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "tasks-1" });
    registry.release("tasks-1");

    advance(LEASE_IDLE_GRACE_MS - 1);
    assert.equal(registry.shouldExitWhenIdle(true), false);

    advance(1);
    assert.equal(registry.shouldExitWhenIdle(true), true);
  });

  it("does not fire while a client is still holding it", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "tasks-1" });
    advance(LEASE_IDLE_GRACE_MS * 10);

    assert.equal(registry.shouldExitWhenIdle(true), false);
  });

  it("restarts the grace period when a client comes back", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "tasks-1" });
    registry.release("tasks-1");
    advance(LEASE_IDLE_GRACE_MS - 1);

    registry.register({ clientId: "notes-1" });
    registry.release("notes-1");
    advance(LEASE_IDLE_GRACE_MS - 1);
    assert.equal(registry.shouldExitWhenIdle(true), false);

    advance(1);
    assert.equal(registry.shouldExitWhenIdle(true), true);
  });

  it("counts a lease lost to expiry as idle, not as still held", () => {
    const { registry, advance } = registryWithClock();
    registry.register({ clientId: "crashed-1" });
    advance(LEASE_TTL_MS + 1);
    registry.sweep();

    advance(LEASE_IDLE_GRACE_MS);
    assert.equal(registry.shouldExitWhenIdle(true), true);
  });
});
