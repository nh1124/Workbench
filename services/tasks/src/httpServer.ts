import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureTasksSchema, findServiceAccountByCoreUserId } from "./db.js";
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
  listTaskPins,
  listTasks,
  moveTaskOccurrence,
  provisionLbsAccount,
  updateTaskPin,
  updateTask
} from "./store.js";
import { RECURRENCE_TYPES, TASK_STATUSES } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function handleError(res: express.Response, error: unknown): express.Response {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  console.error("[tasks-service] request error:", message);

  if (message.includes("LBS_UNREACHABLE")) {
    return res.status(503).json({
      code: "LBS_UNREACHABLE",
      message: "Tasks backend (LBS) is unreachable. Check TASKS_LBS_BASE_URL and LBS server status.",
      detail: message
    });
  }

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
  monthDay: z.number().int().min(1).max(31).optional(),
  nthInMonth: z.number().int().min(1).max(5).optional(),
  weekdayMon1: z.number().int().min(0).max(6).optional()
});

const internalAccountSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1),
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

async function ensureLbsAccessToken(req: express.Request): Promise<string | undefined> {
  const existing = req.authUser?.lbsAccessToken;
  if (existing) {
    return existing;
  }

  const coreUserId = req.authUser?.coreUserId;
  const usernameSnapshot = req.authUser?.usernameSnapshot;
  if (!coreUserId || !usernameSnapshot) {
    return undefined;
  }

  await provisionLbsAccount(coreUserId, usernameSnapshot);
  const refreshed = await findServiceAccountByCoreUserId(coreUserId);
  if (!refreshed?.lbsAccessToken) {
    return undefined;
  }

  if (req.authUser) {
    req.authUser.lbsAccessToken = refreshed.lbsAccessToken;
    req.authUser.lbsRefreshToken = refreshed.lbsRefreshToken;
  }
  return refreshed.lbsAccessToken;
}

app.get("/health", (_req, res) => {
  res.json({
    service: "tasks",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/accounts", requireInternalApiKey, async (req, res) => {
  const parsed = internalAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  await provisionLbsAccount(parsed.data.coreUserId, parsed.data.username);
  return res.status(201).json({ status: "ok", service: "tasks" });
});

app.get("/tasks/export", requireUserAuth, async (req, res) => {
  try {
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const csv = await exportTasksCsv(lbsAccessToken);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"tasks.csv\"");
    return res.send(csv);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/import", requireUserAuth, express.text({ type: "text/csv", limit: "10mb" }), async (req, res) => {
  try {
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const csvContent = typeof req.body === "string" ? req.body : "";
    if (!csvContent.trim()) {
      return res.status(400).json({ message: "CSV content is required" });
    }
    const result = await importTasksCsv(csvContent, lbsAccessToken);
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

    const owner = req.authUser?.coreUserId;
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }

    const tasks = await listTasks({
      projectId: context,
      status: TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
        ? (status as (typeof TASK_STATUSES)[number])
        : undefined,
      limit: Number.isFinite(limit) ? limit : undefined
    }, owner, lbsAccessToken);

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
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
    const context = typeof req.query.context === "string" ? req.query.context : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate and endDate are required" });
    }

    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }

    const parsedStatus = TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
      ? (status as (typeof TASK_STATUSES)[number])
      : undefined;
    const schedule = await getTaskSchedule(startDate, endDate, context, parsedStatus, lbsAccessToken);
    return res.json(schedule);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/:id/occurrences/complete", requireUserAuth, async (req, res) => {
  try {
    const parsed = occurrenceStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const result = await completeTaskOccurrence(
      String(req.params.id),
      parsed.data.targetDate,
      parsed.data.status,
      lbsAccessToken
    );
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post("/tasks/:id/occurrences/move", requireUserAuth, async (req, res) => {
  try {
    const parsed = occurrenceMoveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const result = await moveTaskOccurrence(
      String(req.params.id),
      parsed.data.sourceDate,
      parsed.data.targetDate,
      lbsAccessToken
    );
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/:id/history", requireUserAuth, async (req, res) => {
  try {
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const history = await getTaskHistory(String(req.params.id), lbsAccessToken);
    return res.json(history);
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/tasks/:id", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const task = await getTask(String(req.params.id), owner, lbsAccessToken);

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
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const created = await createTask(normalized as unknown as Parameters<typeof createTask>[0], owner, lbsAccessToken);
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
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const updated = await updateTask(
      String(req.params.id),
      normalized as unknown as Parameters<typeof updateTask>[1],
      owner,
      lbsAccessToken
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
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const deleted = await deleteTask(String(req.params.id), owner, lbsAccessToken);

    if (!deleted) {
      return res.status(404).json({ message: "Task not found" });
    }

    return res.status(204).send();
  } catch (error) {
    return handleError(res, error);
  }
});

app.get("/projects", requireUserAuth, async (req, res) => {
  try {
    const owner = req.authUser?.coreUserId;
    const lbsAccessToken = await ensureLbsAccessToken(req);
    if (!owner) {
      return res.status(401).json({ message: "Missing auth context" });
    }
    if (!lbsAccessToken) {
      return res.status(403).json({ message: "LBS account token not provisioned" });
    }
    const projects = await listTaskProjects(owner, lbsAccessToken);
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

void ensureTasksSchema().then(() => {
  app.listen(port, host, () => {
    console.log(`Tasks service HTTP listening on ${host}:${port}`);
  });
});
