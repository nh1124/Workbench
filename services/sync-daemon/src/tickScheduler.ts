import type { DaemonState, TickScheduler } from "./types.js";

/**
 * Owns when a sync tick runs.
 *
 * This exists to break a call cycle: the remote pull path can discover that a
 * rescan is needed and ask for another tick, while the tick itself is what
 * drives the remote pull. Keeping the scheduler here — with the tick body
 * handed in at wiring time — makes the dependency one-way: callers that need a
 * tick import this module, and this module imports nothing but the state type.
 */

export function createTickScheduler(
  state: DaemonState,
  performTick: (state: DaemonState) => Promise<void>
): TickScheduler {
  async function run(): Promise<void> {
    if (state.tickRunning) {
      state.tickQueued = true;
      return;
    }
    state.tickRunning = true;
    try {
      // Anything queued while this tick ran is folded into another pass, so a
      // change arriving mid-tick is never dropped.
      do {
        state.tickQueued = false;
        await performTick(state);
      } while (state.tickQueued);
    } finally {
      state.tickRunning = false;
    }
  }

  return {
    schedule(delayMs = state.config.watchDebounceMs): void {
      if (state.tickTimer) {
        clearTimeout(state.tickTimer);
      }
      state.tickTimer = setTimeout(() => {
        state.tickTimer = undefined;
        void run();
      }, delayMs);
    },
    run
  };
}

/**
 * Ask for a tick without holding the scheduler.
 *
 * The daemon wires `state.ticker` before it starts serving, so in a running
 * daemon this always reaches the scheduler. A state without one — a test
 * fixture that only exercises the sync logic — is left alone rather than
 * growing a timer it never asked for.
 */
export function scheduleTick(state: DaemonState, delayMs?: number): void {
  state.ticker?.schedule(delayMs);
}
