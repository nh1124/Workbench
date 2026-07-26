import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { logger } from "../logger.js";
import { getOAuthDynamicClient } from "../oauthDynamicClientsStore.js";
import {
  clientMetadataCacheTtlMs,
  clientMetadataFetchTimeoutMs,
  clientMetadataHostAllowlist,
  clientMetadataMaxResponseBytes
} from "./config.js";

export type OAuthClientSource = "client_id_metadata_document" | "dynamic_client_registration";
export type OAuthGrantType = "authorization_code" | "refresh_token";

export type ResolvedOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: OAuthGrantType[];
  responseTypes: "code"[];
  source: OAuthClientSource;
};

export type ClientMetadataCacheRecord = {
  client: ResolvedOAuthClient;
  expiresAtMs: number;
};

export const clientMetadataCache = new Map<string, ClientMetadataCacheRecord>();
export const CLIENT_METADATA_CACHE_MAX_ENTRIES = 500;

/**
 * Drops expired records and, if still over capacity, the oldest insertions.
 * Entries are only evicted lazily on re-request, so distinct client IDs would
 * otherwise grow the cache without bound.
 */
export function pruneClientMetadataCache(nowMs = Date.now()): void {
  for (const [key, record] of clientMetadataCache) {
    if (record.expiresAtMs <= nowMs) clientMetadataCache.delete(key);
  }
  // Map preserves insertion order, so the leading keys are the oldest.
  for (const key of clientMetadataCache.keys()) {
    if (clientMetadataCache.size <= CLIENT_METADATA_CACHE_MAX_ENTRIES) break;
    clientMetadataCache.delete(key);
  }
}

export function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local");
}

export function isPrivateOrReservedIp(address: string): boolean {
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

export async function assertSafeClientMetadataUrl(url: URL): Promise<void> {
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

export async function readLimitedResponseText(response: Response, maxBytes: number): Promise<string> {
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

export function parseClientMetadataDocument(raw: unknown, expectedClientId: string): ResolvedOAuthClient {
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

export async function resolveClientFromMetadataDocument(clientId: string): Promise<ResolvedOAuthClient> {
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
    pruneClientMetadataCache();
    return resolvedClient;
  } finally {
    clearTimeout(timeout);
  }
}

export function isHttpsClientId(clientId: string): boolean {
  try {
    const parsed = new URL(clientId);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type ResolveOAuthClientResult =
  | { ok: true; client: ResolvedOAuthClient }
  | { ok: false; error: "invalid_client" | "invalid_redirect_uri"; message: string };

export type DynamicClientRegistrationPayload = {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
};

export type ParseDynamicClientRegistrationResult =
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

export function parseDynamicClientRegistrationPayload(raw: unknown): ParseDynamicClientRegistrationResult {
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

export async function resolveClientFromDynamicRegistration(clientId: string): Promise<ResolvedOAuthClient | undefined> {
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

export const LOOPBACK_REDIRECT_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackRedirectUri(uri: URL): boolean {
  return uri.protocol === "http:" && LOOPBACK_REDIRECT_HOSTNAMES.has(uri.hostname.toLowerCase());
}

/**
 * RFC 8252 §7.3: for loopback-interface redirect URIs the authorization server
 * MUST allow any port at request time, because native clients (e.g. Claude Code)
 * bind an ephemeral OS-assigned port per run. Non-loopback URIs still require an
 * exact match. PKCE (S256, mandated here) protects the code; the final redirect
 * always uses the client-supplied URI with its actual port.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let registeredUrl: URL;
  let requestedUrl: URL;
  try {
    registeredUrl = new URL(registered);
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }
  if (isLoopbackRedirectUri(registeredUrl) && isLoopbackRedirectUri(requestedUrl)) {
    // Treat all loopback hosts as equivalent and ignore the port; match on path + query.
    return registeredUrl.pathname === requestedUrl.pathname
      && registeredUrl.search === requestedUrl.search;
  }
  return false;
}

export async function resolveOAuthClient(clientId: string, redirectUri: string): Promise<ResolveOAuthClientResult> {
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
      logger.warn("[oauth] client resolution failed for non-URL client_id", {
        client_id: clientId,
        redirect_uri: redirectUri
      });
      return {
        ok: false,
        error: "invalid_client",
        message: "client is not recognized"
      };
    }
    logger.debug("[oauth] resolved dynamically registered client", {
      client_id: dynamicallyRegisteredClient.clientId,
      redirect_uri: redirectUri
    });
    resolvedClient = dynamicallyRegisteredClient;
  }

  if (!resolvedClient.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri))) {
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
