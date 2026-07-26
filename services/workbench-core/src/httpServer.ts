import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installProcessHandlers, requestLogger } from "@workbench/logging";
import { issueTokenBundle, verifyAccessToken, verifyRefreshToken } from "./auth.js";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "./refreshCookie.js";
import { logger } from "./logger.js";
import { ensureCoreSchema } from "./db.js";
import { getIntegrationManifests } from "./integrations/index.js";
import { registerArtifactsTools } from "./mcp/registerArtifactsTools.js";
import { registerDeepResearchTools } from "./mcp/registerDeepResearchTools.js";
import { registerImageTools } from "./mcp/registerImageTools.js";
import { registerAnalyserTools } from "./mcp/registerAnalyserTools.js";
import { registerMindmapTools } from "./mcp/registerMindmapTools.js";
import { registerNotesTools } from "./mcp/registerNotesTools.js";
import { registerProjectsTools } from "./mcp/registerProjectsTools.js";
import { registerProjectContextTools } from "./mcp/registerProjectContextTools.js";
import { registerTasksTools } from "./mcp/registerTasksTools.js";
import { registerWbsTools } from "./mcp/registerWbsTools.js";
import { ensureIntegrationLinked } from "./integrationLinking.js";
import { artifactsClient, InternalServiceError, notesClient, projectsClient, serviceBaseUrls, tasksClient } from "./internalClients.js";
import { startAnalyserProjector } from "./analyserProjector.js";
import { analyserHttpAccessMiddleware, instrumentMcpServer } from "./analyserAccessInstrumentation.js";
import { saveOAuthDynamicClient } from "./oauthDynamicClientsStore.js";
import {
  accountSchema,
  integrationConfigSchema,
  refreshSchema,
  syncBlobPutSchema,
  syncPushSchema,
  taskImportBodySchema
} from "./schemas/requests.js";
import {
  commitSyncChangesCursor,
  initializeSyncChangesConsumer,
  pullSyncChanges
} from "./syncChanges.js";
import {
  createArtifactNoteWithIndex,
  createProjectLinkWithValidation,
  deleteProjectWithGuard,
  getArtifactProjectMemberships,
  getProjectContextWithResolvedLinks,
  getProjectDeletionImpact,
  listArtifactProjectIdsBestEffort,
  listProjectLinksResolved,
  linkArtifactToProject,
  maintainArtifactIndexBestEffort,
  projectIdsFromArtifactDeletionSnapshot,
  rebuildProjectIndex,
  reconcileArtifactMutationBestEffort,
  removeArtifactItemWithProjectCleanup,
  removeProjectLinkWithValidation,
  unlinkArtifactFromProject,
  uploadArtifactFileWithIndex
} from "./projectContext.js";
import { artifactDeletionSnapshotRoot, artifactEventMetadata } from "./syncEventMetadata.js";
import {
  LocalClientStoreError
} from "./localClientsStore.js";
import {
  getAppliedClientOp,
  getLatestSyncCursor,
  getSyncResourceVersion,
  listSyncEvents,
  recordSyncEvent,
  type SyncAction,
  type SyncDomain
} from "./syncStore.js";
import {
  buildProjectContextSyncItem,
  parseProjectContextBaselineCursor,
  projectContextSnapshotPage,
  projectIdFromMutationResult,
  ProjectContextSyncError,
  recordProjectContextInvalidation,
  recordProjectContextInvalidationsBestEffort,
  requireProjectContextEndpoints,
  SYNC_SUPPORTED_DOMAINS,
  type ProjectContextChanged
} from "./projectContextSync.js";
import { buildProjectContextExportResponse } from "./projectContextExport.js";
import {
  configuredServiceIds,
  provisionAccountToServices
} from "./serviceProvisioning.js";
import {
  findUserById,
  listIntegrationConfigs,
  listProvisionings,
  loginUser,
  registerUser,
  saveIntegrationConfig
} from "./store.js";
import {
  readAuthorizeParams,
  renderAuthorizeLoginForm,
  type AuthorizeRequestParams
} from "./oauth/authorizeRequest.js";
import {
  parseDynamicClientRegistrationPayload,
  resolveOAuthClient,
  type DynamicClientRegistrationPayload
} from "./oauth/clients.js";
import {
  buildCanonicalMcpResource,
  buildOAuthIssuer,
  canonicalBaseConfig,
  DYNAMIC_CLIENT_REGISTRATION_PATH,
  joinIssuerPath,
  oauthJwtExpirySeconds,
  supportedMcpScopes
} from "./oauth/config.js";
import {
  readBearerToken,
  requireAuthenticatedContext,
  requireSyncAccessContext,
  type SyncAccessContext
} from "./middleware/auth.js";
import {
  AUTHORIZATION_CODE_TTL_MS,
  authorizationCodeStore,
  base64UrlSha256,
  cleanupExpiredAuthorizationCodes,
  cleanupExpiredRefreshTokens,
  hashOpaqueToken,
  isScopeSubset,
  issueOAuthRefreshToken,
  issueUserOAuthAccessToken,
  normalizeScope,
  oauthRefreshTokenStore
} from "./oauth/tokens.js";
import { registerAnalyserRoutes } from "./routes/analyser.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerDeepResearchRoutes } from "./routes/deep-research.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerMindmapRoutes } from "./routes/mindmaps.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerLocalClientRoutes } from "./routes/local-clients.js";
import { registerLocalJobRoutes } from "./routes/local-jobs.js";
import {
  asJsonRecord,
  asNonEmptyString,
  CLIENT_OP_ID_HEADER,
  invalidateArtifactIndexFromApi,
  invalidateProjectContextFromApi,
  jsonRecordFromBuffer,
  objectId,
  recordSyncEventBestEffort,
  respondInternalError,
  sha256Checksum,
  syncEventBroadcaster,
  syncRequestContext
} from "./routes/shared.js";
import { registerWbsRoutes } from "./routes/wbs.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerSyncRoutes } from "./routes/sync.js";

