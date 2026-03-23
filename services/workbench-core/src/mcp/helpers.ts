import { z } from "zod";
import { verifyAccessToken } from "../auth.js";
import { findUserById } from "../store.js";

export const tokenInput = {
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

export async function runWithAuth<T>(accessToken: string, operation: () => Promise<T>): Promise<T> {
  await ensureAuthenticatedToken(accessToken);
  return operation();
}

export async function runWithAuthContext<T>(
  accessToken: string,
  operation: (context: { userId: string; username: string }) => Promise<T>
): Promise<T> {
  const context = await readAuthContext(accessToken);
  return operation(context);
}
