/**
 * taskDisplayUtils.ts
 * Pure display/colour/format helpers for the Tasks domain.
 * No React, no API calls, no side-effects.
 */

export interface ProjectOption {
  projectId: string;
  projectName?: string;
}

// ── Colour helpers ───────────────────────────────────────────────────────────

/** Returns a traffic-light colour for a numeric load score 0-10. */
export function loadScoreColor(score: number): string {
  if (score >= 8) return "#f87171";
  if (score >= 5) return "#fbbf24";
  return "#6ee7b7";
}

/** Returns a stable hashed colour for a context/project key string. */
export function contextColor(context: string): string {
  const colors = [
    "#22d3ee", "#a78bfa", "#f472b6", "#34d399",
    "#fb923c", "#60a5fa", "#e879f9"
  ];
  let h = 0;
  for (let i = 0; i < context.length; i++) {
    h = (h * 31 + context.charCodeAt(i)) % colors.length;
  }
  return colors[h];
}

// ── String helpers ───────────────────────────────────────────────────────────

export function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/** Returns true if the message looks like an auth/forbidden error. */
export function isAuthErrorMessage(message: string): boolean {
  return /(missing bearer token|unauthori[sz]ed|unauthenticated|forbidden|401)/i.test(
    message
  );
}

// ── Calendar layout ─────────────────────────────────────────────────────────

export interface MonthCell {
  key: string;
  date: Date;
  inCurrentMonth: boolean;
}

export function buildMonthCells(monthDate: Date): MonthCell[] {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const firstWeekday = first.getDay();
  const daysInMonth = new Date(
    monthDate.getFullYear(),
    monthDate.getMonth() + 1,
    0
  ).getDate();
  const result: MonthCell[] = [];

  for (let i = 0; i < firstWeekday; i++) {
    result.push({
      key: `prev-${i}`,
      date: new Date(
        first.getFullYear(),
        first.getMonth(),
        i - firstWeekday + 1
      ),
      inCurrentMonth: false
    });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    result.push({
      key: `cur-${day}`,
      date: new Date(first.getFullYear(), first.getMonth(), day),
      inCurrentMonth: true
    });
  }
  while (result.length % 7 !== 0 || result.length < 35) {
    const nextIndex =
      result.length - (firstWeekday + daysInMonth) + 1;
    result.push({
      key: `next-${nextIndex}`,
      date: new Date(first.getFullYear(), first.getMonth() + 1, nextIndex),
      inCurrentMonth: false
    });
  }
  return result;
}

// ── Timeline helpers ─────────────────────────────────────────────────────────

/** Parse "HH:MM" to minutes-since-midnight. Returns null on invalid input. */
export function parseTimeToMinutes(value?: string): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return hour * 60 + minute;
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// ── Project option helpers ───────────────────────────────────────────────────

/**
 * Merge multiple ProjectOption arrays, deduplicating by projectId.
 * A non-empty projectName wins over an empty/missing one.
 * Result is sorted by projectName (or projectId).
 */
export function mergeProjectOptions(
  ...groups: ProjectOption[][]
): ProjectOption[] {
  const merged = new Map<string, ProjectOption>();
  for (const group of groups) {
    for (const option of group) {
      const id = option.projectId?.trim();
      if (!id) continue;
      const prev = merged.get(id);
      merged.set(id, {
        projectId: id,
        projectName: option.projectName?.trim() || prev?.projectName
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) =>
    (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId)
  );
}

export function filterProjectOptionsByAllowedIds(
  options: ProjectOption[],
  allowedIds: Set<string>
): ProjectOption[] {
  return options.filter((option) => allowedIds.has(option.projectId));
}
