import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { installProcessHandlers, requestLogger } from "@workbench/logging";
import { requireUserAuth } from "./auth.js";
import { logger } from "./logger.js";
import {
  createAttachment,
  deleteAttachment,
  deleteAttachmentsForTask,
  listAttachments,
  readAttachmentData,
  replaceAttachment
} from "./attachmentsStore.js";
import { ensureTasksSchema } from "./db.js";
import {
  createSubtask,
  deleteSubtask,
  deleteSubtasksForTask,
  listSubtasks,
  updateSubtask
} from "./subtasksStore.js";
import {
  completeTaskOccurrence,
  createTask,
  deleteTask,
  exportTasksCsv,
  getTaskSchedule,
  getTask,
  getTaskHistory,
  importTasksCsv,
  listTaskProjects,
  listTasksPage,
  listTaskPins,
  listTasks,
  updateTaskPin,
  updateTask
} from "./store.js";
import {
  moveTaskOccurrence,
  skipTaskOccurrenceException
} from "./taskExceptionStore.js";
import {
  addTaskToToday,
  deleteTaskScheduleItem,
  listTaskScheduleItems,
  listTaskScheduleCalendar,
  listTaskToday,
  removeTaskFromToday,
  updateTaskScheduleItem
} from "./taskScheduleStore.js";
import { RECURRENCE_TYPES, TASK_STATUSES } from "./types.js";
import { getTasksLbsMode } from "./lbs/backendFactory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });
getTasksLbsMode();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const CORE_MUTATION_ORIGIN_HEADER = "x-workbench-core-mutation";
const CORE_MUTATION_TOKEN_HEADER = "x-workbench-core-mutation-token";
const requireCoreMutationOrigin = envFlag("WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN");
const coreMutationToken = optionalEnv("WORKBENCH_CORE_MUTATION_TOKEN");

function isMutationMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE";
}

function requireCoreMutationOriginMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!requireCoreMutationOrigin || !isMutationMethod(req.method) || req.path.startsWith("/internal/")) {
    next();
    return;
  }

  if (req.header(CORE_MUTATION_ORIGIN_HEADER) !== "1") {
    res.status(403).json({
      code: "CORE_MUTATION_ORIGIN_REQUIRED",
      message: "Mutations must be routed through Workbench Core."
    });
    return;
  }

  if (coreMutationToken && req.header(CORE_MUTATION_TOKEN_HEADER) !== coreMutationToken) {
    res.status(403).json({
      code: "CORE_MUTATION_TOKEN_INVALID",
      message: "Invalid Workbench Core mutation token."
    });
    return;
  }

  next();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(requestLogger(logger));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function handleError(res: express.Response, error: unknown): express.Response {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  logger.error("[tasks-service] request error", { err: error });

  return res.status(502).json({ code: "UPSTREAM_ERROR", message });
}

const taskInputSchema = z.object({
  title: z.string().min(1),
  notes: z.string().default(""),
  context: z.string().min(1),
  contextName: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  isLocked: z.boolean().optional(),
  baseLoadScore: z.number().min(0).max(10).optional(),
  recurrence: z.enum(RECURRENCE_TYPES).optional(),
  dueDate: z.string().optional().or(z.literal("")),
  startTime: z.string().optional().or(z.literal("")),
  endTime: z.string().optional().or(z.literal("")),
  timezone: z.string().optional(),
  activeFrom: z.string().optional().or(z.literal("")),
  activeUntil: z.string().optional().or(z.literal("")),
  active: z.boolean().optional(),
  mon: z.boolean().optional(),
  tue: z.boolean().optional(),
  wed: z.boolean().optional(),
  thu: z.boolean().optional(),
  fri: z.boolean().optional(),
  sat: z.boolean().optional(),
  sun: z.boolean().optional(),
  intervalDays: z.number().int().positive().optional(),
  anchorDate: z.string().optional().or(z.literal("")),
  monthDay: z.number().int().min(1).max(31).optional(),
  nthInMonth: z.number().int().min(1).max(5).optional(),
  weekdayMon1: z.number().int().min(0).max(6).optional()
});

const taskPinSchema = z.object({
  pinned: z.boolean()
});

const occurrenceStatusSchema = z.object({
  targetDate: z.string().min(1),
  status: z.enum(TASK_STATUSES)
});

const occurrenceMoveSchema = z.object({
  sourceDate: z.string().min(1),
  targetDate: z.string().min(1)
});

function normalizeEmptyStrings(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = val === "" ? undefined : val;
  }
  return result;
}

