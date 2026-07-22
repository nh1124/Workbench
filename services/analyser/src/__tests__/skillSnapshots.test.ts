import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const {
  getSkillSnapshotWithPool,
  hashSkillBody,
  listSkillSnapshotsWithPool,
  normalizeSkillBody,
  upsertSkillSnapshotWithPool
} = await import("../stores/skillSnapshots.js");
const { setRoutineSkillMissingByKeysWithPool } = await import("../stores/routines.js");

type Call = { text: string; values?: unknown[] };
const capturedAt = "2026-07-22T00:00:00.000Z";

function snapshotPool() {
  const calls: Call[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const pool = {
    calls,
    rows,
    async query<Row = never>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (/INSERT INTO analyser_skill_snapshots/.test(text)) {
        const key = `${values?.[0]}:${values?.[1]}`;
        const existing = rows.get(key);
        const row = {
          id: existing?.id ?? "snapshot-1",
          skill_key: values?.[1],
          skill_version: values?.[2],
          content_hash: values?.[3],
          body_markdown: values?.[4],
          source_ref: values?.[5],
          captured_at: existing?.captured_at ?? capturedAt,
          updated_at: existing ? "2026-07-22T01:00:00.000Z" : capturedAt
        };
        rows.set(key, row);
        return { rows: [row] as Row[] };
      }
      if (/AND skill_key = \$2/.test(text)) {
        const row = rows.get(`${values?.[0]}:${values?.[1]}`);
        return { rows: (row ? [row] : []) as Row[] };
      }
      if (/FROM analyser_skill_snapshots/.test(text)) {
        const ownerPrefix = `${values?.[0]}:`;
        const selected = [...rows.entries()]
          .filter(([key]) => key.startsWith(ownerPrefix))
          .map(([, row]) => {
            const { body_markdown: _body, ...light } = row;
            return light;
          });
        return { rows: selected as Row[] };
      }
      return { rows: [] as Row[] };
    }
  };
  return pool;
}

describe("skill snapshot normalization and hashing", () => {
  it("normalizes line endings and trailing whitespace before hashing", () => {
    assert.equal(normalizeSkillBody("a\r\nb\n"), "a\nb");
    assert.equal(hashSkillBody("a\r\nb\n"), hashSkillBody("a\nb"));
  });
});

describe("skill snapshot store", () => {
  it("upserts one owner/key row with a stable content hash", async () => {
    const pool = snapshotPool();
    const first = await upsertSkillSnapshotWithPool(pool, "owner-1", {
      skillKey: "workbench-analyser-cycle",
      skillVersion: "1",
      bodyMarkdown: "a\r\nb\n",
      sourceRef: "skills/workbench-analyser-cycle/SKILL.md"
    });
    const second = await upsertSkillSnapshotWithPool(pool, "owner-1", {
      skillKey: "workbench-analyser-cycle",
      skillVersion: "2",
      bodyMarkdown: "a\nb",
      sourceRef: "skills/workbench-analyser-cycle/SKILL.md"
    });

    assert.equal(first.contentHash, hashSkillBody("a\nb"));
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(second.skillVersion, "2");
    assert.equal(pool.rows.size, 1);
    assert.match(pool.calls[0].text, /ON CONFLICT \(service_account_id, skill_key\) DO UPDATE SET/);
    assert.match(pool.calls[0].text, /updated_at = NOW\(\)/);
  });

  it("gets the body while list uses the light projection", async () => {
    const pool = snapshotPool();
    await upsertSkillSnapshotWithPool(pool, "owner-1", {
      skillKey: "workbench-maintenance",
      bodyMarkdown: "# Maintenance\n"
    });

    const snapshot = await getSkillSnapshotWithPool(pool, "owner-1", "workbench-maintenance");
    const listed = await listSkillSnapshotsWithPool(pool, "owner-1", { limit: 10 });

    assert.equal(snapshot?.bodyMarkdown, "# Maintenance\n");
    assert.equal(listed.items.length, 1);
    assert.equal("bodyMarkdown" in listed.items[0], false);
    const listCall = pool.calls.find((call) => /ORDER BY skill_key/.test(call.text));
    assert.doesNotMatch(listCall?.text ?? "", /body_markdown/);
    assert.deepEqual(listCall?.values, ["owner-1", 10]);
  });
});

describe("routine skill-missing reconcile", () => {
  it("sets exactly the supplied missing skill keys", async () => {
    const calls: Call[] = [];
    const pool = { async query(text: string, values?: unknown[]) { calls.push({ text, values }); return { rows: [] }; } };
    await setRoutineSkillMissingByKeysWithPool(pool, "owner-1", ["skill-a", "skill-b"]);
    assert.match(calls[0].text, /skill_missing = \(skill_key = ANY\(\$2::text\[\]\)\)/);
    assert.deepEqual(calls[0].values, ["owner-1", ["skill-a", "skill-b"]]);
  });

  it("passes an empty array to unblock every owner routine", async () => {
    const calls: Call[] = [];
    const pool = { async query(text: string, values?: unknown[]) { calls.push({ text, values }); return { rows: [] }; } };
    await setRoutineSkillMissingByKeysWithPool(pool, "owner-1", []);
    assert.deepEqual(calls[0].values, ["owner-1", []]);
  });
});
