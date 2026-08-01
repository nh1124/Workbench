import { describe, expect, it } from "vitest";
import { languageToLocale } from "../uiStrings";

describe("languageToLocale", () => {
  it("maps English (US) to English", () => {
    expect(languageToLocale("English (US)")).toBe("en");
  });

  it.each(["日本語", "Japanese", "Japanese (JP)"])("maps %s to Japanese", (language) => {
    expect(languageToLocale(language)).toBe("ja");
  });

  it("falls back to English for an unknown setting", () => {
    expect(languageToLocale("Unknown")).toBe("en");
  });
});
