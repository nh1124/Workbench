import { addDays } from "../../lib/taskDateUtils";

export const OCCURRENCE_MAX_SEARCH_DAYS = 3650;

export function computeOccurrenceHasMore(
  mode: "planned" | "overdue",
  todayDate: Date,
  nextCursor: Date,
  maxSearchDays: number = OCCURRENCE_MAX_SEARCH_DAYS
): boolean {
  const searchHorizon =
    mode === "planned"
      ? addDays(todayDate, maxSearchDays)
      : addDays(todayDate, -maxSearchDays);
  return mode === "planned"
    ? nextCursor.getTime() <= searchHorizon.getTime()
    : nextCursor.getTime() >= searchHorizon.getTime();
}
