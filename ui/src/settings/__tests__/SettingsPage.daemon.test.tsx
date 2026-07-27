// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as api from "../../lib/api";
import { coreApi, localDaemonApi } from "../../lib/api";
import {
  getWorkbenchLocalDaemonUrl,
  getWorkbenchLocalRoutingMode,
  setWorkbenchLocalDaemonUrl,
  setWorkbenchLocalRoutingMode
} from "../../config/services";
import { SettingsPage } from "../SettingsPage";

/**
 * Characterization tests for the Sync Daemon section of SettingsPage.
 *
 * It is the largest cluster in a 2,236-line component — twelve pieces of state
 * — and had no coverage. These pin the observable behaviour (which daemon API
 * is called, what message is shown, what is persisted) so the cluster can be
 * lifted into a hook without changing what the user sees.
 */

const daemonStatus = {
  status: "ok",
  version: "1.0.0",
  syncRoot: "C:/WorkbenchSync",
  downloadsDir: "C:/Downloads",
  outboxPending: 0,
  outboxFailed: 0,
  conflictsOpen: 0,
  watcherActive: true,
  lastScanAt: "2026-07-27T00:00:00.000Z"
};

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings?tab=account&section=sync-daemon"]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom does not implement scrollIntoView, and the section scrolls itself
  // into view when reached via ?section=sync-daemon.
  Element.prototype.scrollIntoView = vi.fn();
  setWorkbenchLocalDaemonUrl("http://127.0.0.1:35780");
  setWorkbenchLocalRoutingMode("core");

  vi.spyOn(coreApi, "me").mockResolvedValue({
    user: { id: "user-1", username: "alice" },
    provisioning: []
  } as never);
  vi.spyOn(coreApi, "listIntegrationConfigs").mockResolvedValue([]);
  vi.spyOn(api, "fetchAllServiceManifests").mockResolvedValue([]);
  vi.spyOn(coreApi, "listLocalClients").mockResolvedValue({ items: [] } as never);
  vi.spyOn(coreApi, "listLocalClientAuditEvents").mockResolvedValue({ items: [] } as never);
  vi.spyOn(coreApi, "listLocalJobs").mockResolvedValue({ items: [] } as never);

  vi.spyOn(localDaemonApi, "status").mockResolvedValue(daemonStatus as never);
  vi.spyOn(localDaemonApi, "listConflicts").mockResolvedValue({ items: [] } as never);
  vi.spyOn(localDaemonApi, "listPendingJobConfirmations").mockResolvedValue({ items: [] } as never);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

/** The page renders several Refresh buttons, so queries are scoped to this section. */
async function openDaemonSection(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name: "Sync Daemon" });
  const section = heading.closest("section.account-local-daemon");
  if (!section) throw new Error("sync daemon section not found");
  return section as HTMLElement;
}

describe("SettingsPage sync daemon", () => {
  it("reports success after a refresh reaches the daemon", async () => {
    renderSettings();
    const section = await openDaemonSection();

    fireEvent.click(within(section).getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(within(section).getByText("Local daemon refreshed.")).toBeTruthy());
    expect(localDaemonApi.status).toHaveBeenCalled();
    expect(localDaemonApi.listConflicts).toHaveBeenCalled();
    expect(localDaemonApi.listPendingJobConfirmations).toHaveBeenCalled();
  });

  it("surfaces the error when the daemon is unreachable", async () => {
    vi.mocked(localDaemonApi.status).mockRejectedValue(new Error("connection refused"));

    renderSettings();
    const section = await openDaemonSection();

    fireEvent.click(within(section).getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(within(section).getByText("connection refused")).toBeTruthy());
  });

  it("persists the daemon URL", async () => {
    renderSettings();
    const section = await openDaemonSection();

    const input = within(section).getByPlaceholderText("http://127.0.0.1:35780");
    fireEvent.change(input, { target: { value: "http://127.0.0.1:41000" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save URL" }));

    await waitFor(() => expect(getWorkbenchLocalDaemonUrl()).toBe("http://127.0.0.1:41000"));
  });

  it("rejects an invalid daemon URL without persisting it", async () => {
    renderSettings();
    const section = await openDaemonSection();

    const input = within(section).getByPlaceholderText("http://127.0.0.1:35780");
    fireEvent.change(input, { target: { value: "not a url" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save URL" }));

    // The surfaced text is the thrown error, not the "Invalid local daemon URL"
    // fallback, which only applies when something non-Error is thrown.
    await waitFor(() =>
      expect(within(section).getByText("Local daemon URL must be a valid URL.")).toBeTruthy()
    );
    expect(getWorkbenchLocalDaemonUrl()).toBe("http://127.0.0.1:35780");
  });

  it("switches routing mode and persists it", async () => {
    renderSettings();
    const section = await openDaemonSection();

    fireEvent.click(within(section).getByRole("radio", { name: "Local" }));

    await waitFor(() => expect(getWorkbenchLocalRoutingMode()).toBe("local"));
    expect(within(section).getByRole("radio", { name: "Local" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the Core-mode confirmation, which is the one not wiped by a refresh", async () => {
    setWorkbenchLocalRoutingMode("local");
    renderSettings();
    const section = await openDaemonSection();

    fireEvent.click(within(section).getByRole("radio", { name: "Core" }));

    await waitFor(() => expect(getWorkbenchLocalRoutingMode()).toBe("core"));
    expect(within(section).getByText("Core API mode enabled.")).toBeTruthy();
  });

  // Current behaviour, pinned deliberately: saving a URL and switching to
  // Auto/Local both set a confirmation and then call refreshLocalDaemon, whose
  // first act is setLocalDaemonMessage(""). With showSuccess=false nothing
  // replaces it, so the confirmation never reaches the user. Only Core mode
  // keeps its message, because that path does not refresh. This looks like a
  // UX bug rather than an intent, so it is recorded rather than asserted as
  // desirable.
  it("drops the confirmation when the follow-up refresh clears it", async () => {
    renderSettings();
    const section = await openDaemonSection();

    fireEvent.click(within(section).getByRole("radio", { name: "Auto" }));

    await waitFor(() => expect(getWorkbenchLocalRoutingMode()).toBe("auto"));
    expect(
      within(section).queryByText("Auto mode enabled. Core is used online; the daemon is used offline.")
    ).toBeNull();
  });
});
