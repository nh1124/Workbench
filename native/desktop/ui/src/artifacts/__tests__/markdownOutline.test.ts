import { describe, expect, it } from "vitest";
import { parseMarkdownOutline } from "../utils/markdownOutline";
import { insertBelowOutlineEntry, moveOutlineSection } from "../utils/markdownOutlineOps";

/**
 * The outline panel lets the user drag a heading to reorder or re-level a whole
 * section, and insert new content under one. Both operations rewrite the
 * document, so a mistake silently reorders or drops the user's text — and
 * neither had coverage.
 */

const doc = [
  "# One",
  "body one",
  "## One A",
  "body a",
  "# Two",
  "body two",
  "# Three",
  "body three"
].join("\n");

function entriesOf(markdown: string) {
  return parseMarkdownOutline(markdown);
}

function idOf(markdown: string, title: string): string {
  const entry = entriesOf(markdown).find((item) => item.title === title);
  if (!entry) throw new Error(`no outline entry titled ${title}`);
  return entry.id;
}

describe("parseMarkdownOutline", () => {
  it("reads each heading with its level, title and 1-based line", () => {
    const outline = entriesOf(doc);

    expect(outline.map((item) => [item.level, item.title, item.line])).toEqual([
      [1, "One", 1],
      [2, "One A", 3],
      [1, "Two", 5],
      [1, "Three", 7]
    ]);
  });

  it("records the character offset each heading starts at", () => {
    const outline = entriesOf("# A\nbody\n## B");

    expect(outline[0]?.startOffset).toBe(0);
    expect(outline[1]?.startOffset).toBe("# A\nbody\n".length);
  });

  it("ignores text that only looks like a heading", () => {
    // No space after the hashes, and hashes inside a line, are not headings.
    expect(entriesOf("#NoSpace\ntext # not a heading")).toEqual([]);
  });

  it("strips the closing hashes of a wrapped heading", () => {
    expect(entriesOf("## Title ##")[0]?.title).toBe("Title");
  });

  it("names a heading whose title is only whitespace", () => {
    expect(entriesOf("## \t")[0]?.title).toBe("(Untitled heading)");
  });

  // Only the trailing run is treated as decoration, so a title that is itself a
  // hash survives rather than being read as empty.
  it("keeps a title made of hashes", () => {
    expect(entriesOf("##   #")[0]?.title).toBe("#");
  });

  it("returns nothing for a blank document", () => {
    expect(entriesOf("")).toEqual([]);
    expect(entriesOf("   \n  ")).toEqual([]);
  });
});

