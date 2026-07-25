import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Cross-service auth conformance.
 *
 * Each domain service keeps its own copy of the bearer-token middleware. That
 * duplication is deliberate — it keeps services independently deployable and
 * keeps the blast radius of a change to one service inside that service — but
 * it means a flaw in the shared *idea* (unpinned algorithm, unchecked issuer,
 * refresh tokens accepted as access tokens) has to be fixed in every copy, and
 * nothing makes a missed copy visible.
 *
 * This test asserts the security-critical invariants hold in every service's
 * auth module without introducing a shared runtime dependency between them.
 * Services are discovered from the filesystem, so a newly added service is
 * covered the moment it ships an auth.ts.
 *
 * It is deliberately a source-level check: importing each module would require
 * every service's env and database, which would make the guard too expensive to
 * keep green.
 */

const servicesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Core issues and refreshes tokens rather than only verifying them, so its auth
// module has a different shape and is asserted separately below.
const CORE_SERVICE = "workbench-core";

function discoverServiceAuthModules(): Array<{ service: string; source: string; httpServer: string }> {
  return readdirSync(servicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== CORE_SERVICE)
    .map((entry) => ({ service: entry.name, file: path.join(servicesDir, entry.name, "src", "auth.ts") }))
    .filter((candidate) => existsSync(candidate.file))
    .map((candidate) => ({
      service: candidate.service,
      // Collapse whitespace so formatting differences between services (analyser
      // writes the verify options on one line) do not affect the assertions.
      source: readFileSync(candidate.file, "utf8").replace(/\s+/g, " "),
      httpServer: readServiceHttpServer(candidate.service)
    }));
}

function readServiceHttpServer(service: string): string {
  const file = path.join(servicesDir, service, "src", "httpServer.ts");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// Services namespace the key when Core addresses them individually
// (INTERNAL_API_KEY_ANALYSER, INTERNAL_API_KEY_WBS).
const INTERNAL_API_KEY_ENV = /requireEnv\("INTERNAL_API_KEY(_[A-Z]+)?"\)/;
const INTERNAL_ROUTE = /app\.(get|post|put|patch|delete)\(\s*["'`]\/internal\//;

const authModules = discoverServiceAuthModules();

describe("service auth conformance", () => {
  it("discovers the domain services that verify Core-issued tokens", () => {
    assert.ok(
      authModules.length >= 8,
      `expected to find auth modules for the domain services, found ${authModules.length}`
    );
  });

  for (const { service, source, httpServer } of authModules) {
    describe(service, () => {
      it("pins the signing algorithm so a token cannot select its own", () => {
        assert.match(source, /algorithms: \["HS256"\]/, `${service} must pin algorithms to HS256`);
        assert.doesNotMatch(source, /"none"/, `${service} must not allow the none algorithm`);
      });

      it("verifies the issuer", () => {
        assert.match(source, /issuer: jwtIssuer/, `${service} must verify the issuer claim`);
        assert.match(source, /requireEnv\("JWT_ISSUER"\)/, `${service} must require JWT_ISSUER`);
      });

      it("rejects refresh tokens presented as access tokens", () => {
        assert.match(
          source,
          /tokenUse !== "access"/,
          `${service} must reject tokens whose tokenUse is not "access"`
        );
      });

      it("requires both subject and username claims", () => {
        assert.match(source, /!sub \|\| !username/, `${service} must require sub and username claims`);
      });

      it("answers 401 for a missing or invalid token", () => {
        assert.match(source, /status\(401\)/, `${service} must answer 401 for bad credentials`);
        assert.match(
          source,
          /TokenExpiredError|JsonWebTokenError/,
          `${service} must translate jwt verification failures into 401`
        );
      });

      // Tasks has no internal surface and so ships no internal guard. The
      // invariant that matters is that the two always agree: a service must not
      // expose /internal/* routes without a key guard behind them.
      const hasInternalGuard = /export const requireInternalApiKey/.test(source);

      if (hasInternalGuard) {
        it("guards internal routes with a required API key", () => {
          assert.match(source, INTERNAL_API_KEY_ENV, `${service} must require an INTERNAL_API_KEY* env var`);
          assert.match(source, /x-api-key/, `${service} must read the internal API key header`);
          assert.match(source, /status\(403\)/, `${service} must answer 403 for a bad internal API key`);
        });
      } else {
        it("exposes no internal routes, since it ships no internal API key guard", () => {
          assert.doesNotMatch(
            httpServer,
            INTERNAL_ROUTE,
            `${service} exposes /internal/* routes but has no requireInternalApiKey guard`
          );
        });
      }
    });
  }

  it("keeps Core's own verifier pinned and issuer-checked", () => {
    const coreSource = readFileSync(path.join(servicesDir, CORE_SERVICE, "src", "auth.ts"), "utf8")
      .replace(/\s+/g, " ");
    assert.match(coreSource, /algorithms: \["HS256"\]/);
    assert.match(coreSource, /issuer: jwtIssuer/);
    // Core distinguishes access from refresh explicitly rather than hardcoding one.
    assert.match(coreSource, /tokenUse !== expectedUse/);
  });
});
