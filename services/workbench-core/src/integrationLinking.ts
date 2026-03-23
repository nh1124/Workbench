import { z } from "zod";

type IntegrationValues = Record<string, string | number | boolean>;

const tokenResponseSchema = z.object({
  accessToken: z.string().optional(),
  token: z.string().optional(),
  jwt: z.string().optional(),
  refreshToken: z.string().optional(),
  refresh_token: z.string().optional()
}).passthrough();

function asString(value: string | number | boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function readFirst(values: IntegrationValues, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(values[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function extractTokens(raw: unknown): { accessToken: string; refreshToken?: string } {
  const parsed = tokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Auth response is not a valid JSON token payload");
  }

  const accessToken = parsed.data.accessToken ?? parsed.data.token ?? parsed.data.jwt;
  if (!accessToken) {
    throw new Error("Auth response does not contain an access token");
  }

  const refreshToken = parsed.data.refreshToken ?? parsed.data.refresh_token;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {})
  };
}

async function callAuthEndpoint(
  url: string,
  payload: { username: string; password: string }
): Promise<{ accessToken: string; refreshToken?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }

  let json: unknown = {};
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Auth endpoint returned non-JSON response");
    }
  }

  return extractTokens(json);
}

export async function ensureIntegrationLinked(
  integrationId: string,
  values: IntegrationValues
): Promise<IntegrationValues> {
  const baseUrl = readFirst(values, ["authBaseUrl", "baseUrl", "serviceUrl", "apiUrl", "endpoint", "url"]);
  const username = readFirst(values, ["username", "login", "email", "account", "accountId"]);
  const password = readFirst(values, ["password", "pass", "accountPassword"]);

  // If link/auth inputs are not configured, keep config as-is.
  if (!baseUrl || !username || !password) {
    return values;
  }

  const loginPath = readFirst(values, ["authLoginPath", "loginPath"]) ?? "/auth/login";
  const registerPath = readFirst(values, ["authRegisterPath", "registerPath"]) ?? "/auth/register";

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const authPayload = { username, password };

  try {
    const tokens = await callAuthEndpoint(`${normalizedBaseUrl}${loginPath}`, authPayload);
    return {
      ...values,
      linkedUsername: username,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      tokenUpdatedAt: new Date().toISOString()
    };
  } catch (loginError) {
    try {
      const tokens = await callAuthEndpoint(`${normalizedBaseUrl}${registerPath}`, authPayload);
      return {
        ...values,
        linkedUsername: username,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        tokenUpdatedAt: new Date().toISOString()
      };
    } catch (registerError) {
      const loginMessage = loginError instanceof Error ? loginError.message : "Login failed";
      const registerMessage = registerError instanceof Error ? registerError.message : "Registration failed";
      throw new Error(
        `Failed to activate ${integrationId}: login failed (${loginMessage}); register failed (${registerMessage})`
      );
    }
  }
}
