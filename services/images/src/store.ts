import { randomUUID } from "node:crypto";
import { ensureImagesSchema, getImagesPool } from "./db.js";
import { deleteImageBuffer, putImageBuffer, readImageBuffer } from "./storage.js";
import { adapterCapabilities, normalizeImageSize, providerModelOptions, resolveModel, resolveProvider, runProvider } from "./providers/index.js";
import { ImageProviderError } from "./providers/types.js";
import type {
  ImageAssetRecord,
  ImageDefaultsResponse,
  ImageGenerationInput,
  ImageJobRecord,
  ImageJobStatus,
  ImageProgress,
  ImageReferencePurpose,
  ImageReferenceRecord,
  ImageSize,
  ResolvedImageProvider
} from "./types.js";
import type { ProviderImageInput } from "./providers/types.js";

type JsonRecord = Record<string, unknown>;

type ImageJobRow = {
  id: string;
  owner_core_user_id: string;
  status: ImageJobStatus;
  intent: string;
  parent_job_id: string | null;
  provider: ResolvedImageProvider;
  model: string;
  prompt: string;
  instruction: string | null;
  negative_prompt: string | null;
  request_json: JsonRecord;
  context_snapshot_json: JsonRecord;
  progress_json: JsonRecord;
  error_code: string | null;
  error_message: string | null;
  save_to_artifacts: boolean;
  project_id: string | null;
  project_name: string | null;
  artifact_title: string | null;
  artifact_path: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

type ImageAssetRow = {
  id: string;
  job_id: string;
  owner_core_user_id: string;
  source_asset_id: string | null;
  source_reference_id: string | null;
  index_in_job: number;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  original_provider_url: string | null;
  metadata_json: JsonRecord;
  artifact_item_id: string | null;
  artifact_item_path: string | null;
  artifact_title: string | null;
  project_id: string | null;
  project_name: string | null;
  created_at: string;
  deleted_at: string | null;
};

type ImageReferenceRow = {
  id: string;
  owner_core_user_id: string;
  purpose: ImageReferencePurpose;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  project_id: string | null;
  metadata_json: JsonRecord;
  created_at: string;
  deleted_at: string | null;
};

export class ImageServiceError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function normalizeOwner(ownerCoreUserId: string): string {
  const owner = ownerCoreUserId.trim();
  if (!owner) {
    throw new Error("Owner is required");
  }
  return owner;
}

function dateOrUndefined(value: string | null): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function parseProgress(raw: JsonRecord): ImageProgress {
  const stage = typeof raw.stage === "string" ? raw.stage : "queued";
  const percent = typeof raw.percent === "number" ? raw.percent : 0;
  const message = typeof raw.message === "string" ? raw.message : "Queued";
  if (
    stage === "queued" ||
    stage === "provider_running" ||
    stage === "saving_assets" ||
    stage === "completed" ||
    stage === "failed" ||
    stage === "cancelled"
  ) {
    return {
      stage,
      percent: Math.max(0, Math.min(100, percent)),
      message
    };
  }
  return { stage: "queued", percent: 0, message };
}

function toAsset(row: ImageAssetRow): ImageAssetRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    sourceAssetId: row.source_asset_id ?? undefined,
    sourceReferenceId: row.source_reference_id ?? undefined,
    indexInJob: row.index_in_job,
    mimeType: row.mime_type,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    metadata: row.metadata_json ?? {},
    artifactItemId: row.artifact_item_id ?? undefined,
    artifactItemPath: row.artifact_item_path ?? undefined,
    artifactTitle: row.artifact_title ?? undefined,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    deletedAt: dateOrUndefined(row.deleted_at),
    downloadUrl: `/api/images/assets/${encodeURIComponent(row.id)}/download`
  };
}

function toReference(row: ImageReferenceRow): ImageReferenceRecord {
  return {
    id: row.id,
    purpose: row.purpose,
    mimeType: row.mime_type,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    projectId: row.project_id ?? undefined,
    metadata: row.metadata_json ?? {},
    createdAt: new Date(row.created_at).toISOString(),
    deletedAt: dateOrUndefined(row.deleted_at)
  };
}

