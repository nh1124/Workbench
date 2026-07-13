export type DateKey = string;

export type TaskStatus = "todo" | "done" | "skipped";

export type RuleType =
  | "ONCE"
  | "WEEKLY"
  | "EVERY_N_DAYS"
  | "MONTHLY_DAY"
  | "MONTHLY_NTH_WEEKDAY";

export type ExceptionType =
  | "SKIP"
  | "FORCE_DO"
  | "MANUAL_LOCK"
  | "OVERRIDE_LOAD"
  | "RESCHEDULE";

export interface LBSTask {
  task_id: string;
  user_id: string;
  task_name: string;
  context: string;
  base_load_score: number;
  active: boolean;
  rule_type: RuleType;
  due_date: DateKey | null;
  mon: boolean;
  tue: boolean;
  wed: boolean;
  thu: boolean;
  fri: boolean;
  sat: boolean;
  sun: boolean;
  interval_days: number | null;
  anchor_date: DateKey | null;
  month_day: number | null;
  nth_in_month: number | null;
  weekday_mon1: number | null;
  start_date: DateKey | null;
  end_date: DateKey | null;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  external_sync_id: string | null;
  timezone: string | null;
  is_locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface TaskException {
  id: number;
  user_id: string;
  task_id: string;
  target_date: DateKey;
  exception_type: ExceptionType;
  override_load_value: number | null;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  is_locked: boolean;
  created_at: string;
}

export interface TaskExecution {
  id: number;
  user_id: string;
  task_id: string;
  target_date: DateKey;
  status: TaskStatus;
  progress: number;
  actual_time: number | null;
  created_at: string;
}

export interface DailyCondition {
  user_id: string;
  target_date: DateKey;
  cognitive_fatigue: number;
  physical_fatigue: number;
  note: string | null;
  updated_at: string;
}

export interface SystemConfigRow {
  id: number;
  user_id: string;
  key: keyof LBSConfig;
  value: string;
  description: string | null;
  updated_at: string;
}

export interface LBSFixtureInput {
  tasks: LBSTask[];
  task_exceptions: TaskException[];
  task_executions: TaskExecution[];
  daily_conditions: DailyCondition[];
  system_config: SystemConfigRow[];
  ref_today: DateKey;
  reference_user_id: string;
}

export interface LBSConfig {
  ALPHA: number;
  BETA: number;
  SWITCH_COST: number;
  CAP: number;
}

export interface LBSDailyCache {
  user_id: string;
  target_date: DateKey;
  task_id: string;
  calculated_load: number;
  status: TaskStatus;
  is_overflow: boolean;
}

export interface DailyLoadTask {
  task_id: string;
  task_name: string;
  context: string;
  load: number;
  status: TaskStatus;
  start_time: string | null;
  end_time: string | null;
  has_exception: boolean;
  exception_type: ExceptionType | null;
  is_locked: boolean;
}

export type LoadLevel = "SAFE" | "WARNING" | "DANGER" | "CRITICAL";

export interface DailyLoadResult {
  date: DateKey;
  base_load: number;
  task_count: number;
  unique_contexts: number;
  adjusted_load: number;
  raw_adjusted_load?: number;
  count_penalty: number;
  context_penalty: number;
  level: LoadLevel;
  cap: number;
  base_cap: number;
  cognitive_fatigue: number;
  tasks: DailyLoadTask[];
}

export interface WeeklyStats {
  average_load: number;
  recovery_rate: number;
}

export interface TrendRow {
  date: DateKey;
  average_load: number;
  max_load: number;
  min_load: number;
}

export interface ContextDistributionRow {
  date: DateKey;
  total_load: number;
  contexts: Array<{ context: string; load: number }>;
}

export type ExceptionMap = ReadonlyMap<string, TaskException>;
export type ExecutionMap = ReadonlyMap<string, TaskExecution>;
export type ConditionMap = ReadonlyMap<DateKey, number>;
