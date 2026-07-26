import express from "express";
import { localClientHeartbeatSchema, localClientPatchSchema, localClientRegisterSchema } from "../schemas/requests.js";
import { archiveLocalClient, deleteLocalClient, listLocalClientAuditEventsForUser, listLocalClients, recordLocalClientHeartbeat, registerLocalClient, revokeLocalClientTokens, updateLocalClient } from "../localClientsStore.js";
import { requireAuthenticatedContext, requireLocalClientContext } from "../middleware/auth.js";
import { queryFlagEnabled, respondInternalError } from "./shared.js";

export function registerLocalClientRoutes(app: express.Express): void {
app.post("/api/local-clients/register", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = localClientRegisterSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const result = await registerLocalClient(authContext.userId, parsed.data);
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-clients", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const includeArchived = queryFlagEnabled(req.query.includeArchived);

  try {
    const clients = await listLocalClients(authContext.userId, { includeArchived });
    return res.json({ items: clients });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/local-clients/audit-events", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const localClientId = typeof req.query.localClientId === "string" ? req.query.localClientId : undefined;

  try {
    const events = await listLocalClientAuditEventsForUser(authContext.userId, {
      localClientId,
      limit: Number.isFinite(limit) ? limit : undefined
    });
    return res.json({ items: events });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/local-clients/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = localClientPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const client = await updateLocalClient(authContext.userId, String(req.params.id), parsed.data);
    if (!client) {
      return res.status(404).json({ message: "Local client not found" });
    }
    return res.json(client);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-clients/:id/revoke", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const revoked = await revokeLocalClientTokens(authContext.userId, String(req.params.id));
    if (!revoked) {
      return res.status(404).json({ message: "Local client not found or no active token exists" });
    }
    const client = await updateLocalClient(authContext.userId, String(req.params.id), { enabled: false });
    return res.json({ revoked: true, client });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-clients/:id/archive", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const client = await archiveLocalClient(authContext.userId, String(req.params.id));
    if (!client) {
      return res.status(404).json({ message: "Local client not found" });
    }
    return res.json(client);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/local-clients/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const deleted = await deleteLocalClient(authContext.userId, String(req.params.id));
    if (!deleted) {
      return res.status(404).json({ message: "Local client not found" });
    }
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/local-clients/:id/heartbeat", async (req, res) => {
  const localContext = await requireLocalClientContext(req, res);
  if (!localContext) return;
  if (localContext.client.id !== String(req.params.id)) {
    return res.status(403).json({ message: "Local client credentials do not match route client id" });
  }

  const parsed = localClientHeartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const client = await recordLocalClientHeartbeat(localContext.client, parsed.data);
    return res.json(client);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

}