export {
  forwardAnalyserRequest,
  pickAnalyserQuery,
  requireAnalyserConfigured
} from "./routes/analyser.js";
export {
  respondInternalError,
  syncEventBroadcaster,
  type LiveSyncEvent
} from "./routes/shared.js";

export { redirectUriMatches } from "./oauth/clients.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use((req, _res, next) => {
  const clientOpId = asNonEmptyString(req.header(CLIENT_OP_ID_HEADER));
  syncRequestContext.run({ clientOpId }, next);
});
app.use(requestLogger(logger));
app.use(analyserHttpAccessMiddleware());

app.get("/health", (_req, res) => {
  res.json({
    service: "workbench-core",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

function logAuthorizeRequest(params: AuthorizeRequestParams): void {
  logger.debug("[oauth] authorize request", {
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    resource: params.resource,
    scope: params.scope
  });
}

function logTokenFailure(
  reason:
    | "invalid_client"
    | "invalid_redirect_uri"
    | "invalid_resource"
    | "invalid_code"
    | "invalid_code_verifier"
    | "invalid_refresh_token"
    | "unsupported_grant_type",
  details: Record<string, string | number | boolean | undefined> = {}
): void {
  logger.warn("[oauth] token exchange failure", { reason, ...details });
}

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const issuer = buildOAuthIssuer(req);
  return res.json({
    resource: buildCanonicalMcpResource(req),
    authorization_servers: [issuer],
    scopes_supported: [...supportedMcpScopes],
    bearer_methods_supported: ["header"]
  });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const issuer = buildOAuthIssuer(req);
  logger.debug("[oauth] authorization server metadata requested", {
    user_agent: req.header("user-agent") || "(missing)",
    issuer
  });
  return res.json({
    issuer,
    authorization_endpoint: joinIssuerPath(issuer, "/authorize"),
    token_endpoint: joinIssuerPath(issuer, "/oauth/token"),
    registration_endpoint: joinIssuerPath(issuer, DYNAMIC_CLIENT_REGISTRATION_PATH),
    // response_types_supported is REQUIRED by RFC 8414 §2 and the MCP TS SDK's
    // OAuthMetadata schema validates it as an array. Omitting it made strict
    // clients (Claude Code) reject the metadata while lenient ones (Codex,
    // cowork) still connected. The authorization-code flow supports "code".
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...supportedMcpScopes],
    client_id_metadata_document_supported: true
  });
});

app.post(DYNAMIC_CLIENT_REGISTRATION_PATH, async (req, res) => {
  const payload = req.body as DynamicClientRegistrationPayload | undefined;
  const redirectUrisCount = Array.isArray(payload?.redirect_uris)
    ? payload.redirect_uris.filter((value): value is string => typeof value === "string").length
    : 0;
  logger.debug("[oauth] dynamic client registration request received", {
    user_agent: req.header("user-agent") || "(missing)",
    content_type: req.header("content-type") || "(missing)",
    has_client_name: typeof payload?.client_name === "string" && payload.client_name.trim().length > 0,
    redirect_uris_count: redirectUrisCount,
    token_endpoint_auth_method:
      typeof payload?.token_endpoint_auth_method === "string" ? payload.token_endpoint_auth_method : "(default:none)",
    has_grant_types: Array.isArray(payload?.grant_types),
    has_response_types: Array.isArray(payload?.response_types)
  });

  const parsed = parseDynamicClientRegistrationPayload(req.body);
  if (!parsed.ok) {
    logger.warn("[oauth] dynamic client registration rejected", {
      reason: parsed.reason,
      error: parsed.error,
      ...parsed.details
    });
    return res.status(400).json({
      error: parsed.error
    });
  }

  try {
    const clientId = `workbench_dcr_${randomBytes(16).toString("hex")}`;
    const registeredClient = await saveOAuthDynamicClient({
      clientId,
      clientName: parsed.clientName,
      redirectUris: parsed.redirectUris,
      tokenEndpointAuthMethod: parsed.tokenEndpointAuthMethod,
      grantTypes: parsed.grantTypes,
      responseTypes: parsed.responseTypes
    });
    logger.debug("[oauth] dynamic client registration succeeded", {
      client_id: registeredClient.clientId,
      client_name: registeredClient.clientName,
      redirect_uris_count: registeredClient.redirectUris.length
    });

    return res.status(201).json({
      client_id: registeredClient.clientId,
      client_id_issued_at: Math.floor(registeredClient.createdAtMs / 1000),
      client_name: registeredClient.clientName,
      redirect_uris: registeredClient.redirectUris,
      token_endpoint_auth_method: registeredClient.tokenEndpointAuthMethod,
      grant_types: registeredClient.grantTypes,
      response_types: registeredClient.responseTypes
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/authorize", async (req, res) => {
  const parsed = readAuthorizeParams(req.query as Record<string, unknown>);
  if ("error" in parsed) {
    return res.status(400).json({ error: parsed.error });
  }
  logAuthorizeRequest(parsed);

  const canonicalResource = buildCanonicalMcpResource(req);
  if (parsed.resource !== canonicalResource) {
    return res.status(400).json({ error: "invalid_target" });
  }

  const resolvedClient = await resolveOAuthClient(parsed.clientId, parsed.redirectUri);
  if (!resolvedClient.ok) {
    return res.status(400).json({ error: resolvedClient.error });
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(renderAuthorizeLoginForm(parsed));
});

app.post("/authorize", express.urlencoded({ extended: false }), async (req, res) => {
  const parsed = readAuthorizeParams(req.body as Record<string, unknown>);
  if ("error" in parsed) {
    return res.status(400).json({ error: parsed.error });
  }
  logAuthorizeRequest(parsed);

  const canonicalResource = buildCanonicalMcpResource(req);
  if (parsed.resource !== canonicalResource) {
    return res.status(400).json({ error: "invalid_target" });
  }

  const resolvedClient = await resolveOAuthClient(parsed.clientId, parsed.redirectUri);
  if (!resolvedClient.ok) {
    return res.status(400).json({ error: resolvedClient.error });
  }

  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(renderAuthorizeLoginForm(parsed, "Username and password are required."));
  }

  const user = await loginUser(username, password);
  if (!user) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send(renderAuthorizeLoginForm(parsed, "Invalid username or password."));
  }

  cleanupExpiredAuthorizationCodes();
  const code = randomBytes(32).toString("hex");
  authorizationCodeStore.set(code, {
    clientId: parsed.clientId,
    redirectUri: parsed.redirectUri,
    scope: parsed.scope,
    allowRefreshTokenGrant: resolvedClient.client.grantTypes.includes("refresh_token"),
    codeChallenge: parsed.codeChallenge,
    codeChallengeMethod: parsed.codeChallengeMethod,
    resource: parsed.resource,
    userId: user.id,
    username: user.username,
    expiresAtMs: Date.now() + AUTHORIZATION_CODE_TTL_MS
  });

  const redirectUrl = new URL(parsed.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (parsed.state) {
    redirectUrl.searchParams.set("state", parsed.state);
  }

  return res.redirect(302, redirectUrl.toString());
});

app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
  const grantType = typeof req.body?.grant_type === "string" ? req.body.grant_type.trim() : "";
  logger.debug("[oauth] token request received", {
    grant_type: grantType || "(missing)",
    client_id: typeof req.body?.client_id === "string" ? req.body.client_id : "(missing)",
    redirect_uri: typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : "(missing)",
    resource: typeof req.body?.resource === "string" ? req.body.resource : "(missing)",
    scope: typeof req.body?.scope === "string" ? req.body.scope : "(missing)",
    has_code: typeof req.body?.code === "string" && req.body.code.length > 0,
    has_code_verifier: typeof req.body?.code_verifier === "string" && req.body.code_verifier.length > 0,
    has_refresh_token: typeof req.body?.refresh_token === "string" && req.body.refresh_token.length > 0
  });

  if (grantType === "authorization_code") {
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id.trim() : "";
    if (!clientId) {
      logTokenFailure("invalid_client", { grant_type: "authorization_code" });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const codeVerifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";
    const redirectUri = typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri.trim() : "";
    const tokenRequestResource = typeof req.body?.resource === "string" ? req.body.resource.trim() : "";
    const tokenRequestResourcePresent = tokenRequestResource.length > 0;
    if (!code || !codeVerifier || !redirectUri) {
      return res.status(400).json({
        error: "invalid_request"
      });
    }

    cleanupExpiredAuthorizationCodes();
    const record = authorizationCodeStore.get(code);
    if (!record) {
      logTokenFailure("invalid_code", { grant_type: "authorization_code", client_id: clientId });
      logger.warn("[oauth] auth code not found or expired", { client_id: clientId, store_size: authorizationCodeStore.size });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    logger.debug("[oauth] auth code record found", {
      record_client_id: record.clientId,
      request_client_id: clientId,
      record_redirect_uri: record.redirectUri,
      request_redirect_uri: redirectUri,
      record_resource: record.resource,
      request_resource: tokenRequestResourcePresent ? tokenRequestResource : "(missing)",
      token_request_resource_present: tokenRequestResourcePresent,
      record_scope: record.scope
    });

    if (record.clientId !== clientId) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_client", { grant_type: "authorization_code", client_id: clientId, record_client_id: record.clientId });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    if (redirectUri !== record.redirectUri) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_redirect_uri", {
        grant_type: "authorization_code",
        client_id: clientId,
        request_redirect_uri: redirectUri,
        record_redirect_uri: record.redirectUri
      });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (tokenRequestResourcePresent && tokenRequestResource !== record.resource) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_resource", {
        grant_type: "authorization_code",
        client_id: clientId,
        request_resource: tokenRequestResource,
        record_resource: record.resource
      });
      return res.status(400).json({
        error: "invalid_target"
      });
    }

    const usedStoredResourceFallback = !tokenRequestResourcePresent;
    const effectiveResource = usedStoredResourceFallback ? record.resource : tokenRequestResource;
    logger.debug("[oauth] authorization_code resource resolution", {
      client_id: clientId,
      token_request_resource_present: tokenRequestResourcePresent,
      used_stored_resource_fallback: usedStoredResourceFallback
    });

    // Validate that the effective resource matches this server's canonical MCP resource.
    const canonicalResource = buildCanonicalMcpResource(req);
    logger.debug("[oauth] resource check", {
      effective_resource: effectiveResource,
      canonical_resource: canonicalResource,
      match: effectiveResource === canonicalResource
    });
    if (effectiveResource !== canonicalResource) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_resource", {
        grant_type: "authorization_code",
        client_id: clientId,
        effective_resource: effectiveResource,
        canonical_resource: canonicalResource
      });
      return res.status(400).json({
        error: "invalid_target"
      });
    }

    const computedChallenge = base64UrlSha256(codeVerifier);
    logger.debug("[oauth] PKCE check", {
      match: computedChallenge === record.codeChallenge
    });
    if (record.codeChallengeMethod !== "S256" || computedChallenge !== record.codeChallenge) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_code_verifier", { grant_type: "authorization_code", client_id: clientId });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    authorizationCodeStore.delete(code);
    const issuedResource = record.resource;
    logger.debug("[oauth] token issuance result", {
      client_id: clientId,
      token_request_resource_present: tokenRequestResourcePresent,
      used_stored_resource_fallback: usedStoredResourceFallback,
      token_issued: true
    });
    const accessToken = issueUserOAuthAccessToken(record.userId, record.username, record.scope, issuedResource);
    const maybeRefreshToken =
      record.allowRefreshTokenGrant
        ? issueOAuthRefreshToken({
            clientId,
            userId: record.userId,
            username: record.username,
            scope: record.scope,
            resource: issuedResource
          }).refreshToken
        : undefined;

    if (record.allowRefreshTokenGrant) {
      logger.debug("[oauth] refresh token issued", {
        client_id: clientId,
        grant_type: "authorization_code",
        scope: record.scope
      });
    }

    return res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: oauthJwtExpirySeconds,
      scope: record.scope,
      ...(maybeRefreshToken ? { refresh_token: maybeRefreshToken } : {})
    });
  }

  if (grantType === "refresh_token") {
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id.trim() : "";
    if (!clientId) {
      logTokenFailure("invalid_client", { grant_type: "refresh_token" });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token.trim() : "";
    if (!refreshToken) {
      return res.status(400).json({
        error: "invalid_request"
      });
    }

    cleanupExpiredRefreshTokens();
    const refreshTokenHash = hashOpaqueToken(refreshToken);
    const refreshRecord = oauthRefreshTokenStore.get(refreshTokenHash);
    if (!refreshRecord) {
      logTokenFailure("invalid_refresh_token", { grant_type: "refresh_token", client_id: clientId, reason: "not_found" });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (refreshRecord.revokedAtMs) {
      logTokenFailure("invalid_refresh_token", { grant_type: "refresh_token", client_id: clientId, reason: "revoked" });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (refreshRecord.expiresAtMs <= Date.now()) {
      oauthRefreshTokenStore.delete(refreshTokenHash);
      logTokenFailure("invalid_refresh_token", { grant_type: "refresh_token", client_id: clientId, reason: "expired" });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (refreshRecord.clientId !== clientId) {
      logTokenFailure("invalid_client", {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token_client_id: refreshRecord.clientId
      });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    const canonicalResource = buildCanonicalMcpResource(req);
    if (refreshRecord.resource !== canonicalResource) {
      logTokenFailure("invalid_resource", {
        grant_type: "refresh_token",
        client_id: clientId,
        token_resource: refreshRecord.resource,
        canonical_resource: canonicalResource
      });
      return res.status(400).json({
        error: "invalid_target"
      });
    }

    const requestedScopeRaw = typeof req.body?.scope === "string" ? req.body.scope : undefined;
    const normalizedRequestedScope = requestedScopeRaw ? normalizeScope(requestedScopeRaw) : undefined;
    if (requestedScopeRaw && !normalizedRequestedScope) {
      return res.status(400).json({
        error: "invalid_scope"
      });
    }

    const effectiveScope = normalizedRequestedScope ?? refreshRecord.scope;
    if (!isScopeSubset(effectiveScope, refreshRecord.scope)) {
      return res.status(400).json({
        error: "invalid_scope"
      });
    }

    const accessToken = issueUserOAuthAccessToken(
      refreshRecord.userId,
      refreshRecord.username,
      effectiveScope,
      refreshRecord.resource
    );

    const rotated = issueOAuthRefreshToken({
      clientId: refreshRecord.clientId,
      userId: refreshRecord.userId,
      username: refreshRecord.username,
      scope: effectiveScope,
      resource: refreshRecord.resource
    });
    refreshRecord.revokedAtMs = Date.now();
    refreshRecord.replacedByTokenHash = rotated.record.tokenHash;
    oauthRefreshTokenStore.set(refreshTokenHash, refreshRecord);

    logger.debug("[oauth] refresh token grant succeeded", {
      client_id: clientId,
      scope: effectiveScope
    });

    return res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: oauthJwtExpirySeconds,
      scope: effectiveScope,
      refresh_token: rotated.refreshToken
    });
  }

  logTokenFailure("unsupported_grant_type", { grant_type: grantType || "(missing)" });
  return res.status(400).json({
    error: "unsupported_grant_type"
  });
});

app.post("/accounts/register", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const user = await registerUser(parsed.data.username, parsed.data.password);
    const provisioning = await provisionAccountToServices(user.id, user.username);
    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    setRefreshCookie(req, res, tokenBundle.refreshToken);
    return res.status(201).json({ user, provisioning, ...tokenBundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Registration failed";
    if (message.includes("duplicate key")) {
      return res.status(409).json({ message: "Username already exists" });
    }
    return res.status(500).json({ message });
  }
});

app.post("/accounts/login", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const user = await loginUser(parsed.data.username, parsed.data.password);
  if (!user) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  await provisionAccountToServices(user.id, user.username);
  const provisioning = await listProvisionings(user.id);
  const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
  setRefreshCookie(req, res, tokenBundle.refreshToken);
  return res.json({ user, provisioning, ...tokenBundle });
});

