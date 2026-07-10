// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { clearWorkbenchSession, localDaemonApi, maintenanceApi, saveWorkbenchSession } from "../lib/api";

beforeEach(async () => {
  window.history.pushState({}, "", "/maintenance");
  await saveWorkbenchSession({
    user: { id: "user-1", username: "dev" },
    accessToken: "access-token",
    tokenType: "Bearer",
    expiresInSeconds: 3600
  });
  vi.spyOn(localDaemonApi, "status").mockResolvedValue({
    status: "ok",
    coreUrl: "http://127.0.0.1:3000",
    syncRoot: "C:\\WorkbenchSync",
    downloadsDir: "C:\\Downloads",
    watcherActive: true,
    remoteArtifactSnapshotComplete: true
  });
  vi.spyOn(maintenanceApi, "queue").mockResolvedValue({ items: [], totals: { byReason: {} } });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await clearWorkbenchSession();
});

describe("App legacy maintenance route", () => {
  it("redirects /maintenance to /analyser", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Analyser" })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/analyser"));
  });
});
