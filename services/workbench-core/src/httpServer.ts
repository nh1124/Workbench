import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { issueTokenBundle, verifyAccessToken, verifyRefreshToken } from "./auth.js";
import { ensureCoreSchema } from "./db.js";
import { getIntegrationManifests } from "./integrations/index.js";
import { registerArtifactsTools } from "./mcp/registerArtifactsTools.js";
import { registerDeepResearchTools } from "./mcp/registerDeepResearchTools.js";
import { registerImageTools } from "./mcp/registerImageTools.js";
import { registerNotesTools } from "./mcp/registerNotesTools.js";
import { registerProjectsTools } from "./mcp/registerProjectsTools.js";
import { registerTasksTools } from "./mcp/registerTasksTools.js";
import { ensureIntegrationLinked } from "./integrationLinking.js";
import { artifactsClient, imagesClient, InternalServiceError, notesClient, projectsClient, serviceBaseUrls, tasksClient } from "./internalClients.js";
import { getOAuthDynamicClient, saveOAuthDynamicClient } from "./oauthDynamicClientsStore.js";
import {
  archiveLocalClient,
  assertLocalClientCapability,
  claimLocalJobsForClient,
  completeLocalJobForClient,
  createLocalJob,
  deleteLocalClient,
  failLocalJobForClient,
  getLocalJob,
  getLocalJobForClient,
  listLocalClientAuditEventsForUser,
  listLocalJobEventsForUser,
  listLocalClients,
  listLocalJobsForUser,
  LocalClientStoreError,
  recordLocalClientCapabilityDenied,
  recordLocalClientHeartbeat,
  registerLocalClient,
  revokeLocalClientTokens,
  serializeLocalJobForOwner,
  serializeLocalJobsForOwner,
  updateLocalClient,
  verifyLocalClientToken,
  type LocalClient,
  type LocalClientCapability,
  type LocalJobKind,
  type LocalJobStatus,
  type LocalJobTarget
} from "./localClientsStore.js";
import { getSyncResourceVersion, listSyncEvents, recordSyncEvent, type SyncAction, type SyncDomain } from "./syncStore.js";
import { DeepResearchError } from "./deepResearch/errors.js";
import {
  cancelDeepResearch,
  getDeepResearchDefaults,
  listDeepResearchHistory,
  getDeepResearchStatus,
  runDeepResearch,
  saveDeepResearchJobArtifact
} from "./deepResearch/service.js";
import {
  findUserById,
  getIntegrationConfig,
  listIntegrationConfigs,
  listProvisionings,
  loginUser,
  registerUser,
  saveIntegrationConfig,
  upsertProvisioning
} from "./store.js";

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

const oauthJwtSecret = requireEnv("JWT_SECRET");
const oauthJwtIssuer = requireEnv("JWT_ISSUER");
const oauthJwtExpirySecondsRaw = requireEnv("JWT_EXPIRY_SECONDS");
const oauthJwtExpirySeconds = Number(oauthJwtExpirySecondsRaw);
if (!Number.isFinite(oauthJwtExpirySeconds) || oauthJwtExpirySeconds <= 0) {
  throw new Error(`Invalid JWT_EXPIRY_SECONDS value: ${oauthJwtExpirySecondsRaw}`);
}

const supportedMcpScopes = ["mcp:tools"] as const;
const supportedMcpScopeSet = new Set<string>(supportedMcpScopes);
const clientMetadataCacheTtlMs = 5 * 60 * 1000;
const clientMetadataFetchTimeoutMs = 5000;
const clientMetadataMaxResponseBytes = 64 * 1024;
const externalBaseUrlRaw = optionalEnv("CORE_EXTERNAL_BASE_URL");
const clientMetadataHostAllowlist = new Set(
  (optionalEnv("OAUTH_CLIENT_METADATA_HOST_ALLOWLIST") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
);

type OAuthClientSource = "client_id_metadata_document" | "dynamic_client_registration";
type OAuthGrantType = "authorization_code" | "refresh_token";

type ResolvedOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: OAuthGrantType[];
  responseTypes: "code"[];
  source: OAuthClientSource;
};

type ClientMetadataCacheRecord = {
  client: ResolvedOAuthClient;
  expiresAtMs: number;
};

const clientMetadataCache = new Map<string, ClientMetadataCacheRecord>();
const DYNAMIC_CLIENT_REGISTRATION_PATH = "/oauth/register";

type CanonicalBaseConfig = {
  issuer: string;
};

function normalizeCanonicalBase(raw: string): CanonicalBaseConfig {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("CORE_EXTERNAL_BASE_URL must be a valid absolute URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("CORE_EXTERNAL_BASE_URL must use https");
  }

  if (!parsed.host) {
    throw new Error("CORE_EXTERNAL_BASE_URL must include a host");
  }

  const normalizedPath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  const issuer = `${parsed.origin}${normalizedPath}`;
  return { issuer };
}

const canonicalBaseConfig = externalBaseUrlRaw ? normalizeCanonicalBase(externalBaseUrlRaw) : undefined;

function joinIssuerPath(issuer: string, pathSuffix: string): string {
  const normalizedSuffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
  return `${issuer}${normalizedSuffix}`;
}

function buildFallbackIssuerFromRequest(req: express.Request): string {
  const forwardedProto = req
    .header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();
  const forwardedHost = req
    .header("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const hostHeader = forwardedHost || req.header("host")?.trim();
  if (forwardedProto === "https" && hostHeader && hostHeader.length > 0) {
    return `https://${hostHeader}`;
  }
  if (hostHeader && hostHeader.length > 0) {
    return `https://${hostHeader}`;
  }
  return `https://${req.hostname}`;
}

function buildOAuthIssuer(req: express.Request): string {
  return canonicalBaseConfig?.issuer ?? buildFallbackIssuerFromRequest(req);
}

function buildCanonicalMcpResource(req: express.Request): string {
  return joinIssuerPath(buildOAuthIssuer(req), "/mcp");
}

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  scope: string;
  allowRefreshTokenGrant: boolean;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  resource: string;
  userId: string;
  username: string;
  expiresAtMs: number;
};

const authorizationCodeStore = new Map<string, AuthorizationCodeRecord>();
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const oauthRefreshTokenExpirySecondsRaw = optionalEnv("OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS") ?? "2592000";
const oauthRefreshTokenExpirySeconds = Number(oauthRefreshTokenExpirySecondsRaw);
if (!Number.isFinite(oauthRefreshTokenExpirySeconds) || oauthRefreshTokenExpirySeconds <= 0) {
  throw new Error(`Invalid OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS value: ${oauthRefreshTokenExpirySecondsRaw}`);
}

type OAuthRefreshTokenRecord = {
  tokenHash: string;
  clientId: string;
  userId: string;
  username: string;
  scope: string;
  resource: string;
  issuedAtMs: number;
  expiresAtMs: number;
  revokedAtMs?: number;
  replacedByTokenHash?: string;
};

const oauthRefreshTokenStore = new Map<string, OAuthRefreshTokenRecord>();

function cleanupExpiredAuthorizationCodes(nowMs = Date.now()): void {
  for (const [code, record] of authorizationCodeStore.entries()) {
    if (record.expiresAtMs <= nowMs) {
      authorizationCodeStore.delete(code);
    }
  }
}

function cleanupExpiredRefreshTokens(nowMs = Date.now()): void {
  for (const [tokenHash, record] of oauthRefreshTokenStore.entries()) {
    if (record.expiresAtMs <= nowMs) {
      oauthRefreshTokenStore.delete(tokenHash);
    }
  }
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function hashOpaqueToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function issueOAuthRefreshToken(input: {
  clientId: string;
  userId: string;
  username: string;
  scope: string;
  resource: string;
}): { refreshToken: string; record: OAuthRefreshTokenRecord } {
  cleanupExpiredRefreshTokens();
  const refreshToken = randomBytes(48).toString("base64url");
  const tokenHash = hashOpaqueToken(refreshToken);
  const nowMs = Date.now();
  const record: OAuthRefreshTokenRecord = {
    tokenHash,
    clientId: input.clientId,
    userId: input.userId,
    username: input.username.trim().toLowerCase(),
    scope: input.scope,
    resource: input.resource,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + oauthRefreshTokenExpirySeconds * 1000
  };
  oauthRefreshTokenStore.set(tokenHash, record);
  return { refreshToken, record };
}

function parseScopeTokens(scope: string): string[] {
  return scope
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function isScopeSubset(requestedScope: string, grantedScope: string): boolean {
  const requestedTokens = parseScopeTokens(requestedScope);
  const grantedTokenSet = new Set(parseScopeTokens(grantedScope));
  return requestedTokens.every((token) => grantedTokenSet.has(token));
}

function issueUserOAuthAccessToken(userId: string, username: string, scope: string, resource: string): string {
  const normalizedResource = resource.trim();
  return jwt.sign(
    {
      sub: userId,
      username: username.trim().toLowerCase(),
      tokenUse: "access",
      scope
    },
    oauthJwtSecret,
    {
      algorithm: "HS256",
      issuer: oauthJwtIssuer,
      expiresIn: oauthJwtExpirySeconds,
      ...(normalizedResource.length > 0 ? { audience: [normalizedResource] } : {})
    }
  );
}

type AuthorizeRequestParams = {
  responseType: "code";
  clientId: string;
  redirectUri: string;
  state?: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

function normalizeScope(rawScope: string | undefined): string | undefined {
  const normalized = rawScope?.trim();
  const tokens = (normalized && normalized.length > 0 ? normalized : supportedMcpScopes.join(" "))
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) {
    return undefined;
  }
  if (uniqueTokens.some((token) => !supportedMcpScopeSet.has(token))) {
    return undefined;
  }
  return uniqueTokens.join(" ");
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local");
}

function isPrivateOrReservedIp(address: string): boolean {
  const addressType = isIP(address);
  if (addressType === 4) {
    const octets = address.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }

  if (addressType === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("::ffff:")) {
      return isPrivateOrReservedIp(lower.slice("::ffff:".length));
    }
    return false;
  }

  return true;
}

async function assertSafeClientMetadataUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new Error("client metadata URL must use https");
  }

  const hostname = url.hostname.toLowerCase();
  if (clientMetadataHostAllowlist.has(hostname)) {
    return;
  }

  if (isIP(hostname)) {
    throw new Error("IP-literal metadata hosts are blocked unless allowlisted");
  }

  if (isLocalHostname(hostname)) {
    throw new Error("local metadata hosts are blocked unless allowlisted");
  }

  const resolvedAddresses = await dnsLookup(hostname, { all: true });
  if (resolvedAddresses.length === 0) {
    throw new Error("metadata host did not resolve");
  }
  for (const entry of resolvedAddresses) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new Error("metadata host resolved to a private or reserved address");
    }
  }
}

async function readLimitedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLengthRaw = response.headers.get("content-length");
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("metadata response exceeds size limit");
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("metadata response exceeds size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function parseClientMetadataDocument(raw: unknown, expectedClientId: string): ResolvedOAuthClient {
  if (!raw || typeof raw !== "object") {
    throw new Error("metadata document must be a JSON object");
  }
  const metadata = raw as {
    client_id?: unknown;
    client_name?: unknown;
    redirect_uris?: unknown;
  };
  const clientId = typeof metadata.client_id === "string" ? metadata.client_id.trim() : "";
  if (!clientId || clientId !== expectedClientId) {
    throw new Error("metadata client_id mismatch");
  }
  const clientName = typeof metadata.client_name === "string" ? metadata.client_name.trim() : "";
  if (!clientName) {
    throw new Error("metadata client_name is required");
  }
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  if (redirectUris.length === 0) {
    throw new Error("metadata redirect_uris is required");
  }

  return {
    clientId,
    clientName,
    redirectUris: [...new Set(redirectUris)],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    source: "client_id_metadata_document"
  };
}

async function resolveClientFromMetadataDocument(clientId: string): Promise<ResolvedOAuthClient> {
  const cached = clientMetadataCache.get(clientId);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.client;
  }
  if (cached && cached.expiresAtMs <= Date.now()) {
    clientMetadataCache.delete(clientId);
  }

  const metadataUrl = new URL(clientId);
  await assertSafeClientMetadataUrl(metadataUrl);

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), clientMetadataFetchTimeoutMs);
  try {
    const response = await fetch(metadataUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: abortController.signal
    });
    if (!response.ok) {
      throw new Error(`metadata fetch failed with HTTP ${response.status}`);
    }

    const rawText = await readLimitedResponseText(response, clientMetadataMaxResponseBytes);
    const parsed = JSON.parse(rawText) as unknown;
    const resolvedClient = parseClientMetadataDocument(parsed, clientId);
    clientMetadataCache.set(clientId, {
      client: resolvedClient,
      expiresAtMs: Date.now() + clientMetadataCacheTtlMs
    });
    return resolvedClient;
  } finally {
    clearTimeout(timeout);
  }
}