function toJob(row: ImageJobRow, assets: ImageAssetRecord[]): ImageJobRecord {
  return {
    jobId: row.id,
    status: row.status,
    intent:
      row.intent === "refine" || row.intent === "edit" || row.intent === "context_update" ? row.intent : "create",
    parentJobId: row.parent_job_id ?? undefined,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    instruction: row.instruction ?? undefined,
    negativePrompt: row.negative_prompt ?? undefined,
    request: row.request_json ?? {},
    contextSnapshot:
      row.context_snapshot_json && Object.keys(row.context_snapshot_json).length > 0
        ? {
            refs: Array.isArray(row.context_snapshot_json.refs) ? row.context_snapshot_json.refs as never : [],
            summary: typeof row.context_snapshot_json.summary === "string" ? row.context_snapshot_json.summary : undefined
          }
        : undefined,
    progress: parseProgress(row.progress_json ?? {}),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    saveToArtifacts: row.save_to_artifacts,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    artifactTitle: row.artifact_title ?? undefined,
    artifactPath: row.artifact_path ?? undefined,
    assets,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    startedAt: dateOrUndefined(row.started_at),
    completedAt: dateOrUndefined(row.completed_at),
    cancelledAt: dateOrUndefined(row.cancelled_at)
  };
}

function imageDimensions(buffer: Buffer, mimeType: string): { width?: number; height?: number } {
  if (mimeType === "image/png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (mimeType === "image/jpeg" && buffer.length > 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }
      offset += 2 + length;
    }
  }

  return {};
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized;
}

function ensureAllowedImageMime(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") {
    return normalized;
  }
  throw new ImageServiceError("Only PNG, JPEG, and WebP images are supported", "INVALID_INPUT", 400);
}

function providerInputFileName(id: string, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  return `${id}.${extension}`;
}

async function listAssetsForJobs(owner: string, jobIds: string[]): Promise<Map<string, ImageAssetRecord[]>> {
  const map = new Map<string, ImageAssetRecord[]>();
  if (jobIds.length === 0) return map;
  const pool = getImagesPool();
  const result = await pool.query<ImageAssetRow>(
    `
      SELECT *
      FROM image_assets
      WHERE owner_core_user_id = $1 AND job_id = ANY($2::text[]) AND deleted_at IS NULL
      ORDER BY job_id ASC, index_in_job ASC, created_at ASC
    `,
    [owner, jobIds]
  );
  for (const row of result.rows) {
    const list = map.get(row.job_id) ?? [];
    list.push(toAsset(row));
    map.set(row.job_id, list);
  }
  return map;
}

async function getAssetRow(owner: string, assetId: string): Promise<ImageAssetRow | undefined> {
  await ensureImagesSchema();
  const pool = getImagesPool();
  const result = await pool.query<ImageAssetRow>(
    `
      SELECT *
      FROM image_assets
      WHERE id = $1 AND owner_core_user_id = $2 AND deleted_at IS NULL
      LIMIT 1
    `,
    [assetId, owner]
  );
  return result.rows[0];
}

async function getReferenceRow(owner: string, referenceId: string): Promise<ImageReferenceRow | undefined> {
  await ensureImagesSchema();
  const pool = getImagesPool();
  const result = await pool.query<ImageReferenceRow>(
    `
      SELECT *
      FROM image_references
      WHERE id = $1 AND owner_core_user_id = $2 AND deleted_at IS NULL
      LIMIT 1
    `,
    [referenceId, owner]
  );
  return result.rows[0];
}

