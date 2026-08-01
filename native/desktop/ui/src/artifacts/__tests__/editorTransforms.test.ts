import { describe, expect, it } from "vitest";
import {
  transformBoldAtSelection,
  transformEnterWithLevelContinuation,
  transformSelectedLinesLevel,
  transformStrikeAtSelection
} from "../utils/editorTransforms";

/**
 * These drive Tab/Shift-Tab, Ctrl-B/Ctrl-D and Enter in the plain markdown
 * editor. They are pure text-plus-selection transforms, and had no coverage —
 * a wrong selection offset here leaves the caret in the wrong place on every
 * keystroke, which is exactly the kind of thing tests catch and review does not.
 */

describe("transformSelectedLinesLevel", () => {
  it("indents a bullet by one level", () => {
    const result = transformSelectedLinesLevel("- a", 3, 3, 1);
    expect(result?.nextText).toBe("  - a");
  });

  it("turns a plain line into a bullet when indenting", () => {
    const result = transformSelectedLinesLevel("hello", 5, 5, 1);
    expect(result?.nextText).toBe("- hello");
  });

  it("outdents a nested bullet", () => {
    const result = transformSelectedLinesLevel("    - a", 7, 7, -1);
    expect(result?.nextText).toBe("  - a");
  });

  it("strips the marker when outdenting a top-level bullet", () => {
    const result = transformSelectedLinesLevel("- a", 3, 3, -1);
    expect(result?.nextText).toBe("a");
  });

  it("reports no change when outdenting a plain line", () => {
    expect(transformSelectedLinesLevel("hello", 5, 5, -1)).toBeNull();
  });

  it("keeps an ordered list's number while changing its level", () => {
    expect(transformSelectedLinesLevel("3. a", 4, 4, 1)?.nextText).toBe("  3. a");
    expect(transformSelectedLinesLevel("  3. a", 6, 6, -1)?.nextText).toBe("3. a");
  });

  it("transforms every line the selection touches", () => {
    const result = transformSelectedLinesLevel("- a\n- b\n- c", 1, 9, 1);
    expect(result?.nextText).toBe("  - a\n  - b\n  - c");
  });

  it("stops at the line the selection ends on", () => {
    // The selection ends inside "- b", so "- c" is not part of the block.
    const result = transformSelectedLinesLevel("- a\n- b\n- c", 1, 6, 1);
    expect(result?.nextText).toBe("  - a\n  - b\n- c");
  });

  it("selects the whole transformed block when the selection spanned lines", () => {
    const result = transformSelectedLinesLevel("- a\n- b", 1, 5, 1);
    expect(result?.nextSelectionStart).toBe(0);
    expect(result?.nextSelectionEnd).toBe(result?.nextText.length);
  });

  it("keeps a collapsed caret with the text it was sitting in", () => {
    const result = transformSelectedLinesLevel("- a", 3, 3, 1);
    // Two characters of indent were inserted before the caret.
    expect(result?.nextSelectionStart).toBe(5);
    expect(result?.nextSelectionEnd).toBe(5);
  });

  it("leaves lines outside the selection untouched", () => {
    const result = transformSelectedLinesLevel("- a\n- b\n- c", 4, 4, 1);
    expect(result?.nextText).toBe("- a\n  - b\n- c");
  });
});

describe("transformBoldAtSelection", () => {
  it("wraps the selection and keeps it selected", () => {
    const result = transformBoldAtSelection("hello world", 6, 11);
    expect(result.nextText).toBe("hello **world**");
    expect(result.nextText.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe("world");
  });

  it("inserts an empty pair and puts the caret inside it", () => {
    const result = transformBoldAtSelection("ab", 1, 1);
    expect(result.nextText).toBe("a****b");
    expect(result.nextSelectionStart).toBe(3);
    expect(result.nextSelectionEnd).toBe(3);
  });

  it("unwraps when the markers are inside the selection", () => {
    const result = transformBoldAtSelection("a **b** c", 2, 7);
    expect(result.nextText).toBe("a b c");
    expect(result.nextText.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe("b");
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const result = transformBoldAtSelection("a **b** c", 4, 5);
    expect(result.nextText).toBe("a b c");
    expect(result.nextText.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe("b");
  });

  it("wraps rather than unwrapping when only one side has markers", () => {
    const result = transformBoldAtSelection("**ab", 2, 4);
    expect(result.nextText).toBe("****ab**");
  });

  it("treats a bare '****' as a wrap, since there is nothing between to unwrap", () => {
    const result = transformBoldAtSelection("****", 0, 4);
    expect(result.nextText).toBe("");
  });
});

describe("transformStrikeAtSelection", () => {
  it("wraps the selection and keeps it selected", () => {
    const result = transformStrikeAtSelection("hello world", 6, 11);
    expect(result.nextText).toBe("hello ~~world~~");
    expect(result.nextText.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe("world");
  });

  it("inserts an empty pair and puts the caret inside it", () => {
    const result = transformStrikeAtSelection("ab", 1, 1);
    expect(result.nextText).toBe("a~~~~b");
    expect(result.nextSelectionStart).toBe(3);
  });

  it("unwraps from inside and from outside the selection", () => {
    expect(transformStrikeAtSelection("a ~~b~~ c", 2, 7).nextText).toBe("a b c");
    expect(transformStrikeAtSelection("a ~~b~~ c", 4, 5).nextText).toBe("a b c");
  });
});

describe("transformEnterWithLevelContinuation", () => {
  it("continues a bullet list at the same indent", () => {
    const result = transformEnterWithLevelContinuation("  - a", 5, 5);
    expect(result?.nextText).toBe("  - a\n  - ");
    expect(result?.nextSelectionStart).toBe(result?.nextText.length);
  });

  it("continues an ordered list, incrementing the number", () => {
    const result = transformEnterWithLevelContinuation("3. a", 4, 4);
    expect(result?.nextText).toBe("3. a\n4. ");
  });

  it("does nothing on a plain line, leaving Enter to its default", () => {
    expect(transformEnterWithLevelContinuation("hello", 5, 5)).toBeNull();
  });

  it("does nothing when there is a selection to replace", () => {
    expect(transformEnterWithLevelContinuation("- a", 1, 3)).toBeNull();
  });

  it("continues from the caret's own line in a multi-line document", () => {
    const text = "intro\n- a\ntail";
    const result = transformEnterWithLevelContinuation(text, 9, 9);
    expect(result?.nextText).toBe("intro\n- a\n- \ntail");
  });

  // Known quirk: pressing Enter on an empty bullet adds another one rather than
  // leaving the list, which is what most editors do. Pinned, not changed.
  it("adds another bullet on an empty one instead of ending the list", () => {
    const result = transformEnterWithLevelContinuation("- ", 2, 2);
    expect(result?.nextText).toBe("- \n- ");
  });
});
