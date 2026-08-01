import { describe, expect, it } from "vitest";
import { buildProjectIndexQuery, buildProjectMemoryQuery } from "../projectContextQueries";

describe("Project context query builders", () => {
  it("forwards memory search and filters", () => {
    const params = new URLSearchParams(buildProjectMemoryQuery({
      q: "filing rule",
      kind: "decision",
      authority: "user_confirmed",
      status: "active",
      limit: 25,
      cursor: "next page"
    }));
    expect(Object.fromEntries(params)).toEqual({
      q: "filing rule",
      kind: "decision",
      authority: "user_confirmed",
      status: "active",
      limit: "25",
      cursor: "next page"
    });
  });

  it("forwards index query and resource filters", () => {
    const params = new URLSearchParams(buildProjectIndexQuery({
      q: "budget",
      sourceService: "artifacts",
      resourceType: "note",
      limit: 20
    }));
    expect(Object.fromEntries(params)).toEqual({
      q: "budget",
      sourceService: "artifacts",
      resourceType: "note",
      limit: "20"
    });
  });
});