async function appendJobEvent(
  owner: string,
  jobId: string,
  level: "info" | "warn" | "error",
  message: string,
  stage?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const pool = getImagesPool();
  await pool.query(
    `
      INSERT INTO image_job_events (job_id, owner_core_user_id, level, stage, message, metadata_json)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [jobId, owner, level, stage ?? null, message, JSON.stringify(metadata ?? {})]
  );
}

async function addJobInput(input: {
  owner: string;
  jobId: string;
  inputKind: string;
  inputId?: string;
  inputSummary?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const pool = getImagesPool();
  await pool.query(
    `
      INSERT INTO image_job_inputs (job_id, owner_core_user_id, input_kind, input_id, input_summary, metadata_json)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      input.jobId,
      input.owner,
      input.inputKind,
      input.inputId ?? null,
      input.inputSummary ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

async function updateJobProgress(owner: string, jobId: string, progress: ImageProgress): Promise<void> {
  const pool = getImagesPool();
  await pool.query(
    `
      UPDATE image_generation_jobs
      SET progress_json = $3::jsonb, updated_at = NOW()
      WHERE id = $1 AND owner_core_user_id = $2
    `,
    [jobId, owner, JSON.stringify(progress)]
  );
}

function contextSummary(input: ImageGenerationInput): string | undefined {
  const parts: string[] = [];
  if (input.contextSnapshot?.summary?.trim()) {
    parts.push(input.contextSnapshot.summary.trim());
  }
  for (const ref of input.contextSnapshot?.refs ?? input.contextRefs ?? []) {
    const label = [ref.kind, ref.title, ref.path].filter(Boolean).join(": ");
    const content = ref.content?.trim();
    if (label || content) {
      parts.push(content ? `${label}\n${content}`.trim() : label);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export async function imageDefaults(input?: { credentials?: ImageGenerationInput["providerCredentials"] }): Promise<ImageDefaultsResponse> {
  const credentials = input?.credentials;
  const provider = (credentials?.defaultProvider ?? process.env.IMAGES_DEFAULT_PROVIDER ?? "mock") as ImageDefaultsResponse["defaults"]["provider"];
  return {
    enabled: true,
    defaults: {
      provider,
      model:
        provider === "openai"
          ? resolveModel("openai", undefined, credentials)
          : provider === "nanobanana"
            ? resolveModel("nanobanana", undefined, credentials)
            : "workbench-mock-image",
      size: "1024x1024",
      quality: "standard",
      count: 1,
      saveToArtifacts: false
    },
    availableProviders: {
      mock: true,
      openai: Boolean(credentials?.openaiApiKey),
      nanobanana: Boolean(credentials?.nanobananaApiKey)
    },
    availableModels: providerModelOptions(),
    capabilities: adapterCapabilities()
  };
}

export async function createImageReference(input: {
  ownerCoreUserId: string;
  purpose: ImageReferencePurpose;
  mimeType: string;
  buffer: Buffer;
  projectId?: string;
  metadata?: Record<string, unknown>;
}): Promise<ImageReferenceRecord> {
  await ensureImagesSchema();
  const owner = normalizeOwner(input.ownerCoreUserId);
  const mimeType = ensureAllowedImageMime(input.mimeType);
  const id = `imgref_${randomUUID()}`;
  const dimensions = imageDimensions(input.buffer, mimeType);
  const stored = await putImageBuffer({
    ownerCoreUserId: owner,
    kind: input.purpose === "mask" ? "masks" : "references",
    id,
    mimeType,
    buffer: input.buffer
  });

  const pool = getImagesPool();
  const result = await pool.query<ImageReferenceRow>(
    `
      INSERT INTO image_references (
        id, owner_core_user_id, purpose, mime_type, width, height, size_bytes,
        sha256, storage_key, project_id, metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      RETURNING *
    `,
    [
      id,
      owner,
      input.purpose,
      mimeType,
      dimensions.width ?? null,
      dimensions.height ?? null,
      stored.sizeBytes,
      stored.sha256,
      stored.storageKey,
      input.projectId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return toReference(result.rows[0]);
}

export async function listImageJobs(ownerCoreUserId: string, limit = 50): Promise<ImageJobRecord[]> {
  await ensureImagesSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  const pool = getImagesPool();
  const result = await pool.query<ImageJobRow>(
    `
      SELECT *
      FROM image_generation_jobs
      WHERE owner_core_user_id = $1
      ORDER BY updated_at DESC
      LIMIT $2
    `,
    [owner, Math.max(1, Math.min(200, limit))]
  );
  const assets = await listAssetsForJobs(owner, result.rows.map((row) => row.id));
  return result.rows.map((row) => toJob(row, assets.get(row.id) ?? []));
}

export async function getImageJob(ownerCoreUserId: string, jobId: string): Promise<ImageJobRecord | undefined> {
  await ensureImagesSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  const pool = getImagesPool();
  const result = await pool.query<ImageJobRow>(
    `
      SELECT *
      FROM image_generation_jobs
      WHERE id = $1 AND owner_core_user_id = $2
      LIMIT 1
    `,
    [jobId, owner]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const assets = await listAssetsForJobs(owner, [row.id]);
  return toJob(row, assets.get(row.id) ?? []);
}

export async function getImageAsset(ownerCoreUserId: string, assetId: string): Promise<ImageAssetRecord | undefined> {
  const owner = normalizeOwner(ownerCoreUserId);
  const row = await getAssetRow(owner, assetId);
  return row ? toAsset(row) : undefined;
}

export async function readImageAssetData(
  ownerCoreUserId: string,
  assetId: string
): Promise<{ asset: ImageAssetRecord; buffer: Buffer; fileName: string } | undefined> {
  const owner = normalizeOwner(ownerCoreUserId);
  const row = await getAssetRow(owner, assetId);
  if (!row) return undefined;
  const buffer = await readImageBuffer(row.storage_key);
  const extension = row.mime_type === "image/jpeg" ? "jpg" : row.mime_type === "image/webp" ? "webp" : "png";
  return {
    asset: toAsset(row),
    buffer,
    fileName: `${row.id}.${extension}`
  };
}

export async function deleteImageAsset(ownerCoreUserId: string, assetId: string): Promise<boolean> {
  const owner = normalizeOwner(ownerCoreUserId);
  const row = await getAssetRow(owner, assetId);
  if (!row) return false;
  const pool = getImagesPool();
  await pool.query(
    `
      UPDATE image_assets
      SET deleted_at = NOW()
      WHERE id = $1 AND owner_core_user_id = $2 AND deleted_at IS NULL
    `,
    [assetId, owner]
  );
  await deleteImageBuffer(row.storage_key).catch(() => undefined);
  return true;
}

export async function attachArtifactToAsset(
  ownerCoreUserId: string,
  assetId: string,
  artifact: {
    artifactItemId: string;
    artifactItemPath?: string;
    artifactTitle?: string;
    projectId?: string;
    projectName?: string;
  }
): Promise<ImageAssetRecord | undefined> {
  const owner = normalizeOwner(ownerCoreUserId);
  const pool = getImagesPool();
  const result = await pool.query<ImageAssetRow>(
    `
      UPDATE image_assets
      SET
        artifact_item_id = $3,
        artifact_item_path = $4,
        artifact_title = $5,
        project_id = $6,
        project_name = $7
      WHERE id = $1 AND owner_core_user_id = $2 AND deleted_at IS NULL
      RETURNING *
    `,
    [
      assetId,
      owner,
      artifact.artifactItemId,
      artifact.artifactItemPath ?? null,
      artifact.artifactTitle ?? null,
      artifact.projectId ?? null,
      artifact.projectName ?? null
    ]
  );
  return result.rows[0] ? toAsset(result.rows[0]) : undefined;
}

export async function cancelImageJob(ownerCoreUserId: string, jobId: string): Promise<ImageJobRecord | undefined> {
  const owner = normalizeOwner(ownerCoreUserId);
  const existing = await getImageJob(owner, jobId);
  if (!existing) return undefined;
  if (existing.status !== "queued" && existing.status !== "running") {
    return existing;
  }
  const progress: ImageProgress = { stage: "cancelled", percent: existing.progress.percent, message: "Cancelled" };
  const pool = getImagesPool();
  await pool.query(
    `
      UPDATE image_generation_jobs
      SET status = 'cancelled', progress_json = $3::jsonb, cancelled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND owner_core_user_id = $2
    `,
    [jobId, owner, JSON.stringify(progress)]
  );
  await appendJobEvent(owner, jobId, "warn", "Job cancelled.", "cancelled");
  return getImageJob(owner, jobId);
}

async function collectProviderImages(owner: string, jobId: string, input: ImageGenerationInput): Promise<ProviderImageInput[]> {
  const images: ProviderImageInput[] = [];

  for (const assetId of input.sourceAssetIds ?? []) {
    const row = await getAssetRow(owner, assetId);
    if (!row) {
      throw new ImageServiceError(`Source asset not found: ${assetId}`, "INVALID_INPUT", 400);
    }
    const buffer = await readImageBuffer(row.storage_key);
    images.push({
      id: row.id,
      buffer,
      mimeType: row.mime_type,
      fileName: providerInputFileName(row.id, row.mime_type),
      purpose: "source"
    });
    await addJobInput({ owner, jobId, inputKind: "source_asset", inputId: row.id, metadata: { jobId: row.job_id } });
  }

  for (const referenceId of input.referenceImageIds ?? []) {
    const row = await getReferenceRow(owner, referenceId);
    if (!row) {
      throw new ImageServiceError(`Reference image not found: ${referenceId}`, "INVALID_INPUT", 400);
    }
    const buffer = await readImageBuffer(row.storage_key);
    images.push({
      id: row.id,
      buffer,
      mimeType: row.mime_type,
      fileName: providerInputFileName(row.id, row.mime_type),
      purpose: row.purpose
    });
    await addJobInput({ owner, jobId, inputKind: "reference_image", inputId: row.id, metadata: { purpose: row.purpose } });
  }

  for (const artifactId of input.sourceArtifactItemIds ?? []) {
    await addJobInput({ owner, jobId, inputKind: "artifact", inputId: artifactId });
  }

  for (const ref of input.contextSnapshot?.refs ?? input.contextRefs ?? []) {
    await addJobInput({
      owner,
      jobId,
      inputKind: ref.kind,
      inputId: ref.id,
      inputSummary: ref.title ?? ref.path ?? ref.content?.slice(0, 200),
      metadata: {
        path: ref.path
      }
    });
  }

  return images;
}

export async function runImageGeneration(ownerCoreUserId: string, input: ImageGenerationInput): Promise<ImageJobRecord> {
  await ensureImagesSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new ImageServiceError("Prompt is required", "INVALID_INPUT", 400);
  }

  const provider = resolveProvider({ requested: input.provider, credentials: input.providerCredentials });
  const model = resolveModel(provider, input.model, input.providerCredentials);
  const jobId = `imgjob_${randomUUID()}`;
  const intent = input.intent ?? "create";
  const size = normalizeImageSize(input.size) as ImageSize;
  const count = Math.max(1, Math.min(4, Math.round(input.count ?? 1)));
  const quality = input.quality ?? "standard";
  const initialProgress: ImageProgress = {
    stage: "provider_running",
    percent: 10,
    message: "Starting image generation"
  };

  const safeRequest: JsonRecord = {
    intent,
    size,
    count,
    quality,
    stylePreset: input.stylePreset,
    seed: input.seed,
    referenceImageIds: input.referenceImageIds ?? [],
    sourceAssetIds: input.sourceAssetIds ?? [],
    sourceArtifactItemIds: input.sourceArtifactItemIds ?? [],
    preserve: input.preserve ?? []
  };

  const pool = getImagesPool();
  await pool.query(
    `
      INSERT INTO image_generation_jobs (
        id, owner_core_user_id, status, intent, provider, model, prompt, instruction,
        negative_prompt, request_json, context_snapshot_json, progress_json,
        save_to_artifacts, project_id, project_name, artifact_title, artifact_path, started_at
      )
      VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, NOW())
    `,
    [
      jobId,
      owner,
      intent,
      provider,
      model,
      prompt,
      input.instruction?.trim() || null,
      input.negativePrompt?.trim() || null,
      JSON.stringify(safeRequest),
      JSON.stringify(input.contextSnapshot ?? {}),
      JSON.stringify(initialProgress),
      input.saveToArtifacts ?? false,
      input.projectId ?? null,
      input.projectName ?? null,
      input.artifactTitle ?? null,
      input.artifactPath ?? null
    ]
  );
  await appendJobEvent(owner, jobId, "info", `Job created (provider=${provider}, model=${model}).`, "queued");

  try {
    const providerImages = await collectProviderImages(owner, jobId, input);
    await updateJobProgress(owner, jobId, {
      stage: "provider_running",
      percent: 25,
      message: providerImages.length > 0 ? "Generating from source images" : "Generating from prompt"
    });

    const providerResult = await runProvider({
      provider,
      model,
      intent,
      prompt,
      instruction: input.instruction,
      negativePrompt: input.negativePrompt,
      size,
      count,
      quality,
      stylePreset: input.stylePreset,
      seed: input.seed,
      preserve: input.preserve,
      contextSummary: contextSummary(input),
      images: providerImages,
      credentials: input.providerCredentials
    });

    await updateJobProgress(owner, jobId, {
      stage: "saving_assets",
      percent: 80,
      message: "Saving generated assets"
    });

    const firstSourceAssetId = input.sourceAssetIds?.[0];
    const firstReferenceId = input.referenceImageIds?.[0];
    for (let index = 0; index < providerResult.images.length; index += 1) {
      const image = providerResult.images[index];
      const mimeType = normalizeMimeType(image.mimeType || "image/png");
      const assetId = `imgasset_${randomUUID()}`;
      const stored = await putImageBuffer({
        ownerCoreUserId: owner,
        kind: "assets",
        id: assetId,
        mimeType,
        buffer: image.buffer
      });
      const dimensions = image.width && image.height ? { width: image.width, height: image.height } : imageDimensions(image.buffer, mimeType);
      await pool.query(
        `
          INSERT INTO image_assets (
            id, job_id, owner_core_user_id, source_asset_id, source_reference_id, index_in_job,
            mime_type, width, height, size_bytes, sha256, storage_key, original_provider_url, metadata_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
        `,
        [
          assetId,
          jobId,
          owner,
          firstSourceAssetId ?? null,
          firstReferenceId ?? null,
          index,
          mimeType,
          dimensions.width ?? null,
          dimensions.height ?? null,
          stored.sizeBytes,
          stored.sha256,
          stored.storageKey,
          image.originalProviderUrl ?? null,
          JSON.stringify({
            ...(image.metadata ?? {}),
            provider: providerResult.provider,
            model: providerResult.model
          })
        ]
      );
    }

    const completedProgress: ImageProgress = {
      stage: "completed",
      percent: 100,
      message: "Completed"
    };
    await pool.query(
      `
        UPDATE image_generation_jobs
        SET status = 'completed', progress_json = $3::jsonb, completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND owner_core_user_id = $2
      `,
      [jobId, owner, JSON.stringify(completedProgress)]
    );
    await appendJobEvent(owner, jobId, "info", "Image generation completed.", "completed", providerResult.metadata);
    const completed = await getImageJob(owner, jobId);
    if (!completed) {
      throw new Error("Completed job disappeared");
    }
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image generation failed";
    const code =
      error instanceof ImageProviderError || error instanceof ImageServiceError
        ? error.code
        : "PROVIDER_EXECUTION_FAILED";
    const failedProgress: ImageProgress = { stage: "failed", percent: 100, message };
    await pool.query(
      `
        UPDATE image_generation_jobs
        SET status = 'failed', error_code = $3, error_message = $4, progress_json = $5::jsonb, updated_at = NOW()
        WHERE id = $1 AND owner_core_user_id = $2
      `,
      [jobId, owner, code, message, JSON.stringify(failedProgress)]
    );
    await appendJobEvent(owner, jobId, "error", message, "failed", { code });
    throw error;
  }
}

export async function retryImageJob(
  ownerCoreUserId: string,
  jobId: string,
  patch: Partial<ImageGenerationInput>
): Promise<ImageJobRecord | undefined> {
  const existing = await getImageJob(ownerCoreUserId, jobId);
  if (!existing) return undefined;
  return runImageGeneration(ownerCoreUserId, {
    ...(existing.request as Partial<ImageGenerationInput>),
    prompt: existing.prompt,
    instruction: existing.instruction,
    negativePrompt: existing.negativePrompt,
    intent: existing.intent,
    provider: existing.provider,
    model: existing.model,
    saveToArtifacts: existing.saveToArtifacts,
    projectId: existing.projectId,
    projectName: existing.projectName,
    artifactTitle: existing.artifactTitle,
    artifactPath: existing.artifactPath,
    contextSnapshot: existing.contextSnapshot,
    ...patch
  });
}
