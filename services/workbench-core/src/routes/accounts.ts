import { type Express } from "express";
import jwt from "jsonwebtoken";
import { issueTokenBundle, verifyRefreshToken } from "../auth.js";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "../refreshCookie.js";
import { getIntegrationManifests } from "../integrations/index.js";
import { ensureIntegrationLinked } from "../integrationLinking.js";
import { accountSchema, integrationConfigSchema, refreshSchema } from "../schemas/requests.js";
import { configuredServiceIds, provisionAccountToServices } from "../serviceProvisioning.js";
import {
  findUserById,
  listIntegrationConfigs,
  listProvisionings,
  loginUser,
  registerUser,
  saveIntegrationConfig
} from "../store.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";

export function registerAccountRoutes(app: Express): void {
  app.post("/accounts/register", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const user = await registerUser(parsed.data.username, parsed.data.password);
    const provisioning = await provisionAccountToServices(user.id, user.username);
    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    setRefreshCookie(req, res, tokenBundle.refreshToken);
    return res.status(201).json({ user, provisioning, ...tokenBundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Registration failed";
    if (message.includes("duplicate key")) {
      return res.status(409).json({ message: "Username already exists" });
    }
    return res.status(500).json({ message });
  }
});

app.post("/accounts/login", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const user = await loginUser(parsed.data.username, parsed.data.password);
  if (!user) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  await provisionAccountToServices(user.id, user.username);
  const provisioning = await listProvisionings(user.id);
  const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
  setRefreshCookie(req, res, tokenBundle.refreshToken);
  return res.json({ user, provisioning, ...tokenBundle });
});

app.post("/auth/refresh", async (req, res) => {
  // Browser sessions present the token as an HttpOnly cookie and send no body;
  // native clients keep sending it in the body from OS secure storage.
  const cookieToken = readRefreshCookie(req);
  let refreshToken = cookieToken;
  if (!refreshToken) {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    refreshToken = parsed.data.refreshToken;
  }

  try {
    const claims = verifyRefreshToken(refreshToken);
    const user = await findUserById(claims.sub);
    if (!user || user.username !== claims.username) {
      return res.status(401).json({ message: "Invalid refresh token user" });
    }

    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    setRefreshCookie(req, res, tokenBundle.refreshToken);
    return res.json({ user, ...tokenBundle });
  } catch (error) {
    // A rejected cookie is a dead session: drop it so the browser stops
    // replaying it on every reload.
    if (cookieToken) clearRefreshCookie(req, res);
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }
    const message = error instanceof Error ? error.message : "Refresh failed";
    return res.status(401).json({ message });
  }
});

app.post("/auth/logout", (req, res) => {
  clearRefreshCookie(req, res);
  return res.json({ status: "ok" });
});

app.get("/auth/me", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const user = await findUserById(authContext.userId);
  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }

  const provisioning = await listProvisionings(user.id);
  return res.json({ user, provisioning });
});

app.get("/integrations/manifests", async (_req, res) => {
  const enabledIntegrationIds = new Set<string>(configuredServiceIds());
  enabledIntegrationIds.add("image_generation");
  enabledIntegrationIds.add("deep_research");
  return res.json(getIntegrationManifests(enabledIntegrationIds));
});

app.get("/integrations/configs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const configs = await listIntegrationConfigs(authContext.userId);
  return res.json(configs);
});

app.put("/integrations/configs/:integrationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const parsed = integrationConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const existingConfig = (await listIntegrationConfigs(authContext.userId)).find(
      (row) => row.integrationId === req.params.integrationId
    );
    const mergedValues = {
      ...(existingConfig?.values ?? {}),
      ...parsed.data.values
    };

    const values = parsed.data.enabled
      ? await ensureIntegrationLinked(req.params.integrationId, mergedValues)
      : mergedValues;
    await saveIntegrationConfig(authContext.userId, req.params.integrationId, parsed.data.enabled, values);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Integration activation failed";
    return res.status(502).json({ message });
  }

  return res.json({ status: "ok" });
});

}
