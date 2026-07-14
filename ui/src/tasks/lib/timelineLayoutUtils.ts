import { hourLabel, parseTimeToMinutes } from "../../lib/taskDisplayUtils";
import {
  TIMELINE_END_HOUR,
  MIN_TIMELINE_HOUR_HEIGHT,
  TIMELINE_START_HOUR,
} from "../types";

export type TimedEventLayout<T> = T & {
  clippedStart: number;
  clippedEnd: number;
  top: number;
  height: number;
  timeLabel: string;
  lane: number;
  laneCount: number;
};

export function computeTimelineHourHeight(
  availableHeight: number,
  visibleHourCount: number,
  minHourHeight = MIN_TIMELINE_HOUR_HEIGHT
): number {
  if (!Number.isFinite(availableHeight) || !Number.isFinite(visibleHourCount) || visibleHourCount <= 0) {
    return minHourHeight;
  }
  return Math.max(minHourHeight, availableHeight / visibleHourCount);
}

/**
 * Build visual placement information for timeline events with overlap lanes.
 */
export function layoutTimedItems<T extends { startTime?: string; endTime?: string }>(
  items: T[],
  hourHeight = MIN_TIMELINE_HOUR_HEIGHT
): TimedEventLayout<T>[] {
  const sorted = items
    .map((item) => {
      const startMinuteRaw = parseTimeToMinutes(item.startTime);
      const endMinuteRaw = parseTimeToMinutes(item.endTime);
      const fallbackStart = endMinuteRaw !== null ? Math.max(TIMELINE_START_HOUR * 60, endMinuteRaw - 60) : TIMELINE_START_HOUR * 60;
      const startMinute = startMinuteRaw ?? fallbackStart;
      const fallbackEnd = Math.min(TIMELINE_END_HOUR * 60, startMinute + 60);
      const rawEnd = endMinuteRaw ?? fallbackEnd;
      const clippedStart = Math.max(TIMELINE_START_HOUR * 60, Math.min(startMinute, TIMELINE_END_HOUR * 60));
      const boundedEnd = Math.max(clippedStart + 30, rawEnd);
      const clippedEnd = Math.min(TIMELINE_END_HOUR * 60, boundedEnd);
      if (clippedStart >= TIMELINE_END_HOUR * 60 || clippedEnd <= TIMELINE_START_HOUR * 60) return null;
      const top = ((clippedStart - TIMELINE_START_HOUR * 60) / 60) * hourHeight;
      const height = Math.max(22, ((clippedEnd - clippedStart) / 60) * hourHeight);
      const timeLabel = item.startTime
        ? `${item.startTime}${item.endTime ? ` - ${item.endTime}` : ""}`
        : hourLabel(Math.floor(clippedStart / 60));
      return { ...item, clippedStart, clippedEnd, top, height, timeLabel, lane: 0, laneCount: 1 };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.clippedStart !== b.clippedStart ? a.clippedStart - b.clippedStart : a.clippedEnd - b.clippedEnd);

  const active: Array<{ lane: number; end: number }> = [];
  let clusterIndexes: number[] = [];
  let clusterMax = 1;
  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    for (let activeIndex = active.length - 1; activeIndex >= 0; activeIndex--) {
      if (active[activeIndex].end <= event.clippedStart) active.splice(activeIndex, 1);
    }
    if (active.length === 0 && clusterIndexes.length > 0) {
      for (const index of clusterIndexes) sorted[index].laneCount = clusterMax;
      clusterIndexes = [];
      clusterMax = 1;
    }
    const usedLanes = new Set(active.map((a) => a.lane));
    let lane = 0;
    while (usedLanes.has(lane)) lane++;
    event.lane = lane;
    active.push({ lane, end: event.clippedEnd });
    clusterIndexes.push(i);
    clusterMax = Math.max(clusterMax, lane + 1);
  }
  if (clusterIndexes.length > 0) {
    for (const index of clusterIndexes) sorted[index].laneCount = clusterMax;
  }
  return sorted;
}
