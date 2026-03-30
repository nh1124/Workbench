/**
 * taskDateUtils.ts
 * Pure date helpers for the Tasks domain.
 * No React, no API calls, no side-effects.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function startOfWeek(date: Date): Date {
  const v = startOfDay(date);
  v.setDate(v.getDate() - v.getDay());
  return v;
}

export function addDays(date: Date, days: number): Date {
  const v = new Date(date);
  v.setDate(v.getDate() + days);
  return v;
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse a YYYY-MM-DD string (or loose date string) to a local-midnight Date. */
export function parseDateOnly(value?: string): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    return new Date(year, month, day);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return startOfDay(parsed);
}

/**
 * Format a YYYY-MM-DD key as MM.DD.YYYY for display headings.
 * Falls back to the raw key if parsing fails.
 */
export function formatDateHeading(dateKey: string): string {
  const parsed = parseDateOnly(dateKey);
  if (!parsed) return dateKey;
  const mm = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const dd = `${parsed.getDate()}`.padStart(2, "0");
  const yyyy = `${parsed.getFullYear()}`;
  return `${mm}.${dd}.${yyyy}`;
}
