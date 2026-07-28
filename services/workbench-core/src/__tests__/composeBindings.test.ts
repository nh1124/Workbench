import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const compose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");

/**
 * The Postgres containers were published on 0.0.0.0, which put nine databases —
 * with the passwords sitting in the same file — on every interface of the
 * production host. Nothing needs that: services reach their database over
 * loopback, and the Artifacts container reaches its own by compose service
 * name. This holds the bindings to loopback so the exposure cannot come back by
 * someone copying the surrounding block.
 */

describe("docker-compose port bindings", () => {
  const dbPorts = [...compose.matchAll(/^\s+- "(?<binding>[^"]*):5432"$/gm)].map(
    (match) => match.groups!.binding
  );

  it("publishes a database port for each service", () => {
    assert.ok(dbPorts.length >= 9, `expected the nine database bindings, found ${dbPorts.length}`);
  });

  it("binds every database to loopback only", () => {
    const exposed = dbPorts.filter((binding) => !binding.startsWith("127.0.0.1:"));

    assert.deepEqual(
      exposed,
      [],
      `these databases are published on all interfaces: ${exposed.join(", ")}`
    );
  });

  it("keeps the host port numbers the services are configured for", () => {
    // services/*/.env pin these; changing one here without the other breaks
    // every connection.
    const hostPorts = dbPorts.map((binding) => binding.split(":")[1]).sort();
    assert.deepEqual(hostPorts, ["5542", "5543", "5544", "5545", "5546", "5547", "5548", "5549", "5551"]);
  });
});
