import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const coreSource = readFileSync(path.join(repoRoot, "services/workbench-core/src/httpServer.ts"), "utf8");
const viteSource = readFileSync(path.join(repoRoot, "ui/vite.config.ts"), "utf8");

/**
 * The UI and the API share one origin, because the refresh token is an HttpOnly
 * cookie and a second origin would drop it. Which paths belong to the API is
 * therefore decided twice:
 *
 *   production — Core serves ui/dist and treats these prefixes as reserved, so
 *                everything else falls through to index.html
 *   development — Vite serves the UI and proxies these prefixes to Core
 *
 * The two lists have to agree. If they drift, a path works in one and returns
 * the SPA's HTML in the other, which surfaces as a JSON parse error far from
 * the cause.
 */

/** Pull the string literals out of a named array declaration. */
function arrayLiterals(source: string, name: string): string[] {
  const match = new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`, "s").exec(source);
  if (!match) throw new Error(`could not find the ${name} array`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
}

const corePrefixes = arrayLiterals(coreSource, "reservedPrefixes");
const vitePrefixes = arrayLiterals(viteSource, "corePrefixes");

describe("UI and API share one origin", () => {
  it("reserves a non-empty set of API prefixes", () => {
    assert.ok(corePrefixes.length >= 5, `expected the API prefixes, found ${corePrefixes.length}`);
    // The ones the auth flow depends on, spelled out so a silent removal fails.
    for (const required of ["/api", "/auth", "/oauth", "/.well-known"]) {
      assert.ok(corePrefixes.includes(required), `${required} must stay reserved`);
    }
  });

  it("proxies in dev exactly what production reserves", () => {
    assert.deepEqual(
      vitePrefixes,
      corePrefixes,
      "ui/vite.config.ts and services/workbench-core/src/httpServer.ts disagree about which paths are the API"
    );
  });

  it("leaves the SPA fallback to the catch-all rather than express.static", () => {
    // With `index: true` static would answer "/" itself, so the fallback would
    // live in two places and only one of them would have the guards below.
    assert.match(
      coreSource,
      /express\.static\(uiDistPath,\s*\{[^}]*index:\s*false/s,
      "express.static must not serve index.html"
    );
  });

  it("keeps the catch-all from answering API requests with HTML", () => {
    assert.match(
      coreSource,
      /if \(isReservedHttpPath\(pathname\)\) return false;/,
      "a reserved path must never fall through to index.html"
    );
    assert.match(
      coreSource,
      /if \(req\.method !== "GET" && req\.method !== "HEAD"\) return false;/,
      "only GET/HEAD may be answered with the SPA"
    );
    assert.match(
      coreSource,
      /accept\.includes\("text\/html"\) \|\| accept\.includes\("\*\/\*"\)/,
      "a request that did not ask for HTML must not receive the SPA"
    );
  });

  it("serves the UI only when it has been built", () => {
    // Without this guard every unmatched path would 500 on a missing file
    // instead of falling through to a 404 on an API-only deployment.
    assert.match(coreSource, /if \(existsSync\(uiIndexHtmlPath\)\)/);
  });
});
