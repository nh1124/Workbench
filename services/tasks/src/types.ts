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
  // monthly
  monthDay?: number;
  nthInMonth?: number;
  weekdayMon1?: number;
  createdAt: string;
  updatedAt: string;
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
