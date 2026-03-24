import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerArtifactsTools } from "./mcp/registerArtifactsTools.js";
import { registerAuthTools } from "./mcp/registerAuthTools.js";
import { registerDeepResearchTools } from "./mcp/registerDeepResearchTools.js";
import { registerNotesTools } from "./mcp/registerNotesTools.js";
import { registerProjectsTools } from "./mcp/registerProjectsTools.js";
import { registerTasksTools } from "./mcp/registerTasksTools.js";

const server = new McpServer({
  name: "workbench-core-mcp",
  version: "0.2.0"
});

registerAuthTools(server);
registerNotesTools(server);
registerArtifactsTools(server);
registerTasksTools(server);
registerProjectsTools(server);
registerDeepResearchTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
