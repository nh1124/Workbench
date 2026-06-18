#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(scriptDir, "..");
const identityStoragePath = path.resolve(daemonRoot, "dist/identityStorage.js");

if (!existsSync(identityStoragePath)) {
  throw new Error("dist/identityStorage.js was not found. Run `npm run build --workspace services/sync-daemon` first.");
}

const {
  clearIdentity,
  identityPath,
  readIdentityWithSource,
  writeIdentity
} = await import(pathToFileURL(identityStoragePath).href);

const previousEnvClientId = process.env.WORKBENCH_LOCAL_CLIENT_ID;
const previousEnvClientToken = process.env.WORKBENCH_LOCAL_CLIENT_TOKEN;
delete process.env.WORKBENCH_LOCAL_CLIENT_ID;
delete process.env.WORKBENCH_LOCAL_CLIENT_TOKEN;

const root = await mkdtemp(path.join(tmpdir(), "workbench-secure-identity-smoke-"));
const runId = randomUUID();
const config = {
  syncRoot: root,
  deviceId: `smoke-device-${runId}`,
  syncRootId: `smoke-${runId}`,
  persistClientIdentity: false,
  secureClientIdentity: "required"
};
const identity = {
  localClientId: `local-client-${runId}`,
  localClientToken: `local-token-${runId}`,
  deviceId: config.deviceId,
  syncRootId: config.syncRootId
};

try {
  const source = await writeIdentity(config, identity);
  if (source !== "secure") {
    throw new Error(`Expected secure identity storage, got ${source}.`);
  }

  const restored = await readIdentityWithSource(config);
  if (!restored || restored.source !== "secure") {
    throw new Error(`Expected secure identity readback, got ${restored?.source ?? "none"}.`);
  }
  if (restored.identity.localClientId !== identity.localClientId || restored.identity.localClientToken !== identity.localClientToken) {
    throw new Error("Secure identity readback did not match the stored identity.");
  }
  if (existsSync(identityPath(config))) {
    throw new Error("Plaintext client-identity.json was written during secure identity smoke test.");
  }

  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    source: restored.source,
    syncRootId: config.syncRootId
  }, null, 2));
} finally {
  await clearIdentity(config).catch((error) => {
    console.warn(`secure identity smoke cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await rm(root, { recursive: true, force: true });
  if (previousEnvClientId === undefined) {
    delete process.env.WORKBENCH_LOCAL_CLIENT_ID;
  } else {
    process.env.WORKBENCH_LOCAL_CLIENT_ID = previousEnvClientId;
  }
  if (previousEnvClientToken === undefined) {
    delete process.env.WORKBENCH_LOCAL_CLIENT_TOKEN;
  } else {
    process.env.WORKBENCH_LOCAL_CLIENT_TOKEN = previousEnvClientToken;
  }
}
