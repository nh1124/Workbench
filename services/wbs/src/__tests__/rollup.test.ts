import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateItemRollups, calculatePlanRollup, recalculateWbsCodes } from "../rollup.js";

describe("WBS code recalculation", () => {
  it("assigns deterministic hierarchical codes from sibling order", () => {
    const assignments = recalculateWbsCodes([
      { id: "build", sortOrder: 2000 },
      { id: "plan", sortOrder: 1000 },
      { id: "api", parentId: "build", sortOrder: 1000 },
      { id: "ui", parentId: "build", sortOrder: 2000 },
      { id: "routes", parentId: "api", sortOrder: 1000 }
    ]);

    assert.deepEqual(Object.fromEntries(assignments.map((item) => [item.id, item.code])), {
      plan: "1",
      build: "2",
      api: "2.1",
      routes: "2.1.1",
      ui: "2.2"
    });
  });
});

describe("WBS rollups", () => {
  it("sums descendant effort and derives parent progress from children", () => {
    const nodes = [
      { id: "root", sortOrder: 1000, effortHours: 2, status: "todo" as const, progress: 0 },
      { id: "done", parentId: "root", sortOrder: 1000, effortHours: 5, status: "done" as const },
      { id: "doing", parentId: "root", sortOrder: 2000, effortHours: 5, status: "doing" as const }
    ];

    const itemRollups = calculateItemRollups(nodes);
    assert.deepEqual(itemRollups.get("root"), {
      effortHours: 12,
      progress: 75,
      itemCount: 3,
      doneCount: 1
    });
    assert.deepEqual(calculatePlanRollup(nodes), {
      effortHours: 12,
      progress: 75,
      itemCount: 3,
      doneCount: 1
    });
  });
});
