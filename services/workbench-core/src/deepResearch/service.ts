import { artifactsClient } from "../internalClients.js";
import { getIntegrationConfig } from "../store.js";
import { DeepResearchError } from "./errors.js";
import { resolveProviderModel, runDeepResearchProvider } from "./providers.js";
import {
  appendDeepResearchJobLog,
  attachDeepResearchArtifact,
  cancelDeepResearchJob,
  completeDeepResearchJob,
  createDeepResearchJob,
  failDeepResearchJob,
  getDeepResearchJob,
  listDeepResearchJobs,
  mergeDeepResearchJobMetadata,
  updateDeepResearchJobProgress
} from "./store.js";
import type {
  DeepResearchArtifactRef,
  DeepResearchCancelResponse,
  DeepResearchDefaults,
  DeepResearchEventLog,
  DeepResearchHistoryEntry,
  DeepResearchJobRecord,
  DeepResearchProvider,
  DeepResearchProviderInput,
  DeepResearchResolvedRequest,
  DeepResearchRunInput,
  DeepResearchRunResponse,
  DeepResearchRunResponseCompleted,
  DeepResearchSettings,
  DeepResearchSpeed,
  DeepResearchStatusResponse
} from "./types.js";

const DEEP_RESEARCH_INTEGRATION_ID = "deep_research";
const DEFAULTS: DeepResearchDefaults = {
  provider: "auto",
  speed: "deep",
  timeoutSec: 120,
  asyncOnTimeout: true,
  saveToArtifacts: true
};

const PROVIDER_PRIORITY: DeepResearchProvider[] = ["gemini", "openai", "anthropic"];
const runningJobControllers = new Map<string, AbortController>();

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error instanceof Error) {
    return error.name === "AbortError";
  }
  return false;
}

