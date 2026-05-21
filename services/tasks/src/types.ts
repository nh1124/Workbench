export const TASK_STATUSES = ["todo", "done", "skipped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RECURRENCE_TYPES = ["ONCE", "WEEKLY", "EVERY_N_DAYS", "MONTHLY_DAY", "MONTHLY_NTH_WEEKDAY"] as const;
export type RecurrenceType = (typeof RECURRENCE_TYPES)[number];

export interface Task {
  id: string;
  title: string;
  notes: string;
  context: string;
  contextName?: string;
  isPinned?: boolean;
  status: TaskStatus;
  isLocked: boolean;
  baseLoadScore: number;
  recurrence: RecurrenceType;
  dueDate?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  activeFrom?: string;
  activeUntil?: string;
  active: boolean;
  // weekly recurrence
  mon?: boolean;
  tue?: boolean;
  wed?: boolean;
  thu?: boolean;
  fri?: boolean;
  sat?: boolean;
  sun?: boolean;
  // every-n-days
  intervalDays?: number;
  anchorDate?: string;
  // monthly
  monthDay?: number;
  nthInMonth?: number;
  weekdayMon1?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A scheduled occurrence of a task (from task_occurrence_schedule).
 * occurrenceDate = LBS execution date (for completion).
 * scheduledDate  = the calendar date the user planned to work on it.
 */
export interface ScheduleItem {
  id: number;
  taskId: string;
  occurrenceDate: string;
  scheduledDate: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A Task enriched with schedule information.
 * occurrenceDate = LBS execution date used when completing the task.
 * scheduledDate  = the calendar date this item appears on (Today / Schedule calendar).
 * scheduleId is present when the item comes from an explicit schedule entry;
 * undefined when it is an LBS-auto-shown task (occurrence_date = today, no entry in DB).
 */
export interface TodayTask extends Task {
  occurrenceDate: string;
  scheduledDate: string;
  scheduleId?: number;
  startTime?: string;
  endTime?: string;
  timezone?: string;
}

export interface ScheduleCalendarItem {
  scheduleId?: number;
  taskId: string;
  title: string;
  context: string;
  status: TaskStatus;
  occurrenceDate: string;
  scheduledDate: string;
  load?: number;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  isLocked?: boolean;
}

export interface ScheduleCalendarDay {
  date: string;
  items: ScheduleCalendarItem[];
}

export interface TaskInput {
  title: string;
  notes?: string;
  context: string;
  contextName?: string;
  status?: TaskStatus;
  isLocked?: boolean;
  baseLoadScore?: number;
  recurrence?: RecurrenceType;
  dueDate?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  activeFrom?: string;
  activeUntil?: string;
  active?: boolean;
  mon?: boolean;
  tue?: boolean;
  wed?: boolean;
  thu?: boolean;
  fri?: boolean;
  sat?: boolean;
  sun?: boolean;
  intervalDays?: number;
  anchorDate?: string;
  monthDay?: number;
  nthInMonth?: number;
  weekdayMon1?: number;
}

export interface TaskProjectSummary {
  projectId: string;
  projectName?: string;
  taskCount: number;
  latestUpdatedAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: string;
}

export interface TaskSubtask {
  id: string;
  taskId: string;
  occurrenceDate: string;
  title: string;
  isDone: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskHistoryEntry {
  id: string | number;
  taskId: string;
  targetDate: string;
  status: string;
  createdAt: string;
}

export interface TaskScheduleItem {
  taskId: string;
  title: string;
  context: string;
  status: TaskStatus;
  load?: number;
  startTime?: string;
  endTime?: string;
  isLocked?: boolean;
}

export interface TaskScheduleDay {
  date: string;
  totalLoad?: number;
  baseLoad?: number;
  cap?: number;
  level?: string;
  tasks: TaskScheduleItem[];
}
