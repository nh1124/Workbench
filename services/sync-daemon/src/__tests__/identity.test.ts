import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  ensureIdentity,
  readIdentity,
  registerIfNeeded,
  type DaemonConfig
} from "../index.js";
import {
  parseSecureIdentityMode,
  setSecureIdentityBackendForTest,
  type ClientIdentity,
  type SecureIdentityBackend,
  type SecureIdentityMode
} from "../identityStorage.js";

const tempRoots: string[] = [];

function configFor(
  root: string,
  persistClientIdentity?: boolean,
  secureClientIdentity: SecureIdentityMode = "off"
): DaemonConfig {
  return {
    coreUrl: "http://127.0.0.1:3000",
    accessToken: "access-token",
    syncRoot: root,
    downloadsDir: join(root, "downloads"),
    deviceId: "test-device",
    clientName: "test daemon",
    syncRootId: "test-root",
    syncRootLabel: "Test Sync",
    intervalMs: 5000,
    httpPort: 0,
    maxSyncFileBytes: 10 * 1024 * 1024,
    watchEnabled: false,
    watchDebounceMs: 100,
    persistClientIdentity,
    secureClientIdentity
  };
}

function memorySecureBackend(): { backend: SecureIdentityBackend; stored: ClientIdentity | undefined } {
  const state: { stored: ClientIdentity | undefined } = { stored: undefined };
  return {
    backend: {
      name: "memory-secure-storage",
      async read() {
        return state.stored;
      },
      async write(_config, identity) {
        state.stored = identity;
      }
    },
    get stored() {
      return state.stored;
    }
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workbench-sync-identity-"));
  tempRoots.push(root);
  return root;
}

async function withRegisterFetch<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    client: {
      id: "local-client-1",
      deviceId: "registered-device",
      syncRootId: "registered-root"
    },
    clientToken: "secret-token"
  }), {
    status: 201,
    headers: { "Content-Type": "application/json" }
  })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withCountingRegisterFetch<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const originalFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async () => {
    count += 1;
    return new Response(JSON.stringify({
      client: {
        id: `local-client-${count}`,
        deviceId: "registered-device",
        syncRootId: "registered-root"
      },
      clientToken: `secret-token-${count}`
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, count };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

afterEach(async () => {
  setSecureIdentityBackendForTest(undefined);
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("sync-daemon client identity persistence", () => {
  it("parses secure identity storage modes", () => {
    assert.equal(parseSecureIdentityMode(undefined), "off");
    assert.equal(parseSecureIdentityMode("0"), "off");
    assert.equal(parseSecureIdentityMode("auto"), "auto");
    assert.equal(parseSecureIdentityMode("1"), "required");
    assert.equal(parseSecureIdentityMode("required"), "required");
  });

  it("can register without writing a plaintext client identity file", async () => {
    const root = await createRoot();
    const config = configFor(root, false);

    const identity = await withRegisterFetch(() => registerIfNeeded(config));

    assert.equal(identity.localClientId, "local-client-1");
    assert.equal(identity.localClientToken, "secret-token");
    assert.equal(existsSync(join(root, ".workbench", "client-identity.json")), false);
    assert.equal(await readIdentity(config), undefined);
  });

  it("reuses memory identity when plaintext persistence is disabled", async () => {
    const root = await createRoot();
    const state = {
      config: configFor(root, false),
      identity: undefined
    };

    const { result, count } = await withCountingRegisterFetch(async () => {
      const first = await ensureIdentity(state);
      const second = await ensureIdentity(state);
      return { first, second };
    });

    assert.equal(count, 1);
    assert.equal(result.first.localClientId, "local-client-1");
    assert.equal(result.second.localClientId, "local-client-1");
    assert.equal(existsSync(join(root, ".workbench", "client-identity.json")), false);
  });

  it("keeps default identity file persistence backward compatible", async () => {
    const root = await createRoot();
    const config = configFor(root);

    await withRegisterFetch(() => registerIfNeeded(config));

    const path = join(root, ".workbench", "client-identity.json");
    assert.equal(existsSync(path), true);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { localClientToken?: string };
    assert.equal(persisted.localClientToken, "secret-token");
    if (platform() !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode & 0o077, 0);
    }
  });

  it("stores and reads identity through configured secure storage", async () => {
    const root = await createRoot();
    const secure = memorySecureBackend();
    setSecureIdentityBackendForTest(secure.backend);
    const config = configFor(root, true, "required");

    const identity = await withRegisterFetch(() => registerIfNeeded(config));
    const restored = await readIdentity(config);

    assert.equal(identity.localClientId, "local-client-1");
    assert.equal(secure.stored?.localClientToken, "secret-token");
    assert.equal(restored?.localClientToken, "secret-token");
    assert.equal(existsSync(join(root, ".workbench", "client-identity.json")), false);
  });

  it("falls back to the identity file when secure storage is auto and unavailable", async () => {
    const root = await createRoot();
    setSecureIdentityBackendForTest(null);
    const config = configFor(root, true, "auto");

    await withRegisterFetch(() => registerIfNeeded(config));

    assert.equal(existsSync(join(root, ".workbench", "client-identity.json")), true);
  });

  it("fails required secure storage instead of writing a plaintext identity file when unavailable", async () => {
    const root = await createRoot();
    setSecureIdentityBackendForTest(null);
    const config = configFor(root, true, "required");

    await assert.rejects(
      () => registerIfNeeded(config),
      /Secure local client identity storage is not available/
    );
    assert.equal(existsSync(join(root, ".workbench", "client-identity.json")), false);
  });

  it("migrates an existing identity file into secure storage when enabled", async () => {
    const root = await createRoot();
    await withRegisterFetch(() => registerIfNeeded(configFor(root)));
    assert.equal(existsSync(join(root, ".workbench", "client-identity.json")), true);

    const secure = memorySecureBackend();
    setSecureIdentityBackendForTest(secure.backend);
    const migrated = await readIdentity(configFor(root, true, "required"));

    assert.equal(migrated?.localClientToken, "secret-token");
    assert.equal(secure.stored?.localClientToken, "secret-token");
    assert.equal(existsSync(join(root, ".workbench", "client-identity.json")), false);
  });
});
