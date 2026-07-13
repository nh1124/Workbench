export type LbsTaskStatus = "todo" | "done" | "skipped";

export interface LbsScheduleTask {
  task_id: string;
  task_name: string;
  context: string;
  status?: string | null;
  load?: number;
  start_time?: string | null;
  end_time?: string | null;
  is_locked?: boolean | null;
}

export interface LbsScheduleDay {
  date: string;
  total_load?: number;
  base_load?: number;
  cap?: number;
  level?: string;
  tasks: LbsScheduleTask[];
}

export interface LbsBackendContext {
  ownerCoreUserId: string;
  lbsAccessToken?: string;
}

export interface LbsDataPlane {
  listTasks(context?: string, active?: boolean): Promise<Record<string, unknown>[]>;
  getTask(taskId: string, targetDate?: string): Promise<Record<string, unknown>>;
  createTask(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateTask(taskId: string, payload: Record<string, unknown>, forceOverride?: boolean): Promise<Record<string, unknown>>;
  deleteTask(taskId: string, forceOverride?: boolean): Promise<void>;
  bulkDeleteTasks(taskIds: string[], forceOverride?: boolean): Promise<Record<string, unknown>>;
  bulkUpdateActive(taskIds: string[], active: boolean, forceOverride?: boolean): Promise<Record<string, unknown>>;
  resolveTask(taskId: string, targetDate: string): Promise<Record<string, unknown>>;
  completeTask(taskId: string, targetDate: string, status: LbsTaskStatus): Promise<Record<string, unknown>>;
  getTaskHistory(taskId: string, startDate: string, endDate: string): Promise<Record<string, unknown>[]>;
  uploadTasksCsv(csvContent: string): Promise<Record<string, unknown>>;
  exportTasksCsv(): Promise<string>;
  getSchedule(startDate: string, endDate: string): Promise<LbsScheduleDay[]>;
  getDashboard(startDate?: string): Promise<Record<string, unknown>>;
  getHeatmap(start: string, end: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>[]>;
  getTrends(weeks?: number, startDate?: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>>;
  getContextDistribution(start: string, end: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>>;
  calculateLoad(targetDate: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>>;
  forceExpand(startDate: string, endDate: string): Promise<Record<string, unknown>>;
  listExceptions(taskId?: string, startDate?: string, endDate?: string): Promise<Record<string, unknown>[]>;
  createException(payload: Record<string, unknown>, forceOverride?: boolean): Promise<Record<string, unknown>>;
  updateException(exceptionId: number, payload: Record<string, unknown>, forceOverride?: boolean): Promise<Record<string, unknown>>;
  deleteException(exceptionId: number, forceOverride?: boolean): Promise<void>;
  createCondition(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  getCondition(targetDate: string): Promise<Record<string, unknown>>;
  deleteCondition(targetDate: string): Promise<void>;
  healthCheck(): Promise<Record<string, unknown>>;
}
