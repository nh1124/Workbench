import { LbsClient, type LbsClientConfig } from "../lbsClient.js";
import { LocalLbsBackend } from "./localBackend.js";
import type { LbsBackendContext, LbsDataPlane } from "./dataPlane.js";
import type { LbsStoreDatabase } from "./storeUtils.js";

const defaultTimezone = "Asia/Tokyo";

export type TasksLbsMode = "remote" | "local";

export interface LbsConfig {
  baseUrl: string;
  authBaseUrl: string;
  authLoginPath: string;
  authUserCreatePath: string;
  accountPasswordSeed: string;
  apiKey?: string;
  token?: string;
  timezone: string;
  forceOverride: boolean;
  defaultActive: boolean;
}

export interface LbsBackendFactoryDependencies {
  database?: LbsStoreDatabase;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getTasksLbsMode(): TasksLbsMode {
  const mode = process.env.TASKS_LBS_MODE?.trim().toLowerCase() || "remote";
  if (mode !== "remote" && mode !== "local") throw new Error(`Invalid TASKS_LBS_MODE: ${mode}`);
  return mode;
}

export function getLbsConfig(): LbsConfig {
  const mode = getTasksLbsMode();
  const baseUrl = mode === "remote" ? requireEnv("TASKS_LBS_BASE_URL").replace(/\/+$/, "") : "";
  const authBaseUrl = mode === "remote"
    ? (process.env.TASKS_LBS_AUTH_BASE_URL?.trim() || baseUrl).replace(/\/+$/, "")
    : "";
  return {
    baseUrl,
    authBaseUrl,
    authLoginPath: process.env.TASKS_LBS_AUTH_LOGIN_PATH?.trim() || "/auth/login",
    authUserCreatePath: process.env.TASKS_LBS_AUTH_USER_CREATE_PATH?.trim() || "/users/",
    accountPasswordSeed: process.env.TASKS_LBS_ACCOUNT_PASSWORD_SEED?.trim() || "workbench-tasks-lbs-seed",
    apiKey: process.env.TASKS_LBS_API_KEY?.trim() || undefined,
    token: process.env.TASKS_LBS_AUTH_TOKEN?.trim() || undefined,
    timezone: mode === "local"
      ? process.env.TASKS_TIMEZONE?.trim() || defaultTimezone
      : process.env.TASKS_LBS_TIMEZONE?.trim() || process.env.TASKS_TIMEZONE?.trim() || defaultTimezone,
    forceOverride: (process.env.TASKS_LBS_FORCE_OVERRIDE ?? "true").toLowerCase() !== "false",
    defaultActive: (process.env.TASKS_LBS_DEFAULT_ACTIVE ?? "true").toLowerCase() !== "false"
  };
}

function toClientConfig(config: LbsConfig): LbsClientConfig {
  return {
    baseUrl: config.baseUrl,
    authBaseUrl: config.authBaseUrl,
    authLoginPath: config.authLoginPath,
    authUserCreatePath: config.authUserCreatePath,
    timezone: config.timezone,
    apiKey: config.apiKey,
    sharedToken: config.token
  };
}

export function getLbsBackend(
  { ownerCoreUserId, lbsAccessToken }: LbsBackendContext,
  dependencies: LbsBackendFactoryDependencies = {}
): LbsDataPlane {
  if (getTasksLbsMode() === "local") return new LocalLbsBackend(ownerCoreUserId, dependencies.database);
  return new LbsClient(toClientConfig(getLbsConfig()), lbsAccessToken);
}
