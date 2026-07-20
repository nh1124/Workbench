import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { installProcessHandlers } from "@workbench/logging";
import { logger } from "./logger.js";
import { verifyAccessToken } from "./auth.js";
import { instrumentMcpServer } from "./analyserAccessInstrumentation.js";
import { registerArtifactsTools } from "./mcp/registerArtifactsTools.js";
import { registerAuthTools } from "./mcp/registerAuthTools.js";
import { registerDeepResearchTools } from "./mcp/registerDeepResearchTools.js";
import { registerAnalyserTools } from "./mcp/registerAnalyserTools.js";
import { registerMindmapTools } from "./mcp/registerMindmapTools.js";
import { registerNotesTools } from "./mcp/registerNotesTools.js";
import { registerProjectsTools } from "./mcp/registerProjectsTools.js";
import { registerProjectContextTools } from "./mcp/registerProjectContextTools.js";
import { registerTasksTools } from "./mcp/registerTasksTools.js";

installProcessHandlers(logger);

const server = new McpServer({
  name: "workbench-core-mcp",
  version: "0.2.0"
});

const accessToken = process.env.WORKBENCH_MCP_ACCESS_TOKEN?.trim();
if (accessToken) {
  instrumentMcpServer(server, {
    accessToken,
    coreUserId: verifyAccessToken(accessToken).sub
  });
}

registerAuthTools(server);

if (accessToken) {
  const ctx = { accessToken };
  registerNotesTools(server, ctx);
  registerArtifactsTools(server, ctx);
  registerTasksTools(server, ctx);
  registerProjectsTools(server, ctx);
  registerProjectContextTools(server, ctx);
  registerDeepResearchTools(server, ctx);
  registerAnalyserTools(server, ctx);
  registerMindmapTools(server, ctx);
}

const transport = new StdioServerTransport();
await server.connect(transport);
