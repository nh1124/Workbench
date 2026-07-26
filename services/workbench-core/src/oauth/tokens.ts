import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import {
  oauthJwtExpirySeconds,
  oauthJwtIssuer,
  oauthJwtSecret,
  supportedMcpScopes,
  supportedMcpScopeSet
} from "./config.js";

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export type AuthorizationCodeRecord = {
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

export const authorizationCodeStore = new Map<string, AuthorizationCodeRecord>();
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const oauthRefreshTokenExpirySecondsRaw = optionalEnv("OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS") ?? "2592000";
export const oauthRefreshTokenExpirySeconds = Number(oauthRefreshTokenExpirySecondsRaw);
if (!Number.isFinite(oauthRefreshTokenExpirySeconds) || oauthRefreshTokenExpirySeconds <= 0) {
  throw new Error(`Invalid OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS value: ${oauthRefreshTokenExpirySecondsRaw}`);
}

export type OAuthRefreshTokenRecord = {
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

export const oauthRefreshTokenStore = new Map<string, OAuthRefreshTokenRecord>();

export function cleanupExpiredAuthorizationCodes(nowMs = Date.now()): void {
  for (const [code, record] of authorizationCodeStore.entries()) {
    if (record.expiresAtMs <= nowMs) {
      authorizationCodeStore.delete(code);
    }
  }
}

export function cleanupExpiredRefreshTokens(nowMs = Date.now()): void {
  for (const [tokenHash, record] of oauthRefreshTokenStore.entries()) {
    if (record.expiresAtMs <= nowMs) {
      oauthRefreshTokenStore.delete(tokenHash);
    }
  }
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function hashOpaqueToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function issueOAuthRefreshToken(input: {
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

export function parseScopeTokens(scope: string): string[] {
  return scope
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function isScopeSubset(requestedScope: string, grantedScope: string): boolean {
  const requestedTokens = parseScopeTokens(requestedScope);
  const grantedTokenSet = new Set(parseScopeTokens(grantedScope));
  return requestedTokens.every((token) => grantedTokenSet.has(token));
}

export function issueUserOAuthAccessToken(userId: string, username: string, scope: string, resource: string): string {
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

export function normalizeScope(rawScope: string | undefined): string | undefined {
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
