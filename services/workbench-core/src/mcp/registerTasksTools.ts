import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { lbsClient, tasksClient } from "../internalClients.js";
import { asMcpText, runWithAuth } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

export function registerTasksTools(server: McpServer, ctx: ToolContext): void;
export function registerTasksTools(server: McpServer): void;
export function registerTasksTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }

  // ── Task CRUD ────────────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.list",
    {
      title: "List Tasks",
      description: "List tasks for the authenticated user.",
      inputSchema: {
        context: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ context, status, limit }) => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.list(ctx.accessToken, context, status, limit));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.get",
    {
      title: "Get Task",
      description: "Get a single task by ID.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.get(ctx.accessToken, id));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.create",
    {
      title: "Create Task",
      description: "Create a new task.",
      inputSchema: {
        title: z.string().min(1),
        context: z.string().min(1),
        notes: z.string().optional(),
        status: z.string().optional(),
        isLocked: z.boolean().optional(),
        baseLoadScore: z.number().optional(),
        recurrence: z.string().optional(),
        dueDate: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        timezone: z.string().optional(),
        activeFrom: z.string().optional().describe("Active from date (YYYY-MM-DD)"),
        activeUntil: z.string().optional().describe("Active until date (YYYY-MM-DD)"),
        intervalDays: z.number().int().positive().optional().describe("Interval in days (EVERY_N_DAYS only)"),
        anchorDate: z.string().optional().describe("Anchor date for EVERY_N_DAYS recurrence (YYYY-MM-DD). Defaults to activeFrom if not set.")
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.create(ctx.accessToken, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.update",
    {
      title: "Update Task",
      description: "Update fields of an existing task.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        context: z.string().optional(),
        notes: z.string().optional(),
        status: z.string().optional(),
        isLocked: z.boolean().optional(),
        baseLoadScore: z.number().optional(),
        recurrence: z.string().optional(),
        dueDate: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        timezone: z.string().optional(),
        activeFrom: z.string().optional().describe("Active from date (YYYY-MM-DD)"),
        activeUntil: z.string().optional().describe("Active until date (YYYY-MM-DD)"),
        intervalDays: z.number().int().positive().optional().describe("Interval in days (EVERY_N_DAYS only)"),
        anchorDate: z.string().optional().describe("Anchor date for EVERY_N_DAYS recurrence (YYYY-MM-DD)")
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.update(ctx.accessToken, id, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.delete",
    {
      title: "Delete Task",
      description: "Permanently delete a task by ID.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      await runWithAuth(ctx.accessToken, () => tasksClient.remove(ctx.accessToken, id));
      return asMcpText({ status: "ok" });
    }
  );

  // ── Pin management ───────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.pins.list",
    {
      title: "List Pinned Tasks",
      description: "Return the list of pinned task IDs for the authenticated user.",
      inputSchema: {}
    },
    async () => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.pins(ctx.accessToken));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.pins.set",
    {
      title: "Pin / Unpin Task",
      description: "Pin or unpin a task. Pass pinned=true to pin, false to unpin.",
      inputSchema: {
        id: z.string().min(1),
        pinned: z.boolean()
      }
    },
    async ({ id, pinned }) => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.setPin(ctx.accessToken, id, pinned));
      return asMcpText(result);
    }
  );

  // ── Schedule (occurrences) ───────────────────────────────────────────────────

  server.registerTool(
    "tasks.schedule",
    {
      title: "Get Task Schedule",
      description:
        "Return scheduled occurrences of tasks within a date range. " +
        "startDate and endDate must be ISO-8601 date strings (YYYY-MM-DD).",
      inputSchema: {
        startDate: z.string().min(1).describe("Start of the date range (YYYY-MM-DD)"),
        endDate: z.string().min(1).describe("End of the date range (YYYY-MM-DD)"),
        context: z.string().optional(),
        status: z.string().optional()
      }
    },
    async ({ startDate, endDate, context, status }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        tasksClient.schedule(ctx.accessToken, startDate, endDate, context, status)
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.occurrences.complete",
    {
      title: "Complete Task Occurrence",
      description:
        "Mark a specific occurrence of a recurring task as complete (or another status). " +
        "targetDate must be an ISO-8601 date string (YYYY-MM-DD).",
      inputSchema: {
        id: z.string().min(1).describe("Task ID"),
        targetDate: z.string().min(1).describe("Occurrence date to complete (YYYY-MM-DD)"),
        status: z.string().min(1).describe("New status for the occurrence, e.g. 'done'")
      }
    },
    async ({ id, targetDate, status }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        tasksClient.completeOccurrence(ctx.accessToken, id, targetDate, status)
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.occurrences.move",
    {
      title: "Move Task Occurrence",
      description:
        "Reschedule a specific occurrence of a recurring task from one date to another. " +
        "Both dates must be ISO-8601 date strings (YYYY-MM-DD).",
      inputSchema: {
        id: z.string().min(1).describe("Task ID"),
        sourceDate: z.string().min(1).describe("Original occurrence date (YYYY-MM-DD)"),
        targetDate: z.string().min(1).describe("New occurrence date (YYYY-MM-DD)")
      }
    },
    async ({ id, sourceDate, targetDate }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        tasksClient.moveOccurrence(ctx.accessToken, id, sourceDate, targetDate)
      );
      return asMcpText(result);
    }
  );

  // ── History ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.history",
    {
      title: "Get Task History",
      description: "Return the execution / change history for a task.",
      inputSchema: {
        id: z.string().min(1).describe("Task ID")
      }
    },
    async ({ id }) => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.history(ctx.accessToken, id));
      return asMcpText(result);
    }
  );

  // ── Projects ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.projects.list",
    {
      title: "List Task Projects",
      description: "Return the list of projects available in the tasks service.",
      inputSchema: {}
    },
    async () => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.projects(ctx.accessToken));
      return asMcpText(result);
    }
  );

  // ── Import / Export ──────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.export",
    {
      title: "Export Tasks as CSV",
      description: "Export all tasks for the authenticated user as a CSV string.",
      inputSchema: {}
    },
    async () => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.exportCsv(ctx.accessToken));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.import",
    {
      title: "Import Tasks from CSV",
      description: "Import tasks from a CSV string. Returns the number of tasks imported.",
      inputSchema: {
        csv: z.string().min(1).describe("CSV content to import")
      }
    },
    async ({ csv }) => {
      const result = await runWithAuth(ctx.accessToken, () => tasksClient.importCsv(ctx.accessToken, csv));
      return asMcpText(result);
    }
  );

  // ── LBS: Analytics / Condition ───────────────────────────────────────────

  server.registerTool(
    "tasks.lbs.dashboard",
    {
      title: "LBS Dashboard",
      description:
        "Get the LBS weekly dashboard: current cognitive load, warning level (SAFE/WARNING/DANGER/CRITICAL), " +
        "next-day predictions, and KPI summary.",
      inputSchema: {}
    },
    async () => {
      const result = await runWithAuth(ctx.accessToken, () => lbsClient.dashboard(ctx.accessToken));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.calculate",
    {
      title: "LBS Calculate Daily Load",
      description:
        "Calculate the adjusted cognitive load for a specific date using the LBS formula " +
        "(Base + α×N^β + switch_cost×(U-1)). " +
        "Returns load value, warning level, and per-task breakdown. " +
        "date must be YYYY-MM-DD. statuses filters which tasks are included (default: todo,done).",
      inputSchema: {
        date: z.string().min(1).describe("Target date (YYYY-MM-DD)"),
        statuses: z
          .array(z.string())
          .optional()
          .describe("Task statuses to include in calculation, e.g. [\"todo\",\"done\"]")
      }
    },
    async ({ date, statuses }) => {
      const result = await runWithAuth(ctx.accessToken, () => lbsClient.calculate(ctx.accessToken, date, statuses));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.heatmap",
    {
      title: "LBS Heatmap",
      description: "Get calendar heatmap data showing daily cognitive load distribution. " +
        "Useful for identifying overloaded or light days at a glance.",
      inputSchema: {
        statuses: z.array(z.string()).optional().describe("Task statuses to include")
      }
    },
    async ({ statuses }) => {
      const result = await runWithAuth(ctx.accessToken, () => lbsClient.heatmap(ctx.accessToken, statuses));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.trends",
    {
      title: "LBS Weekly Trends",
      description: "Get multi-week load trend predictions from LBS.",
      inputSchema: {
        statuses: z.array(z.string()).optional().describe("Task statuses to include")
      }
    },
    async ({ statuses }) => {
      const result = await runWithAuth(ctx.accessToken, () => lbsClient.trends(ctx.accessToken, statuses));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.context_distribution",
    {
      title: "LBS Context Distribution",
      description: "Get cognitive load breakdown grouped by task context/project.",
      inputSchema: {
        statuses: z.array(z.string()).optional().describe("Task statuses to include")
      }
    },
    async ({ statuses }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        lbsClient.contextDistribution(ctx.accessToken, statuses)
      );
      return asMcpText(result);
    }
  );

  // ── LBS: Schedule ─────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.lbs.schedule",
    {
      title: "LBS Unified Schedule",
      description:
        "Get the LBS unified schedule grouped by date, with exception overrides applied " +
        "(SKIP, OVERRIDE_LOAD, FORCE_DO, RESCHEDULE). " +
        "Prefer this over tasks.schedule when cognitive-load context is needed. " +
        "startDate and endDate must be YYYY-MM-DD.",
      inputSchema: {
        startDate: z.string().min(1).describe("Start of range (YYYY-MM-DD)"),
        endDate: z.string().min(1).describe("End of range (YYYY-MM-DD)")
      }
    },
    async ({ startDate, endDate }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        lbsClient.schedule(ctx.accessToken, startDate, endDate)
      );
      return asMcpText(result);
    }
  );

  // ── LBS: Execution ────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.lbs.execution.record",
    {
      title: "LBS Record Task Execution",
      description:
        "Record or update the execution status for a specific task on a given date. " +
        "status must be one of: done, skipped, in_progress, todo. " +
        "progress is 0-100. actual_time is minutes spent (optional).",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID"),
        targetDate: z.string().min(1).describe("Execution date (YYYY-MM-DD)"),
        status: z
          .enum(["done", "skipped", "in_progress", "todo"])
          .describe("Execution status"),
        progress: z.number().int().min(0).max(100).optional().describe("Progress 0-100"),
        actualTime: z.number().int().positive().optional().describe("Actual time spent in minutes")
      }
    },
    async ({ taskId, targetDate, status, progress, actualTime }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        lbsClient.recordExecution(ctx.accessToken, taskId, {
          target_date: targetDate,
          status,
          progress,
          actual_time: actualTime
        })
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.execution.history",
    {
      title: "LBS Task Execution History",
      description: "Retrieve the full execution history (done/skipped/in_progress/todo records) for a task from LBS.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID")
      }
    },
    async ({ taskId }) => {
      const result = await runWithAuth(ctx.accessToken, () => lbsClient.taskHistory(ctx.accessToken, taskId));
      return asMcpText(result);
    }
  );

  // ── LBS: Exceptions ───────────────────────────────────────────────────────

  server.registerTool(
    "tasks.lbs.exceptions.list",
    {
      title: "LBS List Exceptions",
      description:
        "List task exceptions (SKIP, OVERRIDE_LOAD, FORCE_DO, RESCHEDULE, MANUAL_LOCK). " +
        "Filter by taskId and/or date range.",
      inputSchema: {
        taskId: z.string().optional().describe("Filter by task ID"),
        startDate: z.string().optional().describe("Start of date range (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("End of date range (YYYY-MM-DD)")
      }
    },
    async ({ taskId, startDate, endDate }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        lbsClient.listExceptions(ctx.accessToken, taskId, startDate, endDate)
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.exceptions.create",
    {
      title: "LBS Create Exception",
      description:
        "Create a task exception for a specific date. " +
        "exceptionType: SKIP | OVERRIDE_LOAD | FORCE_DO | RESCHEDULE | MANUAL_LOCK. " +
        "overrideLoadValue is required for OVERRIDE_LOAD. " +
        "startTime / endTime (HH:MM) are required for RESCHEDULE.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID"),
        targetDate: z.string().min(1).describe("Exception date (YYYY-MM-DD)"),
        exceptionType: z
          .enum(["SKIP", "OVERRIDE_LOAD", "FORCE_DO", "RESCHEDULE", "MANUAL_LOCK"])
          .describe("Type of exception"),
        overrideLoadValue: z.number().optional().describe("Custom load value (OVERRIDE_LOAD only)"),
        startTime: z.string().optional().describe("Start time HH:MM (RESCHEDULE only)"),
        endTime: z.string().optional().describe("End time HH:MM (RESCHEDULE only)"),
        isLocked: z.boolean().optional().describe("Lock this exception")
      }
    },
    async ({ taskId, targetDate, exceptionType, overrideLoadValue, startTime, endTime, isLocked }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        lbsClient.createException(ctx.accessToken, {
          task_id: taskId,
          target_date: targetDate,
          exception_type: exceptionType,
          override_load_value: overrideLoadValue,
          start_time: startTime,
          end_time: endTime,
          is_locked: isLocked
        })
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.exceptions.update",
    {
      title: "LBS Update Exception",
      description: "Update an existing task exception by its numeric ID.",
      inputSchema: {
        id: z.number().int().positive().describe("Exception ID"),
        exceptionType: z
          .enum(["SKIP", "OVERRIDE_LOAD", "FORCE_DO", "RESCHEDULE", "MANUAL_LOCK"])
          .optional()
          .describe("Type of exception"),
        overrideLoadValue: z.number().optional().describe("Custom load value"),
        startTime: z.string().optional().describe("Start time HH:MM"),
        endTime: z.string().optional().describe("End time HH:MM"),
        isLocked: z.boolean().optional().describe("Lock this exception")
      }
    },
    async ({ id, exceptionType, overrideLoadValue, startTime, endTime, isLocked }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        lbsClient.updateException(ctx.accessToken, id, {
          exception_type: exceptionType,
          override_load_value: overrideLoadValue,
          start_time: startTime,
          end_time: endTime,
          is_locked: isLocked
        })
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.lbs.exceptions.delete",
    {
      title: "LBS Delete Exception",
      description: "Delete a task exception by its numeric ID.",
      inputSchema: {
        id: z.number().int().positive().describe("Exception ID")
      }
    },
    async ({ id }) => {
      await runWithAuth(ctx.accessToken, () => lbsClient.deleteException(ctx.accessToken, id));
      return asMcpText({ status: "ok" });
    }
  );

  // ── LBS: Expansion ────────────────────────────────────────────────────────

  server.registerTool(
    "tasks.lbs.expand",
    {
      title: "LBS Trigger Expansion",
      description:
        "Force-trigger LBS rule expansion for a date range. " +
        "This pre-computes daily cache entries from task recurrence rules. " +
        "Useful after bulk task changes.",
      inputSchema: {
        startDate: z.string().min(1).describe("Start of range (YYYY-MM-DD)"),
        endDate: z.string().min(1).describe("End of range (YYYY-MM-DD)")
      }
    },
    async ({ startDate, endDate }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        lbsClient.expand(ctx.accessToken, { start_date: startDate, end_date: endDate })
      );
      return asMcpText(result);
    }
  );
}
