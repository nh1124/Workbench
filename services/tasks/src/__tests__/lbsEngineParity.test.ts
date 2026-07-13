import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { pythonRound, shouldTaskOccur, weekdayMon0 } from "../lbs/engine.js";
import { LBSResponseShapes } from "../lbs/responseShapes.js";
import type {
  DateKey,
  LBSFixtureInput,
  LBSTask,
  TaskStatus
} from "../lbs/types.js";

interface ManifestQuery {
  name: string;
  value: string;
}

interface ManifestCall {
  file: string;
  method: string;
  path: string;
  query: ManifestQuery[];
}

interface GoldenManifest {
  calls: ManifestCall[];
  golden_count: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const goldensDir = join(here, "../lbs/__goldens__");
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(goldensDir, file), "utf8")) as T;
const fixture = readJson<LBSFixtureInput>("fixture_input.json");
const manifest = readJson<GoldenManifest>("manifest.json");
const api = new LBSResponseShapes(fixture);

function queryOne(call: ManifestCall, name: string): string | undefined {
  return call.query.find((entry) => entry.name === name)?.value;
}

function queryStatuses(call: ManifestCall): TaskStatus[] {
  return call.query
    .filter((entry) => entry.name === "status")
    .map((entry) => entry.value as TaskStatus);
}

function requiredQuery(call: ManifestCall, name: string): string {
  const value = queryOne(call, name);
  if (!value) {
    throw new Error(`${call.file} is missing query parameter ${name}`);
  }
  return value;
}

function renderCall(call: ManifestCall): unknown {
  if (call.path === "/api/lbs/tasks") {
    const active = queryOne(call, "active");
    return api.listTasks(active === undefined ? undefined : active === "true");
  }
  if (call.path === "/api/lbs/schedule") {
    return api.schedule(
      requiredQuery(call, "start_date"),
      requiredQuery(call, "end_date")
    );
  }
  if (call.path === "/api/lbs/dashboard") {
    return api.dashboard(requiredQuery(call, "start_date"));
  }
  if (call.path === "/api/lbs/heatmap") {
    return api.heatmap(
      requiredQuery(call, "start"),
      requiredQuery(call, "end"),
      queryStatuses(call)
    );
  }
  if (call.path === "/api/lbs/trends") {
    return api.trends(
      Number(requiredQuery(call, "weeks")),
      requiredQuery(call, "start_date"),
      queryStatuses(call)
    );
  }
  if (call.path === "/api/lbs/context-distribution") {
    return api.contextDistribution(
      requiredQuery(call, "start"),
      requiredQuery(call, "end"),
      queryStatuses(call)
    );
  }
  if (call.path === "/api/lbs/exceptions") {
    return api.listExceptions(queryOne(call, "start_date"), queryOne(call, "end_date"));
  }
  const calculate = /^\/api\/lbs\/calculate\/(\d{4}-\d{2}-\d{2})$/.exec(call.path);
  if (calculate) {
    const statuses = queryStatuses(call);
    return api.calculate(calculate[1], statuses.length > 0 ? statuses : undefined);
  }
  const resolved = /^\/api\/lbs\/tasks\/([^/]+)\/resolved$/.exec(call.path);
  if (resolved) {
    return api.resolvedTask(resolved[1], requiredQuery(call, "target_date"));
  }
  const history = /^\/api\/lbs\/tasks\/([^/]+)\/history$/.exec(call.path);
  if (history) {
    return api.getHistory(
      history[1],
      requiredQuery(call, "start_date"),
      requiredQuery(call, "end_date")
    );
  }
  const task = /^\/api\/lbs\/tasks\/([^/]+)$/.exec(call.path);
  if (task) {
    return api.getTask(task[1]);
  }
  throw new Error(`Unhandled golden call: ${call.method} ${call.path}`);
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonKeys(child)])
    );
  }
  return value;
}

function excludeRealClockFields(file: string, value: unknown): unknown {
  if (file !== "dashboard_reference_week.json" || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  // manifest.json documents dashboard.today as capture-clock-dependent even with a fixed start_date.
  const { today: _today, ...stable } = value as Record<string, unknown>;
  return stable;
}

describe("LBS Python golden parity", () => {
  assert.equal(manifest.calls.length, manifest.golden_count);

  for (const call of manifest.calls) {
    it(`matches ${call.file}`, () => {
      const expected = excludeRealClockFields(call.file, readJson<unknown>(call.file));
      const actual = excludeRealClockFields(call.file, renderCall(call));
      assert.deepEqual(sortJsonKeys(actual), sortJsonKeys(expected));
    });
  }
});

const baseTask = fixture.tasks.find((task) => task.task_id === "T-NTH-LAST-SUN") as LBSTask;

describe("LBS recurrence edges beyond the goldens", () => {
  it("clamps monthly day 31 to leap-year February end", () => {
    const task = {
      ...baseTask,
      rule_type: "MONTHLY_DAY",
      month_day: 31,
      end_date: null
    } as LBSTask;
    assert.equal(shouldTaskOccur(task, "2028-02-28"), false);
    assert.equal(shouldTaskOccur(task, "2028-02-29"), true);
  });

  it("matches nth=-1 on the last Sunday across several months", () => {
    for (const date of ["2026-01-25", "2026-02-22", "2026-03-29"] as DateKey[]) {
      assert.equal(shouldTaskOccur(baseTask, date), true, date);
      assert.equal(shouldTaskOccur(baseTask, new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)), false, date);
    }
  });

  it("converts JavaScript Sunday to Python weekday index 6", () => {
    const task = {
      ...baseTask,
      rule_type: "WEEKLY",
      mon: false,
      tue: false,
      wed: false,
      thu: false,
      fri: false,
      sat: false,
      sun: true
    } as LBSTask;
    assert.equal(weekdayMon0("2026-07-05"), 6);
    assert.equal(shouldTaskOccur(task, "2026-07-05"), true);
    assert.equal(shouldTaskOccur(task, "2026-07-06"), false);
  });

  it("rejects EVERY_N_DAYS dates before the anchor", () => {
    const task = fixture.tasks.find((candidate) => candidate.task_id === "T-EVERY-003") as LBSTask;
    assert.equal(shouldTaskOccur(task, "2026-06-28"), false);
    assert.equal(shouldTaskOccur(task, "2026-07-01"), true);
  });

  it("uses round-half-to-even for exact .5 ties", () => {
    assert.equal(pythonRound(2.5), 2);
    assert.equal(pythonRound(3.5), 4);
    assert.equal(pythonRound(1.125, 2), 1.12);
    assert.equal(pythonRound(1.375, 2), 1.38);
  });
});
