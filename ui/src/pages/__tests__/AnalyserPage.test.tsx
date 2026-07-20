// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { analyserApi, ApiError } from "../../lib/api";
import type {
  AnalyserActivityAggregate,
  AnalyserObservationRecord,
  AnalyserOperationRecord,
  AnalyserProposalListItem,
  AnalyserProposalRecord,
  AnalyserSummaryListItem,
  AnalyserSummaryRecord,
  AnalyserStatusResult
} from "../../types/models";
import { AnalyserPage } from "../AnalyserPage";

const updatedAt = "2026-07-20T04:00:00.000Z";

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
  vi.spyOn(analyserApi, "summaries").mockResolvedValue({ items: [] });
  vi.spyOn(analyserApi, "summary").mockImplementation(async (id) => summary(id));
  vi.spyOn(analyserApi, "proposals").mockResolvedValue({ items: [] });
  vi.spyOn(analyserApi, "proposal").mockImplementation(async (id) => proposal(id));
  vi.spyOn(analyserApi, "resolveProposal").mockImplementation(async (id, body) => proposal(id, { status: body.status }));
  vi.spyOn(analyserApi, "supersedeProposal").mockImplementation(async (id) => proposal(id, { status: "superseded" }));
  vi.spyOn(analyserApi, "operations").mockResolvedValue({ items: [] });
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
      expect(analyserApi.activityAggregate).toHaveBeenCalledWith({ ...range, machineId: undefined });
      expect(analyserApi.observations).toHaveBeenCalledWith({
        ...range,
        machineId: undefined,
        source: undefined,
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

  it("appends the next observation page using nextCursor", async () => {
    vi.mocked(analyserApi.observations)
      .mockResolvedValueOnce({ items: [observation("1", { action: "first.action" })], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [observation("2", { action: "second.action" })] });
    const range = currentRange(7);

    renderPage("/analyser?tab=activity");

    expect(await screen.findByText("first.action")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("second.action")).toBeTruthy();
    expect(screen.getByText("first.action")).toBeTruthy();
    expect(analyserApi.observations).toHaveBeenLastCalledWith({
      ...range,
      machineId: undefined,
      source: undefined,
      limit: 50,
      cursor: "cursor-2"
    });
  });

  it("renders summaries, fetches detail with body and metrics, and disables export", async () => {
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
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.title).toBe("Export arrives with the publication pipeline");
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
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.title).toBe("Export arrives with the publication pipeline");
  });
});
