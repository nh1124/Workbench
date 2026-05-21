import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cancelDeepResearch,
  getDeepResearchDefaults,
  getDeepResearchStatus,
  runDeepResearch,
  saveDeepResearchJobArtifact
} from "../deepResearch/service.js";
import { asMcpText, runWithAuthContext } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

const MCP_DEFAULT_SYNC_TIMEOUT_SEC = 30;

export function registerDeepResearchTools(server: McpServer, ctx: ToolContext): void;
export function registerDeepResearchTools(server: McpServer): void;
export function registerDeepResearchTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }
  server.registerTool(
    "deep_research_capabilities",
    {
      title: "Deep Research Capabilities",
      description:
        "Return Deep Research capabilities for the authenticated user, including configured providers, default options, and MCP artifact-save behavior.",
      inputSchema: {}
    },
    async () => {
      const defaults = await runWithAuthContext(ctx.accessToken, ({ userId }) => getDeepResearchDefaults(userId));
      const configuredProviders = (["gemini", "openai", "anthropic"] as const).filter(
        (provider) => defaults.availableProviders[provider]
      );
      const providerOptions = configuredProviders.length > 1 ? (["auto", ...configuredProviders] as const) : configuredProviders;
      return asMcpText({
        enabled: defaults.enabled,
        configuredProviders,
        providerOptions,
        speedOptions: ["deep", "fast"],
        timeoutRangeSec: { min: 10, max: 3600 },
        defaults: defaults.defaults,
        availableProviders: defaults.availableProviders,
        mcpBehavior: {
          defaultSyncTimeoutSec: MCP_DEFAULT_SYNC_TIMEOUT_SEC,
          saveToArtifacts: "forced_true",
          timeoutContinuation:
            "When a sync timeout returns a running job, the response includes accessPlan.status and accessPlan.saveArtifact for immediate follow-up."
        }
      });
    }
  );

  server.registerTool(
    "deep_research",
    {
      title: "Deep Research",
      description:
        "Run deep research with provider routing, timeout fallback, background jobs, and artifact save. MCP calls always save completed results to Artifacts, even if save_to_artifacts is false.",
      inputSchema: {
        query: z.string().min(1),
        provider: z.enum(["auto", "gemini", "openai", "anthropic"]).optional(),
        speed: z.enum(["deep", "fast"]).optional(),
        timeout_sec: z.number().int().positive().optional(),
        async_on_timeout: z.boolean().optional(),
        save_to_artifacts: z.boolean().optional(),
        artifact_title: z.string().optional(),
        artifact_path: z.string().optional(),
        project_id: z.string().optional(),
        project_name: z.string().optional()
      }
    },
    async (payload) => {
      const result = await runWithAuthContext(ctx.accessToken, ({ userId }) =>
        runDeepResearch(userId, ctx.accessToken, {
          query: payload.query,
          provider: payload.provider,
          speed: payload.speed,
          timeoutSec: payload.timeout_sec ?? MCP_DEFAULT_SYNC_TIMEOUT_SEC,
          asyncOnTimeout: payload.async_on_timeout,
          saveToArtifacts: true,
          artifactTitle: payload.artifact_title,
          artifactPath: payload.artifact_path,
          projectId: payload.project_id,
          projectName: payload.project_name
        })
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "deep_research_save_artifact",
    {
      title: "Save Deep Research Result To Artifacts",
      description:
        "Save a completed Deep Research job result to Artifacts at any requested title/path/project. Use this after deep_research_status reports completed when an artifact is missing or a second saved copy is needed.",
      inputSchema: {
        job_id: z.string().min(1),
        artifact_title: z.string().optional(),
        artifact_path: z.string().optional(),
        project_id: z.string().optional(),
        project_name: z.string().optional(),
        create_new: z.boolean().optional()
      }
    },
    async (payload) => {
      const artifact = await runWithAuthContext(ctx.accessToken, ({ userId }) =>
        saveDeepResearchJobArtifact(userId, ctx.accessToken, payload.job_id, {
          artifactTitle: payload.artifact_title,
          artifactPath: payload.artifact_path,
          projectId: payload.project_id,
          projectName: payload.project_name,
          createNew: payload.create_new
        })
      );
      return asMcpText({
        status: "ok",
        artifact,
        access: {
          tool: "artifacts.item.get",
          arguments: {
            id: artifact.id
          }
        }
      });
    }
  );

  server.registerTool(
    "deep_research_status",
    {
      title: "Deep Research Status",
      description:
        "Check a long-running Deep Research job status by job id. Running and completed responses include accessPlan with the next status/save/get tool arguments.",
      inputSchema: {
        job_id: z.string().min(1)
      }
    },
    async ({ job_id }) => {
      const result = await runWithAuthContext(ctx.accessToken, ({ userId }) => getDeepResearchStatus(userId, job_id));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "deep_research_cancel",
    {
      title: "Deep Research Cancel",
      description: "Cancel a running Deep Research job.",
      inputSchema: {
        job_id: z.string().min(1)
      }
    },
    async ({ job_id }) => {
      const result = await runWithAuthContext(ctx.accessToken, ({ userId }) => cancelDeepResearch(userId, job_id));
      return asMcpText(result);
    }
  );
}