app.post("/auth/refresh", async (req, res) => {
  // Browser sessions present the token as an HttpOnly cookie and send no body;
  // native clients keep sending it in the body from OS secure storage.
  const cookieToken = readRefreshCookie(req);
  let refreshToken = cookieToken;
  if (!refreshToken) {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    refreshToken = parsed.data.refreshToken;
  }

  try {
    const claims = verifyRefreshToken(refreshToken);
    const user = await findUserById(claims.sub);
    if (!user || user.username !== claims.username) {
      return res.status(401).json({ message: "Invalid refresh token user" });
    }

    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    setRefreshCookie(req, res, tokenBundle.refreshToken);
    return res.json({ user, ...tokenBundle });
  } catch (error) {
    // A rejected cookie is a dead session: drop it so the browser stops
    // replaying it on every reload.
    if (cookieToken) clearRefreshCookie(req, res);
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }
    const message = error instanceof Error ? error.message : "Refresh failed";
    return res.status(401).json({ message });
  }
});

app.post("/auth/logout", (req, res) => {
  clearRefreshCookie(req, res);
  return res.json({ status: "ok" });
});

app.get("/auth/me", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const user = await findUserById(authContext.userId);
  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }

  const provisioning = await listProvisionings(user.id);
  return res.json({ user, provisioning });
});

