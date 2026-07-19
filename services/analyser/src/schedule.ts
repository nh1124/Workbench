import { AnalyserServiceError } from "./serviceError.js";

export type ScheduleKind = "interval" | "cron";

type CronField = {
  wildcard: boolean;
  values: number[];
};

export type ParsedSchedule =
  | { kind: "interval"; minutes: number; timezone: string }
  | {
      kind: "cron";
      timezone: string;
      minute: CronField;
      hour: CronField;
      dayOfMonth: CronField;
      month: CronField;
      dayOfWeek: CronField;
    };

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface ZonedWallClock extends WallClock {
  weekday: number;
}

function invalidSchedule(message: string): never {
  throw new AnalyserServiceError(400, "INVALID_SCHEDULE", message);
}

function validateTimezone(timezone: string): void {
  if (!timezone) invalidSchedule("Invalid IANA timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    invalidSchedule("Invalid IANA timezone");
  }
}

function parseCronField(raw: string, minimum: number, maximum: number, label: string): CronField {
  if (raw === "*") {
    return {
      wildcard: true,
      values: Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index)
    };
  }
  if (!/^\d+(?:,\d+)*$/.test(raw)) invalidSchedule(`Invalid cron ${label}`);
  const values = raw.split(",").map(Number);
  if (values.some((value) => value < minimum || value > maximum)) {
    invalidSchedule(`Cron ${label} is out of range`);
  }
  return { wildcard: false, values: [...values].sort((left, right) => left - right) };
}

export function parseSchedule(kind: ScheduleKind, expr: string, timezone: string): ParsedSchedule {
  validateTimezone(timezone);
  if (kind === "interval") {
    if (!/^\d+$/.test(expr)) invalidSchedule("Interval must be a positive integer number of minutes");
    const minutes = Number(expr);
    if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 10_080) {
      invalidSchedule("Interval must be between 5 and 10080 minutes");
    }
    return { kind, minutes, timezone };
  }
  if (kind !== "cron") invalidSchedule("Unknown schedule kind");
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
    invalidSchedule("Cron schedule must contain exactly five fields");
  }
  return {
    kind,
    timezone,
    minute: parseCronField(fields[0], 0, 59, "minute"),
    hour: parseCronField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseCronField(fields[2], 1, 31, "day-of-month"),
    month: parseCronField(fields[3], 1, 12, "month"),
    dayOfWeek: parseCronField(fields[4], 0, 6, "day-of-week")
  };
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  });
}

export function wallClockInZone(timezone: string, date: Date): ZonedWallClock {
  validateTimezone(timezone);
  if (Number.isNaN(date.getTime())) invalidSchedule("Invalid schedule reference time");
  const values: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const weekday = WEEKDAYS[values.weekday];
  if (weekday === undefined) invalidSchedule("Unable to resolve timezone wall clock");
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday
  };
}

function wallMilliseconds(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

export function zonedTimeToUtc(timezone: string, wall: WallClock): Date {
  validateTimezone(timezone);
  const desiredMilliseconds = wallMilliseconds(wall);
  const desiredDate = new Date(desiredMilliseconds);
  if (Number.isNaN(desiredMilliseconds)
    || desiredDate.getUTCFullYear() !== wall.year
    || desiredDate.getUTCMonth() + 1 !== wall.month
    || desiredDate.getUTCDate() !== wall.day
    || desiredDate.getUTCHours() !== wall.hour
    || desiredDate.getUTCMinutes() !== wall.minute) {
    invalidSchedule("Invalid wall-clock time");
  }

  const offsetProbes = [0, -36, -24, -12, -6, 6, 12, 24, 36];
  const candidates = new Map<number, Date>();
  for (const hours of offsetProbes) {
    const probe = new Date(desiredMilliseconds + hours * 3_600_000);
    const probeWall = wallClockInZone(timezone, probe);
    const offset = wallMilliseconds(probeWall) - probe.getTime();
    const candidate = new Date(desiredMilliseconds - offset);
    candidates.set(candidate.getTime(), candidate);
  }

  const exact = [...candidates.values()]
    .filter((candidate) => sameWallClock(wallClockInZone(timezone, candidate), wall))
    .sort((left, right) => left.getTime() - right.getTime());
  if (exact[0]) return exact[0];

  // A forward DST jump has no exact inverse. Search the small transition window
  // and return the earliest valid local minute at or after the missing wall time.
  const candidateTimes = [...candidates.keys()];
  const start = Math.min(...candidateTimes) - 180 * 60_000;
  const end = Math.max(...candidateTimes) + 180 * 60_000;
  let best: { date: Date; wallMilliseconds: number } | undefined;
  for (let instant = start; instant <= end; instant += 60_000) {
    const date = new Date(instant);
    const actual = wallClockInZone(timezone, date);
    if (actual.year !== wall.year || actual.month !== wall.month || actual.day !== wall.day) continue;
    const actualMilliseconds = wallMilliseconds(actual);
    if (actualMilliseconds < desiredMilliseconds) continue;
    if (!best || actualMilliseconds < best.wallMilliseconds
      || (actualMilliseconds === best.wallMilliseconds && instant < best.date.getTime())) {
      best = { date, wallMilliseconds: actualMilliseconds };
    }
  }
  if (best) return best.date;
  invalidSchedule("Unable to resolve timezone wall clock");
}

function cronDayMatches(schedule: Extract<ParsedSchedule, { kind: "cron" }>, date: Date): boolean {
  const month = date.getUTCMonth() + 1;
  if (!schedule.month.values.includes(month)) return false;
  const dayOfMonthMatches = schedule.dayOfMonth.values.includes(date.getUTCDate());
  const dayOfWeekMatches = schedule.dayOfWeek.values.includes(date.getUTCDay());
  if (!schedule.dayOfMonth.wildcard && !schedule.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  if (!schedule.dayOfMonth.wildcard) return dayOfMonthMatches;
  if (!schedule.dayOfWeek.wildcard) return dayOfWeekMatches;
  return true;
}

export function computeNextRunAt(kind: ScheduleKind, expr: string, timezone: string, from: Date): Date {
  if (Number.isNaN(from.getTime())) invalidSchedule("Invalid schedule reference time");
  const schedule = parseSchedule(kind, expr, timezone);
  if (schedule.kind === "interval") return new Date(from.getTime() + schedule.minutes * 60_000);

  const searchStart = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const firstWall = wallClockInZone(timezone, searchStart);
  const firstDate = Date.UTC(firstWall.year, firstWall.month - 1, firstWall.day);
  const pairs = schedule.hour.values.flatMap((hour) => schedule.minute.values.map((minute) => ({ hour, minute })));

  for (let dayOffset = 0; dayOffset < 400; dayOffset += 1) {
    const calendarDate = new Date(firstDate + dayOffset * 86_400_000);
    if (!cronDayMatches(schedule, calendarDate)) continue;
    for (const pair of pairs) {
      if (dayOffset === 0
        && (pair.hour < firstWall.hour || (pair.hour === firstWall.hour && pair.minute < firstWall.minute))) continue;
      const candidate = zonedTimeToUtc(timezone, {
        year: calendarDate.getUTCFullYear(),
        month: calendarDate.getUTCMonth() + 1,
        day: calendarDate.getUTCDate(),
        hour: pair.hour,
        minute: pair.minute
      });
      if (candidate.getTime() > from.getTime()) return candidate;
    }
  }
  invalidSchedule("Cron schedule is unsatisfiable within 400 days");
}
