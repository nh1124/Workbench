import { ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type {
  AnalyserMachineRecord,
  AnalyserObservationSource
} from "../../types/models";

export const SOURCES: AnalyserObservationSource[] = [
  "workbench_change",
  "mcp_access",
  "ui_access",
  "agent_session",
  "pc_activity",
  "local_file"
];
export const OBSERVATION_PAGE_SIZE = 50;
export const ANALYSER_PAGE_SIZE = 50;

export function label(value: string): string {
  return value.replaceAll("_", " ");
}

export function optionalDate(value: string | undefined): string {
  return value ? formatDateTime(value) : "—";
}

export function machineName(machine: AnalyserMachineRecord): string {
  return machine.displayName?.trim() || machine.machineKey;
}

export function isAnalyserNotConfigured(error: unknown): boolean {
  return error instanceof ApiError
    ? error.status === 503 && error.code === "ANALYSER_NOT_CONFIGURED"
    : error instanceof Error && /analyser service is not configured/i.test(error.message);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "VERSION_CONFLICT";
}


export function compactValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

