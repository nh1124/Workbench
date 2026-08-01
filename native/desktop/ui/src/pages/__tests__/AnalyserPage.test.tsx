// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { analyserApi, ApiError } from "../../lib/api";
import type {
  AnalyserActivityAggregate,
  AnalyserAutomationPolicy,
  AnalyserCollectionSettings,
  AnalyserDerivedCapture,
  AnalyserObservationRecord,
  AnalyserOperationRecord,
  AnalyserProposalListItem,
  AnalyserProposalRecord,
  AnalyserRoutineRecord,
  AnalyserSettingsResult,
  AnalyserSummaryListItem,
  AnalyserSummaryRecord,
  AnalyserStatusResult
} from "../../types/models";
import { AnalyserPage } from "../AnalyserPage";

const updatedAt = "2026-07-20T04:00:00.000Z";

function collectionSettings(): AnalyserCollectionSettings {
  return {
    workbenchChanges: "metadata",
    mcpAccess: "mutations",
    uiAccess: "reads_and_mutations",
    agentSessionEvents: "explicit_only",
    foregroundAppCapture: true,
    foregroundAppUpload: false,
    windowTitleCapture: false,
    windowTitleUpload: false,
    localFileEvents: "metadata",
    localFileUpload: false,
    screenshots: "local_only",
    screenshotDerivedUpload: false,
    retentionDays: {
      workbench_change: 30,
      mcp_access: 20,
      ui_access: 21,
      agent_session: 22,
      pc_activity: 23,
      local_file: 24
    },
    localScreenshotRetentionDays: 7,
    projectAllow: ["project-a"],
    projectDeny: [],
    resourceTypeAllow: ["note"],
    resourceTypeDeny: [],
    localRootAllow: ["C:\\work"],
    localRootDeny: [],
    excludePatterns: ["**/node_modules/**"]
  };
}

function automationPolicy(): AnalyserAutomationPolicy {
  return {
    enabled: true,
    requireHighConfidence: true,
    destructiveAllowed: false,
    bulkAllowed: false,
    allowedOperationKinds: ["artifact_move", "progress_note_upsert"]
  };
}

function settingsResult(): AnalyserSettingsResult {
  return {
    effective: { settings: collectionSettings(), ownerVersion: 7 },
    rows: [{
      machineId: null,
      settings: { mcpAccess: "mutations" },
      version: 7,
      updatedBy: "settings-user",
      updatedAt
    }],
    automation: { policy: automationPolicy(), version: 9, updatedAt }
  };
}

function analyserRoutine(overrides: Partial<AnalyserRoutineRecord> = {}): AnalyserRoutineRecord {
  return {
    id: "routine-1",
    key: "daily-work-summary",
    name: "Daily work summary",
    skillKey: "workbench-analyser-cycle",
    scheduleKind: "interval",
    scheduleExpr: "15",
    timezone: "Asia/Tokyo",
    enabled: true,
    committedCursor: "0",
    maxRetries: 3,
    backoffMinutes: 5,
    version: 5,
    createdAt: updatedAt,
    updatedAt,
    ...overrides
  };
}

function statusResult(overrides: Partial<AnalyserStatusResult> = {}): AnalyserStatusResult {
  return {
    routines: [{
      key: "daily-activity",
      enabled: true,
      nextRunAt: "2026-07-21T00:00:00.000Z",
      lastCompletedAt: "2026-07-20T00:00:00.000Z",
      lastFailedAt: "2026-07-19T00:00:00.000Z",
      lastErrorSummary: "Temporary provider error",
      activeRun: {
        id: "run-1",
        holder: "agent-desktop",
        leaseExpiresAt: "2026-07-20T04:05:00.000Z"
      }
    }],
    hasOpenProposals: true,
    machines: [{
      id: "11111111-1111-4111-8111-111111111111",
      machineKey: "desktop-key",
      displayName: "Desktop PC",
      platform: "win32",
      registeredAt: updatedAt,
      lastSeenAt: updatedAt
    }],
    ...overrides
  };
}

function aggregateResult(): AnalyserActivityAggregate {
  return {
    totals: { sampleCount: 10, activeCount: 8, idleCount: 2, apps: { Code: 6, Browser: 4 } },
    days: [{
      date: "2026-07-20",
      machineId: null,
      sampleCount: 10,
      activeCount: 8,
      idleCount: 2,
      apps: { Code: 6, Browser: 4 }
    }]
  };
}