function stringValue(raw: string | number | boolean | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

function booleanValue(raw: string | number | boolean | undefined): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function numberValue(raw: string | number | boolean | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pickProvider(value: string | undefined): DeepResearchProviderInput | undefined {
  if (value === "auto" || value === "gemini" || value === "openai" || value === "anthropic") {
    return value;
  }
  return undefined;
}

function pickSpeed(value: string | undefined): DeepResearchSpeed | undefined {
  if (value === "deep" || value === "fast") {
    return value;
  }
  return undefined;
}

function clampTimeout(seconds: number | undefined): number {
  if (!Number.isFinite(seconds)) return DEFAULTS.timeoutSec;
  return Math.max(10, Math.min(3600, Math.round(seconds!)));
}

function normalizeTitle(query: string): string {
  const compact = query.replace(/\s+/g, " ").trim();
  const truncated = compact.length > 80 ? `${compact.slice(0, 80).trim()}...` : compact;
  return `Research: ${truncated || "Untitled"}`;
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "research";
}

function defaultArtifactPath(query: string): string {
  return `research/${slugify(query).slice(0, 80)}.md`;
}

function buildArtifactMarkdown(params: {
  title: string;
  query: string;
  provider: DeepResearchProvider;
  model: string;
  speed: DeepResearchSpeed;
  content: string;
  completedAt: string;
  jobId?: string;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    "## Metadata",
    `- Query: ${params.query}`,
    `- Provider: ${params.provider}`,
    `- Model: ${params.model}`,
    `- Speed: ${params.speed}`,
    `- Completed At: ${params.completedAt}`,
    params.jobId ? `- Job ID: ${params.jobId}` : undefined,
    "",
    "## Result",
    params.content.trim()
  ].filter((line): line is string => typeof line === "string");

  return lines.join("\n");
}

function parseArtifactRef(raw: unknown): DeepResearchArtifactRef {
  if (!raw || typeof raw !== "object") {
    throw new DeepResearchError("Artifacts service returned an invalid item payload", "ARTIFACT_SAVE_FAILED", 502);
  }

  const record = raw as Record<string, unknown>;
  const id = stringValue(record.id as string | number | boolean | undefined);
  const title = stringValue(record.title as string | number | boolean | undefined);
  const path = stringValue(record.path as string | number | boolean | undefined);
  const projectId = stringValue(record.projectId as string | number | boolean | undefined);
  const projectName = stringValue(record.projectName as string | number | boolean | undefined);

  if (!id || !title || !path || !projectId) {
    throw new DeepResearchError("Artifacts service returned an incomplete item payload", "ARTIFACT_SAVE_FAILED", 502);
  }

  return {
    id,
    title,
    path,
    projectId,
    projectName
  };
}

function parseEventLogs(metadata: Record<string, unknown>): DeepResearchEventLog[] {
  const rawLogs = metadata.eventLogs;
  if (!Array.isArray(rawLogs)) {
    return [];
  }

  const logs: DeepResearchEventLog[] = [];
  for (const entry of rawLogs) {
    if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const at = stringValue(record.at as string | number | boolean | undefined);
      const level = stringValue(record.level as string | number | boolean | undefined);
      const message = stringValue(record.message as string | number | boolean | undefined);
      const stage = stringValue(record.stage as string | number | boolean | undefined);

      if (!at || !message) {
        continue;
      }

      if (level !== "info" && level !== "warn" && level !== "error") {
        continue;
      }

      logs.push({
        at,
        level,
        message,
        stage:
          stage === "queued" ||
          stage === "running" ||
          stage === "saving_artifact" ||
          stage === "completed" ||
          stage === "failed" ||
          stage === "cancelled"
            ? stage
            : undefined
      });
  }

  return logs;
}

async function logJobEvent(params: {
  userId: string;
  jobId: string;
  message: string;
  level?: DeepResearchEventLog["level"];
  stage?: DeepResearchEventLog["stage"];
}): Promise<void> {
  try {
    await appendDeepResearchJobLog(params.userId, params.jobId, {
      at: new Date().toISOString(),
      level: params.level ?? "info",
      message: params.message,
      stage: params.stage
    });
  } catch {
    // Best effort only: logs should never break a research job.
  }
}

function toStatusResponse(job: DeepResearchJobRecord): DeepResearchStatusResponse {
  const artifactSaveError =
    typeof job.metadata.artifactSaveError === "string" ? (job.metadata.artifactSaveError as string) : undefined;
  const eventLogs = parseEventLogs(job.metadata);
  const artifact =
    job.artifactItemId && job.artifactItemPath
      ? {
          id: job.artifactItemId,
          path: job.artifactItemPath,
          title: job.artifactTitle || normalizeTitle(job.query),
          projectId: typeof job.metadata.projectId === "string" ? job.metadata.projectId : "default",
          projectName: typeof job.metadata.projectName === "string" ? job.metadata.projectName : undefined
        }
      : undefined;

  return {
    jobId: job.id,
    status: job.status,
    query: job.query,
    provider: job.provider,
    model: job.model,
    speed: job.speed,
    progress: job.progress,
    resultMarkdown: job.resultMarkdown,
    artifact,
    artifactSaveError,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    cancelledAt: job.cancelledAt,
    eventLogs
  };
}

function toHistoryEntry(job: DeepResearchJobRecord): DeepResearchHistoryEntry {
  const status = toStatusResponse(job);
  return {
    jobId: status.jobId,
    status: status.status,
    query: status.query,
    provider: status.provider,
    model: status.model,
    speed: status.speed,
    progress: status.progress,
    artifact: status.artifact,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    cancelledAt: status.cancelledAt,
    eventLogs: status.eventLogs
  };
}

async function saveResultToArtifacts(params: {
  accessToken: string;
  query: string;
  provider: DeepResearchProvider;
  model: string;
  speed: DeepResearchSpeed;
  resultMarkdown: string;
  jobId?: string;
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
}): Promise<DeepResearchArtifactRef> {
  const completedAt = new Date().toISOString();
  const title = params.artifactTitle?.trim() || normalizeTitle(params.query);
  const path = params.artifactPath?.trim() || defaultArtifactPath(params.query);
  const markdown = buildArtifactMarkdown({
    title,
    query: params.query,
    provider: params.provider,
    model: params.model,
    speed: params.speed,
    content: params.resultMarkdown,
    completedAt,
    jobId: params.jobId
  });

  const payload = {
    projectId: params.projectId,
    projectName: params.projectName,
    title,
    path,
    tags: ["research", params.provider, params.speed],
    contentMarkdown: markdown
  };
  const created = await artifactsClient.createNote(params.accessToken, payload);
  return parseArtifactRef(created);
}

async function resolveSettings(userId: string): Promise<DeepResearchSettings> {
  const config = await getIntegrationConfig(userId, DEEP_RESEARCH_INTEGRATION_ID);
  const values = config?.values ?? {};
  const geminiKey = stringValue(values.geminiApiKey);
  const openaiKey = stringValue(values.openaiApiKey);
  const anthropicKey = stringValue(values.anthropicApiKey);

  const apiKeys: Partial<Record<DeepResearchProvider, string>> = {};
  if (geminiKey) apiKeys.gemini = geminiKey;
  if (openaiKey) apiKeys.openai = openaiKey;
  if (anthropicKey) apiKeys.anthropic = anthropicKey;

  const availableProviders = PROVIDER_PRIORITY.filter((provider) => Boolean(apiKeys[provider]));
  const provider = pickProvider(stringValue(values.defaultProvider)) ?? DEFAULTS.provider;
  const speed = pickSpeed(stringValue(values.defaultSpeed)) ?? DEFAULTS.speed;
  const timeoutSec = clampTimeout(numberValue(values.defaultTimeoutSec) ?? DEFAULTS.timeoutSec);
  const asyncOnTimeout = booleanValue(values.defaultAsyncOnTimeout) ?? DEFAULTS.asyncOnTimeout;
  const saveToArtifacts = booleanValue(values.defaultSaveToArtifacts) ?? DEFAULTS.saveToArtifacts;

  return {
    enabled: config?.enabled ?? true,
    apiKeys,
    availableProviders,
    provider,
    speed,
    timeoutSec,
    asyncOnTimeout,
    saveToArtifacts
  };
}

function resolveProvider(inputProvider: DeepResearchProviderInput, settings: DeepResearchSettings): DeepResearchProvider {
  if (inputProvider !== "auto") {
    return inputProvider;
  }

  if (settings.provider !== "auto" && settings.availableProviders.includes(settings.provider)) {
    return settings.provider;
  }

  const fallback = PROVIDER_PRIORITY.find((provider) => settings.availableProviders.includes(provider));
  if (!fallback) {
    throw new DeepResearchError(
      "No Deep Research provider key is configured. Add Gemini, OpenAI, or Anthropic API key in Settings.",
      "MISSING_PROVIDER_KEY",
      400
    );
  }
  return fallback;
}

function resolveRunRequest(input: DeepResearchRunInput, settings: DeepResearchSettings): DeepResearchResolvedRequest {
  const query = input.query?.trim();
  if (!query) {
    throw new DeepResearchError("Query is required", "INVALID_INPUT", 400);
  }

  if (!settings.enabled) {
    throw new DeepResearchError("Deep Research is disabled in Settings", "DEEP_RESEARCH_DISABLED", 400);
  }

  const providerInput = input.provider ?? settings.provider ?? "auto";
  if (!["auto", "gemini", "openai", "anthropic"].includes(providerInput)) {
    throw new DeepResearchError("Invalid provider. Use auto, gemini, openai, or anthropic.", "INVALID_PROVIDER", 400);
  }

  const speed = input.speed ?? settings.speed;
  if (speed !== "deep" && speed !== "fast") {
    throw new DeepResearchError("Invalid speed. Use deep or fast.", "INVALID_SPEED", 400);
  }

  const timeoutSec = clampTimeout(input.timeoutSec ?? settings.timeoutSec);
  const asyncOnTimeout = input.asyncOnTimeout ?? settings.asyncOnTimeout;
  const saveToArtifacts = input.saveToArtifacts ?? settings.saveToArtifacts;
  const provider = resolveProvider(providerInput, settings);

  return {
    query,
    provider,
    speed,
    timeoutSec,
    asyncOnTimeout,
    saveToArtifacts,
    artifactTitle: input.artifactTitle?.trim() || undefined,
    artifactPath: input.artifactPath?.trim() || undefined,
    projectId: input.projectId?.trim() || undefined,
    projectName: input.projectName?.trim() || undefined
  };
}

async function finalizeCompletion(params: {
  userId: string;
  accessToken: string;
  jobId: string;
  request: DeepResearchResolvedRequest;
  resultMarkdown: string;
  provider: DeepResearchProvider;
  model: string;
}): Promise<DeepResearchRunResponseCompleted> {
  let artifact: DeepResearchArtifactRef | undefined;
  let artifactSaveError: string | undefined;
  const completedAt = new Date().toISOString();

  if (params.request.saveToArtifacts) {
    try {
      await logJobEvent({
        userId: params.userId,
        jobId: params.jobId,
        message: "Run completed. Saving result to Artifacts.",
        stage: "saving_artifact"
      });
      await updateDeepResearchJobProgress(params.userId, params.jobId, {
        stage: "saving_artifact",
        percent: 90,
        message: "Saving to Artifacts"
      });
      artifact = await saveResultToArtifacts({
        accessToken: params.accessToken,
        query: params.request.query,
        provider: params.provider,
        model: params.model,
        speed: params.request.speed,
        resultMarkdown: params.resultMarkdown,
        jobId: params.jobId,
        artifactTitle: params.request.artifactTitle,
        artifactPath: params.request.artifactPath,
        projectId: params.request.projectId,
        projectName: params.request.projectName
      });
      await logJobEvent({
        userId: params.userId,
        jobId: params.jobId,
        message: `Artifact saved: ${artifact.title}`,
        stage: "saving_artifact"
      });
    } catch (error) {
      artifactSaveError = error instanceof Error ? error.message : "Failed to save artifact";
      await mergeDeepResearchJobMetadata(params.userId, params.jobId, { artifactSaveError });
      await logJobEvent({
        userId: params.userId,
        jobId: params.jobId,
        message: `Artifact save failed: ${artifactSaveError}`,
        level: "warn",
        stage: "saving_artifact"
      });
    }
  }

  await completeDeepResearchJob(params.userId, params.jobId, {
    resultMarkdown: params.resultMarkdown,
    provider: params.provider,
    model: params.model,
    speed: params.request.speed,
    artifact,
    artifactSaveError
  });
  if (artifact) {
    await attachDeepResearchArtifact(params.userId, params.jobId, artifact);
  }
  await logJobEvent({
    userId: params.userId,
    jobId: params.jobId,
    message: "Research completed successfully.",
    stage: "completed"
  });

  return {
    status: "completed",
    jobId: params.jobId,
    query: params.request.query,
    provider: params.provider,
    model: params.model,
    speed: params.request.speed,
    resultMarkdown: params.resultMarkdown,
    artifact,
    artifactSaveError,
    completedAt
  };
}

async function executeBackgroundJob(params: {
  userId: string;
  accessToken: string;
  jobId: string;
  request: DeepResearchResolvedRequest;
  provider: DeepResearchProvider;
  model: string;
  apiKey: string;
}): Promise<void> {
  try {
    const snapshot = await getDeepResearchJob(params.userId, params.jobId);
    if (!snapshot || snapshot.status !== "running") {
      return;
    }

    const controller = new AbortController();
    runningJobControllers.set(params.jobId, controller);
    await logJobEvent({
      userId: params.userId,
      jobId: params.jobId,
      message: "Sync timeout reached. Continuing in background.",
      stage: "running"
    });

    await updateDeepResearchJobProgress(params.userId, params.jobId, {
      stage: "running",
      percent: 20,
      message: "Running in background"
    });

    const result = await runDeepResearchProvider({
      provider: params.provider,
      speed: params.request.speed,
      model: params.model,
      query: params.request.query,
      apiKey: params.apiKey,
      signal: controller.signal
    });
    await logJobEvent({
      userId: params.userId,
      jobId: params.jobId,
      message: "Background execution finished. Finalizing result.",
      stage: "running"
    });

    await finalizeCompletion({
      userId: params.userId,
      accessToken: params.accessToken,
      jobId: params.jobId,
      request: params.request,
      resultMarkdown: result.content,
      provider: params.provider,
      model: result.model
    });
  } catch (error) {
    if (isAbortError(error)) {
      await logJobEvent({
        userId: params.userId,
        jobId: params.jobId,
        message: "Background execution aborted.",
        level: "warn",
        stage: "cancelled"
      });
      return;
    }
    const message = error instanceof Error ? error.message : "Background research failed";
    try {
      await failDeepResearchJob(params.userId, params.jobId, message);
      await logJobEvent({
        userId: params.userId,
        jobId: params.jobId,
        message: `Background execution failed: ${message}`,
        level: "error",
        stage: "failed"
      });
    } catch {
      // Best effort: background worker should never crash the core process.
    }
  } finally {
    runningJobControllers.delete(params.jobId);
  }
}

export async function getDeepResearchDefaults(userId: string): Promise<{
  enabled: boolean;
  defaults: DeepResearchDefaults;
  availableProviders: Record<DeepResearchProvider, boolean>;
}> {
  const settings = await resolveSettings(userId);
  return {
    enabled: settings.enabled,
    defaults: {
      provider: settings.provider,
      speed: settings.speed,
      timeoutSec: settings.timeoutSec,
      asyncOnTimeout: settings.asyncOnTimeout,
      saveToArtifacts: settings.saveToArtifacts
    },
    availableProviders: {
      gemini: settings.availableProviders.includes("gemini"),
      openai: settings.availableProviders.includes("openai"),
      anthropic: settings.availableProviders.includes("anthropic")
    }
  };
}

export async function runDeepResearch(
  userId: string,
  accessToken: string,
  input: DeepResearchRunInput
): Promise<DeepResearchRunResponse> {
  const settings = await resolveSettings(userId);
  const request = resolveRunRequest(input, settings);
  const apiKey = settings.apiKeys[request.provider];
  if (!apiKey) {
    throw new DeepResearchError(
      `No API key configured for provider '${request.provider}'.`,
      "MISSING_PROVIDER_KEY",
      400
    );
  }

  const model = resolveProviderModel(request.provider, request.speed);
  const createdJob = await createDeepResearchJob({
    userId,
    query: request.query,
    provider: request.provider,
    model,
    speed: request.speed,
    timeoutSec: request.timeoutSec,
    asyncOnTimeout: request.asyncOnTimeout,
    saveToArtifacts: request.saveToArtifacts,
    artifactTitle: request.artifactTitle,
    artifactPath: request.artifactPath,
    metadata: {
      projectId: request.projectId,
      projectName: request.projectName
    },
    progress: {
      stage: "running",
      percent: 10,
      message: "Starting research"
    }
  });
  await logJobEvent({
    userId,
    jobId: createdJob.id,
    message: `Job created (provider=${request.provider}, speed=${request.speed}, timeout=${request.timeoutSec}s).`,
    stage: "queued"
  });
  await logJobEvent({
    userId,
    jobId: createdJob.id,
    message: "Starting synchronous execution.",
    stage: "running"
  });

  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutSec * 1000);

  try {
    const result = await runDeepResearchProvider({
      provider: request.provider,
      speed: request.speed,
      model,
      query: request.query,
      apiKey,
      signal: controller.signal
    });
    clearTimeout(timeoutHandle);
    return await finalizeCompletion({
      userId,
      accessToken,
      jobId: createdJob.id,
      request,
      resultMarkdown: result.content,
      provider: request.provider,
      model: result.model
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    if (isAbortError(error) && timedOut) {
      if (!request.asyncOnTimeout) {
        const timeoutMessage = `Deep Research timed out after ${request.timeoutSec} seconds.`;
        await failDeepResearchJob(userId, createdJob.id, timeoutMessage);
        await logJobEvent({
          userId,
          jobId: createdJob.id,
          message: timeoutMessage,
          level: "warn",
          stage: "failed"
        });
        throw new DeepResearchError(timeoutMessage, "TIMEOUT", 408);
      }

      await logJobEvent({
        userId,
        jobId: createdJob.id,
        message: `Timed out after ${request.timeoutSec}s. Continuing in background.`,
        stage: "running"
      });

      void executeBackgroundJob({
        userId,
        accessToken,
        jobId: createdJob.id,
        request,
        provider: request.provider,
        model,
        apiKey
      }).catch((backgroundError) => {
        const message = backgroundError instanceof Error ? backgroundError.message : "Background research failed";
        void failDeepResearchJob(userId, createdJob.id, message).catch(() => undefined);
      });

      return {
        status: "running",
        jobId: createdJob.id,
        query: request.query,
        provider: request.provider,
        model,
        speed: request.speed,
        message: "Research is continuing in the background. Poll status with deep_research_status."
      };
    }

    const message = error instanceof Error ? error.message : "Deep Research failed";
    await failDeepResearchJob(userId, createdJob.id, message);
    await logJobEvent({
      userId,
      jobId: createdJob.id,
      message: `Execution failed: ${message}`,
      level: "error",
      stage: "failed"
    });
    if (error instanceof DeepResearchError) {
      throw error;
    }
    throw new DeepResearchError(message, "DEEP_RESEARCH_FAILED", 502);
  }
}

export async function getDeepResearchStatus(userId: string, jobId: string): Promise<DeepResearchStatusResponse> {
  const job = await getDeepResearchJob(userId, jobId);
  if (!job) {
    throw new DeepResearchError("Deep Research job not found", "JOB_NOT_FOUND", 404);
  }
  return toStatusResponse(job);
}

export async function listDeepResearchHistory(userId: string, limit?: number): Promise<DeepResearchHistoryEntry[]> {
  const jobs = await listDeepResearchJobs(userId, limit);
  return jobs.map((job) => toHistoryEntry(job));
}

export async function cancelDeepResearch(userId: string, jobId: string): Promise<DeepResearchCancelResponse> {
  const job = await getDeepResearchJob(userId, jobId);
  if (!job) {
    throw new DeepResearchError("Deep Research job not found", "JOB_NOT_FOUND", 404);
  }

  if (job.status !== "running") {
    return {
      jobId,
      status: job.status,
      cancelled: false,
      message: `Job is already ${job.status}.`
    };
  }

  const cancelled = await cancelDeepResearchJob(userId, jobId);
  const controller = runningJobControllers.get(jobId);
  if (controller) {
    controller.abort();
    runningJobControllers.delete(jobId);
  }
  if (cancelled) {
    await logJobEvent({
      userId,
      jobId,
      message: "Job cancelled by user.",
      level: "warn",
      stage: "cancelled"
    });
  }

  return {
    jobId,
    status: cancelled ? "cancelled" : "running",
    cancelled,
    message: cancelled ? "Job cancelled." : "Unable to cancel job."
  };
}

export async function saveDeepResearchJobArtifact(
  userId: string,
  accessToken: string,
  jobId: string,
  input?: {
    artifactTitle?: string;
    artifactPath?: string;
    projectId?: string;
    projectName?: string;
  }
): Promise<DeepResearchArtifactRef> {
  const job = await getDeepResearchJob(userId, jobId);
  if (!job) {
    throw new DeepResearchError("Deep Research job not found", "JOB_NOT_FOUND", 404);
  }
  if (job.status !== "completed" || !job.resultMarkdown) {
    throw new DeepResearchError("Only completed jobs can be saved to Artifacts", "JOB_NOT_COMPLETED", 400);
  }
  if (job.artifactItemId && job.artifactItemPath) {
    return {
      id: job.artifactItemId,
      path: job.artifactItemPath,
      title: job.artifactTitle || normalizeTitle(job.query),
      projectId: typeof job.metadata.projectId === "string" ? job.metadata.projectId : "default",
      projectName: typeof job.metadata.projectName === "string" ? job.metadata.projectName : undefined
    };
  }

  const artifact = await saveResultToArtifacts({
    accessToken,
    query: job.query,
    provider: job.provider,
    model: job.model,
    speed: job.speed,
    resultMarkdown: job.resultMarkdown,
    jobId: job.id,
    artifactTitle: input?.artifactTitle || job.artifactTitle,
    artifactPath: input?.artifactPath || job.artifactPath,
    projectId: input?.projectId || (typeof job.metadata.projectId === "string" ? job.metadata.projectId : undefined),
    projectName:
      input?.projectName || (typeof job.metadata.projectName === "string" ? job.metadata.projectName : undefined)
  });
  await attachDeepResearchArtifact(userId, jobId, artifact);
  await logJobEvent({
    userId,
    jobId,
    message: `Artifact saved manually: ${artifact.title}`,
    stage: "completed"
  });
  return artifact;
}