app.get("/health", (_req, res) => {
  res.json({
    service: "tasks",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.use(requireCoreMutationOriginMiddleware);

app.get("/tasks/export", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const csv = await exportTasksCsv({ ownerCoreUserId: owner });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"tasks.csv\"");
    return res.send(csv);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/import", requireUserAuth, express.text({ type: "text/csv", limit: "10mb" }), async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const csvContent = typeof req.body === "string" ? req.body : "";
    if (!csvContent.trim()) {
      return res.status(400).json({ message: "CSV content is required" });
    }
    const result = await importTasksCsv(csvContent, { ownerCoreUserId: owner });
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks", requireUserAuth, async (req, res) => {
  try {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const context = typeof req.query.context === "string" ? req.query.context : projectId;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const paged = req.query.page === "true" || cursor !== undefined;

    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }

    const filters = {
      projectId: context,
      status: TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
        ? (status as (typeof TASK_STATUSES)[number])
        : undefined,
      limit: Number.isFinite(limit) ? limit : undefined
    };

    if (paged) {
      const page = await listTasksPage({ ...filters, cursor }, owner, { ownerCoreUserId: owner });
      return res.json(page);
    }

    const tasks = await listTasks(filters, owner, { ownerCoreUserId: owner });

    return res.json(tasks);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/pins", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const taskIds = await listTaskPins(owner);
    return res.json({ taskIds });
  } catch (error) {
    return handleError(res, error);
  }
});

// ── Today ("My Day") and Schedule ────────────────────────────────────────────
// NOTE: These routes MUST be registered before any /tasks/:id routes so that
// Express doesn't mistake "today", "schedule-calendar", "schedule-items" for a task ID.

const taskTodayAddSchema = z.object({
  taskId: z.string().min(1),
  scheduledDate: z.string().min(1),
  // occurrenceDate may be empty for tasks with no due date (ONCE + no due_date).
  // In that case the store will fall back to scheduledDate as the LBS completion target.
  occurrenceDate: z.string().optional().default(""),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  timezone: z.string().optional()
});

const scheduleItemUpdateSchema = z.object({
  scheduledDate: z.string().min(1).optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  timezone: z.string().nullable().optional()
});

// GET /tasks/today?date=YYYY-MM-DD
// Returns TodayTask[] — full task objects enriched with occurrenceDate + schedule info.
app.get("/tasks/today", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  logger.debug(`[tasks-service] GET /tasks/today  owner=${owner ?? "?"} date=${date ?? "?"}`);
  try {
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    if (!date) return res.status(400).json({ message: "date query parameter is required (YYYY-MM-DD)" });
    const tasks = await listTaskToday(owner, date, { ownerCoreUserId: owner });
    logger.debug(`[tasks-service] GET /tasks/today  returned ${tasks.length} TodayTask(s) for ${date}`);
    return res.json(tasks);
  } catch (error) {
    return handleError(res, error);
  }
});

