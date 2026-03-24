import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { issueTokenBundle, verifyAccessToken, verifyRefreshToken } from "./auth.js";
import { ensureCoreSchema } from "./db.js";
import { getIntegrationManifests, type IntegrationManifestId } from "./integrations/index.js";
import { registerArtifactsTools } from "./mcp/registerArtifactsTools.js";
import { registerDeepResearchTools } from "./mcp/registerDeepResearchTools.js";
import { registerNotesTools } from "./mcp/registerNotesTools.js";
import { registerProjectsTools } from "./mcp/registerProjectsTools.js";
import { registerTasksTools } from "./mcp/registerTasksTools.js";
import { ensureIntegrationLinked } from "./integrationLinking.js";
import { artifactsClient, InternalServiceError, notesClient, projectsClient, serviceBaseUrls, tasksClient } from "./internalClients.js";
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

type RegisteredOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: OAuthGrantType[];
  responseTypes: "code"[];
  source: "dynamic_client_registration";
  createdAtMs: number;
};

const dynamicallyRegisteredClients = new Map<string, RegisteredOAuthClient>();

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

function resolveClientFromDynamicRegistration(clientId: string): ResolvedOAuthClient | undefined {
  const registered = dynamicallyRegisteredClients.get(clientId);
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
    source: registered.source
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
    const dynamicallyRegisteredClient = resolveClientFromDynamicRegistration(clientId);
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

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

type ServiceTarget = {
  id: IntegrationManifestId;
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
  projectName: z.string().optional()
});

type AuthenticatedContext = {
  userId: string;
  username: string;
  accessToken: string;
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

function respondInternalError(res: express.Response, error: unknown): express.Response {
  if (error instanceof InternalServiceError) {
    if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 400) {
      return res.status(error.status).json({ message: error.body || error.message });
    }
    return res.status(502).json({ message: `[${error.service}] ${error.body || error.message}` });
  }

  const message = error instanceof Error ? error.message : "Unexpected internal error";
  return res.status(500).json({ message });
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

app.post(DYNAMIC_CLIENT_REGISTRATION_PATH, (req, res) => {
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

  const clientId = `workbench_dcr_${randomBytes(16).toString("hex")}`;
  const registeredClient: RegisteredOAuthClient = {
    clientId,
    clientName: parsed.clientName,
    redirectUris: parsed.redirectUris,
    tokenEndpointAuthMethod: parsed.tokenEndpointAuthMethod,
    grantTypes: parsed.grantTypes,
    responseTypes: parsed.responseTypes,
    source: "dynamic_client_registration",
    createdAtMs: Date.now()
  };
  dynamicallyRegisteredClients.set(clientId, registeredClient);
  console.info("[oauth] dynamic client registration succeeded", {
    client_id: registeredClient.clientId,
    client_name: registeredClient.clientName,
    redirect_uris_count: registeredClient.redirectUris.length
  });

  return res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(registeredClient.createdAtMs / 1000),
    client_name: registeredClient.clientName,
    redirect_uris: registeredClient.redirectUris,
    token_endpoint_auth_method: parsed.tokenEndpointAuthMethod,
    grant_types: parsed.grantTypes,
    response_types: parsed.responseTypes
  });
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
  const enabledIntegrationIds = new Set(serviceTargets.map((service) => service.id));
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

app.patch("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.updateItem(authContext.accessToken, String(req.params.id), req.body);
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
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

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

// ---------------------------------------------------------------------------

const port = Number(requireEnv("CORE_SERVICE_PORT"));
const host = requireEnv("CORE_SERVICE_HOST");
if (!Number.isFinite(port)) {
  throw new Error(`Invalid CORE_SERVICE_PORT value: ${process.env.CORE_SERVICE_PORT}`);
}

void ensureCoreSchema().then(() => {
  app.listen(port, host, () => {
    console.log(`Workbench Core HTTP listening on ${host}:${port}`);
    console.log(`MCP HTTP endpoint available at POST http://${host}:${port}/mcp`);
    if (canonicalBaseConfig) {
      console.log(`Canonical external OAuth base configured as ${canonicalBaseConfig.issuer}`);
    }
  });
});
