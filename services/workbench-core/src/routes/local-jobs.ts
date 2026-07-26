import express from "express";
import { issueTokenBundle } from "../auth.js";
import { serviceBaseUrls } from "../internalClients.js";
import { claimLocalJobsForClient, completeLocalJobForClient, createLocalJob, failLocalJobForClient, getLocalJob, getLocalJobForClient, listLocalJobEventsForUser, listLocalJobsForUser, recordLocalClientHeartbeat, serializeLocalJobForOwner, serializeLocalJobsForOwner, type LocalJobKind, type LocalJobStatus, type LocalJobTarget } from "../localClientsStore.js";
import { requireAuthenticatedContext, requireLocalClientCapability } from "../middleware/auth.js";
import { localJobClaimSchema, localJobCompleteSchema, localJobCreateSchema, localJobFailSchema, localJobStatusSchema } from "../schemas/requests.js";
import { findUserById } from "../store.js";
import { queryFlagEnabled, respondInternalError, sha256Checksum } from "./shared.js";

export function registerLocalJobRoutes(app: express.Express): void {
app.get("/api/local-jobs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const parsedStatus = status ? localJobStatusSchema.safeParse(status) : undefined;
  if (parsedStatus && !parsedStatus.success) {
    return res.status(400).json({ message: parsedStatus.error.flatten() });
  }
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const localClientId = typeof req.query.localClientId === "string" ? req.query.localClientId : undefined;
  const includeLocalPaths = queryFlagEnabled(req.query.includeLocalPaths);

  try {
    const jobs = await listLocalJobsForUser(authContext.userId, {
      localClientId,
      status: parsedStatus?.success ? (parsedStatus.data as LocalJobStatus) : undefined,
      limit: Number.isFinite(limit) ? limit : undefined
    });
    return res.json({ items: serializeLocalJobsForOwner(jobs, { includeLocalPaths }) });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = localJobCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const job = await createLocalJob(authContext.userId, {
      localClientId: parsed.data.localClientId,
      idempotencyKey: parsed.data.idempotencyKey,
      kind: parsed.data.kind as LocalJobKind,
      target: parsed.data.target as LocalJobTarget,
      payload: parsed.data.payload,
      ttlSeconds: parsed.data.ttlSeconds
    });
    return res.status(201).json(job);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-jobs/:jobId/events", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const job = await getLocalJob(authContext.userId, String(req.params.jobId));
    if (!job) {
      return res.status(404).json({ message: "Local job not found" });
    }
    const events = await listLocalJobEventsForUser(
      authContext.userId,
      String(req.params.jobId),
      Number.isFinite(limit) ? limit : undefined
    );
    return res.json({ items: events });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-jobs/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const includeLocalPaths = queryFlagEnabled(req.query.includeLocalPaths);

  try {
    const job = await getLocalJob(authContext.userId, String(req.params.jobId));
    if (!job) {
      return res.status(404).json({ message: "Local job not found" });
    }
    return res.json(serializeLocalJobForOwner(job, { includeLocalPaths }));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs/claim", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.claim");
  if (!localContext) return;

  const parsed = localJobClaimSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    await recordLocalClientHeartbeat(localContext.client, {
      syncRootState: { claiming: true }
    });
    const jobs = await claimLocalJobsForClient(localContext.client.id, parsed.data.limit ?? 5);
    return res.json({ items: jobs });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs/:jobId/complete", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.claim");
  if (!localContext) return;

  const parsed = localJobCompleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const job = await completeLocalJobForClient(localContext.client.id, String(req.params.jobId), parsed.data.result);
    if (!job) {
      return res.status(404).json({ message: "Local job not found or already terminal" });
    }
    return res.json(job);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs/:jobId/fail", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.claim");
  if (!localContext) return;

  const parsed = localJobFailSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const job = await failLocalJobForClient(localContext.client.id, String(req.params.jobId), parsed.data.error, {
      retryable: parsed.data.retryable,
      retryAfterSeconds: parsed.data.retryAfterSeconds
    });
    if (!job) {
      return res.status(404).json({ message: "Local job not found or already terminal" });
    }
    return res.json(job);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-jobs/:jobId/download", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.download");
  if (!localContext) return;

  try {
    const job = await getLocalJobForClient(localContext.client.id, String(req.params.jobId));
    if (!job) {
      return res.status(404).json({ message: "Local job not found" });
    }
    if (job.status !== "running" && job.status !== "completed") {
      return res.status(409).json({ message: "Local job must be claimed before download" });
    }

    const user = await findUserById(job.userId);
    if (!user) {
      return res.status(404).json({ message: "Job owner not found" });
    }
    const bundle = issueTokenBundle({ userId: user.id, username: user.username });
    let targetUrl: string | undefined;

    if (job.kind === "download_artifact" || (job.kind === "materialize_resource" && job.payload.domain === "artifacts")) {
      const artifactItemId = typeof job.payload.artifactItemId === "string"
        ? job.payload.artifactItemId
        : typeof job.payload.id === "string"
          ? job.payload.id
          : undefined;
      if (!artifactItemId) {
        return res.status(400).json({ message: "Job payload is missing artifactItemId" });
      }
      targetUrl = `${serviceBaseUrls.artifacts}/artifacts/items/${encodeURIComponent(artifactItemId)}/download?download=1`;
    }

    if (job.kind === "download_task_attachment") {
      const taskId = typeof job.payload.taskId === "string" ? job.payload.taskId : undefined;
      const attachmentId = typeof job.payload.attachmentId === "string" ? job.payload.attachmentId : undefined;
      if (!taskId || !attachmentId) {
        return res.status(400).json({ message: "Job payload is missing taskId or attachmentId" });
      }
      targetUrl = `${serviceBaseUrls.tasks}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download?download=1`;
    }

    if (!targetUrl) {
      return res.status(400).json({ message: `Unsupported local job kind for download: ${job.kind}` });
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${bundle.accessToken}`
      }
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);
    if (upstream.ok) res.setHeader("X-Workbench-Content-Checksum", sha256Checksum(buffer));
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

}

