import { config as loadEnv } from "dotenv";
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findServiceAccountByCoreUserId } from "./db.js";

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
const internalApiKey = requireEnv("INTERNAL_API_KEY");

export interface AuthenticatedUser {
  serviceAccountId: string;
  coreUserId: string;
  usernameSnapshot: string;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

function parseBearerToken(headerValue?: string): string | undefined {
  if (!headerValue) return undefined;
  const [scheme, token] = headerValue.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token.trim();
}

function parseClaims(token: string): { coreUserId: string; username: string } {
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

  if (!sub || !username || tokenUse !== "access") {
    throw new Error("Invalid token claims");
  }

  return {
    coreUserId: sub,
    username: username.trim().toLowerCase()
  };
}

export const requireUserAuth: RequestHandler = async (req, res, next) => {
  const token = parseBearerToken(req.header("authorization"));
  if (!token) {
    res.status(401).json({ message: "Missing bearer token" });
    return;
  }

  try {
    const claims = parseClaims(token);
    const account = await findServiceAccountByCoreUserId(claims.coreUserId);
    if (!account) {
      res.status(403).json({ message: "Service account not provisioned" });
      return;
    }

    req.authUser = {
      serviceAccountId: account.id,
      coreUserId: account.coreUserId,
      usernameSnapshot: account.usernameSnapshot || claims.username
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: "Invalid or expired token" });
      return;
    }

    const message = error instanceof Error ? error.message : "Authentication failed";
    res.status(401).json({ message });
  }
};

export const requireInternalApiKey: RequestHandler = (req, res, next) => {
  const provided = req.header("x-api-key")?.trim();
  if (!provided || provided !== internalApiKey) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  next();
};
