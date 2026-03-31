import { describe, expect, it } from "vitest";
import { computeOccurrenceHasMore } from "../lib/occurrencePagingUtils";

describe("computeOccurrenceHasMore", () => {
  it("keeps planned paging while cursor is within horizon", () => {
    const today = new Date("2026-03-30T00:00:00+09:00");
    const nextCursor = new Date("2026-04-30T00:00:00+09:00");
    expect(computeOccurrenceHasMore("planned", today, nextCursor, 90)).toBe(true);
  });

  it("stops planned paging after horizon", () => {
    const today = new Date("2026-03-30T00:00:00+09:00");
    const nextCursor = new Date("2026-08-01T00:00:00+09:00");
    expect(computeOccurrenceHasMore("planned", today, nextCursor, 90)).toBe(false);
  });

  it("keeps overdue paging while cursor is within backward horizon", () => {
    const today = new Date("2026-03-30T00:00:00+09:00");
    const nextCursor = new Date("2026-03-01T00:00:00+09:00");
    expect(computeOccurrenceHasMore("overdue", today, nextCursor, 90)).toBe(true);
  });

  it("stops overdue paging after backward horizon", () => {
    const today = new Date("2026-03-30T00:00:00+09:00");
    const nextCursor = new Date("2025-01-01T00:00:00+09:00");
    expect(computeOccurrenceHasMore("overdue", today, nextCursor, 90)).toBe(false);
  });
});