function isHttpsClientId(clientId: string): boolean {
  try {
    const parsed = new URL(clientId);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

type ResolveOAuthClientResult =
  | { ok: true; client: ResolvedOAuthClient }
  | { ok: false; error: "invalid_client" | "invalid_redirect_uri"; message: string };

type DynamicClientRegistrationPayload = {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
};

type ParseDynamicClientRegistrationResult =
  | {
      ok: true;
      clientName: string;
      redirectUris: string[];
      tokenEndpointAuthMethod: "none";
      grantTypes: OAuthGrantType[];
      responseTypes: "code"[];
    }
  | {
      ok: false;
      error: string;
      reason:
        | "payload_not_object"
        | "missing_client_name"
        | "missing_redirect_uris"
        | "invalid_redirect_uri_format"
        | "invalid_redirect_uri_scheme"
        | "invalid_redirect_uri_fragment"
        | "unsupported_token_endpoint_auth_method"
        | "unsupported_grant_types"
        | "unsupported_response_types";
      details?: Record<string, string | number | boolean | undefined>;
    };

function parseDynamicClientRegistrationPayload(raw: unknown): ParseDynamicClientRegistrationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_client_metadata", reason: "payload_not_object" };
  }

  const payload = raw as DynamicClientRegistrationPayload;
  const clientName = typeof payload.client_name === "string" ? payload.client_name.trim() : "";
  if (!clientName) {
    return { ok: false, error: "invalid_client_metadata", reason: "missing_client_name" };
  }

  const redirectUris = Array.isArray(payload.redirect_uris)
    ? payload.redirect_uris
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  if (redirectUris.length === 0) {
    return { ok: false, error: "invalid_redirect_uri", reason: "missing_redirect_uris" };
  }

  for (const redirectUri of redirectUris) {
    try {
      const parsed = new URL(redirectUri);
      if (parsed.protocol !== "https:") {
        return {
          ok: false,
          error: "invalid_redirect_uri",
          reason: "invalid_redirect_uri_scheme",
          details: { redirect_uri: redirectUri, scheme: parsed.protocol }
        };
      }
      if (parsed.hash && parsed.hash.length > 0) {
        return {
          ok: false,
          error: "invalid_redirect_uri",
          reason: "invalid_redirect_uri_fragment",
          details: { redirect_uri: redirectUri }
        };
      }
    } catch {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        reason: "invalid_redirect_uri_format",
        details: { redirect_uri: redirectUri }
      };
    }
  }

  const tokenEndpointAuthMethodRaw =
    typeof payload.token_endpoint_auth_method === "string" ? payload.token_endpoint_auth_method.trim() : "none";
  if (tokenEndpointAuthMethodRaw !== "none") {
    return {
      ok: false,
      error: "invalid_client_metadata",
      reason: "unsupported_token_endpoint_auth_method",
      details: { token_endpoint_auth_method: tokenEndpointAuthMethodRaw || "(empty)" }
    };
  }

  const grantTypes = Array.isArray(payload.grant_types)
    ? payload.grant_types.filter((value): value is string => typeof value === "string").map((value) => value.trim())
    : ["authorization_code"];
  const uniqueGrantTypes = [...new Set(grantTypes)];
  const unsupportedGrantTypes = uniqueGrantTypes.filter((value) => value !== "authorization_code" && value !== "refresh_token");
  if (unsupportedGrantTypes.length > 0 || !uniqueGrantTypes.includes("authorization_code")) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      reason: "unsupported_grant_types",
      details: { grant_types: uniqueGrantTypes.join(" ") || "(empty)" }
    };
  }

  const responseTypes = Array.isArray(payload.response_types)
    ? payload.response_types
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
    : ["code"];
  if (responseTypes.length === 0 || responseTypes.some((value) => value !== "code")) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      reason: "unsupported_response_types",
      details: { response_types: responseTypes.join(" ") || "(empty)" }
    };
  }

  return {
    ok: true,
    clientName,
    redirectUris: [...new Set(redirectUris)],
    tokenEndpointAuthMethod: "none",
    grantTypes: uniqueGrantTypes as OAuthGrantType[],
    responseTypes: ["code"]
  };
}

async function resolveClientFromDynamicRegistration(clientId: string): Promise<ResolvedOAuthClient | undefined> {
  const registered = await getOAuthDynamicClient(clientId);
  if (!registered) {
    return undefined;
  }
  return {
    clientId: registered.clientId,
    clientName: registered.clientName,
    redirectUris: registered.redirectUris,
    tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod,
    grantTypes: registered.grantTypes,
    responseTypes: registered.responseTypes,
    source: "dynamic_client_registration"
  };
}

async function resolveOAuthClient(clientId: string, redirectUri: string): Promise<ResolveOAuthClientResult> {
  let resolvedClient: ResolvedOAuthClient;
  if (isHttpsClientId(clientId)) {
    try {
      resolvedClient = await resolveClientFromMetadataDocument(clientId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "client metadata resolution failed";
      return {
        ok: false,
        error: "invalid_client",
        message
      };
    }
  } else {
    const dynamicallyRegisteredClient = await resolveClientFromDynamicRegistration(clientId);
    if (!dynamicallyRegisteredClient) {
      console.warn("[oauth] client resolution failed for non-URL client_id", {
        client_id: clientId,
        redirect_uri: redirectUri
      });
      return {
        ok: false,
        error: "invalid_client",
        message: "client is not recognized"
      };
    }
    console.info("[oauth] resolved dynamically registered client", {
      client_id: dynamicallyRegisteredClient.clientId,
      redirect_uri: redirectUri
    });
    resolvedClient = dynamicallyRegisteredClient;
  }

  if (!resolvedClient.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      message: "redirect_uri is not registered for client"
    };
  }
  return {
    ok: true,
    client: resolvedClient
  };
}

