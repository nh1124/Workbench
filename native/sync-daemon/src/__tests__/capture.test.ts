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
  FileWatcher,
  CAPTURE_UPLOAD_META_KEYS,
  DEFAULT_CAPTURE_CONFIG,
  assertCaptureDbPathAllowed,
  decodeSamplerStdoutChunk,
  ingestSamplerLine,
  isLocalFilePathAllowed,
  normalizeServerCapturePolicy,
  shouldCaptureScreenshot,
  validateCaptureConfigPatch,
  type CaptureLogger,
  type LocalFileEvent
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

describe("local file watcher", () => {
  it("denies configured roots and exclude matches, allows other paths, and ignores invalid regexes", () => {
    const root = join(tmpdir(), "workbench-local-file-root");
    const warnings: unknown[] = [];
    const policy = { localRootDeny: [join(root, "private")], excludePatterns: ["node_modules", "["] };
    assert.equal(isLocalFilePathAllowed(root, join("private", "secret.txt"), policy, silentLogger(warnings)), false);
    assert.equal(isLocalFilePathAllowed(root, join("node_modules", "package.json"), policy, silentLogger(warnings)), false);
    assert.equal(isLocalFilePathAllowed(root, join("src", "index.ts"), policy, silentLogger(warnings)), true);
    assert.ok(warnings.length >= 1);
  });

  it("emits allowed file metadata, filters deny/exclude, detects deletes, and clears on drain", async () => {
    await withTempDir(async (root) => {
      // Real files: the watcher stats the resolved path (statSync is not injected).
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "private"), { recursive: true });
      await writeFile(join(root, "src", "index.ts"), "content", "utf8");
      await writeFile(join(root, "private", "secret.txt"), "secret", "utf8");
      await writeFile(join(root, "cache.tmp"), "tmp", "utf8");

      type WatchCallback = (eventType: "rename" | "change", filename: string | null) => void;
      const callbacks = new Map<string, WatchCallback>();
      const watchImpl = ((watchedRoot: string, _options: unknown, callback: WatchCallback) => {
        callbacks.set(watchedRoot, callback);
        return { close() {} };
      }) as unknown as typeof import("node:fs").watch;

      const policy = normalizeServerCapturePolicy({
        localRootAllow: [root],
        localRootDeny: [join(root, "private")],
        excludePatterns: ["\\.tmp$", "["]
      });
      const warnings: unknown[] = [];
      const watcher = new FileWatcher({
        getPolicy: () => policy,
        getEnabled: () => true,
        watchImpl,
        now: () => new Date("2026-07-21T03:04:05.000Z"),
        logger: silentLogger(warnings)
      });
      watcher.sync();
      const callback = callbacks.get(root);
      assert.ok(callback);
      callback("change", "src/index.ts");
      callback("change", "private/secret.txt");
      callback("change", "cache.tmp");
      callback("rename", "removed.txt");

      const events = watcher.drain();
      assert.equal(events.length, 2);
      const [modified, deleted] = events;
      assert.equal(modified.eventType, "modified");
      assert.equal(modified.relativePath, "src/index.ts");
      assert.equal(modified.observedAt, "2026-07-21T03:04:05.000Z");
      assert.equal(typeof modified.size, "number");
      assert.equal(typeof modified.mtime, "string");
      assert.equal(deleted.eventType, "deleted");
      assert.equal(deleted.relativePath, "removed.txt");
      assert.equal(deleted.mtime, undefined);
      watcher.requeue(events);
      assert.deepEqual(watcher.drain(), events);
      assert.deepEqual(watcher.drain(), []);
      assert.ok(warnings.length >= 1); // the invalid "[" exclude pattern is detected and logged
      watcher.stop();
    });
  });

  it("adds new roots, closes removed roots on sync, and stops all watchers", () => {
    const roots = [join(tmpdir(), "watch-a"), join(tmpdir(), "watch-b"), join(tmpdir(), "watch-c")];
    const watched: string[] = [];
    const closed: string[] = [];
    const watchImpl = ((root: string) => {
      watched.push(root);
      return { close: () => { closed.push(root); } };
    }) as unknown as typeof import("node:fs").watch;
    let allow = [roots[0], roots[1]];
    const watcher = new FileWatcher({
      getPolicy: () => normalizeServerCapturePolicy({ localRootAllow: allow }),
      getEnabled: () => true,
      watchImpl
    });
    watcher.sync();
    watcher.sync(); // idempotent — no new watchers for unchanged roots
    assert.deepEqual(watched, [roots[0], roots[1]]);

    allow = [roots[1], roots[2]];
    watcher.sync();
    assert.deepEqual(watched, [roots[0], roots[1], roots[2]]);
    assert.deepEqual(closed, [roots[0]]);
    watcher.stop();
    assert.deepEqual(closed.sort(), [roots[0], roots[1], roots[2]].sort());
  });

  it("stops watching when the local opt-in is off", () => {
    const closed: string[] = [];
    const watchImpl = ((root: string) => ({ close: () => { closed.push(root); } })) as unknown as typeof import("node:fs").watch;
    let enabled = true;
    const watcher = new FileWatcher({
      getPolicy: () => normalizeServerCapturePolicy({ localRootAllow: [join(tmpdir(), "watch-x")] }),
      getEnabled: () => enabled,
      watchImpl
    });
    watcher.sync();
    enabled = false;
    watcher.sync();
    assert.equal(closed.length, 1);
  });

  it("handles async watcher errors and removes the failed root", () => {
    const root = join(tmpdir(), "watch-error");
    const warnings: unknown[] = [];
    let errorHandler: ((error: Error) => void) | undefined;
    let watched = 0;
    let closed = 0;
    const watchImpl = (() => {
      watched += 1;
      return {
        on(event: string, handler: (error: Error) => void) {
          if (event === "error") errorHandler = handler;
        },
        close() { closed += 1; }
      };
    }) as unknown as typeof import("node:fs").watch;
    const watcher = new FileWatcher({
      getPolicy: () => normalizeServerCapturePolicy({ localRootAllow: [root] }),
      getEnabled: () => true,
      watchImpl,
      logger: silentLogger(warnings)
    });

    watcher.sync();
    assert.ok(errorHandler);
    assert.doesNotThrow(() => errorHandler?.(new Error("watch failed")));
    assert.equal(closed, 1);
    assert.equal(warnings.length, 1);
    watcher.sync();
    assert.equal(watched, 2);
    watcher.stop();
  });
});

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
        assert.equal(config.localFileEnabled, false);
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

  it("validates title, upload, local file, screenshot, idle, and category settings", () => {
    assert.deepEqual(validateCaptureConfigPatch({
      uploadEnabled: true,
      windowTitleCapture: true,
      windowTitleUpload: true,
      localFileEnabled: true,
      screenshotsEnabled: true,
      screenshotIntervalSeconds: 60,
      screenshotRetentionDays: 90,
      idleThresholdSeconds: 60,
      categoryMap: { CODE: "Coding" }
    }), {
      uploadEnabled: true,
      windowTitleCapture: true,
      windowTitleUpload: true,
      localFileEnabled: true,
      screenshotsEnabled: true,
      screenshotIntervalSeconds: 60,
      screenshotRetentionDays: 90,
      idleThresholdSeconds: 60,
      categoryMap: { CODE: "Coding" }
    });
    assert.deepEqual(validateCaptureConfigPatch({ autoPublish: true }), {});
    assert.throws(() => validateCaptureConfigPatch({ windowTitleCapture: "yes" }), /windowTitleCapture/);
    assert.throws(() => validateCaptureConfigPatch({ localFileEnabled: "yes" }), /localFileEnabled/);
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
        logger: silentLogger(),
        getServerPolicy: () => normalizeServerCapturePolicy({ foregroundAppCapture: true })
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
      let policy: ReturnType<typeof normalizeServerCapturePolicy> | null = null;
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
        manager.storage.updateConfig({ screenshotsEnabled: true, windowTitleCapture: true, localFileEnabled: true } as never);
        const unknownPolicy = (manager as unknown as { effectiveConfig(): Record<string, unknown> }).effectiveConfig();
        assert.equal(unknownPolicy.enabled, false);
        assert.equal(unknownPolicy.screenshotsEnabled, false);
        assert.equal(unknownPolicy.localFileEnabled, false);
        policy = normalizeServerCapturePolicy({
          foregroundAppCapture: false,
          screenshots: "off",
          windowTitleCapture: false,
          localFileEvents: "off"
        });
        // Server says off → effective config disables both, and window titles are
        // blanked at persistence even though the local opt-in is on.
        manager.storage.insertSample(
          { sampledAt: "2026-07-10T00:00:00.000Z", processName: "Code", windowTitle: "secret doc" },
          (manager as unknown as { effectiveConfig(): { windowTitleCapture: boolean } }).effectiveConfig() as never
        );
        const disabled = (manager as unknown as { effectiveConfig(): Record<string, unknown> }).effectiveConfig();
        assert.equal(disabled.enabled, false);
        assert.equal(disabled.localFileEnabled, false);
        // Flip the server policy on; effective config now permits capture.
        policy = normalizeServerCapturePolicy({
          foregroundAppCapture: true,
          screenshots: "local_only",
          windowTitleCapture: true,
          localFileEvents: "metadata"
        });
        const effective = (manager as unknown as { effectiveConfig(): Record<string, unknown> }).effectiveConfig();
        assert.equal(effective.enabled, true);
        assert.equal(effective.screenshotsEnabled, true);
        assert.equal(effective.windowTitleCapture, true);
        assert.equal(effective.localFileEnabled, true);
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
    assert.equal(policy.foregroundAppCapture, false);
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
  it("maps local file metadata observations, gates on localFileUpload, and batches at 500", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      const ingestPosts: Array<{ machineId: string; observations: Array<Record<string, unknown>> }> = [];
      let uploadAllowed = false;
      try {
        const uploader = new CaptureUploader({
          storage,
          displayName: "Test daemon",
          platform: "win32",
          createMachineKey: () => "machine-key-1",
          getServerPolicy: () => normalizeServerCapturePolicy({ localFileUpload: uploadAllowed }),
          getJson: async <T>(): Promise<T> => ({} as T),
          postJson: async <T>(path: string, body: unknown): Promise<T> => {
            if (path === "/api/analyser/machines/register") return { id: "machine-1" } as T;
            ingestPosts.push(body as { machineId: string; observations: Array<Record<string, unknown>> });
            return { ingested: 1 } as T;
          }
        });
        const first: LocalFileEvent = {
          eventType: "modified",
          root: "C:\\work",
          relativePath: "src/index.ts",
          observedAt: "2026-07-21T03:04:05.000Z",
          mtime: "2026-07-21T03:04:00.000Z",
          size: 42
        };
        const events = [first, ...Array.from({ length: 500 }, (_, index): LocalFileEvent => ({
          eventType: "deleted",
          root: "C:\\work",
          relativePath: `removed-${index}.txt`,
          observedAt: "2026-07-21T03:04:05.000Z"
        }))];

        // localFileUpload=false → no upload at all.
        await uploader.uploadFileEvents(events);
        assert.equal(ingestPosts.length, 0);

        uploadAllowed = true;
        await uploader.uploadFileEvents(events);

        assert.deepEqual(ingestPosts.map((post) => post.observations.length), [500, 1]);
        assert.equal(ingestPosts.every((post) => post.machineId === "machine-1"), true);
        assert.deepEqual(ingestPosts[0].observations[0], {
          source: "local_file",
          action: "file_modified",
          actorKind: "user",
          occurredAt: "2026-07-21T03:04:05.000Z",
          resourceRefs: [{ service: "local", resourceType: "file", resourceId: "src/index.ts", pathSnapshot: "C:\\work" }],
          metadata: {
            eventType: "modified",
            root: "C:\\work",
            relativePath: "src/index.ts",
            mtime: "2026-07-21T03:04:00.000Z",
            size: 42
          },
          dedupeKey: "local_file:machine-1:C:\\work:src/index.ts:modified:2026-07-21T03:04:00.000Z"
        });
        assert.equal(
          ingestPosts[0].observations[1]?.dedupeKey,
          "local_file:machine-1:C:\\work:removed-0.txt:deleted:2026-07-21T03:04:05.000Z"
        );
      } finally {
        storage.close();
      }
    });
  });

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
