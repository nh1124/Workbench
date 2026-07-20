import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { describe, it } from "node:test";
import {
  CaptureManager,
  CaptureServerPolicyProvider,
  CaptureStorage,
  CaptureUploader,
  CAPTURE_UPLOAD_META_KEYS,
  DEFAULT_CAPTURE_CONFIG,
  assertCaptureDbPathAllowed,
  decodeSamplerStdoutChunk,
  ingestSamplerLine,
  normalizeServerCapturePolicy,
  shouldCaptureScreenshot,
  validateCaptureConfigPatch,
  type CaptureLogger
} from "../capture/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "workbench-capture-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function silentLogger(warnings: unknown[] = []): CaptureLogger {
  return {
    info() {},
    warn(...args: unknown[]) { warnings.push(args); },
    error(...args: unknown[]) { warnings.push(args); }
  };
}

describe("capture storage", () => {
  it("rejects capture DB paths inside the sync root or .workbench metadata", async () => {
    await withTempDir(async (dir) => {
      const syncRoot = join(dir, "sync-root");
      assert.throws(() => assertCaptureDbPathAllowed(join(syncRoot, "capture.sqlite"), syncRoot), /sync root/);
      assert.throws(() => assertCaptureDbPathAllowed(join(dir, ".workbench", "capture.sqlite"), syncRoot), /\.workbench/);
    });
  });

  it("drops stored autoPublish, defaults title privacy off, and preserves existing capture flags", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      try {
        storage.setMeta("capture.config", JSON.stringify({
          enabled: true,
          uploadEnabled: true,
          autoPublish: true,
          retentionDays: 9
        }));
        const config = storage.getConfig();
        assert.equal(config.enabled, true);
        assert.equal(config.uploadEnabled, true);
        assert.equal(config.windowTitleCapture, false);
        assert.equal(config.windowTitleUpload, false);
        assert.equal(config.retentionDays, 9);
        assert.equal("autoPublish" in config, false);
      } finally {
        storage.close();
      }
    });
  });

  it("blanks titles at persistence time unless windowTitleCapture is enabled", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      try {
        storage.insertSample({ sampledAt: "2026-07-07T09:00:00.000Z", processName: "Code", windowTitle: "Private" });
        storage.updateConfig({ windowTitleCapture: true });
        storage.insertSample({ sampledAt: "2026-07-07T09:00:15.000Z", processName: "Code", windowTitle: "Workbench" });
        const samples = storage.listSamplesAfter(undefined, 10);
        assert.equal(samples[0].windowTitle, "");
        assert.equal(samples[1].windowTitle, "Workbench");
      } finally {
        storage.close();
      }
    });
  });

  it("applies exclude patterns before title blanking and ignores invalid patterns", async () => {
    await withTempDir(async (dir) => {
      const warnings: unknown[] = [];
      const storage = new CaptureStorage(join(dir, "capture.sqlite"), { logger: silentLogger(warnings) });
      try {
        const config = storage.setConfig({
          ...DEFAULT_CAPTURE_CONFIG,
          enabled: true,
          excludePatterns: ["Private work", "["]
        });
        assert.equal(storage.insertSample({ sampledAt: "2026-07-07T09:00:00.000Z", processName: "Code", windowTitle: "Private work" }, config), false);
        assert.equal(storage.insertSample({ sampledAt: "2026-07-07T09:00:15.000Z", processName: "Code", windowTitle: "Workbench" }, config), true);
        assert.equal(storage.listSamplesAfter(undefined, 10).length, 1);
        assert.ok(warnings.length >= 1);
      } finally {
        storage.close();
      }
    });
  });

  it("deletes samples older than retentionDays", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      try {
        storage.insertSample({ sampledAt: "2026-06-30T23:59:00.000Z", processName: "Old", windowTitle: "Old" });
        storage.insertSample({ sampledAt: "2026-07-02T00:00:00.000Z", processName: "Current", windowTitle: "Current" });
        assert.equal(storage.deleteSamplesOlderThan(14, new Date("2026-07-15T00:00:00.000Z")), 1);
        assert.deepEqual(storage.listSamplesAfter(undefined, 10).map((sample) => sample.processName), ["Current"]);
      } finally {
        storage.close();
      }
    });
  });

  it("validates title, upload, screenshot, idle, and category settings", () => {
    assert.deepEqual(validateCaptureConfigPatch({
      uploadEnabled: true,
      windowTitleCapture: true,
      windowTitleUpload: true,
      screenshotsEnabled: true,
      screenshotIntervalSeconds: 60,
      screenshotRetentionDays: 90,
      idleThresholdSeconds: 60,
      categoryMap: { CODE: "Coding" }
    }), {
      uploadEnabled: true,
      windowTitleCapture: true,
      windowTitleUpload: true,
      screenshotsEnabled: true,
      screenshotIntervalSeconds: 60,
      screenshotRetentionDays: 90,
      idleThresholdSeconds: 60,
      categoryMap: { CODE: "Coding" }
    });
    assert.deepEqual(validateCaptureConfigPatch({ autoPublish: true }), {});
    assert.throws(() => validateCaptureConfigPatch({ windowTitleCapture: "yes" }), /windowTitleCapture/);
    assert.throws(() => validateCaptureConfigPatch({ screenshotIntervalSeconds: 59 }), /between 60 and 3600/);
    assert.throws(() => validateCaptureConfigPatch({ screenshotRetentionDays: 91 }), /between 1 and 90/);
    assert.throws(() => validateCaptureConfigPatch({ idleThresholdSeconds: 59 }), /between 60 and 3600/);
    assert.throws(() => validateCaptureConfigPatch({ categoryMap: { Code: "" } }), /categoryMap/);
  });

  it("stores screenshot metadata without exposing paths and removes retained files", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      try {
        const dayDir = join(storage.screenshotsDir, "2026-07-01");
        const filePath = join(dayDir, "120000.png");
        await mkdir(dayDir, { recursive: true });
        await writeFile(filePath, "png");
        const id = storage.insertScreenshot({ capturedAt: "2026-07-01T12:00:00.000Z", filePath, processName: "Code", windowTitle: "Workbench" });
        assert.deepEqual(storage.listScreenshots().items, [{ id, capturedAt: "2026-07-01T12:00:00.000Z", processName: "Code", windowTitle: "Workbench" }]);
        assert.equal("filePath" in storage.listScreenshots().items[0], false);
        assert.equal(storage.deleteScreenshotsOlderThan(7, new Date("2026-07-10T12:00:00.000Z")), 1);
        await assert.rejects(access(filePath));
        await assert.rejects(access(dayDir));
      } finally {
        storage.close();
      }
    });
  });

  it("keeps screenshot exclusion behavior unchanged", () => {
    const config = { ...DEFAULT_CAPTURE_CONFIG, enabled: true, screenshotsEnabled: true, excludePatterns: ["Secret"] };
    assert.equal(shouldCaptureScreenshot(config), false);
    assert.equal(shouldCaptureScreenshot(config, { sampledAt: "2026-07-10T00:00:00.000Z", processName: "SecretApp", windowTitle: "private" }), false);
    assert.equal(shouldCaptureScreenshot(config, { sampledAt: "2026-07-10T00:00:00.000Z", processName: "Code", windowTitle: "Workbench" }), true);
  });

  it("rejects enable on unsupported OS", async () => {
    await withTempDir(async (dir) => {
      const manager = new CaptureManager({
        syncRoot: join(dir, "sync-root"),
        dbPath: join(dir, "capture.sqlite"),
        platform: "linux",
        logger: silentLogger()
      });
      try {
        await assert.rejects(() => manager.enable(), /only supported on Windows/);
        assert.equal(manager.config().enabled, false);
      } finally {
        manager.close();
      }
    });
  });

  it("narrows local capture config by the server effective policy (stricter-wins)", async () => {
    await withTempDir(async (dir) => {
      // Local opts everything in; the server policy is the acquisition gate.
      let policy = normalizeServerCapturePolicy({
        foregroundAppCapture: "off",
        screenshots: "off",
        windowTitleCapture: false
      });
      const manager = new CaptureManager({
        syncRoot: join(dir, "sync-root"),
        dbPath: join(dir, "capture.sqlite"),
        platform: "linux",
        logger: silentLogger(),
        getServerPolicy: () => policy
      });
      try {
        manager.storage.updateConfig({ uploadEnabled: true });
        manager.storage.setEnabled(true);
        manager.storage.updateConfig({ screenshotsEnabled: true, windowTitleCapture: true } as never);
        // Server says off → effective config disables both, and window titles are
        // blanked at persistence even though the local opt-in is on.
        manager.storage.insertSample(
          { sampledAt: "2026-07-10T00:00:00.000Z", processName: "Code", windowTitle: "secret doc" },
          (manager as unknown as { effectiveConfig(): { windowTitleCapture: boolean } }).effectiveConfig() as never
        );
        // Flip the server policy on; effective config now permits capture.
        policy = normalizeServerCapturePolicy({
          foregroundAppCapture: "metadata",
          screenshots: "local_only",
          windowTitleCapture: true
        });
        const effective = (manager as unknown as { effectiveConfig(): Record<string, unknown> }).effectiveConfig();
        assert.equal(effective.enabled, true);
        assert.equal(effective.screenshotsEnabled, true);
        assert.equal(effective.windowTitleCapture, true);
      } finally {
        manager.close();
      }
    });
  });

  it("server policy provider caches within TTL and keeps the last value on failure", async () => {
    let now = 1_000;
    let responses: Array<{ settings: Record<string, unknown> } | Error> = [
      { settings: { screenshots: "local_only", foregroundAppUpload: true } }
    ];
    const provider = new CaptureServerPolicyProvider({
      getJson: async <T>(path: string): Promise<T> => {
        assert.match(path, /\/api\/analyser\/settings\/effective/);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return (next ?? { settings: {} }) as T;
      },
      getMachineId: () => "machine-1",
      logger: silentLogger(),
      now: () => now,
      ttlMs: 60_000
    });

    const first = await provider.refresh();
    assert.equal(first?.screenshots, "local_only");
    assert.equal(first?.foregroundAppUpload, true);
    // Within TTL: no new fetch, cached value returned.
    responses = [new Error("should not be called")];
    assert.equal((await provider.refresh())?.screenshots, "local_only");
    // After TTL, a failing fetch keeps the last-known value (no flapping).
    now += 61_000;
    responses = [new Error("network down")];
    assert.equal((await provider.refresh())?.screenshots, "local_only");
  });

  it("normalizes partial server settings to safe defaults", () => {
    const policy = normalizeServerCapturePolicy({ screenshots: "banana", localRootAllow: ["C:/work", 5] });
    assert.equal(policy.screenshots, "off");
    assert.equal(policy.foregroundAppCapture, "off");
    assert.deepEqual(policy.localRootAllow, ["C:/work"]);
    assert.equal(policy.windowTitleCapture, false);
  });

  it("skips malformed sampler lines and decodes split UTF-8 output", async () => {
    const warnings: unknown[] = [];
    const samples: unknown[] = [];
    assert.equal(await ingestSamplerLine("{bad json", (sample) => { samples.push(sample); }, silentLogger(warnings)), false);
    assert.equal(await ingestSamplerLine(JSON.stringify({
      sampledAt: "2026-07-07T09:00:00.000Z",
      processName: "Code",
      windowTitle: "Workbench",
      idleSeconds: 300
    }), (sample) => { samples.push(sample); }, silentLogger(warnings), 300), true);
    assert.deepEqual(samples, [{ sampledAt: "2026-07-07T09:00:00.000Z", processName: "Code", windowTitle: "Workbench", idle: true }]);

    const decoder = new StringDecoder("utf8");
    const line = `${JSON.stringify({ sampledAt: "2026-07-07T09:00:00.000Z", processName: "Code", windowTitle: "日本語タイトル" })}\n`;
    const bytes = Buffer.from(line, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("本", "utf8")) + 1;
    assert.equal(decodeSamplerStdoutChunk(decoder, bytes.subarray(0, splitAt)) + decodeSamplerStdoutChunk(decoder, bytes.subarray(splitAt)), line);
  });
});