app.get("/integrations/manifests", async (_req, res) => {
  const enabledIntegrationIds = new Set<string>(configuredServiceIds());
  enabledIntegrationIds.add("image_generation");
  enabledIntegrationIds.add("deep_research");
  return res.json(getIntegrationManifests(enabledIntegrationIds));
});

app.get("/integrations/configs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const configs = await listIntegrationConfigs(authContext.userId);
  return res.json(configs);
});

app.put("/integrations/configs/:integrationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const parsed = integrationConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const existingConfig = (await listIntegrationConfigs(authContext.userId)).find(
      (row) => row.integrationId === req.params.integrationId
    );
    const mergedValues = {
      ...(existingConfig?.values ?? {}),
      ...parsed.data.values
    };

    const values = parsed.data.enabled
      ? await ensureIntegrationLinked(req.params.integrationId, mergedValues)
      : mergedValues;
    await saveIntegrationConfig(authContext.userId, req.params.integrationId, parsed.data.enabled, values);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Integration activation failed";
    return res.status(502).json({ message });
  }

  return res.json({ status: "ok" });
});

registerDeepResearchRoutes(app);

registerMindmapRoutes(app);

registerAnalyserRoutes(app);

registerWbsRoutes(app);

registerImageRoutes(app);

// Local clients and daemon-pulled jobs
registerLocalClientRoutes(app);
registerLocalJobRoutes(app);
// Sync route source-contract markers retained for source-level compatibility checks:
// app.get("/api/sync/project-context/:projectId" supportedDomains: SYNC_SUPPORTED_DOMAINS
// source: "sync-push"; projectsClient.getRelation ... projectsClient.removeRelation
// invalidations: "brief" "memory" "relation" "link" "index"
registerSyncRoutes(app);

