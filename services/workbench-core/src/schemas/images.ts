import { z } from "zod";

/**
 * Single source of truth for the image generation contract.
 *
 * Both the HTTP facade and the MCP tools validate the same request, so keeping
 * two copies let them drift silently (the MCP surface was missing
 * `sourceArtifactItemIds` even though the Images service supports it).
 *
 * MCP registers tools from a raw ZodRawShape, while Express validates with a
 * ZodObject, so the shared definition is exported as a shape and wrapped where
 * an object is needed.
 */

export const imageProviderSchema = z.enum(["auto", "mock", "openai", "nanobanana"]);
export const imageIntentSchema = z.enum(["create", "refine", "edit", "context_update"]);
export const imageSizeSchema = z.enum(["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024", "auto"]);
export const imageQualitySchema = z.enum(["draft", "standard", "high"]);
export const imagePreserveSchema = z.enum(["composition", "subject", "style", "colors", "text", "layout"]);

export const imageContextRefSchema = z.object({
  kind: z.enum(["project", "artifact", "note", "task", "research", "freeform"]),
  id: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional()
});

/**
 * Fields a caller may supply. `intent` is deliberately excluded: the MCP tools
 * derive it from which tool was invoked, so exposing it there would let callers
 * contradict the tool they called. The HTTP schema below adds it back.
 */
export const imageGenerationFields = {
  prompt: z.string().min(1),
  instruction: z.string().optional(),
  negativePrompt: z.string().optional(),
  provider: imageProviderSchema.optional(),
  model: z.string().optional(),
  size: imageSizeSchema.optional(),
  count: z.number().int().min(1).max(8).optional(),
  quality: imageQualitySchema.optional(),
  stylePreset: z.string().optional(),
  seed: z.number().int().optional(),
  referenceImageIds: z.array(z.string()).optional(),
  sourceAssetIds: z.array(z.string()).optional(),
  sourceArtifactItemIds: z.array(z.string()).optional(),
  contextRefs: z.array(imageContextRefSchema).optional(),
  preserve: z.array(imagePreserveSchema).optional(),
  saveToArtifacts: z.boolean().optional(),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
} as const;

export const imageGenerationRequestSchema = z.object({
  intent: imageIntentSchema.optional(),
  ...imageGenerationFields
});

export const imageRetryRequestSchema = imageGenerationRequestSchema.partial();

export const imageArtifactSaveSchema = z.object({
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});
