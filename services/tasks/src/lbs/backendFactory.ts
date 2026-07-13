import { LocalLbsBackend } from "./localBackend.js";
import type { LbsBackendContext, LbsDataPlane } from "./dataPlane.js";
import type { LbsStoreDatabase } from "./storeUtils.js";

const defaultTimezone = "Asia/Tokyo";

export type TasksLbsMode = "local";

export interface LbsConfig {
  timezone: string;
  forceOverride: boolean;
  defaultActive: boolean;
}

export interface LbsBackendFactoryDependencies {
  database?: LbsStoreDatabase;
}

export function getTasksLbsMode(): TasksLbsMode {
  const mode = process.env.TASKS_LBS_MODE?.trim().toLowerCase() || "local";
  if (mode === "remote") {
    throw new Error(
      "TASKS_LBS_MODE=remote is no longer supported. Migrate production data first; " +
      "see scripts/lbs-migrate/README.md before deploying this version."
    );
  }
  if (mode !== "local") throw new Error(`Invalid TASKS_LBS_MODE: ${mode}`);
  return "local";
}

export function getLbsConfig(): LbsConfig {
  getTasksLbsMode();
  return {
    timezone: process.env.TASKS_TIMEZONE?.trim() || defaultTimezone,
    forceOverride: true,
    defaultActive: true
  };
}

export function getLbsBackend(
  { ownerCoreUserId }: LbsBackendContext,
  dependencies: LbsBackendFactoryDependencies = {}
): LbsDataPlane {
  getTasksLbsMode();
  return new LocalLbsBackend(ownerCoreUserId, dependencies.database);
}
