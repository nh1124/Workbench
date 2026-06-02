import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { imagesClient } from "../internalClients.js";
import { getIntegrationConfig } from "../store.js";
import { asMcpText, runWithAuthContext } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

const IMAGE_GENERATION_INTEGRATION_ID = "image_generation";

const imageProviderSchema = z.enum(["auto", "mock", "openai", "nanobanana"]);
const imageIntentSchema = z.enum(["create", "refine", "edit", "context_update"]);
const imageSizeSchema = z.enum(["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024", "auto"]);
const imageQualitySchema = z.enum(["draft", "standard", "high"]);
const imagePreserveSchema = z.enum(["composition", "subject", "style", "colors", "text", "layout"]);
const imageContextRefSchema = z.object({
  kind: z.enum(["project", "artifact", "note", "task", "research", "freeform"]),
  id: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional()
});

const imageGenerationSchema = {
  prompt: z.string().min(1),
  instruction: z.string().optional(),
  negativePrompt: z.string().optional(),
  provider: imageProviderSchema.optional(),
  model: z.string().optional(),
  size: imageSizeSchema.optional(),
  count: z.number().int().min(1).max(4).optional(),
  quality: imageQualitySchema.optional(),
  stylePreset: z.string().optional(),
  seed: z.number().int().optional(),
  referenceImageIds: z.array(z.string()).optional(),
  sourceAssetIds: z.array(z.string()).optional(),
  contextRefs: z.array(imageContextRefSchema).optional(),
  preserve: z.array(imagePreserveSchema).optional(),
  saveToArtifacts: z.boolean().optional(),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
};

function configString(values: Record<string, string | number | boolean>, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function configBoolean(values: Record<string, string | number | boolean>, key: string): boolean | undefined {
  const value = values[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

async function withImageSettings(userId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = await getIntegrationConfig(userId, IMAGE_GENERATION_INTEGRATION_ID);
  const values = config?.values ?? {};
  if (config?.enabled === false) {
    throw new Error("Image Generation is disabled in Settings.");
  }

  return {
    ...payload,
    provider: payload.provider ?? configString(values, "defaultProvider") ?? "auto",
    size: payload.size ?? configString(values, "defaultSize") ?? "1024x1024",
    quality: payload.quality ?? configString(values, "defaultQuality") ?? "standard",
    saveToArtifacts: payload.saveToArtifacts ?? configBoolean(values, "defaultSaveToArtifacts") ?? false,
    providerCredentials: {
      openaiApiKey: configString(values, "openaiApiKey"),
      nanobananaApiKey: configString(values, "nanobananaApiKey"),
      nanobananaApiUrl: configString(values, "nanobananaApiUrl"),
      defaultProvider: configString(values, "defaultProvider") ?? "auto",
      defaultOpenAIModel: configString(values, "defaultOpenAIModel"),
      defaultNanobananaModel: configString(values, "defaultNanobananaModel")
    }
  };
}

export function registerImageTools(server: McpServer, ctx: ToolContext): void;
export function registerImageTools(server: McpServer): void;
export function registerImageTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }

  server.registerTool(
    "images.generate",
    {
      title: "Generate Image",
      description: "Generate image assets from a prompt, optional reference images, or context.",
      inputSchema: imageGenerationSchema
    },
    async (payload) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const request = await withImageSettings(userId, { ...payload, intent: "create" });
        return imagesClient.generate(ctx.accessToken, request);
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "images.refine",
    {
      title: "Refine Image",
      description: "Refine existing image assets while preserving selected visual properties.",
      inputSchema: {
        ...imageGenerationSchema,
        sourceAssetIds: z.array(z.string()).min(1)
      }
    },
    async (payload) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const request = await withImageSettings(userId, { ...payload, intent: "refine" });
        return imagesClient.generate(ctx.accessToken, request);
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "images.contextUpdate",
    {
      title: "Update Image From Context",
      description: "Update an existing image using supplied project, artifact, note, task, research, or freeform context.",
      inputSchema: {
        ...imageGenerationSchema,
        sourceAssetIds: z.array(z.string()).min(1),
        contextRefs: z.array(imageContextRefSchema).min(1)
      }
    },
    async (payload) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const request = await withImageSettings(userId, { ...payload, intent: "context_update" });
        return imagesClient.generate(ctx.accessToken, request);
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "images.status",
    {
      title: "Get Image Job Status",
      description: "Get image generation job status and generated asset ids.",
      inputSchema: {
        jobId: z.string().min(1)
      }
    },
    async ({ jobId }) => {
      const result = await runWithAuthContext(ctx.accessToken, () => imagesClient.getJob(ctx.accessToken, jobId));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "images.history",
    {
      title: "List Image Jobs",
      description: "List recent image generation jobs.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ limit }) => {
      const result = await runWithAuthContext(ctx.accessToken, () => imagesClient.list(ctx.accessToken, limit));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "images.cancel",
    {
      title: "Cancel Image Job",
      description: "Cancel a queued or running image generation job.",
      inputSchema: {
        jobId: z.string().min(1)
      }
    },
    async ({ jobId }) => {
      const result = await runWithAuthContext(ctx.accessToken, () => imagesClient.cancel(ctx.accessToken, jobId));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "images.asset.get",
    {
      title: "Get Image Asset",
      description: "Get generated image asset metadata.",
      inputSchema: {
        assetId: z.string().min(1)
      }
    },
    async ({ assetId }) => {
      const result = await runWithAuthContext(ctx.accessToken, () => imagesClient.getAsset(ctx.accessToken, assetId));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "images.asset.download",
    {
      title: "Download Image Asset",
      description: "Download an image asset as base64 content.",
      inputSchema: {
        assetId: z.string().min(1)
      }
    },
    async ({ assetId }) => {
      const result = await runWithAuthContext(ctx.accessToken, () => imagesClient.downloadAsset(ctx.accessToken, assetId));
      return asMcpText(result);
    }
  );
}
