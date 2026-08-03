import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import {
  buildArtifactItemUrl,
  openWorkbenchArtifactItem,
  resolveWorkbenchUiOrigin
} from "../artifactOpen.js";

interface CapturedSpawn {
  command: string;
  args: string[];
  options: {
    stdio: "ignore";
    windowsHide?: boolean;
  };
}

function createSuccessfulSpawn(captured: CapturedSpawn[]) {
  return (command: string, args: string[], options: CapturedSpawn["options"]): ChildProcess => {
    captured.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
}

describe("artifact open MCP helpers", () => {
  it("rejects invalid artifact item ids before launching a browser", async () => {
    const captured: CapturedSpawn[] = [];

    assert.throws(
      () => buildArtifactItemUrl("bad/item", "http://localhost:5173"),
      /Invalid artifactItemId/
    );
    await assert.rejects(
      () => openWorkbenchArtifactItem(
        { artifactItemId: "bad item" },
        { spawnImpl: createSuccessfulSpawn(captured) }
      ),
      /Invalid artifactItemId/
    );
    assert.equal(captured.length, 0);
  });

  it("builds an origin-fixed encoded artifact URL", () => {
    const url = buildArtifactItemUrl("artifact.item_1-2", "https://ui.example.test/base/path?ignored=1");
    const parsed = new URL(url);

    assert.equal(url, "https://ui.example.test/artifacts?item=artifact.item_1-2");
    assert.equal(parsed.origin, "https://ui.example.test");
    assert.equal(parsed.pathname, "/artifacts");
    assert.equal(parsed.searchParams.get("item"), "artifact.item_1-2");
  });

  it("rejects non-http UI origins", () => {
    assert.throws(
      () => resolveWorkbenchUiOrigin("file:///tmp/workbench/index.html"),
      /only http and https URLs are supported/
    );
    assert.throws(
      () => resolveWorkbenchUiOrigin("not a url"),
      /expected a valid http or https URL/
    );
  });

  it("opens the built URL with a platform-specific spawn command", async () => {
    const captured: CapturedSpawn[] = [];

    const result = await openWorkbenchArtifactItem(
      { artifactItemId: "artifact-1" },
      {
        uiOrigin: "http://localhost:5173/app",
        platform: "win32",
        spawnImpl: createSuccessfulSpawn(captured)
      }
    );

    assert.deepEqual(result, {
      opened: true,
      url: "http://localhost:5173/artifacts?item=artifact-1"
    });
    assert.deepEqual(captured, [{
      command: "cmd",
      args: ["/c", "start", "", "http://localhost:5173/artifacts?item=artifact-1"],
      options: { stdio: "ignore", windowsHide: true }
    }]);
  });
});
