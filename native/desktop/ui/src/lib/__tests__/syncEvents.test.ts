import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedCallback, createSyncEventStreamParser } from "../syncEvents";

afterEach(() => {
  vi.useRealTimers();
});

describe("sync event stream parsing", () => {
  it("parses CRLF frames split across arbitrary chunks and ignores comments", () => {
    const events: unknown[] = [];
    const parser = createSyncEventStreamParser((event) => events.push(event));

    parser.push(": ping\r\n\r\nevent: sy");
    parser.push("nc\r\ndata: {\"domain\":\"ta");
    parser.push("sks\",\"resourceId\":\"task-1\",\"action\":\"update\",");
    parser.push("\"ts\":\"2026-07-13T00:00:00.000Z\"}\r\n\r");
    expect(events).toEqual([]);
    parser.push("\n");

    expect(events).toEqual([{
      domain: "tasks",
      resourceId: "task-1",
      action: "update",
      ts: "2026-07-13T00:00:00.000Z"
    }]);
  });
});

describe("sync event debounce", () => {
  it("coalesces calls within the delay and supports cancellation", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = createDebouncedCallback(callback, 500);

    debounced.schedule();
    vi.advanceTimersByTime(300);
    debounced.schedule();
    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);

    debounced.schedule();
    debounced.cancel();
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
