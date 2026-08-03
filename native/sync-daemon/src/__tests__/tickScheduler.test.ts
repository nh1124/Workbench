import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTickScheduler, scheduleTick } from "../tickScheduler.js";
import type { DaemonState } from "../types.js";

/**
 * The scheduler decides when a sync tick runs. It was pulled out of index.ts to
 * break the cycle between "the remote pull asks for another tick" and "the tick
 * drives the remote pull", so these cover the coalescing rules that cycle
 * depends on: a tick asked for while one is running must not be lost, and must
 * not start a second concurrent run.
 */

function fakeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    config: { watchDebounceMs: 5 },
    tickRunning: false,
    tickQueued: false,
    ...overrides
  } as unknown as DaemonState;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createTickScheduler", () => {
  it("runs the tick body once per run", async () => {
    const state = fakeState();
    let runs = 0;
    const ticker = createTickScheduler(state, async () => {
      runs += 1;
    });

    await ticker.run();

    assert.equal(runs, 1);
    assert.equal(state.tickRunning, false);
    assert.equal(state.tickQueued, false);
  });

  it("passes the state to the tick body", async () => {
    const state = fakeState();
    let seen: DaemonState | undefined;
    const ticker = createTickScheduler(state, async (given) => {
      seen = given;
    });

    await ticker.run();

    assert.equal(seen, state);
  });

  it("folds a tick asked for mid-run into a second pass", async () => {
    const state = fakeState();
    let runs = 0;
    const ticker = createTickScheduler(state, async () => {
      runs += 1;
      // Only the first pass asks for another, so this settles at two.
      if (runs === 1) await ticker.run();
    });

    await ticker.run();

    assert.equal(runs, 2);
    assert.equal(state.tickQueued, false);
  });

  it("does not start a second concurrent run", async () => {
    const state = fakeState();
    let concurrent = 0;
    let maxConcurrent = 0;
    const ticker = createTickScheduler(state, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(5);
      concurrent -= 1;
    });

    await Promise.all([ticker.run(), ticker.run(), ticker.run()]);

    assert.equal(maxConcurrent, 1);
  });

  it("clears the running flag even when the tick body throws", async () => {
    const state = fakeState();
    const ticker = createTickScheduler(state, async () => {
      throw new Error("tick failed");
    });

    await assert.rejects(() => ticker.run(), /tick failed/);
    assert.equal(state.tickRunning, false);
  });

  it("runs a scheduled tick after the delay", async () => {
    const state = fakeState();
    let runs = 0;
    const ticker = createTickScheduler(state, async () => {
      runs += 1;
    });

    ticker.schedule(1);
    assert.equal(runs, 0, "should not run synchronously");

    await delay(20);
    assert.equal(runs, 1);
    assert.equal(state.tickTimer, undefined);
  });

  it("replaces a pending tick rather than queuing another", async () => {
    const state = fakeState();
    let runs = 0;
    const ticker = createTickScheduler(state, async () => {
      runs += 1;
    });

    ticker.schedule(1);
    ticker.schedule(1);
    ticker.schedule(1);

    await delay(20);
    assert.equal(runs, 1);
  });

  it("falls back to the configured debounce when no delay is given", async () => {
    const state = fakeState({ config: { watchDebounceMs: 1 } as DaemonState["config"] });
    let runs = 0;
    const ticker = createTickScheduler(state, async () => {
      runs += 1;
    });

    ticker.schedule();
    await delay(20);

    assert.equal(runs, 1);
  });
});

describe("scheduleTick", () => {
  it("reaches the scheduler the daemon wired", async () => {
    const state = fakeState();
    let runs = 0;
    state.ticker = createTickScheduler(state, async () => {
      runs += 1;
    });

    scheduleTick(state, 1);
    await delay(20);

    assert.equal(runs, 1);
  });

  it("leaves a state with no scheduler alone", async () => {
    const state = fakeState();

    scheduleTick(state, 1);
    await delay(20);

    // No timer was created, so a fixture that never ticks stays inert.
    assert.equal(state.tickTimer, undefined);
    assert.equal(state.tickRunning, false);
  });
});