function observation(id: string, overrides: Partial<AnalyserObservationRecord> = {}): AnalyserObservationRecord {
  return {
    seq: id,
    id,
    source: "mcp_access",
    action: "notes.get",
    actorKind: "agent",
    occurredAt: updatedAt,
    resourceRefs: [{ service: "notes", resourceType: "note", resourceId: `note-${id}` }],
    metadata: { tool: "notes.get", result: "success" },
    dedupeKey: `dedupe-${id}`,
    receivedAt: updatedAt,
    expiresAt: "2026-08-19T04:00:00.000Z",
    ...overrides
  };
}

function derivedCapture(id: string, overrides: Partial<AnalyserDerivedCapture> = {}): AnalyserDerivedCapture {
  return {
    id,
    kind: "screen_summary",
    title: `Derived capture ${id}`,
    summaryMarkdown: `## Derived insight ${id}\nCompleted a captured workflow.`,
    evidenceRefs: [{ service: "notes", resourceType: "note", resourceId: `derived-note-${id}` }],
    occurredAt: updatedAt,
    receivedAt: updatedAt,
    createdAt: updatedAt,
    ...overrides
  };
}

function summary(id: string, overrides: Partial<AnalyserSummaryRecord> = {}): AnalyserSummaryRecord {
  return {
    id,
    kind: "weekly_work",
    periodStart: "2026-07-13",
    periodEnd: "2026-07-19",
    title: `Summary ${id}`,
    bodyMarkdown: `# Summary body ${id}`,
    metrics: { activeDays: 5 },
    evidenceRefs: [{ service: "notes", resourceType: "note", resourceId: `note-${id}` }],
    routineKey: "weekly-workbench-digest",
    version: 1,
    createdAt: updatedAt,
    updatedAt,
    ...overrides
  };
}

function summaryListItem(id: string, overrides: Partial<AnalyserSummaryRecord> = {}): AnalyserSummaryListItem {
  const { bodyMarkdown: _bodyMarkdown, ...item } = summary(id, overrides);
  return { ...item, bodyChars: summary(id, overrides).bodyMarkdown.length };
}

function proposal(id: string, overrides: Partial<AnalyserProposalRecord> = {}): AnalyserProposalRecord {
  return {
    id,
    kind: "artifact_organization",
    title: `Proposal ${id}`,
    bodyMarkdown: `Proposal body ${id}`,
    evidenceRefs: [{ service: "artifacts", resourceType: "artifact_item", resourceId: `artifact-${id}` }],
    proposedAction: { kind: "artifact_move", params: { targetPath: "archive/2026" } },
    confidenceEvidence: {
      deterministicTarget: true,
      currentEvidence: true,
      policyAllowed: true,
      concurrencyProtected: true,
      reversibleOrNonDestructive: true,
      notes: "All checks passed."
    },
    status: "open",
    routineKey: "artifact-classification",
    version: 3,
    createdAt: updatedAt,
    updatedAt,
    ...overrides
  };
}

function proposalListItem(id: string, overrides: Partial<AnalyserProposalRecord> = {}): AnalyserProposalListItem {
  const full = proposal(id, overrides);
  const { bodyMarkdown: _bodyMarkdown, ...item } = full;
  return { ...item, bodyChars: full.bodyMarkdown.length };
}

function operation(id: string, overrides: Partial<AnalyserOperationRecord> = {}): AnalyserOperationRecord {
  return {
    id,
    operationKind: "artifact_move",
    approvalBasis: "proposal",
    proposalId: "proposal-executed",
    beforeRefs: [{ service: "artifacts", resourceType: "artifact_item", resourceId: "artifact-before", pathSnapshot: "inbox/item.md" }],
    afterRefs: [{ service: "artifacts", resourceType: "artifact_item", resourceId: "artifact-after", pathSnapshot: "archive/item.md" }],
    result: "succeeded",
    idempotencyKey: `operation-${id}`,
    createdAt: updatedAt,
    ...overrides
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(initialEntry = "/analyser") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <AnalyserPage />
    </MemoryRouter>
  );
}

function currentRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  const format = (date: Date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  return { from: format(from), to: format(to) };
}

