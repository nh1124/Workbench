import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tasksClient } from "../internalClients.js";
import { asMcpText, runWithAuth, tokenInput } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

export function registerTasksTools(server: McpServer, ctx?: ToolContext): void {
  server.registerTool(
    "tasks.list",
    {
      title: "List Tasks",
      description: "List tasks for the authenticated user.",
      inputSchema: {
        ...tokenInput,
        context: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ accessToken, context, status, limit }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => tasksClient.list(token!, context, status, limit), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.calendar.list",
    {
      title: "List Calendar Tasks",
      description: "List tasks for calendar use.",
      inputSchema: {
        ...tokenInput,
        context: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ accessToken, context, status, limit }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => tasksClient.list(token!, context, status, limit), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.get",
    {
      title: "Get Task",
      description: "Get a task by id.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => tasksClient.get(token!, id), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.create",
    {
      title: "Create Task",
      description: "Create a task.",
      inputSchema: {
        ...tokenInput,
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
        timezone: z.string().optional()
      }
    },
    async ({ accessToken, ...payload }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => tasksClient.create(token!, payload), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.update",
    {
      title: "Update Task",
      description: "Update a task.",
      inputSchema: {
        ...tokenInput,
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
        timezone: z.string().optional()
      }
    },
    async ({ accessToken, id, ...payload }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => tasksClient.update(token!, id, payload), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "tasks.delete",
    {
      title: "Delete Task",
      description: "Delete a task.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      const token = accessToken ?? ctx?.accessToken;
      await runWithAuth(accessToken, () => tasksClient.remove(token!, id), ctx?.accessToken);
      return asMcpText({ status: "ok" });
    }
  );
}
