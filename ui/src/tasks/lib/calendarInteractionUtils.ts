import { addDays, parseDateOnly, startOfDay, toDateKey } from "../../lib/taskDateUtils";
import { normalizeDateKey } from "./taskOccurrenceIdentity";

export type StandaloneCalendarKind = "day" | "due" | "schedule";
export type StandaloneCalendarKindInput = StandaloneCalendarKind | "today";
export type StandaloneCalendarView = "month" | "week";

export interface StandaloneCalendarOptions {
  calendar: StandaloneCalendarKind;
  view: StandaloneCalendarView;
  date: string;
}

export interface TimelineDragRange {
  startMinutes: number;
  endMinutes: number;
  startTime: string;
  endTime: string;
  top: number;
  height: number;
}

export interface MonthCellContextPayload {
  date: string;
  x: number;
  y: number;
}

export function buildStandaloneCalendarUrl(
  calendar?: StandaloneCalendarKindInput,
  view: StandaloneCalendarView = "month",
  date?: string
): string {
  if (!calendar) return "/tasks/calendar";
  if (calendar === "day" || calendar === "today") {
    const params = new URLSearchParams({ calendar: "day" });
    const normalizedDate = normalizeDateKey(date);
    if (normalizedDate) params.set("date", normalizedDate);
    return `/tasks/calendar?${params.toString()}`;
  }
  const params = new URLSearchParams({ calendar, view });
  return `/tasks/calendar?${params.toString()}`;
}

export function resolveStandaloneCalendarOptions(
  params: URLSearchParams,
  now = new Date()
): StandaloneCalendarOptions {
  const calendarParam = params.get("calendar");
  const calendar: StandaloneCalendarKind = calendarParam === "due" || calendarParam === "schedule"
    ? calendarParam
    : "day";
  const view: StandaloneCalendarView = calendar !== "day" && params.get("view") === "week"
    ? "week"
    : "month";
  const date = normalizeDateKey(params.get("date")) ?? toDateKey(startOfDay(now));
  return { calendar, view, date };
}

export function moveStandaloneDayDate(dateKey: string, offsetDays: number): string {
  const normalizedDate = normalizeDateKey(dateKey);
  const date = normalizedDate ? parseDateOnly(normalizedDate) : null;
  if (!date) throw new Error("Standalone day date must be a valid date key");
  return toDateKey(addDays(date, offsetDays));
}

export function buildMonthCellContextPayload(
  date: Date,
  x: number,
  y: number
): MonthCellContextPayload {
  const dateKey = normalizeDateKey(toDateKey(date));
  if (!dateKey) throw new Error("Calendar cell date must be a valid date key");
  return { date: dateKey, x, y };
}

export function timelineDragToSnappedRange(
  anchorOffsetY: number,
  currentOffsetY: number,
  hourHeight: number,
  startHour = 0,
  endHour = 24,
  snapMinutes = 15
): TimelineDragRange {
  const safeHourHeight = Number.isFinite(hourHeight) && hourHeight > 0 ? hourHeight : 1;
  const safeSnap = Number.isFinite(snapMinutes) && snapMinutes > 0 ? snapMinutes : 15;
  const minMinute = startHour * 60;
  const maxMinute = endHour * 60;
  const clampOffset = (offset: number) => Math.max(0, Math.min(
    (endHour - startHour) * safeHourHeight,
    Number.isFinite(offset) ? offset : 0
  ));
  const toSnappedMinute = (offset: number) => {
    const rawMinute = minMinute + (clampOffset(offset) / safeHourHeight) * 60;
    return Math.max(minMinute, Math.min(maxMinute, Math.round(rawMinute / safeSnap) * safeSnap));
  };

  let startMinutes = Math.min(toSnappedMinute(anchorOffsetY), toSnappedMinute(currentOffsetY));
  let endMinutes = Math.max(toSnappedMinute(anchorOffsetY), toSnappedMinute(currentOffsetY));
  if (endMinutes === startMinutes) {
    if (endMinutes + safeSnap <= maxMinute) endMinutes += safeSnap;
    else startMinutes = Math.max(minMinute, startMinutes - safeSnap);
  }

  const top = ((startMinutes - minMinute) / 60) * safeHourHeight;
  const height = ((endMinutes - startMinutes) / 60) * safeHourHeight;
  return {
    startMinutes,
    endMinutes,
    startTime: formatTimelineMinute(startMinutes),
    endTime: formatTimelineMinute(endMinutes),
    top,
    height,
  };
}

function formatTimelineMinute(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