function readAuthorizeParams(source: Record<string, unknown>): AuthorizeRequestParams | { error: string } {
  const responseType = typeof source.response_type === "string" ? source.response_type.trim() : "";
  if (responseType !== "code") {
    return { error: "unsupported_response_type" };
  }

  const clientId = typeof source.client_id === "string" ? source.client_id.trim() : "";
  if (!clientId) {
    return { error: "invalid_client" };
  }

  const redirectUri = typeof source.redirect_uri === "string" ? source.redirect_uri.trim() : "";
  if (!redirectUri) {
    return { error: "invalid_redirect_uri" };
  }

  const resource = typeof source.resource === "string" ? source.resource.trim() : "";
  if (!resource) {
    return { error: "invalid_request" };
  }

  const normalizedScope = normalizeScope(typeof source.scope === "string" ? source.scope : undefined);
  if (!normalizedScope) {
    return { error: "invalid_scope" };
  }

  const codeChallenge = typeof source.code_challenge === "string" ? source.code_challenge.trim() : "";
  if (!codeChallenge) {
    return { error: "invalid_request" };
  }

  const codeChallengeMethodRaw =
    typeof source.code_challenge_method === "string" ? source.code_challenge_method.trim() : "";
  if (codeChallengeMethodRaw !== "S256") {
    return { error: "invalid_request" };
  }

  const state = typeof source.state === "string" && source.state.trim().length > 0 ? source.state : undefined;
  return {
    responseType: "code",
    clientId,
    redirectUri,
    state,
    resource,
    scope: normalizedScope,
    codeChallenge,
    codeChallengeMethod: "S256"
  };
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAuthorizeLoginForm(params: AuthorizeRequestParams, errorMessage?: string): string {
  const errorHtml = errorMessage
    ? `<p style="color:#b91c1c;background:#fee2e2;padding:8px 10px;border-radius:6px;">${escapeHtml(errorMessage)}</p>`
    : "";
  const stateInput = params.state
    ? `<input type="hidden" name="state" value="${escapeHtml(params.state)}" />`
    : "";
  const resourceInput = `<input type="hidden" name="resource" value="${escapeHtml(params.resource)}" />`;
  const scopeInput = `<input type="hidden" name="scope" value="${escapeHtml(params.scope)}" />`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workbench Authorization</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f8fafc; margin:0; }
      main { max-width:420px; margin:56px auto; background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:24px; }
      h1 { margin:0 0 10px; font-size:20px; }
      p { margin:0 0 16px; color:#334155; font-size:14px; }
      label { display:block; margin:12px 0 6px; font-size:13px; color:#0f172a; }
      input { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px; }
      button { margin-top:16px; width:100%; border:0; border-radius:8px; padding:11px 12px; background:#0f172a; color:#fff; font-weight:600; cursor:pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize Workbench Access</h1>
      <p>Sign in to continue with Claude connector authorization.</p>
      ${errorHtml}
      <form method="post" action="/authorize">
        <input type="hidden" name="response_type" value="${params.responseType}" />
        <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
        <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
        <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
        <input type="hidden" name="code_challenge_method" value="${params.codeChallengeMethod}" />
        ${stateInput}
        ${resourceInput}
        ${scopeInput}
        <label for="username">Username</label>
        <input id="username" name="username" type="text" required autocomplete="username" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" />
        <button type="submit">Authorize</button>
      </form>
    </main>
  </body>
</html>`;
}

export const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

type ServiceTarget = {
  id: "notes" | "artifacts" | "tasks" | "projects" | "images";
  baseUrl: string;
  apiKey: string;
};

const serviceTargets: ServiceTarget[] = [
  {
    id: "notes",
    baseUrl: requireEnv("NOTES_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_NOTES")
  },
  {
    id: "artifacts",
    baseUrl: requireEnv("ARTIFACTS_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_ARTIFACTS")
  },
  {
    id: "tasks",
    baseUrl: requireEnv("TASKS_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_TASKS")
  },
  {
    id: "images",
    baseUrl: requireEnv("IMAGES_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_IMAGES")
  }
];

const projectsServiceUrl = optionalEnv("PROJECTS_SERVICE_URL");
const projectsInternalApiKey = optionalEnv("INTERNAL_API_KEY_PROJECTS");
if (projectsServiceUrl && projectsInternalApiKey) {
  serviceTargets.push({
    id: "projects",
    baseUrl: projectsServiceUrl,
    apiKey: projectsInternalApiKey
  });
}

const accountSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const integrationConfigSchema = z.object({
  enabled: z.boolean(),
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).default({})
});

const taskImportBodySchema = z.union([z.string(), z.object({ csv: z.string() })]);

const deepResearchRequestSchema = z.object({
  query: z.string().min(1),
  provider: z.enum(["auto", "gemini", "openai", "anthropic"]).optional(),
  speed: z.enum(["deep", "fast"]).optional(),
  timeoutSec: z.number().int().positive().optional(),
  asyncOnTimeout: z.boolean().optional(),
  saveToArtifacts: z.boolean().optional(),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});

const deepResearchManualSaveSchema = z.object({
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  createNew: z.boolean().optional()
});

const imageProviderSchema = z.enum(["auto", "mock", "openai", "nanobanana"]);
const imageIntentSchema = z.enum(["create", "refine", "edit", "context_update"]);
const imageSizeSchema = z.enum(["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024", "auto"]);
const imageQualitySchema = z.enum(["draft", "standard", "high"]);
const imagePreserveSchema = z.enum(["composition", "subject", "style", "colors", "text", "layout"]);
const imageContextRefSchema = z.object({
  kind: z.enum(["project", "artifact", "note", "task", "research", "freeform"]),
  id: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional()
});

const imageGenerationRequestSchema = z.object({
  intent: imageIntentSchema.optional(),
  prompt: z.string().min(1),
  instruction: z.string().optional(),
  negativePrompt: z.string().optional(),
  provider: imageProviderSchema.optional(),
  model: z.string().optional(),
  size: imageSizeSchema.optional(),
  count: z.number().int().min(1).max(8).optional(),
  quality: imageQualitySchema.optional(),
  stylePreset: z.string().optional(),
  seed: z.number().int().optional(),
  referenceImageIds: z.array(z.string()).optional(),
  sourceAssetIds: z.array(z.string()).optional(),
  sourceArtifactItemIds: z.array(z.string()).optional(),
  contextRefs: z.array(imageContextRefSchema).optional(),
  preserve: z.array(imagePreserveSchema).optional(),
  saveToArtifacts: z.boolean().optional(),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});

const imageRetryRequestSchema = imageGenerationRequestSchema.partial();

const imageArtifactSaveSchema = z.object({
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});

const jsonRecordSchema = z.record(z.unknown());

const localClientRegisterSchema = z.object({
  deviceId: z.string().min(1),
  clientName: z.string().min(1),
  platform: z.string().min(1),
  capabilities: jsonRecordSchema.optional(),
  syncRootId: z.string().min(1).optional(),
  syncRootLabel: z.string().min(1).optional(),
  default: z.boolean().optional()
});

const localClientPatchSchema = z.object({
  clientName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  capabilities: jsonRecordSchema.optional(),
  syncRootLabel: z.string().min(1).optional(),
  default: z.boolean().optional()
});

const localClientHeartbeatSchema = z.object({
  daemonVersion: z.string().optional(),
  syncRootState: jsonRecordSchema.optional()
});

const localJobKindSchema = z.enum(["download_artifact", "download_task_attachment", "materialize_resource"]);
const localJobTargetSchema = z.enum(["downloads", "sync-folder"]);
const localJobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

const localJobCreateSchema = z.object({
  localClientId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  kind: localJobKindSchema,
  target: localJobTargetSchema,
  payload: jsonRecordSchema.optional(),
  ttlSeconds: z.number().int().positive().optional()
});

const localJobClaimSchema = z.object({
  limit: z.number().int().positive().max(25).optional()
});

const localJobCompleteSchema = z.object({
  result: jsonRecordSchema.default({})
});

const localJobFailSchema = z.object({
  error: z.string().min(1),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().max(86400).optional()
});

const syncPushSchema = z.object({
  ops: z.array(jsonRecordSchema).default([])
});

const syncBlobPutSchema = z.object({
  contentBase64: z.string(),
  filename: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  baseVersion: z.number().int().nonnegative().optional(),
  expectedVersion: z.number().int().positive().optional()
});

type AuthenticatedContext = {
  userId: string;
  username: string;
  accessToken: string;
};

type SyncAccessContext = AuthenticatedContext & {
  localClient?: LocalClient;
};

function readBearerToken(req: express.Request): string | undefined {
  const raw = req.header("authorization");
  if (!raw) return undefined;
  const [scheme, token] = raw.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token.trim();
}

async function requireAuthenticatedContext(
  req: express.Request,
  res: express.Response
): Promise<AuthenticatedContext | undefined> {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ message: "Missing bearer token" });
    return undefined;
  }

  try {
    const claims = verifyAccessToken(token);
    const user = await findUserById(claims.sub);
    if (!user || user.username !== claims.username) {
      res.status(401).json({ message: "Invalid token user" });
      return undefined;
    }

    return {
      userId: user.id,
      username: user.username,
      accessToken: token
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: "Invalid or expired token" });
      return undefined;
    }
    const message = error instanceof Error ? error.message : "Authentication failed";
    res.status(401).json({ message });
    return undefined;
  }
}

async function requireLocalClientContext(
  req: express.Request,
  res: express.Response
): Promise<{ client: LocalClient } | undefined> {
  const localClientId = req.header("x-workbench-local-client-id")?.trim();
  const localClientToken = req.header("x-workbench-local-client-token")?.trim();
  if (!localClientId || !localClientToken) {
    res.status(401).json({ message: "Missing local client credentials" });
    return undefined;
  }

  try {
    const client = await verifyLocalClientToken(localClientId, localClientToken);
    return { client };
  } catch (error) {
    if (error instanceof LocalClientStoreError) {
      res.status(error.status).json({ message: error.message, code: error.code });
      return undefined;
    }
    const message = error instanceof Error ? error.message : "Local client authentication failed";
    res.status(401).json({ message });
    return undefined;
  }
}

async function requireLocalClientCapability(
  req: express.Request,
  res: express.Response,
  capability: LocalClientCapability
): Promise<{ client: LocalClient } | undefined> {
  const localContext = await requireLocalClientContext(req, res);
  if (!localContext) return undefined;
  try {
    assertLocalClientCapability(localContext.client, capability);
    return localContext;
  } catch (error) {
    if (error instanceof LocalClientStoreError) {
      await recordLocalClientCapabilityDenied(localContext.client, capability, {
        method: req.method,
        path: req.path
      }).catch((auditError) => {
        const message = auditError instanceof Error ? auditError.message : String(auditError);
        console.warn("[local-client] failed to record capability denial", {
          localClientId: localContext.client.id,
          capability,
          message
        });
      });
      res.status(error.status).json({ message: error.message, code: error.code, capability });
      return undefined;
    }
    throw error;
  }
}

async function requireSyncAccessContext(
  req: express.Request,
  res: express.Response,
  localClientCapability?: LocalClientCapability
): Promise<SyncAccessContext | undefined> {
  if (readBearerToken(req)) {
    return requireAuthenticatedContext(req, res);
  }

  const localContext = localClientCapability
    ? await requireLocalClientCapability(req, res, localClientCapability)
    : await requireLocalClientContext(req, res);
  if (!localContext) return undefined;
  const user = await findUserById(localContext.client.userId);
  if (!user) {
    res.status(401).json({ message: "Invalid local client user" });
    return undefined;
  }
  const bundle = issueTokenBundle({ userId: user.id, username: user.username });
  return {
    userId: user.id,
    username: user.username,
    accessToken: bundle.accessToken,
    localClient: localContext.client
  };
}

function respondInternalError(res: express.Response, error: unknown): express.Response {
  if (error instanceof LocalClientStoreError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }

  if (error instanceof InternalServiceError) {
    if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 400) {
      return res.status(error.status).json({ message: error.body || error.message });
    }
    return res.status(502).json({ message: `[${error.service}] ${error.body || error.message}` });
  }

  const message = error instanceof Error ? error.message : "Unexpected internal error";
  return res.status(500).json({ message });
}

function objectId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id === "string" && id.trim().length > 0) return id;
  const nestedItem = (value as { item?: unknown }).item;
  if (nestedItem && typeof nestedItem === "object") {
    const nestedId = (nestedItem as { id?: unknown }).id;
    if (typeof nestedId === "string" && nestedId.trim().length > 0) return nestedId;
  }
  return undefined;
}

function recordSyncEventBestEffort(
  userId: string,
  domain: SyncDomain,
  resourceId: string | undefined,
  action: SyncAction,
  payload: Record<string, unknown> = {}
): void {
  if (!resourceId) return;
  void recordSyncEvent(userId, domain, resourceId, action, payload).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[sync] failed to record event", { domain, resourceId, action, message });
  });
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonRecordFromBuffer(buffer: Buffer): Record<string, unknown> {
  try {
    return asJsonRecord(JSON.parse(buffer.toString("utf8")));
  } catch {
    return {};
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function queryFlagEnabled(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(queryFlagEnabled);
  }
  if (typeof value !== "string") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function optionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LocalClientStoreError(400, "SYNC_BASE_VERSION_INVALID", `${fieldName} must be a non-negative integer.`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LocalClientStoreError(400, "SYNC_EXPECTED_VERSION_INVALID", `${fieldName} must be a positive integer.`);
  }
  return value;
}

function decodeContentBase64(contentBase64: string): { compactBase64: string; buffer: Buffer } {
  const compactBase64 = contentBase64.replace(/\s+/g, "");
  if (compactBase64.length === 0) {
    return { compactBase64, buffer: Buffer.alloc(0) };
  }
  if (compactBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
    throw new LocalClientStoreError(400, "SYNC_BLOB_BASE64_INVALID", "contentBase64 must be valid base64.");
  }
  return {
    compactBase64,
    buffer: Buffer.from(compactBase64, "base64")
  };
}

function sha256Checksum(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function withoutKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function syncEventPayloadMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  return withoutKeys(payload, ["contentBase64"]);
}

function requireSyncString(record: Record<string, unknown>, fieldName: string, code: string, message: string): string {
  const value = asNonEmptyString(record[fieldName]);
  if (!value) {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function optionalSyncString(record: Record<string, unknown>, fieldName: string, code: string, message: string): string | undefined {
  if (record[fieldName] === undefined) return undefined;
  const value = asNonEmptyString(record[fieldName]);
  if (!value) {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function optionalRawString(record: Record<string, unknown>, fieldName: string, code: string, message: string): string | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function optionalNullableRawString(
  record: Record<string, unknown>,
  fieldName: string,
  code: string,
  message: string
): string | null | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function optionalNonNegativeSyncInteger(
  record: Record<string, unknown>,
  fieldName: string,
  code: string,
  message: string
): number | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalScheduleItemId(payload: Record<string, unknown>): number | undefined {
  return asPositiveInteger(payload.scheduleId) ?? asPositiveInteger(payload.id);
}

function taskRelationTaskId(op: Record<string, unknown>, payload: Record<string, unknown>): string | undefined {
  return asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.taskId);
}

function requireTaskRelationTaskId(
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  code: string,
  message: string
): string {
  const taskId = taskRelationTaskId(op, payload);
  if (!taskId) {
    throw new LocalClientStoreError(400, code, message);
  }
  return taskId;
}

function scheduleCreatePayload(payload: Record<string, unknown>, taskId: string, code: string) {
  const scheduledDate = requireSyncString(payload, "scheduledDate", code, "Task schedule create requires scheduledDate.");
  const occurrenceDate = optionalRawString(payload, "occurrenceDate", code, "occurrenceDate must be a string when provided.") ?? scheduledDate;
  const startTime = optionalRawString(payload, "startTime", code, "startTime must be a string when provided.");
  const endTime = optionalRawString(payload, "endTime", code, "endTime must be a string when provided.");
  const timezone = optionalRawString(payload, "timezone", code, "timezone must be a string when provided.");
  return { taskId, scheduledDate, occurrenceDate, opts: { startTime, endTime, timezone } };
}

function scheduleItemPatchPayload(payload: Record<string, unknown>): {
  scheduledDate?: string;
  occurrenceDate?: string;
  startTime?: string | null;
  endTime?: string | null;
  timezone?: string | null;
} {
  const code = "SYNC_TASK_SCHEDULE_ITEM_PAYLOAD_INVALID";
  const patch: {
    scheduledDate?: string;
    occurrenceDate?: string;
    startTime?: string | null;
    endTime?: string | null;
    timezone?: string | null;
  } = {};
  const scheduledDate = optionalSyncString(payload, "scheduledDate", code, "scheduledDate must be a non-empty string when provided.");
  const occurrenceDate = optionalRawString(payload, "occurrenceDate", code, "occurrenceDate must be a string when provided.");
  const startTime = optionalNullableRawString(payload, "startTime", code, "startTime must be a string, null, or omitted.");
  const endTime = optionalNullableRawString(payload, "endTime", code, "endTime must be a string, null, or omitted.");
  const timezone = optionalNullableRawString(payload, "timezone", code, "timezone must be a string, null, or omitted.");

  if (scheduledDate !== undefined) patch.scheduledDate = scheduledDate;
  if (occurrenceDate !== undefined) patch.occurrenceDate = occurrenceDate;
  if (startTime !== undefined) patch.startTime = startTime;
  if (endTime !== undefined) patch.endTime = endTime;
  if (timezone !== undefined) patch.timezone = timezone;
  if (Object.keys(patch).length === 0) {
    throw new LocalClientStoreError(400, code, "Task schedule item update requires at least one patch field.");
  }
  return patch;
}

function subtaskUpdatePayload(payload: Record<string, unknown>): { title?: string; isDone?: boolean; sortOrder?: number } {
  const code = "SYNC_TASK_SUBTASK_PAYLOAD_INVALID";
  const updates: { title?: string; isDone?: boolean; sortOrder?: number } = {};
  const title = optionalSyncString(payload, "title", code, "Subtask title must be a non-empty string when provided.");
  const isDone = payload.isDone;
  const sortOrder = optionalNonNegativeSyncInteger(payload, "sortOrder", code, "Subtask sortOrder must be a non-negative integer when provided.");

  if (title !== undefined) updates.title = title;
  if (isDone !== undefined) {
    if (typeof isDone !== "boolean") {
      throw new LocalClientStoreError(400, code, "Subtask isDone must be a boolean when provided.");
    }
    updates.isDone = isDone;
  }
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (Object.keys(updates).length === 0) {
    throw new LocalClientStoreError(400, code, "Subtask update requires title, isDone, or sortOrder.");
  }
  return updates;
}

type SyncPushApplied = {
  index: number;
  clientOpId?: string;
  domain: SyncDomain;
  action: SyncAction;
  resourceId: string;
  version: number;
  cursor: string;
  result?: unknown;
};

type SyncPushRejected = {
  index: number;
  clientOpId?: string;
  op: Record<string, unknown>;
  code: string;
  message: string;
};

async function assertSyncBaseVersion(
  authContext: SyncAccessContext,
  domain: SyncDomain,
  resourceId: string | undefined,
  op: Record<string, unknown>
): Promise<void> {
  const baseVersion = optionalNonNegativeInteger(op.baseVersion, "baseVersion");
  if (baseVersion === undefined) return;

  if (!resourceId) {
    if (baseVersion === 0) return;
    throw new LocalClientStoreError(409, "SYNC_VERSION_CONFLICT", "baseVersion does not match an existing resource.");
  }

  const current = await getSyncResourceVersion(authContext.userId, domain, resourceId);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== baseVersion) {
    throw new LocalClientStoreError(
      409,
      "SYNC_VERSION_CONFLICT",
      `Sync resource version conflict: expected ${baseVersion}, current ${currentVersion}.`
    );
  }
}

async function applyTaskOccurrenceSyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  if (action !== "update" && action !== "upsert") {
    throw new LocalClientStoreError(400, "SYNC_TASK_OCCURRENCE_ACTION_NOT_SUPPORTED", "Task occurrence sync push requires update or upsert action.");
  }

  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task occurrence sync push requires task resourceId or payload.taskId.");
  const operation = asNonEmptyString(payload.operation) ?? asNonEmptyString(payload.kind);
  const normalizedOperation = operation === "skip-exception" ? "skipException" : operation;
  const inferredOperation = normalizedOperation
    ?? (asNonEmptyString(payload.sourceDate) ? "move" : asNonEmptyString(payload.status) ? "complete" : undefined);

  if (inferredOperation === "complete") {
    const targetDate = requireSyncString(payload, "targetDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence complete requires targetDate.");
    const status = requireSyncString(payload, "status", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence complete requires status.");
    return {
      result: await tasksClient.completeOccurrence(authContext.accessToken, taskId, targetDate, status),
      nextResourceId: taskId
    };
  }

  if (inferredOperation === "move") {
    const sourceDate = requireSyncString(payload, "sourceDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence move requires sourceDate.");
    const targetDate = requireSyncString(payload, "targetDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence move requires targetDate.");
    return {
      result: await tasksClient.moveOccurrence(authContext.accessToken, taskId, sourceDate, targetDate),
      nextResourceId: taskId
    };
  }

  if (inferredOperation === "skipException") {
    const targetDate = requireSyncString(payload, "targetDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence skipException requires targetDate.");
    return {
      result: await tasksClient.skipOccurrenceException(authContext.accessToken, taskId, targetDate),
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Task occurrence sync push requires operation complete, move, or skipException.");
}

async function applyTaskSubtaskSyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task subtask sync push requires task resourceId or payload.taskId.");
  const occurrenceDate = requireSyncString(payload, "occurrenceDate", "SYNC_TASK_SUBTASK_PAYLOAD_INVALID", "Task subtask sync push requires occurrenceDate.");
  const subtaskId = asNonEmptyString(payload.subtaskId) ?? asNonEmptyString(payload.id);

  if (action === "create" || (action === "upsert" && !subtaskId)) {
    const title = requireSyncString(payload, "title", "SYNC_TASK_SUBTASK_PAYLOAD_INVALID", "Subtask create requires title.");
    return {
      result: await tasksClient.createSubtask(authContext.accessToken, taskId, occurrenceDate, title),
      nextResourceId: taskId
    };
  }

  if (action === "update" || action === "upsert") {
    if (!subtaskId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SUBTASK_ID_REQUIRED", "Subtask update requires subtaskId.");
    }
    return {
      result: await tasksClient.updateSubtask(authContext.accessToken, taskId, occurrenceDate, subtaskId, subtaskUpdatePayload(payload)),
      nextResourceId: taskId
    };
  }

  if (action === "delete") {
    if (!subtaskId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SUBTASK_ID_REQUIRED", "Subtask delete requires subtaskId.");
    }
    await tasksClient.deleteSubtask(authContext.accessToken, taskId, occurrenceDate, subtaskId);
    return {
      result: { id: subtaskId, taskId, occurrenceDate, deleted: true },
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_SUBTASK_ACTION_NOT_SUPPORTED", "Unsupported task subtask sync push action.");
}

async function applyTaskTodaySyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task today sync push requires task resourceId or payload.taskId.");

  if (action === "create" || action === "upsert") {
    const schedule = scheduleCreatePayload(payload, taskId, "SYNC_TASK_TODAY_PAYLOAD_INVALID");
    return {
      result: await tasksClient.addToday(authContext.accessToken, schedule.taskId, schedule.scheduledDate, schedule.occurrenceDate, schedule.opts),
      nextResourceId: taskId
    };
  }

  if (action === "delete") {
    const scheduledDate = requireSyncString(payload, "scheduledDate", "SYNC_TASK_TODAY_PAYLOAD_INVALID", "Task today delete requires scheduledDate.");
    return {
      result: await tasksClient.removeFromToday(authContext.accessToken, taskId, scheduledDate),
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_TODAY_ACTION_NOT_SUPPORTED", "Task today sync push requires create, upsert, or delete action.");
}

async function applyTaskScheduleItemSyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task scheduleItem sync push requires task resourceId or payload.taskId.");
  const scheduleId = optionalScheduleItemId(payload);

  if (action === "create" || (action === "upsert" && !scheduleId)) {
    const schedule = scheduleCreatePayload(payload, taskId, "SYNC_TASK_SCHEDULE_ITEM_PAYLOAD_INVALID");
    return {
      result: await tasksClient.addToday(authContext.accessToken, schedule.taskId, schedule.scheduledDate, schedule.occurrenceDate, schedule.opts),
      nextResourceId: taskId
    };
  }

  if (action === "update" || action === "upsert") {
    if (!scheduleId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SCHEDULE_ITEM_ID_REQUIRED", "Task schedule item update requires scheduleId.");
    }
    return {
      result: await tasksClient.updateScheduleItem(authContext.accessToken, scheduleId, scheduleItemPatchPayload(payload)),
      nextResourceId: taskId
    };
  }

  if (action === "delete") {
    if (!scheduleId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SCHEDULE_ITEM_ID_REQUIRED", "Task schedule item delete requires scheduleId.");
    }
    await tasksClient.deleteScheduleItem(authContext.accessToken, scheduleId);
    return {
      result: { id: scheduleId, taskId, deleted: true },
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_SCHEDULE_ITEM_ACTION_NOT_SUPPORTED", "Unsupported task schedule item sync push action.");
}

async function applySyncPushOperation(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  index: number
): Promise<SyncPushApplied> {
  const clientOpId = asNonEmptyString(op.clientOpId);
  const domain = asNonEmptyString(op.domain) as SyncDomain | undefined;
  const action = asNonEmptyString(op.action) as SyncAction | undefined;
  const payload = asJsonRecord(op.payload);
  const resourceId = asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.id);

  if (!domain || !["projects", "notes", "artifacts", "tasks"].includes(domain)) {
    throw new LocalClientStoreError(400, "SYNC_DOMAIN_NOT_SUPPORTED", "Only projects, notes, artifacts, and tasks sync push operations are supported in this phase.");
  }
  if (!action || !["create", "update", "delete", "upsert"].includes(action)) {
    throw new LocalClientStoreError(400, "SYNC_ACTION_NOT_SUPPORTED", "Unsupported sync push action.");
  }

  const relation = asNonEmptyString(op.relation) ?? asNonEmptyString(payload.relation);
  const versionResourceId = domain === "tasks" && relation
    ? taskRelationTaskId(op, payload) ?? (relation === "pin" ? resourceId : undefined)
    : domain === "projects" && relation === "default"
      ? asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.projectId) ?? asNonEmptyString(payload.id)
      : resourceId;
  await assertSyncBaseVersion(authContext, domain, versionResourceId, op);

  if (domain === "notes") {
    let result: unknown;
    let nextResourceId = resourceId;
    if (action === "create") {
      result = await notesClient.create(authContext.accessToken, payload);
      nextResourceId = objectId(result);
    } else if (action === "update" || action === "upsert") {
      if (!resourceId) {
        result = await notesClient.create(authContext.accessToken, payload);
        nextResourceId = objectId(result);
      } else {
        result = await notesClient.update(authContext.accessToken, resourceId, payload);
        nextResourceId = objectId(result) ?? resourceId;
      }
    } else {
      if (!resourceId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
      }
      await notesClient.remove(authContext.accessToken, resourceId);
      nextResourceId = resourceId;
      result = { id: resourceId, deleted: true };
    }

    if (!nextResourceId) {
      throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
    }
    const event = await recordSyncEvent(authContext.userId, "notes", nextResourceId, action === "upsert" ? "update" : action, {
      source: "sync-push",
      clientOpId,
      localClientId: authContext.localClient?.id,
      ...(action !== "delete" ? { resource: result } : {}),
      ...(action === "delete" ? { deleted: true } : {})
    });
    return {
      index,
      clientOpId,
      domain: "notes",
      action: event.action,
      resourceId: nextResourceId,
      version: event.version,
      cursor: event.cursor,
      result
    };
  }

  if (domain === "projects") {
    let result: unknown;
    let nextResourceId = resourceId;
    if (relation === "default") {
      if (action !== "update" && action !== "upsert") {
        throw new LocalClientStoreError(400, "SYNC_PROJECT_DEFAULT_ACTION_NOT_SUPPORTED", "Project default sync push requires update or upsert action.");
      }
      const projectId = asNonEmptyString(payload.projectId) ?? asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.id);
      if (!projectId) {
        throw new LocalClientStoreError(400, "SYNC_PROJECT_DEFAULT_PAYLOAD_INVALID", "Project default sync push requires projectId.");
      }
      result = await projectsClient.setDefault(authContext.accessToken, { projectId });
      nextResourceId = projectId;
    } else if (relation) {
      throw new LocalClientStoreError(400, "SYNC_PROJECT_RELATION_NOT_SUPPORTED", "Only project default relation sync push is supported.");
    } else if (action === "create") {
      result = await projectsClient.create(authContext.accessToken, payload);
      nextResourceId = objectId(result);
    } else if (action === "update" || action === "upsert") {
      if (!resourceId) {
        result = await projectsClient.create(authContext.accessToken, payload);
        nextResourceId = objectId(result);
      } else {
        result = await projectsClient.update(authContext.accessToken, resourceId, payload);
        nextResourceId = objectId(result) ?? resourceId;
      }
    } else {
      if (!resourceId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
      }
      await projectsClient.remove(authContext.accessToken, resourceId);
      nextResourceId = resourceId;
      result = { id: resourceId, deleted: true };
    }

    if (!nextResourceId) {
      throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
    }
    const event = await recordSyncEvent(authContext.userId, "projects", nextResourceId, action === "upsert" ? "update" : action, {
      source: "sync-push",
      clientOpId,
      localClientId: authContext.localClient?.id,
      relation,
      ...(action !== "delete" ? { resource: result } : {}),
      ...(action === "delete" ? { deleted: true } : {})
    });
    return {
      index,
      clientOpId,
      domain: "projects",
      action: event.action,
      resourceId: nextResourceId,
      version: event.version,
      cursor: event.cursor,
      result
    };
  }

  if (domain === "tasks") {
    let result: unknown;
    let nextResourceId = resourceId;
    const eventAction: SyncAction = relation ? "update" : action === "upsert" ? "update" : action;

    if (relation === "pin") {
      if (action !== "update" && action !== "upsert") {
        throw new LocalClientStoreError(400, "SYNC_TASK_RELATION_ACTION_NOT_SUPPORTED", "Task pin sync push requires update or upsert action.");
      }
      const taskId = resourceId ?? asNonEmptyString(payload.taskId);
      if (!taskId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Task pin update requires resourceId.");
      }
      const pinned = asBoolean(payload.pinned);
      if (pinned === undefined) {
        throw new LocalClientStoreError(400, "SYNC_TASK_PIN_PAYLOAD_INVALID", "Task pin update requires pinned(boolean).");
      }
      result = await tasksClient.setPin(authContext.accessToken, taskId, pinned);
      nextResourceId = taskId;
    } else if (relation === "attachment") {
      const taskId = asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.taskId);
      if (!taskId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Task attachment sync push requires task resourceId.");
      }
      const attachmentId = asNonEmptyString(payload.attachmentId) ?? asNonEmptyString(payload.id);
      nextResourceId = taskId;

      if (action === "create" || (action === "upsert" && !attachmentId)) {
        const filename = asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename);
        const contentBase64 = asNonEmptyString(payload.contentBase64);
        if (!filename || !contentBase64) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_PAYLOAD_INVALID", "Task attachment create requires filename and contentBase64.");
        }
        const { compactBase64, buffer } = decodeContentBase64(contentBase64);
        const checksum = sha256Checksum(buffer);
        const expectedChecksum = asNonEmptyString(payload.checksum);
        if (expectedChecksum && expectedChecksum !== checksum) {
          throw new LocalClientStoreError(400, "SYNC_BLOB_CHECKSUM_MISMATCH", "Task attachment checksum mismatch.");
        }
        result = await tasksClient.uploadAttachment(authContext.accessToken, taskId, {
          filename,
          mimeType: asNonEmptyString(payload.mimeType),
          contentBase64: compactBase64
        });
      } else if (action === "update" || action === "upsert") {
        if (!attachmentId) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_ID_REQUIRED", "Task attachment update requires attachmentId.");
        }
        const contentBase64 = asNonEmptyString(payload.contentBase64);
        if (!contentBase64) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_PAYLOAD_INVALID", "Task attachment update requires contentBase64.");
        }
        const { compactBase64, buffer } = decodeContentBase64(contentBase64);
        const checksum = sha256Checksum(buffer);
        const expectedChecksum = asNonEmptyString(payload.checksum);
        if (expectedChecksum && expectedChecksum !== checksum) {
          throw new LocalClientStoreError(400, "SYNC_BLOB_CHECKSUM_MISMATCH", "Task attachment checksum mismatch.");
        }
        result = await tasksClient.replaceAttachment(authContext.accessToken, taskId, attachmentId, {
          filename: asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename),
          mimeType: asNonEmptyString(payload.mimeType),
          contentBase64: compactBase64
        });
      } else {
        if (!attachmentId) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_ID_REQUIRED", "Task attachment delete requires attachmentId.");
        }
        await tasksClient.deleteAttachment(authContext.accessToken, taskId, attachmentId);
        result = { id: attachmentId, taskId, deleted: true };
      }
    } else if (relation === "occurrence") {
      ({ result, nextResourceId } = await applyTaskOccurrenceSyncPush(authContext, op, payload, action));
    } else if (relation === "subtask") {
      ({ result, nextResourceId } = await applyTaskSubtaskSyncPush(authContext, op, payload, action));
    } else if (relation === "today") {
      ({ result, nextResourceId } = await applyTaskTodaySyncPush(authContext, op, payload, action));
    } else if (relation === "scheduleItem") {
      ({ result, nextResourceId } = await applyTaskScheduleItemSyncPush(authContext, op, payload, action));
    } else if (relation) {
      throw new LocalClientStoreError(400, "SYNC_TASK_RELATION_NOT_SUPPORTED", "Supported task sync push relations are pin, attachment, occurrence, subtask, today, and scheduleItem.");
    } else if (action === "create") {
      result = await tasksClient.create(authContext.accessToken, payload);
      nextResourceId = objectId(result);
    } else if (action === "update" || action === "upsert") {
      if (!resourceId) {
        result = await tasksClient.create(authContext.accessToken, payload);
        nextResourceId = objectId(result);
      } else {
        result = await tasksClient.update(authContext.accessToken, resourceId, withoutKeys(payload, ["relation"]));
        nextResourceId = objectId(result) ?? resourceId;
      }
    } else {
      if (!resourceId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
      }
      await tasksClient.remove(authContext.accessToken, resourceId);
      nextResourceId = resourceId;
      result = { id: resourceId, deleted: true };
    }

    if (!nextResourceId) {
      throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
    }
    const event = await recordSyncEvent(authContext.userId, "tasks", nextResourceId, eventAction, {
      ...syncEventPayloadMetadata(payload),
      source: "sync-push",
      clientOpId,
      localClientId: authContext.localClient?.id,
      relation,
      ...(action !== "delete" && !relation ? { resource: result } : {}),
      ...(action === "delete" ? { deleted: true } : {})
    });
    return {
      index,
      clientOpId,
      domain: "tasks",
      action: event.action,
      resourceId: nextResourceId,
      version: event.version,
      cursor: event.cursor,
      result
    };
  }

  let result: unknown;
  let nextResourceId = resourceId;
  if (action === "create") {
    const kind = asNonEmptyString(payload.kind) ?? "note";
    if (kind === "folder") {
      result = await artifactsClient.createFolder(authContext.accessToken, withoutKeys(payload, ["kind"]));
    } else if (kind === "file") {
      const filename = asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename);
      const contentBase64 = asNonEmptyString(payload.contentBase64);
      if (!filename || !contentBase64) {
        throw new LocalClientStoreError(400, "SYNC_FILE_PAYLOAD_INVALID", "Artifact file create requires filename and contentBase64.");
      }
      result = await artifactsClient.uploadFile(authContext.accessToken, {
        projectId: asNonEmptyString(payload.projectId),
        projectName: asNonEmptyString(payload.projectName),
        directoryPath: asNonEmptyString(payload.directoryPath),
        scope: asNonEmptyString(payload.scope) as "private" | "org" | "project" | undefined,
        tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
        filename,
        mimeType: asNonEmptyString(payload.mimeType),
        contentBase64
      });
    } else {
      result = await artifactsClient.createNote(authContext.accessToken, withoutKeys(payload, ["kind"]));
    }
    nextResourceId = objectId(result);
  } else if (action === "update" || action === "upsert") {
    if (!resourceId) {
      result = await artifactsClient.createNote(authContext.accessToken, withoutKeys({ ...payload, kind: "note" }, ["kind"]));
      nextResourceId = objectId(result);
    } else if (typeof payload.contentBase64 === "string") {
      const { compactBase64, buffer } = decodeContentBase64(payload.contentBase64);
      const checksum = sha256Checksum(buffer);
      const expectedChecksum = asNonEmptyString(payload.checksum);
      if (expectedChecksum && expectedChecksum !== checksum) {
        throw new LocalClientStoreError(400, "SYNC_BLOB_CHECKSUM_MISMATCH", "Artifact file checksum mismatch.");
      }
      result = await artifactsClient.replaceFileContent(authContext.accessToken, resourceId, {
        filename: asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename),
        mimeType: asNonEmptyString(payload.mimeType),
        contentBase64: compactBase64,
        expectedVersion: optionalPositiveInteger(payload.expectedVersion, "expectedVersion")
      });
      nextResourceId = objectId(result) ?? resourceId;
    } else {
      result = await artifactsClient.updateItem(authContext.accessToken, resourceId, withoutKeys(payload, ["kind"]));
      nextResourceId = objectId(result) ?? resourceId;
    }
  } else {
    if (!resourceId) {
      throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
    }
    await artifactsClient.removeItem(authContext.accessToken, resourceId);
    nextResourceId = resourceId;
    result = { id: resourceId, deleted: true };
  }

  if (!nextResourceId) {
    throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
  }
  const event = await recordSyncEvent(authContext.userId, "artifacts", nextResourceId, action === "upsert" ? "update" : action, {
    source: "sync-push",
    clientOpId,
    localClientId: authContext.localClient?.id,
    ...(action !== "delete" ? { resource: result } : {}),
    ...(action === "delete" ? { deleted: true } : {})
  });
  return {
    index,
    clientOpId,
    domain: "artifacts",
    action: event.action,
    resourceId: nextResourceId,
    version: event.version,
    cursor: event.cursor,
    result
  };
}

function respondDeepResearchError(res: express.Response, error: unknown): express.Response {
  if (error instanceof DeepResearchError) {
    return res.status(error.status).json({
      message: error.message,
      code: error.code
    });
  }

  const message = error instanceof Error ? error.message : "Deep Research request failed";
  return res.status(500).json({
    message,
    code: "DEEP_RESEARCH_INTERNAL_ERROR"
  });
}

type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
type ImageProviderChoice = "auto" | "mock" | "openai" | "nanobanana";
type ImageQualityChoice = "draft" | "standard" | "high";
type ImageSizeChoice = "512x512" | "768x768" | "1024x1024" | "1024x1536" | "1536x1024" | "auto";

const IMAGE_GENERATION_INTEGRATION_ID = "image_generation";

function configString(values: Record<string, string | number | boolean>, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function configBoolean(values: Record<string, string | number | boolean>, key: string): boolean | undefined {
  const value = values[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function pickImageProvider(value: string | undefined): ImageProviderChoice | undefined {
  if (value === "auto" || value === "mock" || value === "openai" || value === "nanobanana") return value;
  return undefined;
}

function pickImageQuality(value: string | undefined): ImageQualityChoice | undefined {
  if (value === "draft" || value === "standard" || value === "high") return value;
  return undefined;
}

function pickImageSize(value: string | undefined): ImageSizeChoice | undefined {
  if (
    value === "512x512" ||
    value === "768x768" ||
    value === "1024x1024" ||
    value === "1024x1536" ||
    value === "1536x1024" ||
    value === "auto"
  ) {
    return value;
  }
  return undefined;
}

async function resolveImageSettings(userId: string): Promise<{
  enabled: boolean;
  defaults: {
    provider: ImageProviderChoice;
    size: ImageSizeChoice;
    quality: ImageQualityChoice;
    count: number;
    saveToArtifacts: boolean;
  };
  providerCredentials: {
    openaiApiKey?: string;
    nanobananaApiKey?: string;
    defaultProvider?: ImageProviderChoice;
    defaultOpenAIModel?: string;
    defaultNanobananaModel?: string;
  };
}> {
  const config = await getIntegrationConfig(userId, IMAGE_GENERATION_INTEGRATION_ID);
  const values = config?.values ?? {};
  const provider = pickImageProvider(configString(values, "defaultProvider")) ?? "auto";
  const size = pickImageSize(configString(values, "defaultSize")) ?? "1024x1024";
  const quality = pickImageQuality(configString(values, "defaultQuality")) ?? "standard";
  const countRaw = Number(configString(values, "defaultCount") ?? "1");
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(8, Math.round(countRaw))) : 1;
  const saveToArtifacts = configBoolean(values, "defaultSaveToArtifacts") ?? false;

  return {
    enabled: config?.enabled ?? true,
    defaults: {
      provider,
      size,
      quality,
      count,
      saveToArtifacts
    },
    providerCredentials: {
      openaiApiKey: configString(values, "openaiApiKey"),
      nanobananaApiKey: configString(values, "nanobananaApiKey"),
      defaultProvider: provider,
      defaultOpenAIModel: configString(values, "defaultOpenAIModel"),
      defaultNanobananaModel: configString(values, "defaultNanobananaModel")
    }
  };
}

function textPreview(raw: unknown, maxLength = 900): string | undefined {
  if (typeof raw !== "string") return undefined;
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxLength ? `${compact.slice(0, maxLength).trim()}...` : compact;
}

async function resolveOneImageContextRef(
  token: string,
  ref: z.infer<typeof imageContextRefSchema>
): Promise<z.infer<typeof imageContextRefSchema>> {
  if (!ref.id || ref.kind === "freeform" || ref.kind === "research") {
    return ref;
  }

  try {
    if (ref.kind === "artifact") {
      const raw = await artifactsClient.getItem(token, ref.id);
      const record = raw as Record<string, unknown>;
      return {
        ...ref,
        title: ref.title ?? (typeof record.title === "string" ? record.title : undefined),
        path: ref.path ?? (typeof record.path === "string" ? record.path : undefined),
        content: ref.content ?? textPreview(record.contentMarkdown)
      };
    }
    if (ref.kind === "note") {
      const raw = await notesClient.get(token, ref.id);
      const record = raw as Record<string, unknown>;
      return {
        ...ref,
        title: ref.title ?? (typeof record.title === "string" ? record.title : undefined),
        content: ref.content ?? textPreview(record.content)
      };
    }
    if (ref.kind === "task") {
      const raw = await tasksClient.get(token, ref.id);
      const record = raw as Record<string, unknown>;
      const notes = typeof record.notes === "string" ? record.notes : undefined;
      const title = typeof record.title === "string" ? record.title : undefined;
      return {
        ...ref,
        title: ref.title ?? title,
        content: ref.content ?? textPreview([title, notes].filter(Boolean).join("\n"))
      };
    }
    if (ref.kind === "project") {
      const raw = await projectsClient.get(token, ref.id);
      const record = raw as Record<string, unknown>;
      return {
        ...ref,
        title: ref.title ?? (typeof record.name === "string" ? record.name : undefined),
        content: ref.content ?? textPreview(record.description)
      };
    }
  } catch {
    return ref;
  }

  return ref;
}

async function buildImageContextSnapshot(
  token: string,
  refs: z.infer<typeof imageContextRefSchema>[] | undefined
): Promise<{ refs: z.infer<typeof imageContextRefSchema>[]; summary?: string } | undefined> {
  if (!refs?.length) {
    return undefined;
  }
  const resolved = await Promise.all(refs.map((ref) => resolveOneImageContextRef(token, ref)));
  const summary = resolved
    .map((ref) => [ref.kind, ref.title, ref.path, ref.content].filter(Boolean).join(": "))
    .filter((line) => line.trim().length > 0)
    .join("\n");
  return {
    refs: resolved,
    summary: summary || undefined
  };
}

function applyImageSettings(
  input: ImageGenerationRequest,
  settings: Awaited<ReturnType<typeof resolveImageSettings>>,
  contextSnapshot?: Awaited<ReturnType<typeof buildImageContextSnapshot>>
): ImageGenerationRequest & {
  contextSnapshot?: Awaited<ReturnType<typeof buildImageContextSnapshot>>;
  providerCredentials: Awaited<ReturnType<typeof resolveImageSettings>>["providerCredentials"];
} {
  return {
    ...input,
    provider: input.provider ?? settings.defaults.provider,
    size: input.size ?? settings.defaults.size,
    quality: input.quality ?? settings.defaults.quality,
    count: input.count ?? settings.defaults.count,
    saveToArtifacts: input.saveToArtifacts ?? settings.defaults.saveToArtifacts,
    contextSnapshot,
    providerCredentials: settings.providerCredentials
  };
}

function slugifyFileName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "generated-image";
}

function splitArtifactPath(pathValue: string | undefined): { directoryPath?: string; filename?: string } {
  const normalized = pathValue?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return {};
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.pop();
  const directoryPath = parts.length > 0 ? parts.join("/") : undefined;
  return { directoryPath, filename };
}

async function saveImageAssetToArtifacts(
  authContext: AuthenticatedContext,
  assetId: string,
  options: {
    artifactTitle?: string;
    artifactPath?: string;
    projectId?: string;
    projectName?: string;
  }
): Promise<unknown> {
  const assetData = await imagesClient.downloadAsset(authContext.accessToken, assetId, false);
  const { directoryPath, filename } = splitArtifactPath(options.artifactPath);
  const extension = assetData.mimeType.includes("jpeg") ? "jpg" : assetData.mimeType.includes("webp") ? "webp" : "png";
  const uploadFilename =
    filename ??
    `${slugifyFileName(options.artifactTitle ?? assetData.fileName.replace(/\.[^.]+$/, ""))}.${extension}`;

  const created = await artifactsClient.uploadFile(authContext.accessToken, {
    projectId: options.projectId,
    projectName: options.projectName,
    directoryPath,
    scope: "project",
    tags: ["image-generation", "generated"],
    filename: uploadFilename,
    mimeType: assetData.mimeType,
    contentBase64: assetData.contentBase64
  });

  const record = created as Record<string, unknown>;
  const artifactItemId = typeof record.id === "string" ? record.id : undefined;
  if (artifactItemId) {
    await imagesClient.attachArtifact(authContext.accessToken, assetId, {
      artifactItemId,
      artifactItemPath: typeof record.path === "string" ? record.path : undefined,
      artifactTitle: typeof record.title === "string" ? record.title : options.artifactTitle,
      projectId: typeof record.projectId === "string" ? record.projectId : options.projectId,
      projectName: typeof record.projectName === "string" ? record.projectName : options.projectName
    });
  }
  return created;
}

async function autoSaveCompletedImageAssets(
  authContext: AuthenticatedContext,
  result: unknown,
  request: ImageGenerationRequest
): Promise<unknown> {
  const record = result as { assets?: Array<{ id?: unknown }> };
  const assetIds = Array.isArray(record.assets)
    ? record.assets.map((asset) => (typeof asset.id === "string" ? asset.id : undefined)).filter((id): id is string => Boolean(id))
    : [];
  if (assetIds.length === 0) {
    return result;
  }

  const artifactRefs: unknown[] = [];
  for (let index = 0; index < assetIds.length; index += 1) {
    const suffix = assetIds.length > 1 ? `-${index + 1}` : "";
    const artifact = await saveImageAssetToArtifacts(authContext, assetIds[index], {
      artifactTitle: request.artifactTitle,
      artifactPath: request.artifactPath ? request.artifactPath.replace(/(\.[^.\/]+)?$/, `${suffix}$1`) : undefined,
      projectId: request.projectId,
      projectName: request.projectName
    });
    artifactRefs.push(artifact);
  }
  return {
    ...(result as Record<string, unknown>),
    artifactRefs
  };
}

async function provisionAccountToServices(userId: string, username: string) {
  const results = await Promise.all(
    serviceTargets.map(async (service) => {
      try {
        const response = await fetch(`${service.baseUrl}/internal/accounts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": service.apiKey
          },
          body: JSON.stringify({ coreUserId: userId, username })
        });

        if (!response.ok) {
          const text = await response.text();
          await upsertProvisioning(userId, service.id, "error", text || `HTTP ${response.status}`);
          return { serviceId: service.id, status: "error" as const, message: text || `HTTP ${response.status}` };
        }

        await upsertProvisioning(userId, service.id, "ok");
        return { serviceId: service.id, status: "ok" as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provisioning failed";
        await upsertProvisioning(userId, service.id, "error", message);
        return { serviceId: service.id, status: "error" as const, message };
      }
    })
  );

  return results;
}

