import { z } from "zod";
import { verifyAccessToken } from "../auth.js";
import { findUserById } from "../store.js";

export const tokenInput = {
  accessToken: z.string().optional()
};

export const tokenInputRequired = {
  accessToken: z.string().min(1)
};

export function asMcpText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function ensureAuthenticatedToken(accessToken: string): Promise<void> {
  const claims = verifyAccessToken(accessToken);
  const user = await findUserById(claims.sub);
  if (!user || user.username !== claims.username) {
    throw new Error("Invalid access token user");
  }
}

async function readAuthContext(accessToken: string): Promise<{ userId: string; username: string }> {
  const claims = verifyAccessToken(accessToken);
  const user = await findUserById(claims.sub);
  if (!user || user.username !== claims.username) {
    throw new Error("Invalid access token user");
  }
  return {
    userId: user.id,
    username: user.username
  };
}

export async function runWithAuth<T>(
  accessToken: string | undefined,
  operation: () => Promise<T>,
  injectedToken?: string
): Promise<T> {
  const token = accessToken ?? injectedToken;
  if (!token) {
    throw new Error("accessToken is required");
  }
  await ensureAuthenticatedToken(token);
  return operation();
}

export async function runWithAuthContext<T>(
  accessToken: string | undefined,
  operation: (context: { userId: string; username: string }) => Promise<T>,
  injectedToken?: string
): Promise<T> {
  const token = accessToken ?? injectedToken;
  if (!token) {
    throw new Error("accessToken is required");
  }
  const context = await readAuthContext(token);
  return operation(context);
}
