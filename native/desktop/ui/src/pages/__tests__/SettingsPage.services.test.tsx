// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LocalSyncServiceCard } from "../SettingsPage";

afterEach(() => cleanup());

describe("LocalSyncServiceCard", () => {
  it("links Services users to the Local Sync daemon settings", () => {
    render(<MemoryRouter><LocalSyncServiceCard /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Local Sync" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Configure" }).getAttribute("href"))
      .toBe("/settings?tab=account&section=sync-daemon");
  });
});
