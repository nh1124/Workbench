import { describe, expect, it } from "vitest";
import { nextNoteSelection } from "../notes/NotesAppView";

const ORDER = ["a", "b", "c", "d", "e"];

function select(options: {
  clickedId: string;
  selected?: string[];
  anchorId?: string | null;
  shiftKey?: boolean;
  toggleKey?: boolean;
}) {
  const result = nextNoteSelection({
    orderedIds: ORDER,
    clickedId: options.clickedId,
    selected: new Set(options.selected ?? []),
    anchorId: options.anchorId ?? null,
    shiftKey: options.shiftKey ?? false,
    toggleKey: options.toggleKey ?? false
  });
  return { ids: [...result.selected], anchorId: result.anchorId };
}

describe("nextNoteSelection", () => {
  it("replaces the selection on a plain click", () => {
    const result = select({ clickedId: "c", selected: ["a", "b"], anchorId: "a" });
    expect(result.ids).toEqual(["c"]);
    expect(result.anchorId).toBe("c");
  });

  it("adds and removes with the toggle key", () => {
    const added = select({ clickedId: "c", selected: ["a"], anchorId: "a", toggleKey: true });
    expect(added.ids.sort()).toEqual(["a", "c"]);

    const removed = select({ clickedId: "a", selected: ["a", "c"], anchorId: "a", toggleKey: true });
    expect(removed.ids).toEqual(["c"]);
  });

  it("selects the range between the anchor and the click", () => {
    const result = select({ clickedId: "d", selected: ["b"], anchorId: "b", shiftKey: true });
    expect(result.ids).toEqual(["b", "c", "d"]);
  });

  it("selects the range when the click is above the anchor", () => {
    const result = select({ clickedId: "a", selected: ["d"], anchorId: "d", shiftKey: true });
    expect(result.ids).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the anchor so a second shift click re-measures from the same note", () => {
    const first = select({ clickedId: "d", selected: ["b"], anchorId: "b", shiftKey: true });
    expect(first.anchorId).toBe("b");

    const second = select({
      clickedId: "c",
      selected: first.ids,
      anchorId: first.anchorId,
      shiftKey: true
    });
    // Shrinks back towards the anchor rather than growing from the previous click.
    expect(second.ids).toEqual(["b", "c"]);
  });

  it("falls back to a plain click when there is no anchor to measure from", () => {
    const result = select({ clickedId: "c", shiftKey: true });
    expect(result.ids).toEqual(["c"]);
    expect(result.anchorId).toBe("c");
  });

  it("ignores an anchor that is no longer in the list", () => {
    const result = select({ clickedId: "c", selected: ["c"], anchorId: "gone", shiftKey: true });
    expect(result.ids).toEqual(["c"]);
  });
});
