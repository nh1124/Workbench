import express from "express";
import { z } from "zod";
import {
  artifactsClient,
  imagesClient,
  notesClient,
  projectsClient,
  serviceBaseUrls,
  tasksClient
} from "../internalClients.js";
import {
  requireAuthenticatedContext,
  type AuthenticatedContext
} from "../middleware/auth.js";
import {
  listArtifactProjectIdsBestEffort,
  uploadArtifactFileWithIndex
} from "../projectContext.js";
import {
  imageArtifactSaveSchema,
  imageContextRefSchema,
  imageGenerationRequestSchema,
  imageRetryRequestSchema
} from "../schemas/images.js";
import { ensureImagesAccountProvisioned } from "../serviceProvisioning.js";
import { getIntegrationConfig } from "../store.js";
import {
  invalidateArtifactIndexFromApi,
  respondInternalError
} from "./shared.js";

type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
type ImageProviderChoice = "auto" | "mock" | "openai" | "nanobanana";
type ImageQualityChoice = "draft" | "standard" | "high";
type ImageSizeChoice = "512x512" | "768x768" | "1024x1024" | "1024x1536" | "1536x1024" | "auto";

const IMAGE_GENERATION_INTEGRATION_ID = "image_generation";

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

function pickImageProvider(value: string | undefined): ImageProviderChoice | undefined {
  if (value === "auto" || value === "mock" || value === "openai" || value === "nanobanana") return value;
  return undefined;
}

function pickImageQuality(value: string | undefined): ImageQualityChoice | undefined {
  if (value === "draft" || value === "standard" || value === "high") return value;
  return undefined;
}

function pickImageSize(value: string | undefined): ImageSizeChoice | undefined {
  if (
    value === "512x512" ||
    value === "768x768" ||
    value === "1024x1024" ||
    value === "1024x1536" ||
    value === "1536x1024" ||
    value === "auto"
  ) {
    return value;
  }
  return undefined;
}

async function resolveImageSettings(userId: string): Promise<{
  enabled: boolean;
  defaults: {
    provider: ImageProviderChoice;
    size: ImageSizeChoice;
    quality: ImageQualityChoice;
    count: number;
    saveToArtifacts: boolean;
  };
  providerCredentials: {
    openaiApiKey?: string;
    nanobananaApiKey?: string;
    defaultProvider?: ImageProviderChoice;
    defaultOpenAIModel?: string;
    defaultNanobananaModel?: string;
  };
}> {
  const config = await getIntegrationConfig(userId, IMAGE_GENERATION_INTEGRATION_ID);
  const values = config?.values ?? {};
  const provider = pickImageProvider(configString(values, "defaultProvider")) ?? "auto";
  const size = pickImageSize(configString(values, "defaultSize")) ?? "1024x1024";
  const quality = pickImageQuality(configString(values, "defaultQuality")) ?? "standard";
  const countRaw = Number(configString(values, "defaultCount") ?? "1");
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(8, Math.round(countRaw))) : 1;
  const saveToArtifacts = configBoolean(values, "defaultSaveToArtifacts") ?? false;

  return {
    enabled: config?.enabled ?? true,
    defaults: {
      provider,
      size,
      quality,
      count,
      saveToArtifacts
    },
    providerCredentials: {
      openaiApiKey: configString(values, "openaiApiKey"),
      nanobananaApiKey: configString(values, "nanobananaApiKey"),
      defaultProvider: provider,
      defaultOpenAIModel: configString(values, "defaultOpenAIModel"),
      defaultNanobananaModel: configString(values, "defaultNanobananaModel")
    }
  };
}

function textPreview(raw: unknown, maxLength = 900): string | undefined {
  if (typeof raw !== "string") return undefined;
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxLength ? `${compact.slice(0, maxLength).trim()}...` : compact;
}

async function resolveOneImageContextRef(
  token: string,
  ref: z.infer<typeof imageContextRefSchema>
): Promise<z.infer<typeof imageContextRefSchema>> {
  if (!ref.id || ref.kind === "freeform" || ref.kind === "research") {
    return ref;
  }

  try {
    if (ref.kind === "artifact") {
      const raw = await artifactsClient.getItem(token, ref.id);
      const record = raw as Record<string, unknown>;
      return {
        ...ref,
        title: ref.title ?? (typeof record.title === "string" ? record.title : undefined),
        path: ref.path ?? (typeof record.path === "string" ? record.path : undefined),
        content: ref.content ?? textPreview(record.contentMarkdown)
      };
    }
    if (ref.kind === "note") {
      const raw = await notesClient.get(token, ref.id);
      const record = raw as Record<string, unknown>;
      return {
        ...ref,
        title: ref.title ?? (typeof record.title === "string" ? record.title : undefined),
        content: ref.content ?? textPreview(record.content)
      };
    }
    if (ref.kind === "task") {
      const raw = await tasksClient.get(token, ref.id);
      const record = raw as Record<string, unknown>;
      const notes = typeof record.notes === "string" ? record.notes : undefined;
      const title = typeof record.title === "string" ? record.title : undefined;
      return {
        ...ref,
        title: ref.title ?? title,
        content: ref.content ?? textPreview([title, notes].filter(Boolean).join("\n"))
      };
    }
    if (ref.kind === "project") {
      const raw = await projectsClient.get(token, ref.id);
      const record = raw as Record<string, unknown>;
      return {
        ...ref,
        title: ref.title ?? (typeof record.name === "string" ? record.name : undefined),
        content: ref.content ?? textPreview(record.description)
      };
    }
  } catch {
    return ref;
  }

  return ref;
}

