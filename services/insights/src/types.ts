import { z } from "zod";

export const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a valid calendar date");
export const timestampSchema = z.string().datetime({ offset: true });
export const jsonObjectSchema = z.record(z.unknown());

export const machineRegisterSchema = z.object({
  machineKey: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255).optional(),
  platform: z.string().trim().min(1).max(100).optional()
}).strict();
export const sampleIngestSchema = z.object({
  machineId: z.string().uuid(),
  samples: z.array(z.object({
    sampledAt: timestampSchema, processName: z.string().min(1), windowTitle: z.string(), idle: z.boolean().optional()
  }).strict()).max(500)
}).strict();
export const summaryIngestSchema = z.object({
  machineId: z.string().uuid(),
  summaries: z.array(z.object({
    summaryDate: dateSchema, summaryMarkdown: z.string(), metricsJson: jsonObjectSchema.optional(),
    sampleCount: z.number().int().nonnegative().optional(), generatedAt: timestampSchema
  }).strict()).max(50)
}).strict();
export const derivedCreateSchema = z.object({
  machineId: z.string().uuid().optional(), observedDate: dateSchema,
  kind: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(500),
  contentMarkdown: z.string(), payloadJson: jsonObjectSchema.optional()
}).strict();

export interface MachineRecord {
  id: string; machineKey: string; displayName?: string; platform?: string; registeredAt: string; lastSeenAt: string;
}
export interface ActivitySampleInput { sampledAt: string; processName: string; windowTitle: string; idle?: boolean }
export interface ActivitySummaryInput {
  summaryDate: string; summaryMarkdown: string; metricsJson?: Record<string, unknown>; sampleCount?: number; generatedAt: string;
}
export interface SummaryMetadataRecord {
  machineId: string; summaryDate: string; metricsJson?: Record<string, unknown>;
  sampleCount: number; generatedAt: string; updatedAt: string;
}
export interface SummaryRecord extends SummaryMetadataRecord { summaryMarkdown: string }
export interface DerivedObservationRecord {
  id: string; machineId?: string; observedDate: string; kind: string; title: string;
  contentMarkdown: string; payloadJson?: Record<string, unknown>; createdAt: string;
}
export interface ActivityAggregate {
  totals: { activeSeconds: number; idleSeconds: number; contextSwitches: number };
  categories: Record<string, number>; apps: Record<string, number>;
  days: Array<{ date: string; machineId: string; activeSeconds: number; contextSwitches: number }>;
}