// POST /tasks/today — add a schedule item (= "add to My Day")
// Body: { taskId, scheduledDate, occurrenceDate, startTime?, endTime?, timezone? }
// scheduledDate  = the calendar date to work on the task (today when called from My Day button)
// occurrenceDate = LBS execution date (may differ for Overdue/Planned tasks)
app.post("/tasks/today", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  logger.debug(`[tasks-service] POST /tasks/today  owner=${owner ?? "?"} body=${JSON.stringify(req.body)}`);
  try {
    const parsed = taskTodayAddSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const { taskId, scheduledDate, occurrenceDate, startTime, endTime, timezone } = parsed.data;
    const result = await addTaskToToday(owner, taskId, scheduledDate, occurrenceDate, { startTime, endTime, timezone });
    logger.debug(`[tasks-service] POST /tasks/today  created scheduleId=${result.id} taskId=${taskId}`);
    return res.status(201).json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

// DELETE /tasks/today/:taskId?scheduledDate=YYYY-MM-DD&occurrenceDate=YYYY-MM-DD
// If occurrenceDate is present, delete only that occurrence-level membership.
// Without occurrenceDate, keep the legacy broad task + scheduledDate behavior.
app.delete("/tasks/today/:taskId", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  const taskId = String(req.params.taskId);
  const scheduledDate = typeof req.query.scheduledDate === "string" ? req.query.scheduledDate : undefined;
  const occurrenceDate = typeof req.query.occurrenceDate === "string" ? req.query.occurrenceDate : undefined;
  logger.debug(
    `[tasks-service] DELETE /tasks/today/${taskId}  owner=${owner ?? "?"} scheduledDate=${scheduledDate ?? "?"} occurrenceDate=${occurrenceDate ?? "?"}`
  );
  try {
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    if (!scheduledDate) return res.status(400).json({ message: "scheduledDate query parameter is required (YYYY-MM-DD)" });
    const result = await removeTaskFromToday(owner, taskId, scheduledDate, occurrenceDate);
    logger.debug(`[tasks-service] DELETE /tasks/today/${taskId}  removed ${result.removed} item(s)`);
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

// GET /tasks/schedule-calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns ScheduleCalendarDay[] grouped by scheduled_date.
app.get("/tasks/schedule-calendar", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  logger.debug(`[tasks-service] GET /tasks/schedule-calendar  owner=${owner ?? "?"} ${startDate}→${endDate}`);
  try {
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate query parameters are required" });
    const days = await listTaskScheduleCalendar(owner, startDate, endDate, { ownerCoreUserId: owner });
    return res.json(days);
  } catch (error) {
    return handleError(res, error);
  }
});

// PUT /tasks/schedule-items/:id — update a schedule item's time/date fields
app.put("/tasks/schedule-items/:id", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  const scheduleId = parseInt(String(req.params.id), 10);
  logger.debug(`[tasks-service] PUT /tasks/schedule-items/${scheduleId}  owner=${owner ?? "?"} body=${JSON.stringify(req.body)}`);
  try {
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "occurrenceDate")) {
      logger.warn(
        `[tasks-service] PUT /tasks/schedule-items/${scheduleId} ignored immutable occurrenceDate; use the occurrence move route`
      );
    }
    const parsed = scheduleItemUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
    const result = await updateTaskScheduleItem(owner, scheduleId, parsed.data);
    if (!result) return res.status(404).json({ message: "Schedule item not found" });
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.delete("/tasks/schedule-items/:id", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  const scheduleId = parseInt(String(req.params.id), 10);
  try {
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
    const deleted = await deleteTaskScheduleItem(owner, scheduleId);
    if (!deleted) return res.status(404).json({ message: "Schedule item not found" });
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error);
  }
});

app.put("/tasks/:id/pin", requireUserAuth, async (req, res) => {
  try {
    const parsed = taskPinSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const result = await updateTaskPin(owner, String(req.params.id), parsed.data.pinned);
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/schedule", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
    const context = typeof req.query.context === "string" ? req.query.context : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate and endDate are required" });
    }
    if (!owner) return res.status(401).json({ message: "Missing auth context" });

    const parsedStatus = TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
      ? (status as (typeof TASK_STATUSES)[number])
      : undefined;
    const schedule = await getTaskSchedule(startDate, endDate, context, parsedStatus, { ownerCoreUserId: owner });
    return res.json(schedule);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/:id/occurrences/complete", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    const parsed = occurrenceStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const result = await completeTaskOccurrence(
      String(req.params.id),
      parsed.data.targetDate,
      parsed.data.status,
      { ownerCoreUserId: owner }
    );
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/:id/occurrences/move", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    const parsed = occurrenceMoveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const result = await moveTaskOccurrence(
      String(req.params.id),
      parsed.data.sourceDate,
      parsed.data.targetDate,
      { ownerCoreUserId: owner }
    );
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/:id/occurrences/skip-exception", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    const parsed = z.object({ targetDate: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const result = await skipTaskOccurrenceException(
      String(req.params.id),
      parsed.data.targetDate,
      { ownerCoreUserId: owner }
    );
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/:id/history", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const history = await getTaskHistory(String(req.params.id), { ownerCoreUserId: owner });
    return res.json(history);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/:id/schedule-items", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const items = await listTaskScheduleItems(owner, String(req.params.id));
    return res.json(items);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/:id", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const task = await getTask(String(req.params.id), owner, { ownerCoreUserId: owner });

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    return res.json(task);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks", requireUserAuth, async (req, res) => {
  try {
    const parsed = taskInputSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }

    const normalized = normalizeEmptyStrings(parsed.data as Record<string, unknown>);
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const created = await createTask(
      normalized as unknown as Parameters<typeof createTask>[0],
      owner,
      { ownerCoreUserId: owner }
    );
    return res.status(201).json(created);
  } catch (error) {
    return handleError(res, error);
  }
});

app.patch("/tasks/:id", requireUserAuth, async (req, res) => {
  try {
    const parsed = taskInputSchema.partial().safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }

    const normalized = normalizeEmptyStrings(parsed.data as Record<string, unknown>);
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const updated = await updateTask(
      String(req.params.id),
      normalized as unknown as Parameters<typeof updateTask>[1],
      owner,
      { ownerCoreUserId: owner }
    );

    if (!updated) {
      return res.status(404).json({ message: "Task not found" });
    }

    return res.json(updated);
  } catch (error) {
    return handleError(res, error);
  }
});

