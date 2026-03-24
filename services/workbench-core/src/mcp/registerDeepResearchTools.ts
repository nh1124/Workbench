import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cancelDeepResearch,
  getDeepResearchDefaults,
  getDeepResearchStatus,
  runDeepResearch
} from "../deepResearch/service.js";
import { asMcpText, runWithAuthContext, tokenInput } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

export function registerDeepResearchTools(server: McpServer, ctx?: ToolContext): void {
  server.registerTool(
    "deep_research_capabilities",
    {
      title: "Deep Research Capabilities",
      description:
        "Return Deep Research capabilities for the authenticated user, including configured providers and default options.",
      inputSchema: {
        ...tokenInput
      }
    },
    async ({ accessToken }) => {
      const defaults = await runWithAuthContext(accessToken, ({ userId }) => getDeepResearchDefaults(userId), ctx?.accessToken);
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
        availableProviders: defaults.availableProviders
      });
    }
  );

  server.registerTool(
    "deep_research",
    {
      title: "Deep Research",
      description: "Run deep research with provider routing, timeout fallback, background jobs, and artifact save.",
      inputSchema: {
        ...tokenInput,
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
    async ({ accessToken, ...payload }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuthContext(
        accessToken,
        ({ userId }) =>
          runDeepResearch(userId, token!, {
            query: payload.query,
            provider: payload.provider,
            speed: payload.speed,
            timeoutSec: payload.timeout_sec,
            asyncOnTimeout: payload.async_on_timeout,
            saveToArtifacts: payload.save_to_artifacts,
            artifactTitle: payload.artifact_title,
            artifactPath: payload.artifact_path,
            projectId: payload.project_id,
            projectName: payload.project_name
          }),
        ctx?.accessToken
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "deep_research_status",
    {
      title: "Deep Research Status",
      description: "Check a long-running Deep Research job status by job id.",
      inputSchema: {
        ...tokenInput,
        job_id: z.string().min(1)
      }
    },
    async ({ accessToken, job_id }) => {
      const result = await runWithAuthContext(
        accessToken,
        ({ userId }) => getDeepResearchStatus(userId, job_id),
        ctx?.accessToken
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "deep_research_cancel",
    {
      title: "Deep Research Cancel",
      description: "Cancel a running Deep Research job.",
      inputSchema: {
        ...tokenInput,
        job_id: z.string().min(1)
      }
    },
    async ({ accessToken, job_id }) => {
      const result = await runWithAuthContext(
        accessToken,
        ({ userId }) => cancelDeepResearch(userId, job_id),
        ctx?.accessToken
      );
      return asMcpText(result);
    }
  );
}