describe("moveOutlineSection", () => {
  it("moves a section together with the body under it", () => {
    const result = moveOutlineSection({
      markdown: doc,
      entries: entriesOf(doc),
      draggedId: idOf(doc, "Three"),
      targetId: idOf(doc, "One"),
      targetLevel: 1
    });

    expect(result.split("\n")).toEqual([
      "# One",
      "body one",
      "## One A",
      "body a",
      "# Three",
      "body three",
      "# Two",
      "body two"
    ]);
  });

  it("carries a subsection's children along with it", () => {
    const source = ["# A", "## A1", "text", "# B"].join("\n");
    const result = moveOutlineSection({
      markdown: source,
      entries: entriesOf(source),
      draggedId: idOf(source, "A1"),
      targetId: idOf(source, "B"),
      targetLevel: 2
    });

    expect(result.split("\n")).toEqual(["# A", "# B", "## A1", "text"]);
  });

  it("re-levels the dragged heading but not the body under it", () => {
    const source = ["# A", "## A1", "text", "# B"].join("\n");
    const result = moveOutlineSection({
      markdown: source,
      entries: entriesOf(source),
      draggedId: idOf(source, "A1"),
      targetId: idOf(source, "B"),
      targetLevel: 1
    });

    expect(result.split("\n")).toEqual(["# A", "# B", "# A1", "text"]);
  });

  it("re-levels in place when dropped on itself", () => {
    const source = ["# A", "## A1", "text"].join("\n");
    const result = moveOutlineSection({
      markdown: source,
      entries: entriesOf(source),
      draggedId: idOf(source, "A1"),
      targetId: idOf(source, "A1"),
      targetLevel: 3
    });

    expect(result.split("\n")).toEqual(["# A", "### A1", "text"]);
  });

  it("refuses to drop a section inside itself", () => {
    const source = ["# A", "## A1", "text", "# B"].join("\n");
    const result = moveOutlineSection({
      markdown: source,
      entries: entriesOf(source),
      draggedId: idOf(source, "A"),
      targetId: idOf(source, "A1"),
      targetLevel: 2
    });

    expect(result).toBe(source);
  });

  it("returns the document untouched when an id is unknown", () => {
    expect(
      moveOutlineSection({
        markdown: doc,
        entries: entriesOf(doc),
        draggedId: "missing",
        targetId: idOf(doc, "One"),
        targetLevel: 1
      })
    ).toBe(doc);
  });

  it("holds the level inside the 1..6 range markdown allows", () => {
    const source = ["# A", "## A1", "text"].join("\n");
    const tooDeep = moveOutlineSection({
      markdown: source,
      entries: entriesOf(source),
      draggedId: idOf(source, "A1"),
      targetId: idOf(source, "A1"),
      targetLevel: 99
    });

    expect(tooDeep.split("\n")[1]).toBe("###### A1");
  });

  // Moving forward removes the section before re-inserting it, so the target
  // index shifts back by the section's length. Getting that wrong lands the
  // section past the sibling that follows the target.
  it("lands a forward move directly after the target, not at the end", () => {
    const source = ["# A", "## A1", "text", "# B", "body b", "# C", "body c"].join("\n");
    const result = moveOutlineSection({
      markdown: source,
      entries: entriesOf(source),
      draggedId: idOf(source, "A1"),
      targetId: idOf(source, "B"),
      targetLevel: 2
    });

    expect(result.split("\n")).toEqual(["# A", "# B", "body b", "## A1", "text", "# C", "body c"]);
  });

  it("keeps every line, so a move never loses content", () => {
    const result = moveOutlineSection({
      markdown: doc,
      entries: entriesOf(doc),
      draggedId: idOf(doc, "Two"),
      targetId: idOf(doc, "Three"),
      targetLevel: 1
    });

    expect(result.split("\n").sort()).toEqual(doc.split("\n").sort());
  });
});

describe("insertBelowOutlineEntry", () => {
  it("inserts a heading at the entry's own level, after its section", () => {
    const result = insertBelowOutlineEntry({
      markdown: doc,
      entries: entriesOf(doc),
      entryId: idOf(doc, "One A"),
      kind: "heading"
    });

    expect(result.markdown.split("\n")).toEqual([
      "# One",
      "body one",
      "## One A",
      "body a",
      "",
      "## New heading",
      "# Two",
      "body two",
      "# Three",
      "body three"
    ]);
  });

  it("inserts a top-level heading for the 'text' kind", () => {
    const source = "# A\nbody";
    const result = insertBelowOutlineEntry({
      markdown: source,
      entries: entriesOf(source),
      entryId: idOf(source, "A"),
      kind: "text"
    });

    expect(result.markdown.split("\n")).toEqual(["# A", "body", "", "# New heading"]);
  });

  it("inserts a bullet for the 'bullet' kind", () => {
    const source = "# A\nbody";
    const result = insertBelowOutlineEntry({
      markdown: source,
      entries: entriesOf(source),
      entryId: idOf(source, "A"),
      kind: "bullet"
    });

    expect(result.markdown.split("\n")).toEqual(["# A", "body", "", "- New item"]);
  });

  it("points the cursor at the line it inserted", () => {
    const source = "# A\nbody";
    const result = insertBelowOutlineEntry({
      markdown: source,
      entries: entriesOf(source),
      entryId: idOf(source, "A"),
      kind: "bullet"
    });

    expect(result.markdown.slice(result.cursorOffset)).toBe("- New item");
  });

  it("leaves the document alone and parks the cursor at the end for an unknown id", () => {
    const result = insertBelowOutlineEntry({
      markdown: doc,
      entries: entriesOf(doc),
      entryId: "missing",
      kind: "heading"
    });

    expect(result.markdown).toBe(doc);
    expect(result.cursorOffset).toBe(doc.length);
  });
});
