import express from "express";
import { logger } from "../logger.js";
import { serviceBaseUrls, tasksClient } from "../internalClients.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";
import { taskImportBodySchema } from "../schemas/requests.js";
import {
  asJsonRecord,
  asNonEmptyString,
  jsonRecordFromBuffer,
  objectId,
  recordSyncEventBestEffort,
  respondInternalError
} from "./shared.js";

export function registerTaskRoutes(app: express.Express): void {
app.get("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const context = typeof req.query.context === "string" ? req.query.context : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await tasksClient.list(authContext.accessToken, context, status, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/pins", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.pins(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/tasks/:id/pin", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : undefined;
  if (pinned === undefined) {
    return res.status(400).json({ message: "pinned(boolean) is required" });
  }

  try {
    const result = await tasksClient.setPin(authContext.accessToken, String(req.params.id), pinned);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "pin",
      pinned,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/schedule", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  const context = typeof req.query.context === "string" ? req.query.context : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;

  if (!startDate || !endDate) {
    return res.status(400).json({ message: "startDate and endDate are required" });
  }

  try {
    const result = await tasksClient.schedule(authContext.accessToken, startDate, endDate, context, status);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/complete", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  const status = typeof req.body?.status === "string" ? req.body.status : undefined;
  if (!targetDate || !status) {
    return res.status(400).json({ message: "targetDate and status are required" });
  }

  try {
    const result = await tasksClient.completeOccurrence(authContext.accessToken, String(req.params.id), targetDate, status);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      targetDate,
      status,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/move", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const sourceDate = typeof req.body?.sourceDate === "string" ? req.body.sourceDate : undefined;
  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  if (!sourceDate || !targetDate) {
    return res.status(400).json({ message: "sourceDate and targetDate are required" });
  }

  try {
    const result = await tasksClient.moveOccurrence(authContext.accessToken, String(req.params.id), sourceDate, targetDate);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      operation: "move",
      sourceDate,
      targetDate,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/skip-exception", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  if (!targetDate) {
    return res.status(400).json({ message: "targetDate is required" });
  }

  try {
    const result = await tasksClient.skipOccurrenceException(authContext.accessToken, String(req.params.id), targetDate);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      operation: "skipException",
      targetDate,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── These literal-path GET routes MUST come before GET /api/tasks/:id ──────

app.get("/api/tasks/export", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const csv = await tasksClient.exportCsv(authContext.accessToken);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="tasks.csv"');
    return res.send(csv);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// GET /api/tasks/today?date=YYYY-MM-DD → TodayTask[] (task + occurrenceDate)
app.get("/api/tasks/today", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  logger.debug(`[workbench-core] GET /api/tasks/today  date=${date ?? "?"}`);
  if (!date) return res.status(400).json({ message: "date query parameter is required (YYYY-MM-DD)" });
  try {
    const result = await tasksClient.today(authContext.accessToken, date);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// GET /api/tasks/schedule-calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns ScheduleCalendarDay[] grouped by scheduled_date.
// NOTE: Must be registered before GET /api/tasks/:id to prevent Express from
//       matching "schedule-calendar" as a task ID.
app.get("/api/tasks/schedule-calendar", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  logger.debug(`[workbench-core] GET /api/tasks/schedule-calendar  ${startDate}→${endDate}`);
  if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate query parameters are required" });
  try {
    const result = await tasksClient.scheduleCalendar(authContext.accessToken, startDate, endDate);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id/history", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.history(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id/schedule-items", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.listScheduleItemsForTask(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.create(authContext.accessToken, req.body);
    await recordSyncEventBestEffort(authContext.userId, "tasks", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.update(authContext.accessToken, String(req.params.id), req.body);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await tasksClient.remove(authContext.accessToken, String(req.params.id));
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/import", express.text({ type: "text/csv", limit: "10mb" }), async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = taskImportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  const csvContent = typeof parsed.data === "string" ? parsed.data : parsed.data.csv;
  if (!csvContent.trim()) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  try {
    const result = await tasksClient.importCsv(authContext.accessToken, csvContent);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Attachments ────────────────────────────────────────────────────────

app.get("/api/tasks/:id/attachments", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.listAttachments(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/attachments", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments`;
  const contentType = req.header("content-type");

  try {
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
    if (upstream.ok) {
      const attachment = responseContentType?.includes("application/json")
        ? jsonRecordFromBuffer(buffer)
        : {};
      await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
        source: "core-api",
        relation: "attachment",
        action: "create",
        attachment
      });
    }
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.put("/api/tasks/:id/attachments/:attachmentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const attachmentId = encodeURIComponent(String(req.params.attachmentId));
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments/${attachmentId}`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "PUT",
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
    if (upstream.ok) {
      const attachment = responseContentType?.includes("application/json")
        ? jsonRecordFromBuffer(buffer)
        : {};
      await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
        source: "core-api",
        relation: "attachment",
        action: "update",
        attachmentId: String(req.params.attachmentId),
        attachment
      });
    }
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment replacement proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/tasks/:id/attachments/:attachmentId/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const attachmentId = encodeURIComponent(String(req.params.attachmentId));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") query.set("download", req.query.download);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments/${attachmentId}/download${suffix}`;

  try {
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
    const message = error instanceof Error ? error.message : "Download proxy failed";
    return res.status(502).json({ message });
  }
});

app.delete("/api/tasks/:id/attachments/:attachmentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await tasksClient.deleteAttachment(authContext.accessToken, String(req.params.id), String(req.params.attachmentId));
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "attachment",
      action: "delete",
      attachmentId: String(req.params.attachmentId),
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Subtasks ────────────────────────────────────────────────────────────

app.get("/api/tasks/:id/occurrences/:date/subtasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.listSubtasks(authContext.accessToken, String(req.params.id), String(req.params.date));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/:date/subtasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.createSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      req.body?.title
    );
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "create",
      occurrenceDate: String(req.params.date),
      subtaskId: objectId(result),
      subtask: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/tasks/:id/occurrences/:date/subtasks/:subtaskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.updateSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      String(req.params.subtaskId),
      req.body
    );
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "update",
      occurrenceDate: String(req.params.date),
      subtaskId: String(req.params.subtaskId),
      patch: req.body as Record<string, unknown>,
      subtask: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/:id/occurrences/:date/subtasks/:subtaskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await tasksClient.deleteSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      String(req.params.subtaskId)
    );
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "delete",
      occurrenceDate: String(req.params.date),
      subtaskId: String(req.params.subtaskId),
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Today ("My Day") and Schedule ──────────────────────────────────────
// NOTE: GET /api/tasks/today is registered before GET /api/tasks/:id (above).
// Only POST, DELETE, schedule-calendar, and schedule-items remain here.

// POST /api/tasks/today — add a schedule item (= "add to My Day")
// Body: { taskId: string, scheduledDate: string, occurrenceDate: string, startTime?, endTime?, timezone? }
// scheduledDate  = calendar date to work on the task (today when called from My Day button)
// occurrenceDate = LBS execution date (may differ for Overdue/Planned tasks)
app.post("/api/tasks/today", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  logger.debug(`[workbench-core] POST /api/tasks/today  body=${JSON.stringify(req.body)}`);
  try {
    const { taskId, scheduledDate, occurrenceDate, startTime, endTime, timezone } = req.body as {
      taskId?: unknown; scheduledDate?: unknown; occurrenceDate?: unknown;
      startTime?: unknown; endTime?: unknown; timezone?: unknown;
    };
    // occurrenceDate may be omitted or "" for tasks with no LBS due date
    // (ONCE + no due_date); the tasks-service resolves it to scheduledDate.
    if (typeof taskId !== "string" || !taskId || typeof scheduledDate !== "string" || !scheduledDate) {
      return res.status(400).json({ message: "taskId and scheduledDate are required strings" });
    }
    if (occurrenceDate !== undefined && typeof occurrenceDate !== "string") {
      return res.status(400).json({ message: "occurrenceDate must be a string when provided" });
    }
    const requestedOccurrenceDate = occurrenceDate ?? "";
    const opts = {
      startTime: typeof startTime === "string" ? startTime : undefined,
      endTime: typeof endTime === "string" ? endTime : undefined,
      timezone: typeof timezone === "string" ? timezone : undefined
    };
    const result = await tasksClient.addToday(authContext.accessToken, taskId, scheduledDate, requestedOccurrenceDate, opts);
    const resultRecord = result as Record<string, unknown>;
    const effectiveOccurrenceDate = typeof resultRecord.occurrenceDate === "string"
      ? resultRecord.occurrenceDate
      : requestedOccurrenceDate || scheduledDate;
    await recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "today",
      action: "create",
      scheduledDate,
      occurrenceDate: effectiveOccurrenceDate,
      startTime: opts.startTime,
      endTime: opts.endTime,
      timezone: opts.timezone,
      scheduleItem: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// DELETE /api/tasks/today/:taskId?scheduledDate=YYYY-MM-DD — remove from Today
app.delete("/api/tasks/today/:taskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const taskId = String(req.params.taskId);
  const scheduledDate = typeof req.query.scheduledDate === "string" ? req.query.scheduledDate : undefined;
  const occurrenceDate = typeof req.query.occurrenceDate === "string" ? req.query.occurrenceDate : undefined;
  logger.debug(`[workbench-core] DELETE /api/tasks/today/${taskId}  scheduledDate=${scheduledDate ?? "?"} occurrenceDate=${occurrenceDate ?? "?"}`);
  if (!scheduledDate) return res.status(400).json({ message: "scheduledDate query parameter is required (YYYY-MM-DD)" });
  try {
    const result = await tasksClient.removeFromToday(authContext.accessToken, taskId, scheduledDate, occurrenceDate);
    await recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "today",
      action: "delete",
      scheduledDate,
      occurrenceDate,
      deleted: true,
      result: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// PUT /api/tasks/schedule-items/:id — update a schedule item's time/date fields
app.put("/api/tasks/schedule-items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const scheduleId = parseInt(req.params.id, 10);
  logger.debug(`[workbench-core] PUT /api/tasks/schedule-items/${scheduleId}  body=${JSON.stringify(req.body)}`);
  if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
  try {
    const patch = req.body as { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null };
    const result = await tasksClient.updateScheduleItem(authContext.accessToken, scheduleId, patch);
    if (!result) return res.status(404).json({ message: "Schedule item not found" });
    await recordSyncEventBestEffort(authContext.userId, "tasks", result.taskId, "update", {
      source: "core-api",
      relation: "scheduleItem",
      action: "update",
      scheduleId,
      patch: patch as Record<string, unknown>,
      scheduleItem: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/schedule-items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const scheduleId = parseInt(req.params.id, 10);
  if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
  try {
    const body = asJsonRecord(req.body);
    const taskId = asNonEmptyString(body.taskId) ?? (typeof req.query.taskId === "string" ? req.query.taskId.trim() : undefined);
    const scheduledDate = asNonEmptyString(body.scheduledDate) ?? (typeof req.query.scheduledDate === "string" ? req.query.scheduledDate.trim() : undefined);
    const occurrenceDate = asNonEmptyString(body.occurrenceDate) ?? (typeof req.query.occurrenceDate === "string" ? req.query.occurrenceDate.trim() : undefined);
    await tasksClient.deleteScheduleItem(authContext.accessToken, scheduleId);
    await recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "scheduleItem",
      action: "delete",
      scheduleId,
      scheduledDate,
      occurrenceDate,
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});
}
