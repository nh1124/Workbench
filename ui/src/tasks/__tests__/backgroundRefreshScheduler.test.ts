import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundRefreshScheduler } from "../lib/backgroundRefreshScheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("createBackgroundRefreshScheduler", () => {
  it("coalesces repeated schedules into one trailing refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = createBackgroundRefreshScheduler({ refresh, delayMs: 800 });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(400);
    scheduler.schedule();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(799);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("defers while an occurrence mutation is in flight", async () => {
    vi.useFakeTimers();
    let mutationInFlight = true;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = createBackgroundRefreshScheduler({
      refresh,
      isBlocked: () => mutationInFlight,
      delayMs: 800,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(800);
    expect(refresh).not.toHaveBeenCalled();

    mutationInFlight = false;
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(800);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces SSE and mutation-reconcile schedules", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = createBackgroundRefreshScheduler({ refresh, delayMs: 800 });

    scheduler.schedule(); // SSE
    await vi.advanceTimersByTimeAsync(300);
    scheduler.schedule(); // occurrence reconcile
    await vi.advanceTimersByTimeAsync(800);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("queues exactly one follow-up when the timer fires during a refresh", async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const refresh = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(undefined);
    const scheduler = createBackgroundRefreshScheduler({ refresh, delayMs: 800 });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(800);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(800);
    expect(refresh).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
