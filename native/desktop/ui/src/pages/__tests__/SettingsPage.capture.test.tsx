// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureDaemonState } from "../../types/models";
import { CaptureSettingsSection } from "../SettingsPage";

function captureState(overrides: Partial<CaptureDaemonState> = {}): CaptureDaemonState {
  return {
    dbPath: "C:\\Users\\dev\\AppData\\Local\\Workbench\\capture.sqlite",
    config: {
      enabled: false,
      uploadEnabled: false,
      screenshotsEnabled: false,
      screenshotIntervalSeconds: 300,
      screenshotRetentionDays: 7,
      intervalSeconds: 15,
      retentionDays: 14,
      excludePatterns: []
    },
    status: {
      enabled: false,
      collectorAlive: false,
      lastSampleAt: undefined,
      lastSummaryAt: undefined,
      sampleCount24h: 0
    },
    ...overrides
  };
}

function captureApi(initialState = captureState()) {
  return {
    captureStatus: vi.fn().mockResolvedValue(initialState),
    enableCapture: vi.fn().mockResolvedValue(captureState({
      config: { ...initialState.config, enabled: true },
      status: { ...initialState.status, enabled: true, collectorAlive: true }
    })),
    disableCapture: vi.fn().mockResolvedValue(captureState()),
    updateCaptureConfig: vi.fn().mockImplementation((patch) =>
      Promise.resolve(captureState({
        config: {
          ...initialState.config,
          ...patch
        }
      }))
    ),
    summarizeCapture: vi.fn().mockResolvedValue({
      summaryDate: "2026-07-07",
      noteResourceId: "note-capture",
      generatedAt: "2026-07-07T00:00:00.000Z",
      sampleCount: 0,
      action: "create",
      title: "Capture Daily Summary 2026-07-07"
    })
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CaptureSettingsSection", () => {
  it("only renders in the Tauri desktop runtime", () => {
    const api = captureApi();

    render(<CaptureSettingsSection nativeRuntimeAvailable={false} api={api} pollIntervalMs={0} />);

    expect(screen.queryByRole("region", { name: "Capture" })).toBeNull();
    expect(api.captureStatus).not.toHaveBeenCalled();
  });

  it("calls the enable capture API", async () => {
    const api = captureApi();
    render(<CaptureSettingsSection nativeRuntimeAvailable={true} api={api} pollIntervalMs={0} />);

    expect(await screen.findByText("Disabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));

    await waitFor(() => expect(api.enableCapture).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Enabled")).toBeTruthy();
  });

  it("saves capture configuration through the daemon API", async () => {
    const api = captureApi();
    render(<CaptureSettingsSection nativeRuntimeAvailable={true} api={api} pollIntervalMs={0} />);

    fireEvent.change(await screen.findByLabelText("Capture interval seconds"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Capture retention days"), { target: { value: "21" } });
    fireEvent.change(screen.getByLabelText("Capture exclude patterns"), {
      target: { value: "Private App\n^Secret" }
    });
    fireEvent.click(screen.getByLabelText("Enable activity upload"));
    fireEvent.click(screen.getByLabelText("Enable screenshots"));
    fireEvent.change(screen.getByLabelText("Screenshot interval seconds"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Screenshot retention days"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save capture settings" }));

    await waitFor(() => {
      expect(api.updateCaptureConfig).toHaveBeenCalledWith({
        intervalSeconds: 30,
        retentionDays: 21,
        excludePatterns: ["Private App", "^Secret"],
        uploadEnabled: true,
        screenshotsEnabled: true,
        screenshotIntervalSeconds: 600,
        screenshotRetentionDays: 10
      });
    });
  });
});