describe("capture analyser uploader", () => {
  it("registers through analyser, maps exact observations, batches, and advances the new tuple cursor", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
      const gets: string[] = [];
      try {
        storage.setMeta("capture.machineId", "legacy-machine");
        storage.setConfig({ ...DEFAULT_CAPTURE_CONFIG, enabled: true, uploadEnabled: true, windowTitleCapture: true, intervalSeconds: 20 });
        for (let index = 0; index < 501; index += 1) {
          storage.insertSample({
            sampledAt: new Date(Date.parse("2026-07-01T00:00:00.000Z") + index * 1000).toISOString(),
            processName: "Code",
            windowTitle: `Window ${index}`,
            idle: index % 2 === 0
          });
        }
        const uploader = new CaptureUploader({
          storage,
          displayName: "Test daemon",
          platform: "win32",
          createMachineKey: () => "machine-key-1",
          getJson: async <T>(path: string): Promise<T> => {
            gets.push(path);
            return { settings: { foregroundAppUpload: true } } as T;
          },
          postJson: async <T>(path: string, body: unknown): Promise<T> => {
            posts.push({ path, body: body as Record<string, unknown> });
            return (path.endsWith("/register") ? { id: "machine-1" } : { ingested: 1 }) as T;
          }
        });

        await uploader.run();

        assert.deepEqual(posts[0], {
          path: "/api/analyser/machines/register",
          body: { machineKey: "machine-key-1", displayName: "Test daemon", platform: "win32" }
        });
        assert.equal(storage.getMeta(CAPTURE_UPLOAD_META_KEYS.machineId), "machine-1");
        assert.equal(gets[0], "/api/analyser/settings/effective?machineId=machine-1");
        const ingestPosts = posts.filter((call) => call.path === "/api/analyser/observations/ingest");
        assert.deepEqual(ingestPosts.map((call) => (call.body.observations as unknown[]).length), [500, 1]);
        assert.deepEqual((ingestPosts[0].body.observations as Array<Record<string, unknown>>)[0], {
          source: "pc_activity",
          action: "foreground_sample",
          actorKind: "user",
          occurredAt: "2026-07-01T00:00:00.000Z",
          metadata: { app: "Code", idle: true, intervalSeconds: 20 },
          dedupeKey: "pc:machine-1:2026-07-01T00:00:00.000Z"
        });
        assert.deepEqual(JSON.parse(storage.getMeta(CAPTURE_UPLOAD_META_KEYS.samplesCursor) ?? "{}"), {
          sampledAt: "2026-07-01T00:08:20.000Z",
          id: 501
        });
      } finally {
        storage.close();
      }
    });
  });

  it("includes a captured title only when windowTitleUpload is true", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      let observation: Record<string, unknown> | undefined;
      try {
        storage.setConfig({ ...DEFAULT_CAPTURE_CONFIG, enabled: true, uploadEnabled: true, windowTitleCapture: true, windowTitleUpload: true });
        storage.insertSample({ sampledAt: "2026-07-02T09:00:00.000Z", processName: "Code", windowTitle: "Workbench" });
        const uploader = new CaptureUploader({
          storage,
          displayName: "Test daemon",
          platform: "win32",
          getJson: async <T>(): Promise<T> => ({ settings: { foregroundAppUpload: true } }) as T,
          postJson: async <T>(path: string, body: unknown): Promise<T> => {
            if (path.endsWith("/register")) return { id: "machine-1" } as T;
            observation = ((body as { observations: Array<Record<string, unknown>> }).observations)[0];
            return { ingested: 1 } as T;
          }
        });
        await uploader.run();
        assert.deepEqual(observation?.metadata, { app: "Code", idle: false, intervalSeconds: 15, windowTitle: "Workbench" });
      } finally {
        storage.close();
      }
    });
  });

  it("advances the cursor only after a successful ingest", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      let failIngest = true;
      try {
        storage.setConfig({ ...DEFAULT_CAPTURE_CONFIG, enabled: true, uploadEnabled: true });
        storage.insertSample({ sampledAt: "2026-07-03T09:00:00.000Z", processName: "Code", windowTitle: "Workbench" });
        const uploader = new CaptureUploader({
          storage,
          displayName: "Test daemon",
          platform: "win32",
          logger: silentLogger(),
          getJson: async <T>(): Promise<T> => ({ settings: { foregroundAppUpload: true } }) as T,
          postJson: async <T>(path: string): Promise<T> => {
            if (path.endsWith("/register")) return { id: "machine-1" } as T;
            if (failIngest) throw new Error("offline");
            return { ingested: 1 } as T;
          }
        });
        await uploader.run();
        assert.equal(storage.getMeta(CAPTURE_UPLOAD_META_KEYS.samplesCursor), undefined);
        failIngest = false;
        await uploader.run();
        assert.ok(storage.getMeta(CAPTURE_UPLOAD_META_KEYS.samplesCursor));
      } finally {
        storage.close();
      }
    });
  });

  it("fails closed when the effective gate is false or cannot be fetched", async () => {
    for (const policy of ["false", "error"] as const) {
      await withTempDir(async (dir) => {
        const storage = new CaptureStorage(join(dir, "capture.sqlite"));
        const postPaths: string[] = [];
        try {
          storage.setConfig({ ...DEFAULT_CAPTURE_CONFIG, enabled: true, uploadEnabled: true });
          storage.insertSample({ sampledAt: "2026-07-04T09:00:00.000Z", processName: "Code", windowTitle: "Workbench" });
          const uploader = new CaptureUploader({
            storage,
            displayName: "Test daemon",
            platform: "win32",
            logger: silentLogger(),
            getJson: async <T>(): Promise<T> => {
              if (policy === "error") throw new Error("policy unavailable");
              return { settings: { foregroundAppUpload: false } } as T;
            },
            postJson: async <T>(path: string): Promise<T> => {
              postPaths.push(path);
              return { id: "machine-1" } as T;
            }
          });
          await uploader.run();
          assert.equal(postPaths.includes("/api/analyser/observations/ingest"), false);
          assert.equal(uploader.serverUploadAllowed, policy === "false" ? false : null);
        } finally {
          storage.close();
        }
      });
    }
  });

  it("does nothing while local uploadEnabled is false", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      let calls = 0;
      try {
        storage.setConfig({ ...DEFAULT_CAPTURE_CONFIG, enabled: true, uploadEnabled: false });
        const uploader = new CaptureUploader({
          storage,
          displayName: "Test daemon",
          platform: "win32",
          getJson: async <T>(): Promise<T> => { calls += 1; return {} as T; },
          postJson: async <T>(): Promise<T> => { calls += 1; return {} as T; }
        });
        await uploader.run();
        assert.equal(calls, 0);
      } finally {
        storage.close();
      }
    });
  });
});
