import express, { type Express } from "express";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { issueTokenBundle, verifyAccessToken } from "../auth.js";
import { logger } from "../logger.js";
import { findUserById } from "../store.js";
import { instrumentMcpServer } from "../analyserAccessInstrumentation.js";
import { registerArtifactsTools } from "../mcp/registerArtifactsTools.js";
import { registerDeepResearchTools } from "../mcp/registerDeepResearchTools.js";
import { registerImageTools } from "../mcp/registerImageTools.js";
import { registerAnalyserTools } from "../mcp/registerAnalyserTools.js";
import { registerMindmapTools } from "../mcp/registerMindmapTools.js";
import { registerNotesTools } from "../mcp/registerNotesTools.js";
import { registerProjectsTools } from "../mcp/registerProjectsTools.js";
import { registerProjectContextTools } from "../mcp/registerProjectContextTools.js";
import { registerTasksTools } from "../mcp/registerTasksTools.js";
import { registerWbsTools } from "../mcp/registerWbsTools.js";
import { buildCanonicalMcpResource, buildOAuthIssuer, joinIssuerPath } from "../oauth/config.js";
import { readBearerToken } from "../middleware/auth.js";

export function registerMcpRoutes(app: Express): void {
  // Requires Bearer token authentication. Tools are accessible at POST /mcp.
// ---------------------------------------------------------------------------

type McpInjectedContext = {
  accessToken: string;
  coreUserId: string;
};

function createMcpServerInstance(injectedContext: McpInjectedContext): McpServer {
  const server = new McpServer({ name: "workbench-core-mcp", version: "0.2.0" });
  instrumentMcpServer(server, injectedContext);
  registerNotesTools(server, injectedContext);
  registerArtifactsTools(server, injectedContext);
  registerTasksTools(server, injectedContext);
  registerProjectsTools(server, injectedContext);
  registerProjectContextTools(server, injectedContext);
  registerDeepResearchTools(server, injectedContext);
  registerImageTools(server, injectedContext);
  registerAnalyserTools(server, injectedContext);
  registerMindmapTools(server, injectedContext);
  registerWbsTools(server, injectedContext);
  return server;
}

// Handle POST /mcp - used for tool calls (and initialize)
function setMcpBearerChallengeHeader(req: express.Request, res: express.Response): void {
  const issuer = buildOAuthIssuer(req);
  const resourceMetadataUrl = joinIssuerPath(issuer, "/.well-known/oauth-protected-resource");
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:tools"`);
}

function isExpectedMcpAudience(decoded: { aud?: unknown }, expectedAudience: string): boolean {
  const aud = decoded.aud;
  if (!aud) {
    return false;
  }
  if (typeof aud === "string") {
    return aud === expectedAudience;
  }
  if (Array.isArray(aud)) {
    return aud.includes(expectedAudience);
  }
  return false;
}

function tokenHasRequiredScope(decoded: { scope?: unknown }, requiredScope: string): boolean {
  const scopeClaim = decoded.scope;
  if (typeof scopeClaim === "string") {
    return scopeClaim
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0)
      .includes(requiredScope);
  }
  if (Array.isArray(scopeClaim)) {
    return scopeClaim.includes(requiredScope);
  }
  return false;
}

app.post("/mcp", async (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Bearer token required for MCP access" });
  }

  let injectedContext: McpInjectedContext | undefined;
  try {
    verifyAccessToken(token);
  } catch {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }

  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded !== "object") {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token payload" });
  }

  const expectedAudience = buildCanonicalMcpResource(req);
  if (!isExpectedMcpAudience(decoded as { aud?: unknown }, expectedAudience)) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token audience" });
  }
  if (!tokenHasRequiredScope(decoded as { scope?: unknown }, "mcp:tools")) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Insufficient token scope" });
  }

  const decodedIdentity = decoded as { sub?: unknown; username?: unknown };
  if (typeof decodedIdentity.sub !== "string" || decodedIdentity.sub.trim().length === 0) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token subject" });
  }

  const user = await findUserById(decodedIdentity.sub);
  if (!user) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token user" });
  }

  const bundle = issueTokenBundle({ userId: user.id, username: user.username });
  injectedContext = { accessToken: bundle.accessToken, coreUserId: user.id };
  logger.info("[mcp] user context injected", { username: user.username });

  const server = createMcpServerInstance(injectedContext);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP request failed";
    if (!res.headersSent) {
      res.status(500).json({ error: "InternalError", message });
    }
  }
});

// Handle GET /mcp - SSE stream for server-initiated messages (stateless: returns 405)
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error: "MethodNotAllowed",
    message: "This MCP server runs in stateless mode. Use POST /mcp for all requests."
  });
});

}
