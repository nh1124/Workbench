// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  createNotionBlock,
  ensureNotionTableBlockStructure,
  findNotionBlock,
  getNotionTableColumnCount,
  getNotionTableRows,
  hasMeaningfulBlockContent,
  markdownToNotionHtml,
  notionEditorToMarkdown
} from "../utils/notionMarkdown";

/**
 * The Notion-style editor stores documents as markdown but edits them as DOM,
 * so every save runs markdown -> HTML -> markdown. If that pair is not a true
 * round trip, simply opening and saving a note silently rewrites it.
 *
 * These tests pin the round trip for each block kind, which is the property
 * that actually protects the user's documents.
 */

function roundTrip(markdown: string): string {
  const editor = document.createElement("div");
  editor.innerHTML = markdownToNotionHtml(markdown);
  return notionEditorToMarkdown(editor);
}

function editorFrom(markdown: string): HTMLElement {
  const editor = document.createElement("div");
  editor.innerHTML = markdownToNotionHtml(markdown);
  return editor;
}

describe("markdown round trip", () => {
  const preserved: Array<[string, string]> = [
    ["a paragraph", "hello world"],
    ["a heading", "# Title"],
    ["a deep heading", "### Deep"],
    ["a bullet", "- item"],
    ["nested bullets", "- a\n  - b\n    - c"],
    ["an ordered list keeping its markers", "1. first\n2. second"],
    ["an ordered list not starting at one", "3. third"],
    ["a horizontal rule", "---"],
    ["bold", "a **bold** b"],
    ["strikethrough", "a ~~gone~~ b"],
    ["a link", "see [docs](https://example.com) here"],
    ["an image", "![alt text](https://example.com/a.png)"],
    ["bold inside a heading", "# A **bold** title"],
    ["a link with a bold label", "[**strong**](https://e.com)"],
    ["a fenced code block with its language", "```ts\nconst x = 1;\n```"],
    ["code containing a stray backtick", "```\na ` b\n```"],
    ["a table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
    ["a table with inline formatting", "| **a** | [l](https://e.com) |\n| --- | --- |\n| 1 | 2 |"],
    ["blank lines between paragraphs", "a\n\nb"],
    ["a mixed document", "# T\n\n- one\n- two\n\npara"],
    ["an empty document", ""]
  ];

  it.each(preserved)("preserves %s", (_label, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("leaves characters that are HTML-significant untouched", () => {
    expect(roundTrip("a < b & c > d")).toBe("a < b & c > d");
    expect(roundTrip("it's \"quoted\"")).toBe("it's \"quoted\"");
  });

  it("does not let markup in the source become live HTML", () => {
    const html = markdownToNotionHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(roundTrip("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });

  it("normalises the horizontal rule spellings to one form", () => {
    expect(roundTrip("***")).toBe("---");
    expect(roundTrip("-----")).toBe("---");
  });

  it("is idempotent, so repeated saves do not drift", () => {
    const source = "# T\n\n- one\n  - two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\npara";
    const once = roundTrip(source);
    expect(roundTrip(once)).toBe(once);
  });
});

describe("table cells", () => {
  it("keeps an empty cell empty rather than writing a literal break", () => {
    expect(roundTrip("| a | b |\n| --- | --- |\n|  | 2 |")).toBe("| a | b |\n| --- | --- |\n|  | 2 |");
    expect(roundTrip("|  | b |\n| --- | --- |\n| 1 | 2 |")).toBe("|  | b |\n| --- | --- |\n| 1 | 2 |");
    expect(roundTrip("| a | b |\n| --- | --- |\n|  |  |")).toBe("| a | b |\n| --- | --- |\n|  |  |");
  });

  it("still encodes a real line break inside a cell as <br>", () => {
    const source = "| a<br>b | c |\n| --- | --- |\n| 1 | 2 |";
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps a literal pipe escaped", () => {
    const source = "| a \\| b | c |\n| --- | --- |\n| 1 | 2 |";
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps a cell whose only content is an image", () => {
    const source = "| ![x](https://e.com/i.png) | c |\n| --- | --- |\n| 1 | 2 |";
    expect(roundTrip(source)).toBe(source);
  });

  it("gives a header-only table an empty body row to edit", () => {
    const editor = editorFrom("| a | b |\n| --- | --- |");
    const table = editor.querySelector("table") as HTMLTableElement;

    expect(getNotionTableColumnCount(table)).toBe(2);
    // Header plus the generated body row.
    expect(getNotionTableRows(table).length).toBe(2);
  });
});

describe("block structure", () => {
  it("tags each block with the kind the serializer reads back", () => {
    const editor = editorFrom("# H\n- b\n1. o\n---\npara");
    const kinds = Array.from(editor.children).map((child) => (child as HTMLElement).dataset.mdKind);

    expect(kinds).toEqual(["heading", "bullet", "ordered", "hr", "paragraph"]);
  });

  it("records the nesting level so indentation survives the round trip", () => {
    const editor = editorFrom("- a\n  - b\n    - c");
    const levels = Array.from(editor.children).map((child) => (child as HTMLElement).dataset.mdLevel);

    expect(levels).toEqual(["1", "2", "3"]);
  });
});

describe("createNotionBlock", () => {
  it("builds a block the serializer can read back", () => {
    const editor = document.createElement("div");
    editor.append(createNotionBlock("heading", 2));
    editor.append(createNotionBlock("bullet", 3));
    editor.append(createNotionBlock("ordered", 1, 4));
    editor.append(createNotionBlock("paragraph"));

    expect(notionEditorToMarkdown(editor)).toBe("##\n    -\n4.\n");
  });
});

describe("findNotionBlock", () => {
  it("finds the block owning a nested node", () => {
    const editor = editorFrom("a **bold** b");
    const strong = editor.querySelector("strong") as HTMLElement;

    expect(findNotionBlock(editor, strong.firstChild)).toBe(editor.children[0]);
  });

  it("returns the block itself when handed one", () => {
    const editor = editorFrom("para");
    const block = editor.children[0] as HTMLElement;

    expect(findNotionBlock(editor, block)).toBe(block);
  });

  it("returns nothing for a node outside the editor", () => {
    const editor = editorFrom("para");
    const outside = document.createElement("span");

    expect(findNotionBlock(editor, outside)).toBeNull();
    expect(findNotionBlock(editor, null)).toBeNull();
  });
});

describe("hasMeaningfulBlockContent", () => {
  it("treats text and images as content", () => {
    expect(hasMeaningfulBlockContent(editorFrom("text").children[0] as HTMLElement)).toBe(true);
    expect(
      hasMeaningfulBlockContent(editorFrom("![x](https://e.com/i.png)").children[0] as HTMLElement)
    ).toBe(true);
  });

  it("treats an empty block and a lone break as empty", () => {
    expect(hasMeaningfulBlockContent(editorFrom("").children[0] as HTMLElement | undefined ?? document.createElement("p"))).toBe(false);

    const block = document.createElement("p");
    block.innerHTML = "<br>";
    expect(hasMeaningfulBlockContent(block)).toBe(false);
  });
});

describe("ensureNotionTableBlockStructure", () => {
  it("repairs a table block that lost its wrapper markup", () => {
    const block = document.createElement("div");
    block.dataset.mdKind = "table";
    block.innerHTML = "<table><tr><td>a</td><td>b</td></tr></table>";

    ensureNotionTableBlockStructure(block);

    const table = block.querySelector("table") as HTMLTableElement;
    expect(table.querySelector("thead")).not.toBeNull();
    expect(table.querySelector("tbody")).not.toBeNull();
  });
});