async function buildImageContextSnapshot(
  token: string,
  refs: z.infer<typeof imageContextRefSchema>[] | undefined
): Promise<{ refs: z.infer<typeof imageContextRefSchema>[]; summary?: string } | undefined> {
  if (!refs?.length) {
    return undefined;
  }
  const resolved = await Promise.all(refs.map((ref) => resolveOneImageContextRef(token, ref)));
  const summary = resolved
    .map((ref) => [ref.kind, ref.title, ref.path, ref.content].filter(Boolean).join(": "))
    .filter((line) => line.trim().length > 0)
    .join("\n");
  return {
    refs: resolved,
    summary: summary || undefined
  };
}

function applyImageSettings(
  input: ImageGenerationRequest,
  settings: Awaited<ReturnType<typeof resolveImageSettings>>,
  contextSnapshot?: Awaited<ReturnType<typeof buildImageContextSnapshot>>
): ImageGenerationRequest & {
  contextSnapshot?: Awaited<ReturnType<typeof buildImageContextSnapshot>>;
  providerCredentials: Awaited<ReturnType<typeof resolveImageSettings>>["providerCredentials"];
} {
  return {
    ...input,
    provider: input.provider ?? settings.defaults.provider,
    size: input.size ?? settings.defaults.size,
    quality: input.quality ?? settings.defaults.quality,
    count: input.count ?? settings.defaults.count,
    saveToArtifacts: input.saveToArtifacts ?? settings.defaults.saveToArtifacts,
    contextSnapshot,
    providerCredentials: settings.providerCredentials
  };
}

function slugifyFileName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "generated-image";
}

function splitArtifactPath(pathValue: string | undefined): { directoryPath?: string; filename?: string } {
  const normalized = pathValue?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return {};
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.pop();
  const directoryPath = parts.length > 0 ? parts.join("/") : undefined;
  return { directoryPath, filename };
}

async function saveImageAssetToArtifacts(
  authContext: AuthenticatedContext,
  assetId: string,
  options: {
    artifactTitle?: string;
    artifactPath?: string;
    projectId?: string;
    projectName?: string;
  }
): Promise<unknown> {
  const assetData = await imagesClient.downloadAsset(authContext.accessToken, assetId, false);
  const { directoryPath, filename } = splitArtifactPath(options.artifactPath);
  const extension = assetData.mimeType.includes("jpeg") ? "jpg" : assetData.mimeType.includes("webp") ? "webp" : "png";
  const uploadFilename =
    filename ??
    `${slugifyFileName(options.artifactTitle ?? assetData.fileName.replace(/\.[^.]+$/, ""))}.${extension}`;

  const created = await uploadArtifactFileWithIndex(authContext.accessToken, {
    projectId: options.projectId,
    projectName: options.projectName,
    directoryPath,
    scope: "project",
    tags: ["image-generation", "generated"],
    filename: uploadFilename,
    mimeType: assetData.mimeType,
    contentBase64: assetData.contentBase64
  });

  const record = created as Record<string, unknown>;
  const artifactItemId = typeof record.id === "string" ? record.id : undefined;
  const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, created);
  await invalidateArtifactIndexFromApi(authContext.userId, projectIds, artifactItemId ?? "unknown");
  if (artifactItemId) {
    await imagesClient.attachArtifact(authContext.accessToken, assetId, {
      artifactItemId,
      artifactItemPath: typeof record.path === "string" ? record.path : undefined,
      artifactTitle: typeof record.title === "string" ? record.title : options.artifactTitle,
      projectId: typeof record.projectId === "string" ? record.projectId : options.projectId,
      projectName: typeof record.projectName === "string" ? record.projectName : options.projectName
    });
  }
  return created;
}

async function autoSaveCompletedImageAssets(
  authContext: AuthenticatedContext,
  result: unknown,
  request: ImageGenerationRequest
): Promise<unknown> {
  const record = result as { assets?: Array<{ id?: unknown }> };
  const assetIds = Array.isArray(record.assets)
    ? record.assets.map((asset) => (typeof asset.id === "string" ? asset.id : undefined)).filter((id): id is string => Boolean(id))
    : [];
  if (assetIds.length === 0) {
    return result;
  }

  const artifactRefs: unknown[] = [];
  for (let index = 0; index < assetIds.length; index += 1) {
    const suffix = assetIds.length > 1 ? `-${index + 1}` : "";
    const artifact = await saveImageAssetToArtifacts(authContext, assetIds[index], {
      artifactTitle: request.artifactTitle,
      artifactPath: request.artifactPath ? request.artifactPath.replace(/(\.[^.\/]+)?$/, `${suffix}$1`) : undefined,
      projectId: request.projectId,
      projectName: request.projectName
    });
    artifactRefs.push(artifact);
  }
  return {
    ...(result as Record<string, unknown>),
    artifactRefs
  };
}