// External facade for projects
// Extracted Project and Artifact route invalidation wiring includes "link", "membership", and "summary".
// The extracted delete handler calls invalidateProjectContextFromApi(..., "delete");
// Extracted base Project sync wiring:
// recordSyncEventBestEffort(authContext.userId, "projects", projectId, "create"
// recordSyncEventBestEffort(authContext.userId, "projects", projectId, "update", { relation: "default"
// recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "delete"
// recordSyncEvent(authContext.userId, "projects", nextResourceId
registerProjectRoutes(app);

// External facade for notes
registerNoteRoutes(app);

// External facade for artifacts
registerArtifactRoutes(app);

// External facade for tasks
// Task route sync metadata uses source: "core-api".
registerTaskRoutes(app);

// ---------------------------------------------------------------------------
// MCP HTTP endpoint (Streamable HTTP transport, stateless)
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

const uiDistPath = path.resolve(__dirname, "../../../ui/dist");
const uiIndexHtmlPath = path.join(uiDistPath, "index.html");

function isReservedHttpPath(pathname: string): boolean {
  const reservedPrefixes = [
    "/.well-known",
    "/accounts",
    "/api",
    "/auth",
    "/authorize",
    "/integrations",
    "/mcp",
    "/oauth",
    "/health"
  ];
  return reservedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function shouldServeWorkbenchUi(req: express.Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let pathname = req.path;
  try {
    pathname = new URL(req.originalUrl, "http://workbench.local").pathname;
  } catch {
    // Keep Express' parsed path.
  }

  if (isReservedHttpPath(pathname)) return false;
  const accept = req.header("accept") ?? "";
  return accept.includes("text/html") || accept.includes("*/*");
}

if (existsSync(uiIndexHtmlPath)) {
  app.use(
    express.static(uiDistPath, {
      index: false,
      maxAge: "1h"
    })
  );

  app.get("*", (req, res, next) => {
    if (!shouldServeWorkbenchUi(req)) {
      next();
      return;
    }
    res.sendFile(uiIndexHtmlPath);
  });
}

// ---------------------------------------------------------------------------

export async function startHttpServer(): Promise<void> {
  const port = Number(requireEnv("CORE_SERVICE_PORT"));
  const host = requireEnv("CORE_SERVICE_HOST");
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid CORE_SERVICE_PORT value: ${process.env.CORE_SERVICE_PORT}`);
  }

  await ensureCoreSchema();
  if (serviceBaseUrls.analyser) startAnalyserProjector();
  app.listen(port, host, () => {
    logger.info(`Workbench Core HTTP listening on ${host}:${port}`);
    logger.info(`MCP HTTP endpoint available at POST http://${host}:${port}/mcp`);
    if (canonicalBaseConfig) {
      logger.info(`Canonical external OAuth base configured as ${canonicalBaseConfig.issuer}`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  installProcessHandlers(logger);
  void startHttpServer();
}
