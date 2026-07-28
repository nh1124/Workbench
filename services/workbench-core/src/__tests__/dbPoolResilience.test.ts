import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createServer } from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const servicesDir = path.resolve(__dirname, "../../..");

/**
 * Every service builds a pg Pool. When an idle pooled client's connection
 * drops — a database restart, a network blip — pg emits 'error' on the Pool.
 * Node treats an unhandled 'error' event on an EventEmitter as fatal, so a
 * service without a listener dies the moment its database blinks.
 *
 * On the production host these services are supervised by one `concurrently -k`
 * process, which kills the whole group when any member exits. One database
 * restart therefore took down all of them, with nothing to bring them back.
 *
 * The first test proves the failure mode is real; the second holds every
 * service to the fix.
 */

function serviceDbFiles(): Array<{ service: string; file: string }> {
  return readdirSync(servicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      service: entry.name,
      file: path.join(servicesDir, entry.name, "src/db.ts")
    }))
    .filter((entry) => existsSync(entry.file))
    .filter((entry) => readFileSync(entry.file, "utf8").includes("new Pool("));
}

/** Accepts a connection, then destroys it — a database going away mid-idle. */
async function rudeServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe("pg pool resilience", () => {
  it("emits an 'error' event a service must listen for", async () => {
    const server = await rudeServer();
    const pool = new Pool({
      host: "127.0.0.1",
      port: server.port,
      database: "x",
      user: "x",
      password: "x"
    });

    // Without any listener this event is what kills the process. Attaching one
    // here is exactly what the fix does in each service.
    const seen = new Promise<Error>((resolve) => {
      pool.on("error", resolve);
      pool.connect().catch(resolve);
    });

    const error = await seen;
    assert.ok(error instanceof Error, "the dropped connection must surface as an Error");

    await pool.end().catch(() => {});
    await server.close();
  });

  it("keeps a pool usable after a connection is dropped", async () => {
    const server = await rudeServer();
    const pool = new Pool({
      host: "127.0.0.1",
      port: server.port,
      database: "x",
      user: "x",
      password: "x"
    });
    pool.on("error", () => {});

    // The pool discards the broken client rather than wedging, so a later
    // attempt fails on its own terms instead of hanging.
    await assert.rejects(() => pool.query("select 1"));
    await assert.rejects(() => pool.query("select 1"));

    await pool.end().catch(() => {});
    await server.close();
  });

  it("has every service attaching a pool error handler", () => {
    const files = serviceDbFiles();
    assert.ok(files.length >= 8, `expected the service db.ts files, found ${files.length}`);

    const missing = files
      .filter(({ file }) => !/pool\.on\(\s*["']error["']/.test(readFileSync(file, "utf8")))
      .map(({ service }) => service);

    assert.deepEqual(
      missing,
      [],
      `these services would die when their database blinks: ${missing.join(", ")}`
    );
  });
});
