import express, { type Express } from "express";
import { randomBytes } from "node:crypto";
import { loginUser } from "../store.js";
import { logger } from "../logger.js";
import { saveOAuthDynamicClient } from "../oauthDynamicClientsStore.js";
import { respondInternalError } from "./shared.js";
import {
  readAuthorizeParams,
  renderAuthorizeLoginForm,
  type AuthorizeRequestParams
} from "../oauth/authorizeRequest.js";
import {
  parseDynamicClientRegistrationPayload,
  resolveOAuthClient,
  type DynamicClientRegistrationPayload
} from "../oauth/clients.js";
import {
  buildCanonicalMcpResource,
  buildOAuthIssuer,
  DYNAMIC_CLIENT_REGISTRATION_PATH,
  joinIssuerPath,
  oauthJwtExpirySeconds,
  supportedMcpScopes
} from "../oauth/config.js";
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
} from "../oauth/tokens.js";

export function registerOAuthRoutes(app: Express): void {
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

}
