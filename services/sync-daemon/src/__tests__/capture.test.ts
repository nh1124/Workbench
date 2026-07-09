import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { describe, it } from "node:test";
import {
  CaptureManager,
  CaptureStorage,
  assertCaptureDbPathAllowed,
  buildCaptureSummaryMarkdown,
  decodeSamplerStdoutChunk,
  ingestSamplerLine,
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
          intervalSeconds: 15,
          retentionDays: 14,
          excludePatterns: ["SecretApp", "["],
          autoPublish: false
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
      { sampledAt: "2026-07-07T09:00:00.000Z", processName: "Code", windowTitle: "Workbench" },
      { sampledAt: "2026-07-07T09:15:00.000Z", processName: "Code", windowTitle: "Workbench" },
      { sampledAt: "2026-07-07T10:00:00.000Z", processName: "Browser", windowTitle: "Docs" }
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
      ""
    ].join("\n"));
    assert.equal(
      buildCaptureSummaryMarkdown("2026-07-08", [], 15),
      "# Capture Daily Summary 2026-07-08\n\nNo samples recorded.\n"
    );
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

        const listed = manager.listSummaries();
        const items = listed.items as Array<Record<string, unknown>>;
        assert.equal(items.length, 1);
        assert.equal(items[0].summaryDate, "2026-07-08");
        assert.equal(items[0].published, false);
        assert.equal("summaryMarkdown" in items[0], false);

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
      windowTitle: "Workbench"
    }), (sample) => {
      samples.push(sample);
    }, silentLogger(warnings));

    assert.equal(skipped, false);
    assert.equal(accepted, true);
    assert.equal(samples.length, 1);
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
