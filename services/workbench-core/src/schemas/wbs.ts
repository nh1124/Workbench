import { z } from "zod";

/**
 * Shared WBS request contract for the HTTP facade and the MCP tools.
 * See ./images.ts for why these are exported as shapes rather than objects.
 *
 * Two drifts were resolved in favour of the stricter HTTP definition when these
 * were unified: plan and item `title` now reject empty strings on both surfaces.
 */

export const wbsStatusSchema = z.enum(["todo", "doing", "blocked", "done"]);
export const wbsDependencyTypeSchema = z.enum([
  "finish_to_start",
  "start_to_start",
  "finish_to_finish",
  "start_to_finish"
]);
export const wbsExportFormatSchema = z.enum(["json", "markdown", "csv"]);

export const wbsPlanCreateFields = {
  title: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  settings: z.record(z.unknown()).optional()
} as const;

export const wbsPlanUpdateFields = {
  expectedVersion: z.number().int().positive(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  projectId: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  settings: z.record(z.unknown()).optional()
} as const;

export const wbsItemCreateFields = {
  parentId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  ownerLabel: z.string().optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  effortHours: z.number().nonnegative().optional(),
  status: wbsStatusSchema.optional(),
  progress: z.number().int().min(0).max(100).optional()
} as const;

export const wbsItemUpdateFields = {
  expectedVersion: z.number().int().positive(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  ownerLabel: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  effortHours: z.number().nonnegative().nullable().optional(),
  status: wbsStatusSchema.optional(),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  linkedTaskId: z.string().nullable().optional()
} as const;

export const wbsItemMoveFields = {
  expectedVersion: z.number().int().positive(),
  parentId: z.string().nullable().optional(),
  beforeItemId: z.string().optional(),
  afterItemId: z.string().optional()
} as const;

// The WBS service already falls back to finish_to_start, so the default here is
// equivalent to the previously-optional MCP form.
export const wbsDependencyCreateFields = {
  fromItemId: z.string().min(1),
  toItemId: z.string().min(1),
  dependencyType: wbsDependencyTypeSchema.default("finish_to_start"),
  lagDays: z.number().int().optional()
} as const;

export const wbsArtifactSaveFields = {
  format: wbsExportFormatSchema.default("markdown"),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
} as const;

export const wbsPlanCreateSchema = z.object(wbsPlanCreateFields);
export const wbsPlanUpdateSchema = z.object(wbsPlanUpdateFields);
export const wbsItemCreateSchema = z.object(wbsItemCreateFields);
export const wbsItemUpdateSchema = z.object(wbsItemUpdateFields);
export const wbsItemMoveSchema = z.object(wbsItemMoveFields);
export const wbsDependencyCreateSchema = z.object(wbsDependencyCreateFields);
export const wbsArtifactSaveSchema = z.object(wbsArtifactSaveFields);
