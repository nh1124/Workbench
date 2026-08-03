import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPTURE_UPLOAD_META_KEYS,
  CaptureUploader,
  DEFAULT_CAPTURE_CONFIG,
  type CaptureStorage
} from "../capture/index.js";

type MetaWrite = { key: string; value: string };

function storageStub(machineId: string): { storage: CaptureStorage; meta: Map<string, string>; writes: MetaWrite[] } {
  const meta = new Map<string, string>([
    [CAPTURE_UPLOAD_META_KEYS.machineId, machineId],
    [CAPTURE_UPLOAD_META_KEYS.machineKey, "machine-key-1"]
  ]);
  const writes: MetaWrite[] = [];
  const sample = {
    id: 1,
    sampledAt: "2026-07-22T00:00:00.000Z",
    processName: "Code",
    windowTitle: "Workbench",
    idle: false
  };
  const storage = {
    getConfig: () => ({ ...DEFAULT_CAPTURE_CONFIG, enabled: true, uploadEnabled: true }),
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: string) => {
      writes.push({ key, value });
      meta.set(key, value);
    },
    listSamplesAfter: (cursor: unknown) => cursor ? [] : [sample]
  } as unknown as CaptureStorage;
  return { storage, meta, writes };
}

describe("capture uploader machine recovery", () => {
  it("re-registers and retries one ingest with the fresh machine id", async () => {
    const { storage, meta, writes } = storageStub("stale-machine-id");
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    let ingestCalls = 0;
    const uploader = new CaptureUploader({
      storage,
      displayName: "Test daemon",
      platform: "win32",
      getJson: async <T>(): Promise<T> => ({ settings: { foregroundAppUpload: true } }) as T,
      postJson: async <T>(path: string, body: unknown): Promise<T> => {
        posts.push({ path, body: body as Record<string, unknown> });
        if (path === "/api/analyser/machines/register") return { id: "fresh-machine-id" } as T;
        ingestCalls += 1;
        if (ingestCalls === 1) throw { status: 409, code: "MACHINE_UNKNOWN" };
        return { ingested: 1 } as T;
      }
    });

    await uploader.run();

    const machineWrites = writes.filter((write) => write.key === CAPTURE_UPLOAD_META_KEYS.machineId);
    assert.deepEqual(machineWrites, [
      { key: CAPTURE_UPLOAD_META_KEYS.machineId, value: "" },
      { key: CAPTURE_UPLOAD_META_KEYS.machineId, value: "fresh-machine-id" }
    ]);
    assert.equal(meta.get(CAPTURE_UPLOAD_META_KEYS.machineId), "fresh-machine-id");
    assert.equal(posts.filter((post) => post.path === "/api/analyser/machines/register").length, 1);
    const ingests = posts.filter((post) => post.path === "/api/analyser/observations/ingest");
    assert.deepEqual(ingests.map((post) => post.body.machineId), ["stale-machine-id", "fresh-machine-id"]);
    const retriedObservation = (ingests[1].body.observations as Array<Record<string, unknown>>)[0];
    assert.equal(retriedObservation.dedupeKey, "pc:fresh-machine-id:2026-07-22T00:00:00.000Z");
    assert.ok(meta.get(CAPTURE_UPLOAD_META_KEYS.samplesCursor));
  });

  it("does not re-register after a successful ingest", async () => {
    const { storage, meta, writes } = storageStub("known-machine-id");
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const uploader = new CaptureUploader({
      storage,
      displayName: "Test daemon",
      platform: "win32",
      getJson: async <T>(): Promise<T> => ({ settings: { foregroundAppUpload: true } }) as T,
      postJson: async <T>(path: string, body: unknown): Promise<T> => {
        posts.push({ path, body: body as Record<string, unknown> });
        return { ingested: 1 } as T;
      }
    });

    await uploader.run();

    assert.equal(posts.some((post) => post.path === "/api/analyser/machines/register"), false);
    const ingest = posts.find((post) => post.path === "/api/analyser/observations/ingest");
    assert.equal(ingest?.body.machineId, "known-machine-id");
    assert.equal(writes.some((write) => write.key === CAPTURE_UPLOAD_META_KEYS.machineId), false);
    assert.ok(meta.get(CAPTURE_UPLOAD_META_KEYS.samplesCursor));
  });
});
