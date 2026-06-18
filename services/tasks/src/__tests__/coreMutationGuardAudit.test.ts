import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

const services = [
  { name: "notes", httpServerPath: "services/notes/src/httpServer.ts" },
  { name: "projects", httpServerPath: "services/projects/src/httpServer.ts" },
  { name: "artifacts", httpServerPath: "services/artifacts/src/httpServer.ts" },
  { name: "tasks", httpServerPath: "services/tasks/src/httpServer.ts" }
];

const mutationRoutePattern = /app\.(post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

describe("Core mutation origin guard audit", () => {
  for (const service of services) {
    it(`${service.name} mounts the guard before user-facing mutation routes`, () => {
      const source = readFileSync(path.join(repoRoot, service.httpServerPath), "utf8");
      const guardIndex = source.indexOf("app.use(requireCoreMutationOriginMiddleware);");

      assert.notEqual(guardIndex, -1, `${service.name} must mount requireCoreMutationOriginMiddleware`);
      assert.match(
        source,
        /WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN/,
        `${service.name} must keep the opt-in guard flag`
      );
      assert.match(source, /x-workbench-core-mutation/, `${service.name} must check the Core mutation header`);
      assert.match(
        source,
        /req\.path\.startsWith\(["'`]\/internal\/["'`]\)/,
        `${service.name} must leave /internal/* routes governed by the internal API key`
      );

      const auditedRoutes: string[] = [];
      const unguardedRoutes: string[] = [];
      for (const match of source.matchAll(mutationRoutePattern)) {
        const method = match[1]?.toUpperCase();
        const route = match[2];
        if (!method || !route || route.startsWith("/internal/")) {
          continue;
        }

        auditedRoutes.push(`${method} ${route}`);
        if ((match.index ?? -1) < guardIndex) {
          unguardedRoutes.push(`${method} ${route}`);
        }
      }

      assert.ok(auditedRoutes.length > 0, `${service.name} should expose at least one audited mutation route`);
      assert.deepEqual(
        unguardedRoutes,
        [],
        `${service.name} has user-facing mutation routes mounted before the Core-origin guard`
      );
    });
  }
});
