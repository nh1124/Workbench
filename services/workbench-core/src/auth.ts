import { config as loadEnv } from "dotenv";
import jwt from "jsonwebtoken";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const jwtSecret = requireEnv("JWT_SECRET");
const jwtIssuer = requireEnv("JWT_ISSUER");
const jwtExpirySecondsRaw = requireEnv("JWT_EXPIRY_SECONDS");
const refreshJwtExpirySecondsRaw = process.env.JWT_REFRESH_EXPIRY_SECONDS?.trim() || "2592000";

type TokenUse = "access" | "refresh";

export interface AccessTokenClaims {
  sub: string;
  username: string;
  tokenUse: "access";
  iss: string;
  iat: number;
  exp: number;
}

export interface RefreshTokenClaims {
  sub: string;
  username: string;
  tokenUse: "refresh";
  iss: string;
  iat: number;
  exp: number;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
}

const accessTokenExpiresInSeconds = Number(jwtExpirySecondsRaw);
if (!Number.isFinite(accessTokenExpiresInSeconds) || accessTokenExpiresInSeconds <= 0) {
  throw new Error(`Invalid JWT_EXPIRY_SECONDS value: ${jwtExpirySecondsRaw}`);
}

const refreshTokenExpiresInSeconds = Number(refreshJwtExpirySecondsRaw);
if (!Number.isFinite(refreshTokenExpiresInSeconds) || refreshTokenExpiresInSeconds <= 0) {
  throw new Error(`Invalid JWT_REFRESH_EXPIRY_SECONDS value: ${refreshJwtExpirySecondsRaw}`);
}

function issueJwtToken(input: { userId: string; username: string; tokenUse: TokenUse; expiresInSeconds: number }): string {
  return jwt.sign(
    {
      sub: input.userId,
      username: input.username,
      tokenUse: input.tokenUse
    },
    jwtSecret,
    {
      algorithm: "HS256",
      issuer: jwtIssuer,
      expiresIn: input.expiresInSeconds
    }
  );
}

export function issueTokenBundle(input: { userId: string; username: string }): TokenBundle {
  const normalizedUsername = input.username.trim().toLowerCase();
  const accessToken = issueJwtToken({
    userId: input.userId,
    username: normalizedUsername,
    tokenUse: "access",
    expiresInSeconds: accessTokenExpiresInSeconds
  });
  const refreshToken = issueJwtToken({
    userId: input.userId,
    username: normalizedUsername,
    tokenUse: "refresh",
    expiresInSeconds: refreshTokenExpiresInSeconds
  });

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresInSeconds: accessTokenExpiresInSeconds
  };
}

function verifyTokenWithUse(token: string, expectedUse: TokenUse): {
  sub: string;
  username: string;
  tokenUse: TokenUse;
  iss: string;
  iat: number;
  exp: number;
} {
  const decoded = jwt.verify(token, jwtSecret, {
    algorithms: ["HS256"],
    issuer: jwtIssuer
  });

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid token payload");
  }

  const sub = typeof decoded.sub === "string" ? decoded.sub : undefined;
  const username = typeof decoded.username === "string" ? decoded.username : undefined;
  const tokenUse = decoded.tokenUse === "access" || decoded.tokenUse === "refresh" ? decoded.tokenUse : undefined;
  const iss = typeof decoded.iss === "string" ? decoded.iss : undefined;
  const iat = typeof decoded.iat === "number" ? decoded.iat : undefined;
  const exp = typeof decoded.exp === "number" ? decoded.exp : undefined;

  if (!sub || !username || !tokenUse || !iss || !iat || !exp) {
    throw new Error("Invalid token claims");
  }
  if (tokenUse !== expectedUse) {
    throw new Error(`Invalid token type: expected ${expectedUse}`);
  }

  return {
    sub,
    username: username.trim().toLowerCase(),
    tokenUse,
    iss,
    iat,
    exp
  };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const claims = verifyTokenWithUse(token, "access");
  return {
    ...claims,
    tokenUse: "access"
  };
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  const claims = verifyTokenWithUse(token, "refresh");
  return {
    ...claims,
    tokenUse: "refresh"
  };
}
