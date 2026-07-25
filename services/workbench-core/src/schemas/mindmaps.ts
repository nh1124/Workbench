import { z } from "zod";

/**
 * Shared Mindmap request contract for the HTTP facade and the MCP tools.
 * See ./images.ts for why these are exported as shapes rather than objects.
 */

export const mindmapModeSchema = z.enum(["mindmap", "logical_tree"]);
export const mindmapExportFormatSchema = z.enum(["json", "markdown", "svg"]);

export const mindmapCreateFields = {
  title: z.string().min(1),
  description: z.string().optional(),
  mode: mindmapModeSchema.optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  body: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  template: z.enum(["blank", "mindmap", "logical_tree"]).optional()
} as const;

export const mindmapUpdateFields = {
  title: z.string().optional(),
  description: z.string().optional(),
  mode: mindmapModeSchema.optional(),
  projectId: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  body: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  expectedVersion: z.number().int().positive().optional()
} as const;

export const mindmapArtifactSaveFields = {
  format: mindmapExportFormatSchema.default("markdown"),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
} as const;

export const mindmapCreateSchema = z.object(mindmapCreateFields);
export const mindmapUpdateSchema = z.object(mindmapUpdateFields);
export const mindmapArtifactSaveSchema = z.object(mindmapArtifactSaveFields);
