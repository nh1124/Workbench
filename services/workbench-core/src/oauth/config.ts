import { config as loadEnv } from "dotenv";
import type express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These constants are read at module load, and ESM evaluates this module before
// the body of whichever module imported it. Load the service .env here — the
// same way auth.ts and db.ts do — so startup does not depend on some other
// import happening to run dotenv first.
loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

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

export const oauthJwtSecret = requireEnv("JWT_SECRET");
export const oauthJwtIssuer = requireEnv("JWT_ISSUER");
const oauthJwtExpirySecondsRaw = requireEnv("JWT_EXPIRY_SECONDS");
export const oauthJwtExpirySeconds = Number(oauthJwtExpirySecondsRaw);
if (!Number.isFinite(oauthJwtExpirySeconds) || oauthJwtExpirySeconds <= 0) {
  throw new Error(`Invalid JWT_EXPIRY_SECONDS value: ${oauthJwtExpirySecondsRaw}`);
}

export const supportedMcpScopes = ["mcp:tools"] as const;
export const supportedMcpScopeSet = new Set<string>(supportedMcpScopes);
export const clientMetadataCacheTtlMs = 5 * 60 * 1000;
export const clientMetadataFetchTimeoutMs = 5000;
export const clientMetadataMaxResponseBytes = 64 * 1024;
export const externalBaseUrlRaw = optionalEnv("CORE_EXTERNAL_BASE_URL");
export const clientMetadataHostAllowlist = new Set(
  (optionalEnv("OAUTH_CLIENT_METADATA_HOST_ALLOWLIST") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
);

export const DYNAMIC_CLIENT_REGISTRATION_PATH = "/oauth/register";

export type CanonicalBaseConfig = {
  issuer: string;
};

export function normalizeCanonicalBase(raw: string): CanonicalBaseConfig {
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

export const canonicalBaseConfig = externalBaseUrlRaw ? normalizeCanonicalBase(externalBaseUrlRaw) : undefined;

export function joinIssuerPath(issuer: string, pathSuffix: string): string {
  const normalizedSuffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
  return `${issuer}${normalizedSuffix}`;
}

export function buildFallbackIssuerFromRequest(req: express.Request): string {
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

export function buildOAuthIssuer(req: express.Request): string {
  return canonicalBaseConfig?.issuer ?? buildFallbackIssuerFromRequest(req);
}

export function buildCanonicalMcpResource(req: express.Request): string {
  return joinIssuerPath(buildOAuthIssuer(req), "/mcp");
}
