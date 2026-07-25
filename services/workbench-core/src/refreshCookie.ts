import type express from "express";
import { refreshTokenLifetimeSeconds } from "./auth.js";

/**
 * Browser sessions keep the refresh token in an HttpOnly cookie so page script
 * (and therefore any XSS payload) cannot read it; only the short-lived access
 * token lives in page memory. Native (Tauri) clients keep using OS secure
 * storage and send the token in the request body instead, so the refresh route
 * accepts either source.
 *
 * Path is scoped to /auth so the cookie rides along on refresh and logout only,
 * never on ordinary API calls.
 */
export const REFRESH_COOKIE_NAME = "workbench_refresh";
export const REFRESH_COOKIE_PATH = "/auth";

export function requestIsHttps(req: Pick<express.Request, "secure" | "headers">): boolean {
  if (req.secure) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim() === "https";
}

export function readRefreshCookie(req: Pick<express.Request, "headers">): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) continue;
    const raw = part.slice(separator + 1).trim();
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

export function refreshCookieOptions(req: Pick<express.Request, "secure" | "headers">) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: requestIsHttps(req),
    path: REFRESH_COOKIE_PATH
  };
}

export function setRefreshCookie(
  req: Pick<express.Request, "secure" | "headers">,
  res: Pick<express.Response, "cookie">,
  refreshToken: string
): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...refreshCookieOptions(req),
    maxAge: refreshTokenLifetimeSeconds * 1000
  });
}

export function clearRefreshCookie(
  req: Pick<express.Request, "secure" | "headers">,
  res: Pick<express.Response, "clearCookie">
): void {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(req));
}
