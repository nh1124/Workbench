import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { describe, it } from "node:test";
import {
  CaptureManager,
  CaptureStorage,
  DEFAULT_CAPTURE_CONFIG,
  analyzeCaptureSummary,
  assertCaptureDbPathAllowed,
  buildCaptureSummaryMarkdown,
  decodeSamplerStdoutChunk,
  ingestSamplerLine,
  shouldCaptureScreenshot,
  validateCaptureConfigPatch,
  type CaptureLogger,
  type CaptureSummaryPublisher
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
    warn(...args: unknown[]) {
      warnings.push(args);
    },
    error(...args: unknown[]) {
      warnings.push(args);
    }
  };
}

describe("capture storage and summarization", () => {
  it("rejects capture DB paths inside the sync root or .workbench metadata", async () => {
    await withTempDir(async (dir) => {
      const syncRoot = join(dir, "sync-root");
      assert.throws(
        () => assertCaptureDbPathAllowed(join(syncRoot, "capture.sqlite"), syncRoot),
        /sync root/
      );
      assert.throws(
        () => assertCaptureDbPathAllowed(join(dir, ".workbench", "capture.sqlite"), syncRoot),
        /\.workbench/
      );
    });
  });

  it("does not persist samples that match exclude patterns and ignores invalid patterns", async () => {
    await withTempDir(async (dir) => {
      const warnings: unknown[] = [];
      const storage = new CaptureStorage(join(dir, "capture.sqlite"), { logger: silentLogger(warnings) });
      try {
        const config = storage.setConfig({
          enabled: true,
          screenshotsEnabled: false,
          screenshotIntervalSeconds: 300,
          screenshotRetentionDays: 7,
          intervalSeconds: 15,
          retentionDays: 14,
          excludePatterns: ["SecretApp", "["],
          autoPublish: false,
          idleThresholdSeconds: 300,
          categoryMap: { Code: "Editor" }
        });
        const skipped = storage.insertSample({
          sampledAt: "2026-07-07T09:00:00.000Z",
          processName: "SecretApp",
          windowTitle: "Private work"
        }, config);
        const inserted = storage.insertSample({
          sampledAt: "2026-07-07T09:15:00.000Z",
          processName: "Code",
          windowTitle: "Workbench"
        }, config);

        assert.equal(skipped, false);
        assert.equal(inserted, true);
        assert.equal(storage.listSamplesForDate("2026-07-07").length, 1);
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
        storage.insertSample({
          sampledAt: "2026-06-30T23:59:00.000Z",
          processName: "Old",
          windowTitle: "Old"
        });
        storage.insertSample({
          sampledAt: "2026-07-02T00:00:00.000Z",
          processName: "Current",
          windowTitle: "Current"
        });

        const removed = storage.deleteSamplesOlderThan(14, new Date("2026-07-15T00:00:00.000Z"));

        assert.equal(removed, 1);
        assert.deepEqual(storage.listSamplesForDate("2026-06-30"), []);
        assert.equal(storage.listSamplesForDate("2026-07-02").length, 1);
      } finally {
        storage.close();
      }
    });
  });

  it("builds deterministic markdown from fixed samples", () => {
    const markdown = buildCaptureSummaryMarkdown("2026-07-07", [
      { sampledAt: "2026-07-07T09:00:00.000Z", processName: "Code", windowTitle: "Workbench", idle: false },
      { sampledAt: "2026-07-07T09:15:00.000Z", processName: "Code", windowTitle: "Workbench", idle: false },
      { sampledAt: "2026-07-07T10:00:00.000Z", processName: "Browser", windowTitle: "Docs", idle: false }
    ], 15);

    assert.equal(markdown, [
      "# Capture Daily Summary 2026-07-07",
      "",
      "## App Activity",
      "",
      "| App | Active Time | Samples |",
      "|---|---:|---:|",
      "| Code | 30s | 2 |",
      "| Browser | 15s | 1 |",
      "",
      "## Top Window Titles",
      "",
      "| Window Title | Count |",
      "|---|---:|",
      "| Workbench | 2 |",
      "| Docs | 1 |",
      "",
      "## Timeline",
      "",
      "| Hour | Primary App | Samples |",
      "|---|---|---:|",
      "| 09:00 | Code | 2 |",
      "| 10:00 | Browser | 1 |",
      "",
      "## Focus Blocks",
      "",
      "| Start - End | App | Window Title | Active Time |",
      "|---|---|---|---:|",
      "",
      "## Context Switches",
      "",
      "1",
      "",
      "## Categories",
      "",
      "| Category | Active Time |",
      "|---|---:|",
      "| Editor | 30s |",
      "| Other | 15s |",
      "",
      "## Idle Time",
      "",
      "0s",
      ""
    ].join("\n"));
    assert.equal(
      buildCaptureSummaryMarkdown("2026-07-08", [], 15),
      "# Capture Daily Summary 2026-07-08\n\nNo samples recorded.\n"
    );
  });

  it("validates screenshot config defaults and patch bounds", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      try {
        assert.equal(storage.getConfig().screenshotsEnabled, false);
        assert.equal(storage.getConfig().screenshotIntervalSeconds, 300);
        assert.equal(storage.getConfig().screenshotRetentionDays, 7);
      } finally { storage.close(); }
    });
    assert.deepEqual(validateCaptureConfigPatch({ screenshotsEnabled: true, screenshotIntervalSeconds: 60, screenshotRetentionDays: 90 }), {
      screenshotsEnabled: true, screenshotIntervalSeconds: 60, screenshotRetentionDays: 90
    });
    assert.throws(() => validateCaptureConfigPatch({ screenshotIntervalSeconds: 59 }), /between 60 and 3600/);
    assert.throws(() => validateCaptureConfigPatch({ screenshotRetentionDays: 91 }), /between 1 and 90/);
  });

  it("stores and lists screenshot metadata without exposing file paths", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      try {
        const id = storage.insertScreenshot({ capturedAt: "2026-07-10T10:20:30.000Z", filePath: join(storage.screenshotsDir, "2026-07-10", "102030.png"), processName: "Code", windowTitle: "Workbench" });
        storage.insertScreenshot({ capturedAt: "2026-07-09T10:20:30.000Z", filePath: join(storage.screenshotsDir, "2026-07-09", "102030.png") });
        const result = storage.listScreenshots({ date: "2026-07-10" });
        assert.deepEqual(result.items, [{ id, capturedAt: "2026-07-10T10:20:30.000Z", processName: "Code", windowTitle: "Workbench" }]);
        assert.equal("filePath" in result.items[0], false);
      } finally { storage.close(); }
    });
  });

  it("deletes retained screenshot rows, files, and empty date directories", async () => {
    await withTempDir(async (dir) => {
      const storage = new CaptureStorage(join(dir, "capture.sqlite"));
      try {
        const dayDir = join(storage.screenshotsDir, "2026-07-01");
        const filePath = join(dayDir, "120000.png");
        await mkdir(dayDir, { recursive: true });
        await writeFile(filePath, "png");
        storage.insertScreenshot({ capturedAt: "2026-07-01T12:00:00.000Z", filePath });
        assert.equal(storage.deleteScreenshotsOlderThan(7, new Date("2026-07-10T12:00:00.000Z")), 1);
        await assert.rejects(access(filePath));
        await assert.rejects(access(dayDir));
        assert.deepEqual(storage.listScreenshots().items, []);
      } finally { storage.close(); }
    });
  });

  it("skips screenshots without a foreground sample or while excluded", () => {
    const config = { ...DEFAULT_CAPTURE_CONFIG, enabled: true, screenshotsEnabled: true, excludePatterns: ["Secret"] };
    assert.equal(shouldCaptureScreenshot(config), false);
    assert.equal(shouldCaptureScreenshot(config, { sampledAt: "2026-07-10T00:00:00.000Z", processName: "SecretApp", windowTitle: "private" }), false);
    assert.equal(shouldCaptureScreenshot(config, { sampledAt: "2026-07-10T00:00:00.000Z", processName: "Code", windowTitle: "Workbench" }), true);
  });

  it("aggregates focus blocks, switches, categories, and idle time deterministically", () => {
    const start = new Date("2026-07-09T09:00:00.000Z").getTime();
    const codeSamples = Array.from({ length: 60 }, (_, index) => ({
      sampledAt: new Date(start + index * 15_000).toISOString(),
      processName: "Code",
      windowTitle: "Workbench",
      idle: false
    }));
    const analysis = analyzeCaptureSummary("2026-07-09", [
      ...codeSamples,
      { sampledAt: "2026-07-09T09:15:00.000Z", processName: "msedge", windowTitle: "Docs", idle: false },
      { sampledAt: "2026-07-09T09:15:15.000Z", processName: "msedge", windowTitle: "Docs", idle: false },
      { sampledAt: "2026-07-09T09:15:30.000Z", processName: "Code", windowTitle: "Workbench", idle: true },
      { sampledAt: "2026-07-09T09:15:45.000Z", processName: "Code", windowTitle: "Workbench", idle: false }
    ], 15, { CODE: "Coding", MSEDGE: "Web" });

    assert.deepEqual(analysis.metrics, {
      activeSeconds: 945,
      idleSeconds: 15,
      contextSwitches: 2,
      focusBlocks: [{
        startAt: "2026-07-09T09:00:00.000Z",
        endAt: "2026-07-09T09:15:00.000Z",
        app: "Code",
        title: "Workbench",
        activeSeconds: 900
      }],
      categories: { Coding: 915, Web: 30 },
      apps: { Code: 915, msedge: 30 }
    });
    assert.match(analysis.markdown, /\| 09:00 - 09:15 \| Code \| Workbench \| 15m 0s \|/);
    assert.match(analysis.markdown, /## Context Switches\n\n2/);
    assert.match(analysis.markdown, /## Idle Time\n\n15s/);
  });

  it("splits a same-window session when a sample gap exceeds two intervals", () => {
    const start = new Date("2026-07-10T09:00:00.000Z").getTime();
    const samples = Array.from({ length: 59 }, (_, index) => ({
      sampledAt: new Date(start + index * 15_000).toISOString(),
      processName: "Code",
      windowTitle: "Workbench",
      idle: false
    }));
    samples.push({
      sampledAt: new Date(start + 61 * 15_000).toISOString(),
      processName: "Code",
      windowTitle: "Workbench",
      idle: false
    });

    const analysis = analyzeCaptureSummary("2026-07-10", samples, 15);

    assert.equal(analysis.metrics.activeSeconds, 900);
    assert.deepEqual(analysis.metrics.focusBlocks, []);
  });

  it("validates idle threshold and category map config patches", () => {
    assert.deepEqual(validateCaptureConfigPatch({
      idleThresholdSeconds: 60,
      categoryMap: { CODE: "Coding" }
    }), {
      idleThresholdSeconds: 60,
      categoryMap: { CODE: "Coding" }
    });
    assert.throws(() => validateCaptureConfigPatch({ idleThresholdSeconds: 59 }), /between 60 and 3600/);
    assert.throws(() => validateCaptureConfigPatch({ categoryMap: { Code: "" } }), /categoryMap/);
  });

  it("updates the same daily summary on regeneration", async () => {
    await withTempDir(async (dir) => {
      const calls: Array<{ noteResourceId?: string; title: string }> = [];
      const publisher: CaptureSummaryPublisher = {
        async publishSummary(input) {
          calls.push({ noteResourceId: input.noteResourceId, title: input.title });
          return {
            noteResourceId: input.noteResourceId ?? "note-capture-2026-07-07",
            action: input.noteResourceId ? "update" : "create"
          };
        }
      };
      const manager = new CaptureManager({
        syncRoot: join(dir, "sync-root"),
        dbPath: join(dir, "capture.sqlite"),
        platform: "win32",
        logger: silentLogger(),
        publisher
      });
      try {
        manager.storage.updateConfig({ autoPublish: true });
        manager.storage.insertSample({
          sampledAt: "2026-07-07T09:00:00.000Z",
          processName: "Code",
          windowTitle: "Workbench"
        });

        const first = await manager.summarize("2026-07-07", new Date("2026-07-07T12:00:00.000Z"));
        const second = await manager.summarize("2026-07-07", new Date("2026-07-07T12:05:00.000Z"));

        assert.equal(first.action, "create");
        assert.equal(second.action, "update");
        assert.deepEqual(calls, [
          { noteResourceId: undefined, title: "Capture Daily Summary 2026-07-07" },
          { noteResourceId: "note-capture-2026-07-07", title: "Capture Daily Summary 2026-07-07" }
        ]);
      } finally {
        manager.close();
      }
    });
  });

  it("stores summaries without publishing by default and publishes on demand", async () => {
    await withTempDir(async (dir) => {
      const calls: Array<{ noteResourceId?: string; contentMarkdown: string }> = [];
      const publisher: CaptureSummaryPublisher = {
        async publishSummary(input) {
          calls.push({ noteResourceId: input.noteResourceId, contentMarkdown: input.contentMarkdown });
          return {
            noteResourceId: input.noteResourceId ?? "note-capture-2026-07-08",
            action: input.noteResourceId ? "update" : "create"
          };
        }
      };
      const manager = new CaptureManager({
        syncRoot: join(dir, "sync-root"),
        dbPath: join(dir, "capture.sqlite"),
        platform: "win32",
        logger: silentLogger(),
        publisher
      });
      try {
        manager.storage.insertSample({
          sampledAt: "2026-07-08T09:00:00.000Z",
          processName: "Code",
          windowTitle: "Workbench"
        });

        const saved = await manager.summarize("2026-07-08", new Date("2026-07-08T12:00:00.000Z"));
        assert.equal(saved.action, "saved");
        assert.equal(saved.published, false);
        assert.equal(calls.length, 0);

        const detail = manager.summaryDetail("2026-07-08");
        assert.match(String(detail.summaryMarkdown), /Capture Daily Summary 2026-07-08/);
        assert.deepEqual(detail.metrics, {
          activeSeconds: 15,
          idleSeconds: 0,
          contextSwitches: 0,
          focusBlocks: [],
          categories: { Editor: 15 },
          apps: { Code: 15 }
        });

        const listed = manager.listSummaries();
        const items = listed.items as Array<Record<string, unknown>>;
        assert.equal(items.length, 1);
        assert.equal(items[0].summaryDate, "2026-07-08");
        assert.equal(items[0].published, false);
        assert.equal("summaryMarkdown" in items[0], false);
        assert.equal("metrics" in items[0], false);

        const first = await manager.publishSummary("2026-07-08");
        assert.equal(first.action, "create");
        assert.equal(first.published, true);
        const second = await manager.publishSummary("2026-07-08");
        assert.equal(second.action, "update");
        assert.equal(calls.length, 2);
        assert.equal(calls[1].noteResourceId, "note-capture-2026-07-08");
        assert.equal(calls[0].contentMarkdown, calls[1].contentMarkdown);

        await assert.rejects(() => manager.publishSummary("2026-01-01"), /No capture summary exists/);
      } finally {
        manager.close();
      }
    });
  });

  it("rejects enable on unsupported OS", async () => {
    await withTempDir(async (dir) => {
      const manager = new CaptureManager({
        syncRoot: join(dir, "sync-root"),
        dbPath: join(dir, "capture.sqlite"),
        platform: "linux",
        logger: silentLogger(),
        publisher: {
          async publishSummary() {
            throw new Error("not used");
          }
        }
      });
      try {
        await assert.rejects(() => manager.enable(), /only supported on Windows/);
        assert.equal(manager.config().enabled, false);
      } finally {
        manager.close();
      }
    });
  });

  it("skips malformed sampler JSON lines", async () => {
    const warnings: unknown[] = [];
    const samples: unknown[] = [];
    const skipped = await ingestSamplerLine("{bad json", (sample) => {
      samples.push(sample);
    }, silentLogger(warnings));
    const accepted = await ingestSamplerLine(JSON.stringify({
      sampledAt: "2026-07-07T09:00:00.000Z",
      processName: "Code",
      windowTitle: "Workbench",
      idleSeconds: 300
    }), (sample) => {
      samples.push(sample);
    }, silentLogger(warnings), 300);

    assert.equal(skipped, false);
    assert.equal(accepted, true);
    assert.equal(samples.length, 1);
    assert.deepEqual(samples, [{
      sampledAt: "2026-07-07T09:00:00.000Z",
      processName: "Code",
      windowTitle: "Workbench",
      idle: true
    }]);
    assert.ok(warnings.length >= 1);
  });

  it("decodes sampler stdout when UTF-8 characters span chunks", () => {
    const decoder = new StringDecoder("utf8");
    const line = `${JSON.stringify({
      sampledAt: "2026-07-07T09:00:00.000Z",
      processName: "Code",
      windowTitle: "日本語タイトル"
    })}\n`;
    const bytes = Buffer.from(line, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("本", "utf8")) + 1;

    const first = decodeSamplerStdoutChunk(decoder, bytes.subarray(0, splitAt));
    const second = decodeSamplerStdoutChunk(decoder, bytes.subarray(splitAt));

    assert.equal(first + second, line);
  });
});