app.delete("/tasks/:id", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const taskId = String(req.params.id);
    const deleted = await deleteTask(taskId, owner, { ownerCoreUserId: owner });

    if (!deleted) {
      return res.status(404).json({ message: "Task not found" });
    }

    // Cascade: remove locally-stored attachments and subtasks.
    await Promise.all([
      deleteAttachmentsForTask(taskId, owner),
      deleteSubtasksForTask(taskId, owner)
    ]);

    return res.status(204).send();
  } catch (error) {
    return handleError(res, error);
  }
});

// ── Attachments ───────────────────────────────────────────────────────────────

app.get("/tasks/:id/attachments", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const attachments = await listAttachments(String(req.params.id), owner);
    return res.json(attachments);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/:id/attachments", requireUserAuth, upload.single("file"), async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    if (!req.file) return res.status(400).json({ message: "File is required" });
    const created = await createAttachment(String(req.params.id), owner, req.file);
    return res.status(201).json(created);
  } catch (error) {
    return handleError(res, error);
  }
});

app.put("/tasks/:id/attachments/:attachmentId", requireUserAuth, upload.single("file"), async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    if (!req.file) return res.status(400).json({ message: "File is required" });
    const updated = await replaceAttachment(
      String(req.params.attachmentId),
      String(req.params.id),
      owner,
      {
        originalname: typeof req.body.filename === "string" ? req.body.filename : undefined,
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        size: req.file.size
      }
    );
    if (!updated) return res.status(404).json({ message: "Attachment not found" });
    return res.json(updated);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/:id/attachments/:attachmentId/download", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const data = await readAttachmentData(String(req.params.attachmentId), String(req.params.id), owner);
    if (!data) return res.status(404).json({ message: "Attachment not found" });
    const asAttachment = String(req.query.download ?? "") === "1";
    res.setHeader("Content-Type", data.mimeType);
    res.setHeader("Content-Length", String(data.buffer.length));
    res.setHeader(
      "Content-Disposition",
      `${asAttachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(data.filename)}`
    );
    return res.send(data.buffer);
  } catch (error) {
    return handleError(res, error);
  }
});

app.delete("/tasks/:id/attachments/:attachmentId", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const deleted = await deleteAttachment(String(req.params.attachmentId), String(req.params.id), owner);
    if (!deleted) return res.status(404).json({ message: "Attachment not found" });
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error);
  }
});

// ── Subtasks ──────────────────────────────────────────────────────────────────

const subtaskInputSchema = z.object({ title: z.string().min(1) });
const subtaskUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  isDone: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional()
});

app.get("/tasks/:id/occurrences/:date/subtasks", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const subtasks = await listSubtasks(String(req.params.id), String(req.params.date), owner);
    return res.json(subtasks);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/:id/occurrences/:date/subtasks", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const parsed = subtaskInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
    const created = await createSubtask(String(req.params.id), String(req.params.date), owner, parsed.data.title);
    return res.status(201).json(created);
  } catch (error) {
    return handleError(res, error);
  }
});

app.patch("/tasks/:id/occurrences/:date/subtasks/:subtaskId", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const parsed = subtaskUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
    const updated = await updateSubtask(
      String(req.params.subtaskId),
      String(req.params.id),
      String(req.params.date),
      owner,
      parsed.data
    );
    if (!updated) return res.status(404).json({ message: "Subtask not found" });
    return res.json(updated);
  } catch (error) {
    return handleError(res, error);
  }
});

app.delete("/tasks/:id/occurrences/:date/subtasks/:subtaskId", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) return res.status(401).json({ message: "Missing auth context" });
    const deleted = await deleteSubtask(
      String(req.params.subtaskId),
      String(req.params.id),
      String(req.params.date),
      owner
    );
    if (!deleted) return res.status(404).json({ message: "Subtask not found" });
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/projects", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    const projects = await listTaskProjects(owner, { ownerCoreUserId: owner });
    return res.json(projects);
  } catch (error) {
    return handleError(res, error);
  }
});

const port = Number(requireEnv("TASKS_SERVICE_PORT"));
const host = requireEnv("TASKS_SERVICE_HOST");
if (!Number.isFinite(port)) {
  throw new Error(`Invalid TASKS_SERVICE_PORT value: ${process.env.TASKS_SERVICE_PORT}`);
}

installProcessHandlers(logger);

void ensureTasksSchema().then(() => {
  app.listen(port, host, () => {
    logger.info(`Tasks service HTTP listening on ${host}:${port}`);
  });
});