async function ensureImagesAccountProvisioned(authContext: AuthenticatedContext): Promise<void> {
  const service = serviceTargets.find((target) => target.id === "images");
  if (!service) return;

  try {
    const response = await fetch(`${service.baseUrl}/internal/accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": service.apiKey
      },
      body: JSON.stringify({ coreUserId: authContext.userId, username: authContext.username })
    });

    if (!response.ok) {
      const text = await response.text();
      const message = text || `HTTP ${response.status}`;
      await upsertProvisioning(authContext.userId, service.id, "error", message);
      throw new Error(`Images service provisioning failed: ${message}`);
    }

    await upsertProvisioning(authContext.userId, service.id, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Images service provisioning failed";
    await upsertProvisioning(authContext.userId, service.id, "error", message);
    throw error;
  }
}

app.get("/health", (_req, res) => {
  res.json({
    service: "workbench-core",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

function logAuthorizeRequest(params: AuthorizeRequestParams): void {
  console.info("[oauth] authorize request", {
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
  console.warn("[oauth] token exchange failure", { reason, ...details });
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
  console.info("[oauth] authorization server metadata requested", {
    user_agent: req.header("user-agent") || "(missing)",
    issuer
  });
  return res.json({
    issuer,
    authorization_endpoint: joinIssuerPath(issuer, "/authorize"),
    token_endpoint: joinIssuerPath(issuer, "/oauth/token"),
    registration_endpoint: joinIssuerPath(issuer, DYNAMIC_CLIENT_REGISTRATION_PATH),
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
  console.info("[oauth] dynamic client registration request received", {
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
    console.warn("[oauth] dynamic client registration rejected", {
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
    console.info("[oauth] dynamic client registration succeeded", {
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
  console.info("[oauth] token request received", {
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
      console.warn("[oauth] auth code not found or expired", { client_id: clientId, store_size: authorizationCodeStore.size });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    console.info("[oauth] auth code record found", {
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
    console.info("[oauth] authorization_code resource resolution", {
      client_id: clientId,
      token_request_resource_present: tokenRequestResourcePresent,
      used_stored_resource_fallback: usedStoredResourceFallback
    });

    // Validate that the effective resource matches this server's canonical MCP resource.
    const canonicalResource = buildCanonicalMcpResource(req);
    console.info("[oauth] resource check", {
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
    console.info("[oauth] PKCE check", {
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
    console.info("[oauth] token issuance result", {
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
      console.info("[oauth] refresh token issued", {
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

    console.info("[oauth] refresh token grant succeeded", {
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
  return res.json({ user, provisioning, ...tokenBundle });
});

app.post("/auth/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const claims = verifyRefreshToken(parsed.data.refreshToken);
    const user = await findUserById(claims.sub);
    if (!user || user.username !== claims.username) {
      return res.status(401).json({ message: "Invalid refresh token user" });
    }

    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    return res.json({ user, ...tokenBundle });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }
    const message = error instanceof Error ? error.message : "Refresh failed";
    return res.status(401).json({ message });
  }
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
  const enabledIntegrationIds = new Set<string>(serviceTargets.map((service) => service.id));
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

app.get("/api/deep-research/defaults", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const defaults = await getDeepResearchDefaults(authContext.userId);
    return res.json(defaults);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.post("/api/deep-research", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = deepResearchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const result = await runDeepResearch(authContext.userId, authContext.accessToken, parsed.data);
    return res.json(result);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.get("/api/deep-research/jobs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    const result = await listDeepResearchHistory(authContext.userId, Number.isFinite(limit) ? limit : undefined);
    return res.json({ items: result });
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.get("/api/deep-research/jobs/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await getDeepResearchStatus(authContext.userId, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.post("/api/deep-research/jobs/:jobId/cancel", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await cancelDeepResearch(authContext.userId, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.post("/api/deep-research/jobs/:jobId/save", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = deepResearchManualSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const artifact = await saveDeepResearchJobArtifact(
      authContext.userId,
      authContext.accessToken,
      String(req.params.jobId),
      parsed.data
    );
    return res.json({ status: "ok", artifact });
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.get("/api/images/defaults", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const settings = await resolveImageSettings(authContext.userId);
    const serviceDefaults = (await imagesClient.defaults(authContext.accessToken)) as Record<string, unknown>;
    const serviceDefaultValues = (serviceDefaults.defaults as Record<string, unknown> | undefined) ?? {};
    const serviceAvailableModels =
      (serviceDefaults.availableModels as Record<string, Array<{ id?: unknown }>> | undefined) ?? {};
    const firstServiceModel = (providerId: string): string | undefined => {
      const first = serviceAvailableModels[providerId]?.[0]?.id;
      return typeof first === "string" ? first : undefined;
    };
    const configuredServiceModel = (providerId: string, configured: string | undefined): string | undefined => {
      if (!configured) return undefined;
      const options = serviceAvailableModels[providerId] ?? [];
      return options.some((option) => option.id === configured) ? configured : undefined;
    };
    const provider = settings.defaults.provider;
    const model =
      provider === "openai"
        ? configuredServiceModel("openai", settings.providerCredentials.defaultOpenAIModel) ?? firstServiceModel("openai")
        : provider === "nanobanana"
          ? configuredServiceModel("nanobanana", settings.providerCredentials.defaultNanobananaModel) ?? firstServiceModel("nanobanana")
          : typeof serviceDefaultValues.model === "string"
            ? serviceDefaultValues.model
            : "workbench-mock-image";

    return res.json({
      ...serviceDefaults,
      enabled: settings.enabled,
      defaults: {
        ...serviceDefaultValues,
        provider,
        model,
        size: settings.defaults.size,
        quality: settings.defaults.quality,
        count: settings.defaults.count,
        saveToArtifacts: settings.defaults.saveToArtifacts
      },
      availableProviders: {
        mock: true,
        openai: Boolean(settings.providerCredentials.openaiApiKey),
        nanobanana: Boolean(settings.providerCredentials.nanobananaApiKey)
      }
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/references", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const target = `${serviceBaseUrls.images}/images/references`;
  const contentType = req.header("content-type");
  try {
    await ensureImagesAccountProvisioned(authContext);
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) res.setHeader("Content-Type", responseContentType);
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reference upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.post("/api/images/generations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = imageGenerationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureImagesAccountProvisioned(authContext);
    const settings = await resolveImageSettings(authContext.userId);
    if (!settings.enabled) {
      return res.status(400).json({ message: "Image Generation is disabled in Settings.", code: "IMAGE_GENERATION_DISABLED" });
    }
    const contextSnapshot = await buildImageContextSnapshot(authContext.accessToken, parsed.data.contextRefs);
    const payload = applyImageSettings(parsed.data, settings, contextSnapshot);
    const generated = await imagesClient.generate(authContext.accessToken, payload);
    const result = payload.saveToArtifacts
      ? await autoSaveCompletedImageAssets(authContext, generated, payload)
      : generated;
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/generations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.list(authContext.accessToken, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/generations/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.getJob(authContext.accessToken, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/generations/:jobId/cancel", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.cancel(authContext.accessToken, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/images/generations/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    await imagesClient.deleteJob(authContext.accessToken, String(req.params.jobId));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/generations/:jobId/retry", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = imageRetryRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureImagesAccountProvisioned(authContext);
    const settings = await resolveImageSettings(authContext.userId);
    if (!settings.enabled) {
      return res.status(400).json({ message: "Image Generation is disabled in Settings.", code: "IMAGE_GENERATION_DISABLED" });
    }
    const contextSnapshot = await buildImageContextSnapshot(authContext.accessToken, parsed.data.contextRefs);
    const payload = applyImageSettings(parsed.data as ImageGenerationRequest, settings, contextSnapshot);
    const generated = await imagesClient.retry(authContext.accessToken, String(req.params.jobId), payload);
    const result = payload.saveToArtifacts
      ? await autoSaveCompletedImageAssets(authContext, generated, payload)
      : generated;
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/assets/:assetId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const result = await imagesClient.getAsset(authContext.accessToken, String(req.params.assetId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/images/assets/:assetId/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const assetId = encodeURIComponent(String(req.params.assetId));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") query.set("download", req.query.download);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.images}/images/assets/${assetId}/download${suffix}`;

  try {
    await ensureImagesAccountProvisioned(authContext);
    const upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${authContext.accessToken}` }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image download proxy failed";
    return res.status(502).json({ message });
  }
});

app.delete("/api/images/assets/:assetId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureImagesAccountProvisioned(authContext);
    await imagesClient.deleteAsset(authContext.accessToken, String(req.params.assetId));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/images/assets/:assetId/artifact", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = imageArtifactSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureImagesAccountProvisioned(authContext);
    const artifact = await saveImageAssetToArtifacts(authContext, String(req.params.assetId), parsed.data);
    return res.status(201).json({ status: "ok", artifact });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// Local clients and daemon-pulled jobs
app.post("/api/local-clients/register", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = localClientRegisterSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const result = await registerLocalClient(authContext.userId, parsed.data);
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-clients", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const includeArchived = queryFlagEnabled(req.query.includeArchived);

  try {
    const clients = await listLocalClients(authContext.userId, { includeArchived });
    return res.json({ items: clients });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-clients/audit-events", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const localClientId = typeof req.query.localClientId === "string" ? req.query.localClientId : undefined;

  try {
    const events = await listLocalClientAuditEventsForUser(authContext.userId, {
      localClientId,
      limit: Number.isFinite(limit) ? limit : undefined
    });
    return res.json({ items: events });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/local-clients/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = localClientPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const client = await updateLocalClient(authContext.userId, String(req.params.id), parsed.data);
    if (!client) {
      return res.status(404).json({ message: "Local client not found" });
    }
    return res.json(client);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-clients/:id/revoke", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const revoked = await revokeLocalClientTokens(authContext.userId, String(req.params.id));
    if (!revoked) {
      return res.status(404).json({ message: "Local client not found or no active token exists" });
    }
    const client = await updateLocalClient(authContext.userId, String(req.params.id), { enabled: false });
    return res.json({ revoked: true, client });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-clients/:id/archive", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const client = await archiveLocalClient(authContext.userId, String(req.params.id));
    if (!client) {
      return res.status(404).json({ message: "Local client not found" });
    }
    return res.json(client);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/local-clients/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const deleted = await deleteLocalClient(authContext.userId, String(req.params.id));
    if (!deleted) {
      return res.status(404).json({ message: "Local client not found" });
    }
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-clients/:id/heartbeat", async (req, res) => {
  const localContext = await requireLocalClientContext(req, res);
  if (!localContext) return;
  if (localContext.client.id !== String(req.params.id)) {
    return res.status(403).json({ message: "Local client credentials do not match route client id" });
  }

  const parsed = localClientHeartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const client = await recordLocalClientHeartbeat(localContext.client, parsed.data);
    return res.json(client);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-jobs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const parsedStatus = status ? localJobStatusSchema.safeParse(status) : undefined;
  if (parsedStatus && !parsedStatus.success) {
    return res.status(400).json({ message: parsedStatus.error.flatten() });
  }
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const localClientId = typeof req.query.localClientId === "string" ? req.query.localClientId : undefined;
  const includeLocalPaths = queryFlagEnabled(req.query.includeLocalPaths);

  try {
    const jobs = await listLocalJobsForUser(authContext.userId, {
      localClientId,
      status: parsedStatus?.success ? (parsedStatus.data as LocalJobStatus) : undefined,
      limit: Number.isFinite(limit) ? limit : undefined
    });
    return res.json({ items: serializeLocalJobsForOwner(jobs, { includeLocalPaths }) });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = localJobCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const job = await createLocalJob(authContext.userId, {
      localClientId: parsed.data.localClientId,
      idempotencyKey: parsed.data.idempotencyKey,
      kind: parsed.data.kind as LocalJobKind,
      target: parsed.data.target as LocalJobTarget,
      payload: parsed.data.payload,
      ttlSeconds: parsed.data.ttlSeconds
    });
    return res.status(201).json(job);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-jobs/:jobId/events", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const job = await getLocalJob(authContext.userId, String(req.params.jobId));
    if (!job) {
      return res.status(404).json({ message: "Local job not found" });
    }
    const events = await listLocalJobEventsForUser(
      authContext.userId,
      String(req.params.jobId),
      Number.isFinite(limit) ? limit : undefined
    );
    return res.json({ items: events });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-jobs/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const includeLocalPaths = queryFlagEnabled(req.query.includeLocalPaths);

  try {
    const job = await getLocalJob(authContext.userId, String(req.params.jobId));
    if (!job) {
      return res.status(404).json({ message: "Local job not found" });
    }
    return res.json(serializeLocalJobForOwner(job, { includeLocalPaths }));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs/claim", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.claim");
  if (!localContext) return;

  const parsed = localJobClaimSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    await recordLocalClientHeartbeat(localContext.client, {
      syncRootState: { claiming: true }
    });
    const jobs = await claimLocalJobsForClient(localContext.client.id, parsed.data.limit ?? 5);
    return res.json({ items: jobs });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs/:jobId/complete", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.claim");
  if (!localContext) return;

  const parsed = localJobCompleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const job = await completeLocalJobForClient(localContext.client.id, String(req.params.jobId), parsed.data.result);
    if (!job) {
      return res.status(404).json({ message: "Local job not found or already terminal" });
    }
    return res.json(job);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-jobs/:jobId/fail", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.claim");
  if (!localContext) return;

  const parsed = localJobFailSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const job = await failLocalJobForClient(localContext.client.id, String(req.params.jobId), parsed.data.error, {
      retryable: parsed.data.retryable,
      retryAfterSeconds: parsed.data.retryAfterSeconds
    });
    if (!job) {
      return res.status(404).json({ message: "Local job not found or already terminal" });
    }
    return res.json(job);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-jobs/:jobId/download", async (req, res) => {
  const localContext = await requireLocalClientCapability(req, res, "local_jobs.download");
  if (!localContext) return;

  try {
    const job = await getLocalJobForClient(localContext.client.id, String(req.params.jobId));
    if (!job) {
      return res.status(404).json({ message: "Local job not found" });
    }
    if (job.status !== "running" && job.status !== "completed") {
      return res.status(409).json({ message: "Local job must be claimed before download" });
    }

    const user = await findUserById(job.userId);
    if (!user) {
      return res.status(404).json({ message: "Job owner not found" });
    }
    const bundle = issueTokenBundle({ userId: user.id, username: user.username });
    let targetUrl: string | undefined;

    if (job.kind === "download_artifact" || (job.kind === "materialize_resource" && job.payload.domain === "artifacts")) {
      const artifactItemId = typeof job.payload.artifactItemId === "string"
        ? job.payload.artifactItemId
        : typeof job.payload.id === "string"
          ? job.payload.id
          : undefined;
      if (!artifactItemId) {
        return res.status(400).json({ message: "Job payload is missing artifactItemId" });
      }
      targetUrl = `${serviceBaseUrls.artifacts}/artifacts/items/${encodeURIComponent(artifactItemId)}/download?download=1`;
    }

    if (job.kind === "download_task_attachment") {
      const taskId = typeof job.payload.taskId === "string" ? job.payload.taskId : undefined;
      const attachmentId = typeof job.payload.attachmentId === "string" ? job.payload.attachmentId : undefined;
      if (!taskId || !attachmentId) {
        return res.status(400).json({ message: "Job payload is missing taskId or attachmentId" });
      }
      targetUrl = `${serviceBaseUrls.tasks}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download?download=1`;
    }

    if (!targetUrl) {
      return res.status(400).json({ message: `Unsupported local job kind for download: ${job.kind}` });
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${bundle.accessToken}`
      }
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);
    if (upstream.ok) res.setHeader("X-Workbench-Content-Checksum", sha256Checksum(buffer));
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/snapshot", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.pull");
  if (!authContext) return;

  const requestedDomains = typeof req.query.domains === "string"
    ? req.query.domains.split(",").map((value) => value.trim()).filter(Boolean)
    : ["projects", "notes", "artifacts", "tasks"];
  const domainSet = new Set(requestedDomains);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const snapshotLimit = Number.isFinite(limit) ? limit : undefined;

  try {
    const snapshot: Record<string, unknown> = {};
    if (domainSet.has("projects")) {
      snapshot.projects = await projectsClient.list(authContext.accessToken, undefined, undefined, snapshotLimit ?? 100, cursor);
    }
    if (domainSet.has("notes")) {
      snapshot.notes = await notesClient.listPage(authContext.accessToken, undefined, snapshotLimit ?? 100, cursor);
    }
    if (domainSet.has("artifacts")) {
      snapshot.artifacts = await artifactsClient.treeListPage(authContext.accessToken, {
        limit: snapshotLimit ?? 500,
        cursor
      });
    }
    if (domainSet.has("tasks")) {
      snapshot.tasks = await tasksClient.listPage(authContext.accessToken, undefined, undefined, snapshotLimit ?? 100, cursor);
    }
    return res.json({
      generatedAt: new Date().toISOString(),
      domains: snapshot
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/pull", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.pull");
  if (!authContext) return;

  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;

  try {
    const result = await listSyncEvents(authContext.userId, cursor, Number.isFinite(limit) ? limit : 100);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/blobs/:blobId", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.blobs.read");
  if (!authContext) return;

  const blobId = String(req.params.blobId);
  let targetUrl: string | undefined;
  if (blobId.startsWith("artifact:")) {
    const id = blobId.slice("artifact:".length);
    targetUrl = `${serviceBaseUrls.artifacts}/artifacts/items/${encodeURIComponent(id)}/download?download=1`;
  } else if (blobId.startsWith("task-attachment:")) {
    const [, taskId, attachmentId] = blobId.split(":");
    if (taskId && attachmentId) {
      targetUrl = `${serviceBaseUrls.tasks}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download?download=1`;
    }
  }

  if (!targetUrl) {
    return res.status(404).json({ message: "Unsupported sync blob id" });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      }
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);
    if (upstream.ok) res.setHeader("X-Workbench-Content-Checksum", sha256Checksum(buffer));
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/sync/blobs/:blobId", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.blobs.write");
  if (!authContext) return;

  const parsed = syncBlobPutSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const blobId = String(req.params.blobId);
  try {
    if (blobId.startsWith("task-attachment:")) {
      const [, taskId, attachmentId] = blobId.split(":");
      if (!taskId || !attachmentId) {
        return res.status(400).json({ message: "Task attachment blob id must be task-attachment:<taskId>:<attachmentId>" });
      }
      await assertSyncBaseVersion(authContext, "tasks", taskId, { baseVersion: parsed.data.baseVersion });
      const { compactBase64, buffer } = decodeContentBase64(parsed.data.contentBase64);
      const checksum = sha256Checksum(buffer);
      if (parsed.data.checksum && parsed.data.checksum !== checksum) {
        return res.status(400).json({
          message: "Blob checksum mismatch",
          code: "SYNC_BLOB_CHECKSUM_MISMATCH",
          expected: parsed.data.checksum,
          actual: checksum
        });
      }

      const result = await tasksClient.replaceAttachment(authContext.accessToken, taskId, attachmentId, {
        filename: parsed.data.filename,
        mimeType: parsed.data.mimeType,
        contentBase64: compactBase64
      });
      const event = await recordSyncEvent(authContext.userId, "tasks", taskId, "update", {
        source: "sync-blob-put",
        blobId,
        localClientId: authContext.localClient?.id,
        relation: "attachment",
        attachmentId,
        checksum,
        sizeBytes: buffer.length
      });

      return res.json({
        blobId,
        domain: "tasks",
        resourceId: taskId,
        attachmentId,
        sizeBytes: buffer.length,
        checksum,
        version: event.version,
        cursor: event.cursor,
        result
      });
    }

    if (!blobId.startsWith("artifact:")) {
      return res.status(404).json({ message: "Unsupported sync blob id" });
    }

    const resourceId = blobId.slice("artifact:".length).trim();
    if (!resourceId) {
      return res.status(400).json({ message: "Artifact blob id is missing a resource id" });
    }

    await assertSyncBaseVersion(authContext, "artifacts", resourceId, { baseVersion: parsed.data.baseVersion });
    const { compactBase64, buffer } = decodeContentBase64(parsed.data.contentBase64);
    const checksum = sha256Checksum(buffer);
    if (parsed.data.checksum && parsed.data.checksum !== checksum) {
      return res.status(400).json({
        message: "Blob checksum mismatch",
        code: "SYNC_BLOB_CHECKSUM_MISMATCH",
        expected: parsed.data.checksum,
        actual: checksum
      });
    }

    const result = await artifactsClient.replaceFileContent(authContext.accessToken, resourceId, {
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      contentBase64: compactBase64,
      expectedVersion: parsed.data.expectedVersion
    });
    const event = await recordSyncEvent(authContext.userId, "artifacts", resourceId, "update", {
      source: "sync-blob-put",
      blobId,
      localClientId: authContext.localClient?.id,
      checksum,
      sizeBytes: buffer.length
    });

    return res.json({
      blobId,
      domain: "artifacts",
      resourceId,
      sizeBytes: buffer.length,
      checksum,
      version: event.version,
      cursor: event.cursor,
      result
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/sync/push", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.push");
  if (!authContext) return;

  const parsed = syncPushSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const applied: SyncPushApplied[] = [];
  const rejected: SyncPushRejected[] = [];
  for (const [index, op] of parsed.data.ops.entries()) {
    const clientOpId = asNonEmptyString(op.clientOpId);
    try {
      applied.push(await applySyncPushOperation(authContext, op, index));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync push operation failed";
      rejected.push({
        index,
        clientOpId,
        op,
        code: error instanceof LocalClientStoreError ? error.code : "SYNC_PUSH_OPERATION_FAILED",
        message
      });
    }
  }

  return res.status(rejected.length > 0 && applied.length === 0 ? 409 : 202).json({
    applied,
    rejected,
    serverCursor: applied.length > 0 ? applied[applied.length - 1].cursor : undefined
  });
});

// External facade for projects
app.get("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  try {
    const result = await projectsClient.list(
      authContext.accessToken,
      query,
      status,
      Number.isFinite(limit) ? limit : undefined,
      cursor
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.create(authContext.accessToken, req.body);
    recordSyncEventBestEffort(authContext.userId, "projects", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.getDefault(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.setDefault(authContext.accessToken, req.body);
    const body = asJsonRecord(req.body);
    const projectId = asNonEmptyString(body.projectId) ?? objectId(result);
    recordSyncEventBestEffort(authContext.userId, "projects", projectId, "update", {
      source: "core-api",
      relation: "default",
      projectId,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.get(authContext.accessToken, String(req.params.projectId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.update(authContext.accessToken, String(req.params.projectId), req.body);
    recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await projectsClient.remove(authContext.accessToken, String(req.params.projectId));
    recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for notes
app.get("/api/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await notesClient.list(authContext.accessToken, projectId, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/notes/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/notes/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.create(authContext.accessToken, req.body);
    recordSyncEventBestEffort(authContext.userId, "notes", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/notes/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.update(authContext.accessToken, String(req.params.id), req.body);
    recordSyncEventBestEffort(authContext.userId, "notes", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await notesClient.remove(authContext.accessToken, String(req.params.id));
    recordSyncEventBestEffort(authContext.userId, "notes", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for artifacts
app.get("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await artifactsClient.list(authContext.accessToken, projectId, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/tree", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

  try {
    const result = await artifactsClient.tree(authContext.accessToken, projectId);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/tree/list", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const pathPrefix = typeof req.query.pathPrefix === "string" ? req.query.pathPrefix : undefined;
  const kinds = typeof req.query.kinds === "string" ? req.query.kinds.split(",").map((kind) => kind.trim()) : undefined;
  const includeContent = typeof req.query.includeContent === "string" ? ["1", "true", "yes"].includes(req.query.includeContent.toLowerCase()) : undefined;
  const updatedSince = typeof req.query.updatedSince === "string" ? req.query.updatedSince : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await artifactsClient.treeList(authContext.accessToken, {
      projectId,
      pathPrefix,
      kinds,
      includeContent,
      updatedSince,
      limit: Number.isFinite(limit) ? limit : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.getItem(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/folders", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.createFolder(authContext.accessToken, req.body);
    recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.createNote(authContext.accessToken, req.body);
    recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/upload", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const target = `${serviceBaseUrls.artifacts}/artifacts/upload`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) {
      res.setHeader("Content-Type", responseContentType);
    }

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.patch("/api/artifacts/items/:id/content-patch", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.patchNoteContent(authContext.accessToken, String(req.params.id), req.body);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/items/:id/section", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.updateNoteSection(authContext.accessToken, String(req.params.id), req.body);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.updateItem(authContext.accessToken, String(req.params.id), req.body);
    recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await artifactsClient.removeItem(authContext.accessToken, String(req.params.id));
    recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const id = encodeURIComponent(String(req.params.id));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") {
    query.set("download", req.query.download);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.artifacts}/artifacts/items/${id}/download${suffix}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/artifacts/items/:id/preview-pdf", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const id = encodeURIComponent(String(req.params.id));
  const target = `${serviceBaseUrls.artifacts}/artifacts/items/${id}/preview-pdf`;

  try {
    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preview proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.create(authContext.accessToken, req.body);
    recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.update(authContext.accessToken, String(req.params.id), req.body);
    recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await artifactsClient.remove(authContext.accessToken, String(req.params.id));
    recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for tasks
app.get("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const context = typeof req.query.context === "string" ? req.query.context : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await tasksClient.list(authContext.accessToken, context, status, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/pins", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.pins(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/tasks/:id/pin", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : undefined;
  if (pinned === undefined) {
    return res.status(400).json({ message: "pinned(boolean) is required" });
  }

  try {
    const result = await tasksClient.setPin(authContext.accessToken, String(req.params.id), pinned);
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "pin",
      pinned,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/schedule", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  const context = typeof req.query.context === "string" ? req.query.context : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;

  if (!startDate || !endDate) {
    return res.status(400).json({ message: "startDate and endDate are required" });
  }

  try {
    const result = await tasksClient.schedule(authContext.accessToken, startDate, endDate, context, status);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/complete", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  const status = typeof req.body?.status === "string" ? req.body.status : undefined;
  if (!targetDate || !status) {
    return res.status(400).json({ message: "targetDate and status are required" });
  }

  try {
    const result = await tasksClient.completeOccurrence(authContext.accessToken, String(req.params.id), targetDate, status);
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      targetDate,
      status,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/move", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const sourceDate = typeof req.body?.sourceDate === "string" ? req.body.sourceDate : undefined;
  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  if (!sourceDate || !targetDate) {
    return res.status(400).json({ message: "sourceDate and targetDate are required" });
  }

  try {
    const result = await tasksClient.moveOccurrence(authContext.accessToken, String(req.params.id), sourceDate, targetDate);
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      operation: "move",
      sourceDate,
      targetDate,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/skip-exception", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  if (!targetDate) {
    return res.status(400).json({ message: "targetDate is required" });
  }

  try {
    const result = await tasksClient.skipOccurrenceException(authContext.accessToken, String(req.params.id), targetDate);
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      operation: "skipException",
      targetDate,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── These literal-path GET routes MUST come before GET /api/tasks/:id ──────

app.get("/api/tasks/export", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const csv = await tasksClient.exportCsv(authContext.accessToken);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="tasks.csv"');
    return res.send(csv);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// GET /api/tasks/today?date=YYYY-MM-DD → TodayTask[] (task + occurrenceDate)
app.get("/api/tasks/today", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  console.log(`[workbench-core] GET /api/tasks/today  date=${date ?? "?"}`);
  if (!date) return res.status(400).json({ message: "date query parameter is required (YYYY-MM-DD)" });
  try {
    const result = await tasksClient.today(authContext.accessToken, date);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// GET /api/tasks/schedule-calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns ScheduleCalendarDay[] grouped by scheduled_date.
// NOTE: Must be registered before GET /api/tasks/:id to prevent Express from
//       matching "schedule-calendar" as a task ID.
app.get("/api/tasks/schedule-calendar", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  console.log(`[workbench-core] GET /api/tasks/schedule-calendar  ${startDate}→${endDate}`);
  if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate query parameters are required" });
  try {
    const result = await tasksClient.scheduleCalendar(authContext.accessToken, startDate, endDate);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id/history", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.history(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id/schedule-items", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.listScheduleItemsForTask(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.create(authContext.accessToken, req.body);
    recordSyncEventBestEffort(authContext.userId, "tasks", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.update(authContext.accessToken, String(req.params.id), req.body);
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await tasksClient.remove(authContext.accessToken, String(req.params.id));
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/import", express.text({ type: "text/csv", limit: "10mb" }), async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = taskImportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  const csvContent = typeof parsed.data === "string" ? parsed.data : parsed.data.csv;
  if (!csvContent.trim()) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  try {
    const result = await tasksClient.importCsv(authContext.accessToken, csvContent);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Attachments ────────────────────────────────────────────────────────

app.get("/api/tasks/:id/attachments", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.listAttachments(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/attachments", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) res.setHeader("Content-Type", responseContentType);
    if (upstream.ok) {
      const attachment = responseContentType?.includes("application/json")
        ? jsonRecordFromBuffer(buffer)
        : {};
      recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
        source: "core-api",
        relation: "attachment",
        action: "create",
        attachment
      });
    }
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.put("/api/tasks/:id/attachments/:attachmentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const attachmentId = encodeURIComponent(String(req.params.attachmentId));
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments/${attachmentId}`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) res.setHeader("Content-Type", responseContentType);
    if (upstream.ok) {
      const attachment = responseContentType?.includes("application/json")
        ? jsonRecordFromBuffer(buffer)
        : {};
      recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
        source: "core-api",
        relation: "attachment",
        action: "update",
        attachmentId: String(req.params.attachmentId),
        attachment
      });
    }
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment replacement proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/tasks/:id/attachments/:attachmentId/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const attachmentId = encodeURIComponent(String(req.params.attachmentId));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") query.set("download", req.query.download);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments/${attachmentId}/download${suffix}`;

  try {
    const upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${authContext.accessToken}` }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download proxy failed";
    return res.status(502).json({ message });
  }
});

app.delete("/api/tasks/:id/attachments/:attachmentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await tasksClient.deleteAttachment(authContext.accessToken, String(req.params.id), String(req.params.attachmentId));
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "attachment",
      action: "delete",
      attachmentId: String(req.params.attachmentId),
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Subtasks ────────────────────────────────────────────────────────────

app.get("/api/tasks/:id/occurrences/:date/subtasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.listSubtasks(authContext.accessToken, String(req.params.id), String(req.params.date));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/:date/subtasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.createSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      req.body?.title
    );
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "create",
      occurrenceDate: String(req.params.date),
      subtaskId: objectId(result),
      subtask: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/tasks/:id/occurrences/:date/subtasks/:subtaskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.updateSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      String(req.params.subtaskId),
      req.body
    );
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "update",
      occurrenceDate: String(req.params.date),
      subtaskId: String(req.params.subtaskId),
      patch: req.body as Record<string, unknown>,
      subtask: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/:id/occurrences/:date/subtasks/:subtaskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await tasksClient.deleteSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      String(req.params.subtaskId)
    );
    recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "delete",
      occurrenceDate: String(req.params.date),
      subtaskId: String(req.params.subtaskId),
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Today ("My Day") and Schedule ──────────────────────────────────────
// NOTE: GET /api/tasks/today is registered before GET /api/tasks/:id (above).
// Only POST, DELETE, schedule-calendar, and schedule-items remain here.

// POST /api/tasks/today — add a schedule item (= "add to My Day")
// Body: { taskId: string, scheduledDate: string, occurrenceDate: string, startTime?, endTime?, timezone? }
// scheduledDate  = calendar date to work on the task (today when called from My Day button)
// occurrenceDate = LBS execution date (may differ for Overdue/Planned tasks)
app.post("/api/tasks/today", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  console.log(`[workbench-core] POST /api/tasks/today  body=${JSON.stringify(req.body)}`);
  try {
    const { taskId, scheduledDate, occurrenceDate, startTime, endTime, timezone } = req.body as {
      taskId?: unknown; scheduledDate?: unknown; occurrenceDate?: unknown;
      startTime?: unknown; endTime?: unknown; timezone?: unknown;
    };
    // occurrenceDate may be "" for tasks with no LBS due date (ONCE + no due_date);
    // the tasks-service will fall back to scheduledDate in that case.
    if (typeof taskId !== "string" || !taskId || typeof scheduledDate !== "string" || !scheduledDate || typeof occurrenceDate !== "string") {
      return res.status(400).json({ message: "taskId, scheduledDate, and occurrenceDate (all strings) are required" });
    }
    const opts = {
      startTime: typeof startTime === "string" ? startTime : undefined,
      endTime: typeof endTime === "string" ? endTime : undefined,
      timezone: typeof timezone === "string" ? timezone : undefined
    };
    const result = await tasksClient.addToday(authContext.accessToken, taskId, scheduledDate, occurrenceDate, opts);
    recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "today",
      action: "create",
      scheduledDate,
      occurrenceDate,
      startTime: opts.startTime,
      endTime: opts.endTime,
      timezone: opts.timezone,
      scheduleItem: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// DELETE /api/tasks/today/:taskId?scheduledDate=YYYY-MM-DD — remove from Today
app.delete("/api/tasks/today/:taskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const taskId = String(req.params.taskId);
  const scheduledDate = typeof req.query.scheduledDate === "string" ? req.query.scheduledDate : undefined;
  console.log(`[workbench-core] DELETE /api/tasks/today/${taskId}  scheduledDate=${scheduledDate ?? "?"}`);
  if (!scheduledDate) return res.status(400).json({ message: "scheduledDate query parameter is required (YYYY-MM-DD)" });
  try {
    const result = await tasksClient.removeFromToday(authContext.accessToken, taskId, scheduledDate);
    recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "today",
      action: "delete",
      scheduledDate,
      deleted: true,
      result: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// PUT /api/tasks/schedule-items/:id — update a schedule item's time/date fields
app.put("/api/tasks/schedule-items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const scheduleId = parseInt(req.params.id, 10);
  console.log(`[workbench-core] PUT /api/tasks/schedule-items/${scheduleId}  body=${JSON.stringify(req.body)}`);
  if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
  try {
    const patch = req.body as { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null };
    const result = await tasksClient.updateScheduleItem(authContext.accessToken, scheduleId, patch);
    if (!result) return res.status(404).json({ message: "Schedule item not found" });
    recordSyncEventBestEffort(authContext.userId, "tasks", result.taskId, "update", {
      source: "core-api",
      relation: "scheduleItem",
      action: "update",
      scheduleId,
      patch: patch as Record<string, unknown>,
      scheduleItem: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/schedule-items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const scheduleId = parseInt(req.params.id, 10);
  if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
  try {
    const body = asJsonRecord(req.body);
    const taskId = asNonEmptyString(body.taskId) ?? (typeof req.query.taskId === "string" ? req.query.taskId.trim() : undefined);
    const scheduledDate = asNonEmptyString(body.scheduledDate) ?? (typeof req.query.scheduledDate === "string" ? req.query.scheduledDate.trim() : undefined);
    const occurrenceDate = asNonEmptyString(body.occurrenceDate) ?? (typeof req.query.occurrenceDate === "string" ? req.query.occurrenceDate.trim() : undefined);
    await tasksClient.deleteScheduleItem(authContext.accessToken, scheduleId);
    recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "scheduleItem",
      action: "delete",
      scheduleId,
      scheduledDate,
      occurrenceDate,
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ---------------------------------------------------------------------------
// MCP HTTP endpoint (Streamable HTTP transport, stateless)
// Requires Bearer token authentication. Tools are accessible at POST /mcp.
// ---------------------------------------------------------------------------

type McpInjectedContext = {
  accessToken: string;
};

function createMcpServerInstance(injectedContext: McpInjectedContext): McpServer {
  const server = new McpServer({ name: "workbench-core-mcp", version: "0.2.0" });
  registerNotesTools(server, injectedContext);
  registerArtifactsTools(server, injectedContext);
  registerTasksTools(server, injectedContext);
  registerProjectsTools(server, injectedContext);
  registerDeepResearchTools(server, injectedContext);
  registerImageTools(server, injectedContext);
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
  injectedContext = { accessToken: bundle.accessToken };
  console.info("[mcp] user context injected", { username: user.username });

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
  app.listen(port, host, () => {
    console.log(`Workbench Core HTTP listening on ${host}:${port}`);
    console.log(`MCP HTTP endpoint available at POST http://${host}:${port}/mcp`);
    if (canonicalBaseConfig) {
      console.log(`Canonical external OAuth base configured as ${canonicalBaseConfig.issuer}`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void startHttpServer();
}
