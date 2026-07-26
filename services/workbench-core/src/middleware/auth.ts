import type express from "express";
import jwt from "jsonwebtoken";
import { isOAuthScopedToken, issueTokenBundle, verifyAccessToken } from "../auth.js";
import {
  assertLocalClientCapability,
  LocalClientStoreError,
  recordLocalClientCapabilityDenied,
  verifyLocalClientToken,
  type LocalClient,
  type LocalClientCapability
} from "../localClientsStore.js";
import { logger } from "../logger.js";
import { findUserById } from "../store.js";

export type AuthenticatedContext = {
  userId: string;
  username: string;
  accessToken: string;
};

export type SyncAccessContext = AuthenticatedContext & {
  localClient?: LocalClient;
};

export function readBearerToken(req: express.Request): string | undefined {
  const raw = req.header("authorization");
  if (!raw) return undefined;
  const [scheme, token] = raw.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token.trim();
}

export async function requireAuthenticatedContext(
  req: express.Request,
  res: express.Response,
  options: { rejectOAuthScopedTokens?: boolean } = {}
): Promise<AuthenticatedContext | undefined> {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ message: "Missing bearer token" });
    return undefined;
  }

  try {
    const claims = verifyAccessToken(token);
    if (options.rejectOAuthScopedTokens && isOAuthScopedToken(claims)) {
      res.status(403).json({ message: "This action requires the authenticated user, not an OAuth-scoped client token", code: "USER_ONLY" });
      return undefined;
    }
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

export async function requireLocalClientContext(
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

export async function requireLocalClientCapability(
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
        logger.warn("[local-client] failed to record capability denial", {
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

export async function requireSyncAccessContext(
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
