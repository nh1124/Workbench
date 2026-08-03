import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(__dirname, "../..");
const entrySource = readFileSync(path.join(daemonRoot, "src/index.ts"), "utf8");
const buildScript = readFileSync(path.join(daemonRoot, "scripts/build-tauri-sidecar.mjs"), "utf8");

/**
 * The Tauri sidecar is built by copying src/index.ts two directories down and
 * repointing its sibling imports at the real source tree. That rewrite used to
 * be a hand-written list of specifiers, so it broke every time index.ts gained
 * or lost a module — three times, each found only when someone ran the desktop
 * app. These hold the invariants the rewrite depends on.
 */

const siblingImports = [...entrySource.matchAll(/from\s+"\.\/([A-Za-z0-9/_.-]+)\.js"/g)].map(
  (match) => match[1]
);

describe("tauri sidecar entry", () => {
  it("imports siblings that all exist as TypeScript sources", () => {
    assert.ok(siblingImports.length > 0, "index.ts should import its sibling modules");

    const missing = siblingImports.filter(
      (modulePath) => !existsSync(path.join(daemonRoot, "src", `${modulePath}.ts`))
    );

    assert.deepEqual(
      missing,
      [],
      `the sidecar build cannot repoint these: ${missing.join(", ")}`
    );
  });

  it("uses only static specifiers the rewrite can see", () => {
    // A dynamic import would survive the rewrite and then fail to resolve from
    // the generated entry's directory.
    assert.equal(/\bimport\s*\(/.test(entrySource), false, "index.ts must not use dynamic import()");
    assert.equal(/\brequire\s*\(/.test(entrySource), false, "index.ts must not use require()");
  });

  it("keeps the anchors the build script still matches literally", () => {
    // The rewrite is generic now, but these two are still matched by hand.
    assert.ok(
      entrySource.includes("const __filename = fileURLToPath(import.meta.url);"),
      "the sidecar build replaces this line to make __filename the executable path"
    );
    assert.ok(
      /if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === __filename\) \{\r?\n  await main\(\);\r?\n\}\s*$/.test(
        entrySource
      ),
      "the sidecar build replaces the main block so the daemon runs unconditionally"
    );
  });

  it("rewrites whatever index.ts imports rather than a fixed list", () => {
    // The regression that kept recurring: the script named each module it knew
    // about, so a new module was silently left behind.
    const namedModules = siblingImports.filter((modulePath) =>
      buildScript.includes(`"./${modulePath}.js"`)
    );

    assert.deepEqual(
      namedModules,
      [],
      `the build script hardcodes these specifiers and will drift again: ${namedModules.join(", ")}`
    );
  });
});
