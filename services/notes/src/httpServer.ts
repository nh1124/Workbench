import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureNotesSchema, upsertServiceAccount } from "./db.js";
import {
  confirmNote,
  createNote,
  deleteNote,
  flagNote,
  getNote,
  listNoteProjects,
  listNotes,
  listNotesPage,
  snoozeNote,
  updateNote
} from "./store.js";
import { InvalidNoteQueueCursorError, listNoteMaintenanceQueue } from "./maintenanceQueueStore.js";
import {
  NOTE_LIFECYCLE_STATES,
  NOTE_MAINTENANCE_QUEUE_REASONS,
  NOTE_REVIEW_REASONS,
  type NoteMaintenanceQueueReason
} from "./types.js";

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

export const app = express();
app.use(cors());
app.use(express.json());

const noteInputSchema = z.object({
  title: z.string().min(1),
  content: z.string().default(""),
  projectId: z.string().min(1),
  projectName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  lifecycleState: z.enum(NOTE_LIFECYCLE_STATES).optional(),
  reviewAfter: z.string().datetime().nullable().optional(),
  reviewReason: z.enum(NOTE_REVIEW_REASONS).nullable().optional()
});

const noteConfirmSchema = z.object({
  lifecycleState: z.enum(["curated", "verified"]).optional(),
  reviewAfter: z.string().datetime().nullable().optional()
});

const futureDateTimeSchema = z.string().datetime().refine((value) => Date.parse(value) > Date.now(), {
  message: "Datetime must be in the future"
});

const noteSnoozeSchema = z.object({
  until: futureDateTimeSchema
});

const noteFlagSchema = z.object({
  reason: z.enum(NOTE_REVIEW_REASONS),
  note: z.string().optional()
});

const internalAccountSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1),
});

app.get("/health", (_req, res) => {
  res.json({
    service: "notes",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/accounts", requireInternalApiKey, async (req, res) => {
  const parsed = internalAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  await upsertServiceAccount(parsed.data.coreUserId, parsed.data.username);
  return res.status(201).json({ status: "ok", service: "notes" });
});

app.use(requireCoreMutationOriginMiddleware);

function sanitizeLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type QueueRouteOptions = {
  projectId?: string;
  reason?: NoteMaintenanceQueueReason;
  cursor?: string;
  limit?: number;
};

function readQueueRouteOptions(req: express.Request, res: express.Response): QueueRouteOptions | undefined {
  if (req.query.reason !== undefined && typeof req.query.reason !== "string") {
    res.status(400).json({ message: "Invalid maintenance reason" });
    return undefined;
  }
  const reason = typeof req.query.reason === "string" ? req.query.reason : undefined;
  if (reason && !NOTE_MAINTENANCE_QUEUE_REASONS.includes(reason as NoteMaintenanceQueueReason)) {
    res.status(400).json({ message: "Invalid maintenance reason" });
    return undefined;
  }
  return {
    projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
    reason: reason as NoteMaintenanceQueueReason | undefined,
    cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
    limit: sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined)
  };
}

app.get("/maintenance/note-queue", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  try {
    const options = readQueueRouteOptions(req, res);
    if (!options) return;
    return res.json(await listNoteMaintenanceQueue(owner, options));
  } catch (error) {
    if (error instanceof InvalidNoteQueueCursorError) {
      return res.status(400).json({ code: "INVALID_CURSOR", message: error.message });
    }
    throw error;
  }
});

app.get("/notes", requireUserAuth, async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const paged = req.query.page === "true" || cursor !== undefined;
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  if (paged) {
    const page = await listNotesPage(projectId, Number.isFinite(limit) ? limit : undefined, cursor, owner);
    return res.json(page);
  }
  const notes = await listNotes(projectId, Number.isFinite(limit) ? limit : undefined, owner);
  res.json(notes);
});

app.get("/notes/:id", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const note = await getNote(String(req.params.id), owner);

  if (!note) {
    return res.status(404).json({ message: "Note not found" });
  }

  return res.json(note);
});

app.post("/notes", requireUserAuth, async (req, res) => {
  const parsed = noteInputSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const created = await createNote(parsed.data, owner);
  return res.status(201).json(created);
});

app.patch("/notes/:id", requireUserAuth, async (req, res) => {
  const parsed = noteInputSchema.partial().safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const updated = await updateNote(String(req.params.id), parsed.data, owner);

  if (!updated) {
    return res.status(404).json({ message: "Note not found" });
  }

  return res.json(updated);
});

app.post("/notes/:id/confirm", requireUserAuth, async (req, res) => {
  const parsed = noteConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const updated = await confirmNote(
    String(req.params.id),
    { lifecycleState: parsed.data.lifecycleState, reviewAfter: parsed.data.reviewAfter ?? null },
    owner
  );

  if (!updated) {
    return res.status(404).json({ message: "Note not found" });
  }

  return res.json(updated);
});

app.post("/notes/:id/snooze", requireUserAuth, async (req, res) => {
  const parsed = noteSnoozeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const updated = await snoozeNote(String(req.params.id), parsed.data.until, owner);

  if (!updated) {
    return res.status(404).json({ message: "Note not found" });
  }

  return res.json(updated);
});

app.post("/notes/:id/flag", requireUserAuth, async (req, res) => {
  const parsed = noteFlagSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const updated = await flagNote(String(req.params.id), parsed.data.reason, owner);

  if (!updated) {
    return res.status(404).json({ message: "Note not found" });
  }

  return res.json(parsed.data.note === undefined ? updated : { ...updated, note: parsed.data.note });
});

app.delete("/notes/:id", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const deleted = await deleteNote(String(req.params.id), owner);

  if (!deleted) {
    return res.status(404).json({ message: "Note not found" });
  }

  return res.status(204).send();
});

app.get("/projects", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const projects = await listNoteProjects(owner);
  res.json(projects);
});

const port = Number(requireEnv("NOTES_SERVICE_PORT"));
const host = requireEnv("NOTES_SERVICE_HOST");
if (!Number.isFinite(port)) {
  throw new Error(`Invalid NOTES_SERVICE_PORT value: ${process.env.NOTES_SERVICE_PORT}`);
}

const isDirectExecution = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
if (isDirectExecution) {
  void ensureNotesSchema().then(() => {
    app.listen(port, host, () => {
      console.log(`Notes service HTTP listening on ${host}:${port}`);
    });
  });
}
