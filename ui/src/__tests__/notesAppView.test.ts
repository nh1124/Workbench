import { describe, expect, it } from "vitest";
import { noteSnippet, standaloneNoteUrl } from "../notes/NotesAppView";

describe("noteSnippet", () => {
  it("uses the first line with content", () => {
    expect(noteSnippet("first line\nsecond line")).toBe("first line");
  });

  it("skips leading blank lines", () => {
    expect(noteSnippet("\n\n  \nreal content")).toBe("real content");
  });

  it("strips markdown heading markers so the list is not all punctuation", () => {
    expect(noteSnippet("# Title\nbody")).toBe("Title");
    expect(noteSnippet("### Deep heading")).toBe("Deep heading");
  });

  it("returns an empty string for empty content", () => {
    expect(noteSnippet("")).toBe("");
    expect(noteSnippet("\n \n")).toBe("");
  });
});

describe("standaloneNoteUrl", () => {
  it("keeps the app query so the new window renders the dedicated shell", () => {
    expect(standaloneNoteUrl("abc")).toBe("?app=notes&note=abc");
  });

  it("encodes ids that need it", () => {
    expect(standaloneNoteUrl("a/b c")).toBe("?app=notes&note=a%2Fb%20c");
  });
});