beforeEach(() => {
  vi.spyOn(analyserApi, "status").mockResolvedValue(statusResult());
  vi.spyOn(analyserApi, "machines").mockResolvedValue({ items: statusResult().machines });
  vi.spyOn(analyserApi, "activityAggregate").mockResolvedValue(aggregateResult());
  vi.spyOn(analyserApi, "observations").mockResolvedValue({ items: [] });
  vi.spyOn(analyserApi, "derivedCaptures").mockResolvedValue({ items: [derivedCapture("1")] });
  vi.spyOn(analyserApi, "summaries").mockResolvedValue({ items: [] });
  vi.spyOn(analyserApi, "summary").mockImplementation(async (id) => summary(id));
  vi.spyOn(analyserApi, "proposals").mockResolvedValue({ items: [] });
  vi.spyOn(analyserApi, "proposal").mockImplementation(async (id) => proposal(id));
  vi.spyOn(analyserApi, "export").mockImplementation(async (body) => ({
    publication: {
      id: "publication-1",
      sourceKind: body.sourceKind,
      sourceId: body.sourceId,
      targetKind: body.targetKind,
      targetId: `${body.targetKind}-export-1`,
      contentHash: "a".repeat(64),
      provenance: "ui",
      createdAt: updatedAt
    },
    created: true,
    target: { kind: body.targetKind, id: `${body.targetKind}-export-1` }
  }));
  vi.spyOn(analyserApi, "resolveProposal").mockImplementation(async (id, body) => proposal(id, { status: body.status }));
  vi.spyOn(analyserApi, "supersedeProposal").mockImplementation(async (id) => proposal(id, { status: "superseded" }));
  vi.spyOn(analyserApi, "operations").mockResolvedValue({ items: [] });
  vi.spyOn(analyserApi, "settings").mockResolvedValue(settingsResult());
  vi.spyOn(analyserApi, "routines").mockResolvedValue({ items: [analyserRoutine()] });
  vi.spyOn(analyserApi, "skillCatalog").mockResolvedValue({ skills: ["workbench-analyser-cycle"] });
  vi.spyOn(analyserApi, "runSkillIntegrity").mockResolvedValue({
    checkedRoutines: 1,
    missing: [],
    drifted: [],
    proposalsCreated: 0
  });
  vi.spyOn(analyserApi, "routineStatus").mockResolvedValue({ items: statusResult().routines });
  vi.spyOn(analyserApi, "createRoutine").mockImplementation(async (body) => analyserRoutine({ ...body, version: 1 }));
  vi.spyOn(analyserApi, "deleteRoutine").mockResolvedValue(undefined);
  vi.spyOn(analyserApi, "updateCollectionPolicy").mockImplementation(async (body) => ({
    machineId: body.machineId ?? null,
    settings: body.settings,
    version: (body.expectedVersion ?? 0) + 1,
    updatedBy: "settings-user",
    updatedAt
  }));
  vi.spyOn(analyserApi, "updateAutomationPolicy").mockImplementation(async (body) => ({
    policy: body.policy,
    version: (body.expectedVersion ?? 0) + 1,
    updatedBy: "settings-user",
    updatedAt
  }));
  vi.spyOn(analyserApi, "updateRoutine").mockImplementation(async (_key, body) => analyserRoutine({ ...body, version: 6 }));
  vi.spyOn(analyserApi, "seedRoutines").mockResolvedValue(undefined);
  vi.spyOn(analyserApi, "projectorFlush").mockResolvedValue({ projected: 0, skipped: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AnalyserPage", () => {
  it("renders Overview routine status and machines", async () => {
    renderPage();

    expect(await screen.findByText("daily-activity")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Temporary provider error")).toBeTruthy();
    expect(screen.getByText("agent-desktop")).toBeTruthy();
    expect(screen.getByText("Desktop PC")).toBeTruthy();
    expect(screen.getByText("win32")).toBeTruthy();
    expect(screen.getByText("Open proposals need review")).toBeTruthy();
  });

  it("shows the never-claimed runner warning", async () => {
    vi.mocked(analyserApi.status).mockResolvedValue(statusResult({
      runnerHealth: {
        state: "never_claimed",
        lastClaimAt: null,
        runners: [],
        overdueRoutines: []
      }
    }));

    renderPage();

    const panel = await screen.findByRole("region", { name: /runner health/i });
    expect(within(panel).getByText("No runner has ever claimed a routine")).toBeTruthy();
    expect(within(panel).getByText(/Nothing has polled yet/)).toBeTruthy();
    expect(within(panel).getByText("No runner has claimed a routine yet.")).toBeTruthy();
  });

  it("shows a healthy runner without a warning", async () => {
    vi.mocked(analyserApi.status).mockResolvedValue(statusResult({
      runnerHealth: {
        state: "healthy",
        lastClaimAt: "2026-07-25T11:50:00.000Z",
        runners: [{
          runner: "codex-loop",
          lastSeenAt: "2026-07-25T11:50:00.000Z",
          lastStatus: "processing",
          runsLast24h: 3
        }],
        overdueRoutines: []
      }
    }));

    renderPage();

    const panel = await screen.findByRole("region", { name: /runner health/i });
    expect(within(panel).getByText("Runner active")).toBeTruthy();
    expect(within(panel).getByText("codex-loop")).toBeTruthy();
    expect(within(panel).getByText("processing")).toBeTruthy();
    expect(within(panel).getByText("3")).toBeTruthy();
    expect(within(panel).queryByText("No runner has ever claimed a routine")).toBeNull();
    expect(within(panel).queryByText("Runner may have stopped")).toBeNull();
  });

  it("shows a stalled runner and its overdue routine", async () => {
    vi.mocked(analyserApi.status).mockResolvedValue(statusResult({
      runnerHealth: {
        state: "stalled",
        lastClaimAt: "2026-07-25T08:00:00.000Z",
        runners: [{
          runner: "agent",
          lastSeenAt: "2026-07-25T08:00:00.000Z",
          lastStatus: "failed",
          runsLast24h: 1
        }],
        overdueRoutines: [{
          key: "weekly-workbench-digest",
          nextRunAt: "2026-07-25T09:00:00.000Z",
          overdueMinutes: 95
        }]
      }
    }));

    renderPage();

    const panel = await screen.findByRole("region", { name: /runner health/i });
    expect(within(panel).getByText("Runner may have stopped")).toBeTruthy();
    expect(within(panel).getByText("Routines are overdue and no runner has claimed recently.")).toBeTruthy();
    expect(within(panel).getByText("weekly-workbench-digest")).toBeTruthy();
    expect(within(panel).getByText("overdue 95 min")).toBeTruthy();
  });

  it("renders an older status payload without runner health", async () => {
    vi.mocked(analyserApi.status).mockResolvedValue(statusResult());

    renderPage();

    expect(await screen.findByText("daily-activity")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /runner health/i })).toBeNull();
  });

  it("shows a friendly state for ANALYSER_NOT_CONFIGURED", async () => {
    vi.mocked(analyserApi.status).mockRejectedValue(new ApiError({
      backend: "core",
      method: "GET",
      path: "/api/analyser/status",
      url: "http://core/api/analyser/status",
      detail: "Analyser service is not configured",
      status: 503,
      code: "ANALYSER_NOT_CONFIGURED"
    }));

    renderPage();

    expect(await screen.findByRole("heading", { name: "Analyser service is not configured" })).toBeTruthy();
    expect(screen.getByText(/Configure the Analyser service/)).toBeTruthy();
  });

  it("switches to Activity through the query param and requests the computed range", async () => {
    const range = currentRange(7);
    renderPage();

    await screen.findByText("daily-activity");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByRole("heading", { name: "Server aggregate" })).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/analyser?tab=activity");
    await waitFor(() => {
      expect(analyserApi.activityAggregate).toHaveBeenCalledWith({
        ...range,
        machineId: undefined,
        timezone: expect.any(String)
      });
      expect(analyserApi.observations).toHaveBeenCalledWith({
        from: expect.stringMatching(/T.*Z$/),
        to: expect.stringMatching(/T.*Z$/),
        machineId: undefined,
        source: undefined,
        limit: 50
      });
      expect(analyserApi.derivedCaptures).toHaveBeenCalledWith({
        from: expect.stringMatching(/T.*Z$/),
        to: expect.stringMatching(/T.*Z$/),
        machineId: undefined,
        limit: 50
      });
    });
  });

  it("renders observation metadata and references without rendering a body field", async () => {
    const row = {
      ...observation("1", { metadata: { workspace: "Workbench", version: 3 } }),
      body: "Sensitive prose must not render"
    };
    vi.mocked(analyserApi.observations).mockResolvedValue({ items: [row] });

    renderPage("/analyser?tab=activity");

    expect(await screen.findByText("notes.get")).toBeTruthy();
    expect(screen.getByText("workspace:")).toBeTruthy();
    expect(screen.getByText("Workbench")).toBeTruthy();
    expect(screen.getByText("version:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "notes/note/note-1" }).getAttribute("href")).toBe("/notes?noteId=note-1");
    expect(screen.queryByText("Sensitive prose must not render")).toBeNull();
    expect(screen.getByText(/bodies are never stored/i)).toBeTruthy();
  });

  it("renders derived capture text and requests the selected activity range", async () => {
    renderPage("/analyser?tab=activity");

    expect(await screen.findByText("Derived capture 1")).toBeTruthy();
    expect(screen.getByText(/Completed a captured workflow/)).toBeTruthy();
    expect(screen.getByText(/Images stay on the machine and are never uploaded/)).toBeTruthy();
    expect(analyserApi.derivedCaptures).toHaveBeenCalledWith({
      from: expect.stringMatching(/T.*Z$/),
      to: expect.stringMatching(/T.*Z$/),
      machineId: undefined,
      limit: 50
    });
  });

  it("appends the next observation page using nextCursor", async () => {
    vi.mocked(analyserApi.observations)
      .mockResolvedValueOnce({ items: [observation("1", { action: "first.action" })], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [observation("2", { action: "second.action" })] });
    renderPage("/analyser?tab=activity");

    expect(await screen.findByText("first.action")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("second.action")).toBeTruthy();
    expect(screen.getByText("first.action")).toBeTruthy();
    expect(analyserApi.observations).toHaveBeenLastCalledWith({
      from: expect.stringMatching(/T.*Z$/),
      to: expect.stringMatching(/T.*Z$/),
      machineId: undefined,
      source: undefined,
      limit: 50,
      cursor: "cursor-2"
    });
  });

  it("exports a summary with the selected target kind and optional overrides", async () => {
    vi.mocked(analyserApi.summaries).mockResolvedValue({ items: [summaryListItem("summary-1", { title: "Weekly focus" })] });
    vi.mocked(analyserApi.summary).mockResolvedValue(summary("summary-1", {
      title: "Weekly focus",
      bodyMarkdown: "## Focused delivery\nCompleted the analyser shell.",
      metrics: { focusHours: 12, completed: true }
    }));

    renderPage("/analyser?tab=summaries");

    fireEvent.click(await screen.findByText("Weekly focus"));
    expect(await screen.findByText(/Completed the analyser shell/)).toBeTruthy();
    expect(screen.getByText("focusHours")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(analyserApi.summary).toHaveBeenCalledWith("summary-1");
    const exportButton = screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    fireEvent.click(exportButton);
    fireEvent.change(screen.getByLabelText("Export target kind"), { target: { value: "artifact" } });
    fireEvent.change(screen.getByLabelText("Export title override"), { target: { value: "Focused delivery export" } });
    fireEvent.change(screen.getByLabelText("Export project ID"), { target: { value: "project-1" } });
    fireEvent.change(screen.getByLabelText("Export artifact path"), { target: { value: "reports/focused-delivery.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Export record" }));

    await waitFor(() => expect(analyserApi.export).toHaveBeenCalledWith({
      sourceKind: "summary",
      sourceId: "summary-1",
      targetKind: "artifact",
      title: "Focused delivery export",
      projectId: "project-1",
      path: "reports/focused-delivery.md"
    }));
    expect(await screen.findByText("Exported to Artifact.")).toBeTruthy();
  });

  it("appends the next summaries page using nextCursor", async () => {
    vi.mocked(analyserApi.summaries)
      .mockResolvedValueOnce({ items: [summaryListItem("summary-1", { title: "First summary" })], nextCursor: "summary-cursor-2" })
      .mockResolvedValueOnce({ items: [summaryListItem("summary-2", { title: "Second summary" })] });

    renderPage("/analyser?tab=summaries");

    expect(await screen.findByText("First summary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second summary")).toBeTruthy();
    expect(screen.getByText("First summary")).toBeTruthy();
    expect(analyserApi.summaries).toHaveBeenLastCalledWith({
      kind: undefined,
      from: undefined,
      to: undefined,
      routineKey: undefined,
      limit: 50,
      cursor: "summary-cursor-2"
    });
  });

  it("uses the open proposal filter by default and approves with UI provenance and version", async () => {
    const open = proposal("proposal-approve", { title: "Approve indexing fix", version: 7 });
    vi.mocked(analyserApi.proposals).mockResolvedValue({ items: [proposalListItem(open.id, open)] });
    vi.mocked(analyserApi.proposal).mockResolvedValue(open);
    vi.mocked(analyserApi.resolveProposal).mockResolvedValue({ ...open, status: "approved", version: 8 });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPage("/analyser?tab=proposals");

    expect(await screen.findByText("Approve indexing fix")).toBeTruthy();
    expect(analyserApi.proposals).toHaveBeenCalledWith({ status: "open", kind: undefined, limit: 50 });
    fireEvent.click(screen.getByText("Approve indexing fix"));
    const exportButton = await screen.findByRole("button", { name: "Export" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.title).toBe("Only approved or executed proposals can be exported as durable knowledge");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(analyserApi.resolveProposal).toHaveBeenCalledWith("proposal-approve", {
      status: "approved",
      provenance: "workbench-ui",
      expectedVersion: 7
    }));
  });

  it("rejects an open proposal after confirmation with UI provenance and version", async () => {
    const open = proposal("proposal-reject", { title: "Reject stale move", version: 4 });
    vi.mocked(analyserApi.proposals).mockResolvedValue({ items: [proposalListItem(open.id, open)] });
    vi.mocked(analyserApi.proposal).mockResolvedValue(open);
    vi.mocked(analyserApi.resolveProposal).mockResolvedValue({ ...open, status: "rejected", version: 5 });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPage("/analyser?tab=proposals");

    fireEvent.click(await screen.findByText("Reject stale move"));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(analyserApi.resolveProposal).toHaveBeenCalledWith("proposal-reject", {
      status: "rejected",
      provenance: "workbench-ui",
      expectedVersion: 4
    }));
  });

  it("reloads proposal detail and shows a notice on VERSION_CONFLICT", async () => {
    const stale = proposal("proposal-conflict", { title: "Concurrent proposal", version: 2, bodyMarkdown: "Stale proposal body" });
    const fresh = proposal("proposal-conflict", { title: "Concurrent proposal", version: 3, bodyMarkdown: "Fresh proposal body" });
    vi.mocked(analyserApi.proposals).mockResolvedValue({ items: [proposalListItem(stale.id, stale)] });
    vi.mocked(analyserApi.proposal).mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    vi.mocked(analyserApi.resolveProposal).mockRejectedValue(new ApiError({
      backend: "core",
      method: "POST",
      path: "/api/analyser/proposals/proposal-conflict/resolve",
      url: "http://core/api/analyser/proposals/proposal-conflict/resolve",
      detail: "Proposal version conflict",
      status: 409,
      code: "VERSION_CONFLICT"
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPage("/analyser?tab=proposals");

    fireEvent.click(await screen.findByText("Concurrent proposal"));
    expect(await screen.findByText("Stale proposal body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Proposal changed elsewhere — reloaded.")).toBeTruthy();
    expect(await screen.findByText("Fresh proposal body")).toBeTruthy();
    expect(analyserApi.proposal).toHaveBeenCalledTimes(2);
  });

  it("loads and renders the recorded operation for an executed proposal", async () => {
    const executed = proposal("proposal-executed", { title: "Executed artifact move", status: "executed" });
    vi.mocked(analyserApi.proposals).mockImplementation(async (query) => query.status === "executed"
      ? { items: [proposalListItem(executed.id, executed)] }
      : { items: [] });
    vi.mocked(analyserApi.proposal).mockResolvedValue(executed);
    vi.mocked(analyserApi.operations).mockResolvedValue({ items: [operation("operation-1")] });

    renderPage("/analyser?tab=proposals");

    fireEvent.click(screen.getByRole("button", { name: "executed" }));
    fireEvent.click(await screen.findByText("Executed artifact move"));
    expect(await screen.findByText("succeeded")).toBeTruthy();
    expect(screen.getAllByText("artifact move").length).toBeGreaterThan(0);
    expect(screen.getByText("inbox/item.md")).toBeTruthy();
    expect(screen.getByText("archive/item.md")).toBeTruthy();
    expect(analyserApi.operations).toHaveBeenCalledWith({ proposalId: "proposal-executed" });
    const exportButton = screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    expect(exportButton.title).toBe("");
  });

  it("renders collection settings from settings() with the local-only screenshot caption", async () => {
    renderPage("/analyser?tab=settings");

    expect(await screen.findByRole("heading", { name: "Collection" })).toBeTruthy();
    const collection = within(screen.getByRole("region", { name: "Collection" }));
    expect((collection.getByLabelText("MCP access") as HTMLSelectElement).value).toBe("mutations");
    expect((collection.getByLabelText("Project allow list") as HTMLInputElement).value).toBe("project-a");
    expect(collection.getByText("Screenshots are captured and stored on this machine only — never uploaded")).toBeTruthy();
    expect((collection.getByLabelText("Screenshot-derived text upload") as HTMLInputElement).checked).toBe(false);
    expect(collection.getByText("Lets a local agent upload TEXT it derived from screenshots/captures to the server. The screenshot image itself is never uploaded.")).toBeTruthy();
    expect(analyserApi.settings).toHaveBeenCalledTimes(1);
    expect(analyserApi.machines).toHaveBeenCalledTimes(1);
  });

  it("saves the complete owner collection override with its expected version", async () => {
    renderPage("/analyser?tab=settings");

    await screen.findByRole("heading", { name: "Collection" });
    const collection = within(screen.getByRole("region", { name: "Collection" }));
    const workbenchChanges = collection.getByLabelText("Workbench changes") as HTMLSelectElement;
    fireEvent.change(workbenchChanges, { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "Save collection settings" }));

    await waitFor(() => expect(analyserApi.updateCollectionPolicy).toHaveBeenCalledWith({
      machineId: null,
      settings: { ...collectionSettings(), workbenchChanges: "off" },
      expectedVersion: 7
    }));
  });

  it("saves automation policy with the stored automation version", async () => {
    renderPage("/analyser?tab=settings");

    fireEvent.click(await screen.findByLabelText("destructive allowed"));
    fireEvent.click(screen.getByRole("button", { name: "Save automation policy" }));

    await waitFor(() => expect(analyserApi.updateAutomationPolicy).toHaveBeenCalledWith({
      policy: { ...automationPolicy(), destructiveAllowed: true },
      expectedVersion: 9
    }));
  });

  it("saves only changed routine schedule fields with the routine version", async () => {
    renderPage("/analyser?tab=routines");

    const expression = await screen.findByLabelText("Daily work summary schedule expression");
    fireEvent.change(expression, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));

    await waitFor(() => expect(analyserApi.updateRoutine).toHaveBeenCalledWith("daily-work-summary", {
      scheduleExpr: "30",
      expectedVersion: 5
    }));
  });

  it("runs skill integrity and reloads routines and the canonical catalog", async () => {
    vi.mocked(analyserApi.runSkillIntegrity).mockResolvedValue({
      checkedRoutines: 1,
      missing: ["skill-gone"],
      drifted: ["skill-changed"],
      proposalsCreated: 1
    });
    renderPage("/analyser?tab=routines");

    const routinesTab = await screen.findByRole("region", { name: "Routines" });
    await waitFor(() => {
      expect(analyserApi.routines).toHaveBeenCalledTimes(1);
      expect(analyserApi.skillCatalog).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(within(routinesTab).getByRole("button", { name: "Run skill integrity check" }));

    await waitFor(() => expect(analyserApi.runSkillIntegrity).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(analyserApi.routines).toHaveBeenCalledTimes(2);
      expect(analyserApi.skillCatalog).toHaveBeenCalledTimes(2);
    });
    expect(within(routinesTab).getByText("Skill integrity: blocked 1, drift 1, proposals 1.")).toBeTruthy();
  });

  it("shows the authoritative blocked badge only when skillMissing is true", async () => {
    vi.mocked(analyserApi.routines).mockResolvedValue({
      items: [
        analyserRoutine({ key: "blocked-routine", name: "Blocked routine", skillKey: "deleted-skill", skillMissing: true }),
        analyserRoutine({ id: "routine-2", key: "unblocked-routine", name: "Unblocked routine", skillMissing: false })
      ]
    });
    vi.mocked(analyserApi.skillCatalog).mockResolvedValue({ skills: ["workbench-analyser-cycle"] });

    renderPage("/analyser?tab=routines");

    const blockedRoutine = (await screen.findByText("Blocked routine")).closest("article");
    const unblockedRoutine = screen.getByText("Unblocked routine").closest("article");
    expect(blockedRoutine).toBeTruthy();
    expect(unblockedRoutine).toBeTruthy();
    expect(within(blockedRoutine as HTMLElement).getByText("blocked · skill missing")).toBeTruthy();
    expect(within(blockedRoutine as HTMLElement).queryByText("skill missing")).toBeNull();
    expect(within(unblockedRoutine as HTMLElement).queryByText("blocked · skill missing")).toBeNull();
  });

  it("shows a warning only for routines whose skill is missing from the canonical catalog", async () => {
    vi.mocked(analyserApi.routines).mockResolvedValue({
      items: [
        analyserRoutine({ key: "available-routine", name: "Available routine" }),
        analyserRoutine({ id: "routine-2", key: "missing-routine", name: "Missing routine", skillKey: "deleted-skill" })
      ]
    });
    vi.mocked(analyserApi.skillCatalog).mockResolvedValue({ skills: ["workbench-analyser-cycle"] });

    renderPage("/analyser?tab=routines");

    const availableRoutine = (await screen.findByText("Available routine")).closest("article");
    const missingRoutine = screen.getByText("Missing routine").closest("article");
    expect(availableRoutine).toBeTruthy();
    expect(missingRoutine).toBeTruthy();
    expect(within(availableRoutine as HTMLElement).queryByText("skill missing")).toBeNull();
    expect(within(missingRoutine as HTMLElement).getByText("skill missing")).toBeTruthy();
  });

  it("does not show missing-skill warnings when the catalog request fails", async () => {
    vi.mocked(analyserApi.routines).mockResolvedValue({
      items: [analyserRoutine({ name: "Unchecked routine", skillKey: "deleted-skill" })]
    });
    vi.mocked(analyserApi.skillCatalog).mockRejectedValue(new Error("catalog unavailable"));

    renderPage("/analyser?tab=routines");

    const routine = (await screen.findByText("Unchecked routine")).closest("article");
    expect(routine).toBeTruthy();
    await waitFor(() => expect(analyserApi.skillCatalog).toHaveBeenCalled());
    expect(within(routine as HTMLElement).queryByText("skill missing")).toBeNull();
  });

  it("does not show missing-skill warnings when the catalog reports itself unavailable", async () => {
    vi.mocked(analyserApi.routines).mockResolvedValue({
      items: [analyserRoutine({ name: "Unavailable catalog routine", skillKey: "deleted-skill" })]
    });
    vi.mocked(analyserApi.skillCatalog).mockResolvedValue({ skills: [], unavailable: true });

    renderPage("/analyser?tab=routines");

    const routine = (await screen.findByText("Unavailable catalog routine")).closest("article");
    expect(routine).toBeTruthy();
    await waitFor(() => expect(analyserApi.skillCatalog).toHaveBeenCalled());
    expect(within(routine as HTMLElement).queryByText("skill missing")).toBeNull();
  });

  it("creates a routine from the Routines tab form", async () => {
    renderPage("/analyser?tab=routines");

    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    fireEvent.change(screen.getByLabelText("New routine key"), { target: { value: "custom-weekly" } });
    fireEvent.change(screen.getByLabelText("New routine name"), { target: { value: "Custom weekly" } });
    fireEvent.change(screen.getByLabelText("New routine skill key"), { target: { value: "workbench-analyser-cycle" } });
    fireEvent.change(screen.getByLabelText("New routine schedule expression"), { target: { value: "0 9 * * 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

    await waitFor(() => expect(analyserApi.createRoutine).toHaveBeenCalledWith(expect.objectContaining({
      key: "custom-weekly",
      name: "Custom weekly",
      skillKey: "workbench-analyser-cycle",
      scheduleKind: "cron",
      scheduleExpr: "0 9 * * 1"
    })));
  });

  it("deletes a routine after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage("/analyser?tab=routines");

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(analyserApi.deleteRoutine).toHaveBeenCalledWith("daily-work-summary"));
    confirmSpy.mockRestore();
  });

  it("shows an invalid routine schedule message inline", async () => {
    vi.mocked(analyserApi.updateRoutine).mockRejectedValue(new ApiError({
      backend: "core",
      method: "PATCH",
      path: "/api/analyser/routines/daily-work-summary",
      url: "http://core/api/analyser/routines/daily-work-summary",
      detail: "Invalid cron minute",
      responseMessage: "Invalid cron minute",
      status: 400,
      code: "INVALID_SCHEDULE"
    }));

    renderPage("/analyser?tab=routines");
    fireEvent.change(await screen.findByLabelText("Daily work summary schedule expression"), { target: { value: "bad cron" } });
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));

    expect(await screen.findByText("Invalid cron minute")).toBeTruthy();
  });

  it("reloads settings and shows a notice after a collection version conflict", async () => {
    vi.mocked(analyserApi.updateCollectionPolicy).mockRejectedValue(new ApiError({
      backend: "core",
      method: "PUT",
      path: "/api/analyser/settings/collection",
      url: "http://core/api/analyser/settings/collection",
      detail: "Collection policy version conflict",
      status: 409,
      code: "VERSION_CONFLICT"
    }));

    renderPage("/analyser?tab=settings");
    fireEvent.click(await screen.findByRole("button", { name: "Save collection settings" }));

    expect(await screen.findByText("Collection settings changed elsewhere — reloaded.")).toBeTruthy();
    expect(analyserApi.settings).toHaveBeenCalledTimes(2);
  });
});