export function registerImageRoutes(app: express.Express): void {
app.get("/api/images/defaults", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const settings = await resolveImageSettings(authContext.userId);
    const serviceDefaults = (await imagesClient.defaults(authContext.accessToken)) as Record<string, unknown>;
    const serviceDefaultValues = (serviceDefaults.defaults as Record<string, unknown> | undefined) ?? {};
    const serviceAvailableModels =
      (serviceDefaults.availableModels as Record<string, Array<{ id?: unknown }>> | undefined) ?? {};
    const firstServiceModel = (providerId: string): string | undefined => {
      const first = serviceAvailableModels[providerId]?.[0]?.id;
      return typeof first === "string" ? first : undefined;
    };
    const configuredServiceModel = (providerId: string, configured: string | undefined): string | undefined => {
      if (!configured) return undefined;
      const options = serviceAvailableModels[providerId] ?? [];
      return options.some((option) => option.id === configured) ? configured : undefined;
    };
    const provider = settings.defaults.provider;
    const model =
      provider === "openai"
        ? configuredServiceModel("openai", settings.providerCredentials.defaultOpenAIModel) ?? firstServiceModel("openai")
        : provider === "nanobanana"
          ? configuredServiceModel("nanobanana", settings.providerCredentials.defaultNanobananaModel) ?? firstServiceModel("nanobanana")
          : typeof serviceDefaultValues.model === "string"
            ? serviceDefaultValues.model
            : "workbench-mock-image";

    return res.json({
      ...serviceDefaults,
      enabled: settings.enabled,
      defaults: {
        ...serviceDefaultValues,
        provider,
        model,
        size: settings.defaults.size,
        quality: settings.defaults.quality,
        count: settings.defaults.count,
        saveToArtifacts: settings.defaults.saveToArtifacts
      },
      availableProviders: {
        mock: true,
        openai: Boolean(settings.providerCredentials.openaiApiKey),
        nanobanana: Boolean(settings.providerCredentials.nanobananaApiKey)
      }
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/references", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const target = `${serviceBaseUrls.images}/images/references`;
  const contentType = req.header("content-type");
  try {
    await ensureImagesAccountProvisioned(authContext);
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) res.setHeader("Content-Type", responseContentType);
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reference upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.post("/api/images/generations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = imageGenerationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureImagesAccountProvisioned(authContext);
    const settings = await resolveImageSettings(authContext.userId);
    if (!settings.enabled) {
      return res.status(400).json({ message: "Image Generation is disabled in Settings.", code: "IMAGE_GENERATION_DISABLED" });
    }
    const contextSnapshot = await buildImageContextSnapshot(authContext.accessToken, parsed.data.contextRefs);
    const payload = applyImageSettings(parsed.data, settings, contextSnapshot);
    const generated = await imagesClient.generate(authContext.accessToken, payload);
    const result = payload.saveToArtifacts
      ? await autoSaveCompletedImageAssets(authContext, generated, payload)
      : generated;
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/generations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.list(authContext.accessToken, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/generations/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.getJob(authContext.accessToken, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/generations/:jobId/cancel", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.cancel(authContext.accessToken, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/images/generations/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    await imagesClient.deleteJob(authContext.accessToken, String(req.params.jobId));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/generations/:jobId/retry", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = imageRetryRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureImagesAccountProvisioned(authContext);
    const settings = await resolveImageSettings(authContext.userId);
    if (!settings.enabled) {
      return res.status(400).json({ message: "Image Generation is disabled in Settings.", code: "IMAGE_GENERATION_DISABLED" });
    }
    const contextSnapshot = await buildImageContextSnapshot(authContext.accessToken, parsed.data.contextRefs);
    const payload = applyImageSettings(parsed.data as ImageGenerationRequest, settings, contextSnapshot);
    const generated = await imagesClient.retry(authContext.accessToken, String(req.params.jobId), payload);
    const result = payload.saveToArtifacts
      ? await autoSaveCompletedImageAssets(authContext, generated, payload)
      : generated;
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/assets/:assetId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.getAsset(authContext.accessToken, String(req.params.assetId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/assets/:assetId/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const assetId = encodeURIComponent(String(req.params.assetId));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") query.set("download", req.query.download);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.images}/images/assets/${assetId}/download${suffix}`;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${authContext.accessToken}` }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image download proxy failed";
    return res.status(502).json({ message });
  }
});

app.delete("/api/images/assets/:assetId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    await imagesClient.deleteAsset(authContext.accessToken, String(req.params.assetId));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/assets/:assetId/artifact", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = imageArtifactSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureImagesAccountProvisioned(authContext);
    const artifact = await saveImageAssetToArtifacts(authContext, String(req.params.assetId), parsed.data);
    return res.status(201).json({ status: "ok", artifact });
  } catch (error) {
    return respondInternalError(res, error);
  }
});
}
