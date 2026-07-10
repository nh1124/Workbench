import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { coreApi, isTauriNativeRuntime, localDaemonApi, maintenanceApi, notesApi, projectsApi } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type {
  CaptureSummaryRecord,
  CaptureScreenshot,
  MaintenanceQueueItem,
  MaintenanceQueueKind,
  MaintenanceQueueReason,
  MaintenanceQueueResult,
  MaintenanceUsageSummary,
  ProjectMemoryKind
} from "../types/models";
import "./MaintenancePage.css";

const QUEUE_KINDS: MaintenanceQueueKind[] = ["memory", "note", "brief", "index_drift"];
const QUEUE_REASONS: MaintenanceQueueReason[] = [
  "raw",
  "expired",
  "unconfirmed",
  "conflict",
  "manual",
  "source_changed",
  "unused",
  "brief_unmaintained",
  "brief_oversized"
];
const MEMORY_KINDS: ProjectMemoryKind[] = ["decision", "fact", "preference", "pitfall", "observation"];
const PAGE_SIZE = 20;
const CAPTURE_SUMMARY_PAGE_SIZE = 20;

type FilterState = {
  kind: MaintenanceQueueKind | "";
  reason: MaintenanceQueueReason | "";
  projectId: string;
};

type ItemDraft = {
  reviewAfter?: string;
  snoozePreset?: "week" | "month" | "quarter" | "custom";
  snoozeUntil?: string;
  noteLifecycle?: "curated" | "verified";
  supersedeKind?: ProjectMemoryKind;
  supersedeBody?: string;
};

const initialFilters: FilterState = {
  kind: "",
  reason: "",
  projectId: ""
};

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function reasonLabel(reason: MaintenanceQueueReason): string {
  const labels: Record<MaintenanceQueueReason, string> = {
    raw: "Raw",
    expired: "Expired",
    unconfirmed: "Unconfirmed",
    conflict: "Conflict",
    manual: "Manual",
    source_changed: "Source changed",
    unused: "Unused",
    brief_unmaintained: "Brief",
    brief_oversized: "Brief oversized"
  };
  return labels[reason];
}

function nextSnoozeDate(preset: ItemDraft["snoozePreset"]): string {
  const date = new Date();
  if (preset === "month") date.setMonth(date.getMonth() + 1);
  else if (preset === "quarter") date.setMonth(date.getMonth() + 3);
  else date.setDate(date.getDate() + 7);
  return date.toISOString();
}

function dateInputToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function itemMatchesReasonFilter(item: MaintenanceQueueItem, reason: MaintenanceQueueReason | ""): boolean {
  return !reason || item.reasons.includes(reason);
}

function decrementTotals(
  totals: MaintenanceQueueResult["totals"],
  reasons: MaintenanceQueueReason[]
): MaintenanceQueueResult["totals"] {
  const byReason = { ...totals.byReason };
  for (const reason of reasons) {
    const next = Math.max(0, (byReason[reason] ?? 0) - 1);
    if (next === 0) delete byReason[reason];
    else byReason[reason] = next;
  }
  return { byReason };
}

function EmptyStateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M5 12.5l4 4L19 6.5" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function mergeCaptureSummaries(existing: CaptureSummaryRecord[], incoming: CaptureSummaryRecord[]): CaptureSummaryRecord[] {
  const byDate = new Map(existing.map((summary) => [summary.summaryDate, summary]));
  for (const summary of incoming) {
    byDate.set(summary.summaryDate, { ...byDate.get(summary.summaryDate), ...summary });
  }
  return [...byDate.values()].sort((left, right) => right.summaryDate.localeCompare(left.summaryDate));
}

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function screenshotTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function resourceLabel(resource: MaintenanceUsageSummary["topResources"][number]): string {
  return `${resource.sourceService}/${resource.resourceType}/${resource.resourceId}`;
}

function ActivityTab() {
  const nativeRuntimeAvailable = isTauriNativeRuntime();
  const [summaries, setSummaries] = useState<CaptureSummaryRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [selectedDate, setSelectedDate] = useState<string>();
  const [selectedSummary, setSelectedSummary] = useState<CaptureSummaryRecord>();
  const [usageSummary, setUsageSummary] = useState<MaintenanceUsageSummary>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [publishingDate, setPublishingDate] = useState<string>();
  const [summaryError, setSummaryError] = useState<string>();
  const [usageError, setUsageError] = useState<string>();
  const [screenshots, setScreenshots] = useState<CaptureScreenshot[]>([]);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);
  const [screenshotsError, setScreenshotsError] = useState<string>();
  const [expandedScreenshot, setExpandedScreenshot] = useState<CaptureScreenshot>();
  const screenshotDate = selectedDate ?? localDateString();

  const loadUsageSummary = async () => {
    try {
      setUsageError(undefined);
      setUsageSummary(await coreApi.maintenanceUsageSummary());
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : "Usage insights are unavailable.");
    }
  };

  const loadSummaries = async (cursor?: string) => {
    if (!nativeRuntimeAvailable) return;
    const isLoadingMore = Boolean(cursor);
    if (isLoadingMore) setLoadingMore(true);
    else setSummaryLoading(true);
    setSummaryError(undefined);

    try {
      const result = await localDaemonApi.listCaptureSummaries({ limit: CAPTURE_SUMMARY_PAGE_SIZE, cursor });
      setSummaries((current) => (isLoadingMore ? mergeCaptureSummaries(current, result.items) : mergeCaptureSummaries([], result.items)));
      setNextCursor(result.nextCursor);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : "Capture summaries are unavailable.");
    } finally {
      if (isLoadingMore) setLoadingMore(false);
      else setSummaryLoading(false);
    }
  };

  useEffect(() => {
    void loadUsageSummary();
    if (nativeRuntimeAvailable) {
      void loadSummaries();
    }
  }, [nativeRuntimeAvailable]);

  useEffect(() => {
    if (!nativeRuntimeAvailable) return;
    let cancelled = false;
    setScreenshotsLoading(true);
    setScreenshots([]);
    setScreenshotsError(undefined);
    void localDaemonApi.listCaptureScreenshots({ date: screenshotDate }).then((result) => {
      if (!cancelled) setScreenshots(result.items);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setScreenshots([]);
        setScreenshotsError(error instanceof Error ? error.message : "Screenshots are unavailable.");
      }
    }).finally(() => {
      if (!cancelled) setScreenshotsLoading(false);
    });
    return () => { cancelled = true; };
  }, [nativeRuntimeAvailable, screenshotDate]);

  const openSummary = async (summaryDate: string) => {
    if (!nativeRuntimeAvailable) return;
    setSelectedDate(summaryDate);
    setDetailLoading(true);
    setSummaryError(undefined);
    try {
      setSelectedSummary(await localDaemonApi.getCaptureSummary(summaryDate));
    } catch (error) {
      setSelectedSummary(undefined);
      setSummaryError(error instanceof Error ? error.message : "Capture summary could not be loaded.");
    } finally {
      setDetailLoading(false);
    }
  };

  const publishSummary = async (summaryDate: string) => {
    if (!nativeRuntimeAvailable) return;
    setPublishingDate(summaryDate);
    setSummaryError(undefined);
    try {
      const published = await localDaemonApi.publishCaptureSummary(summaryDate);
      const updated = { ...published, published: true };
      setSummaries((current) => mergeCaptureSummaries(current, [updated]));
      setSelectedSummary((current) => current?.summaryDate === summaryDate ? { ...current, ...updated } : current);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : "Capture summary could not be saved to Notes.");
    } finally {
      setPublishingDate(undefined);
    }
  };

  const zeroHitQueries = usageSummary?.zeroHitQueries.slice(0, 3) ?? [];
  const topResources = usageSummary?.topResources.slice(0, 3) ?? [];

  return (
    <section className="analyser-activity" aria-label="Activity">
      <div className="activity-usage-grid" aria-label="Usage insights">
        <article className="activity-usage-card">
          <span>Truncation events</span>
          <strong>{usageSummary?.truncation.count ?? "—"}</strong>
          <small>{usageSummary ? "in the recent usage window" : usageError ? "Core usage is unavailable" : "Loading usage insights..."}</small>
        </article>
        <article className="activity-usage-card">
          <span>Zero-hit queries</span>
          {zeroHitQueries.length > 0 ? (
            <ol>
              {zeroHitQueries.map((query) => <li key={query.queryText}><span>{query.queryText}</span><strong>{query.count}</strong></li>)}
            </ol>
          ) : <small>{usageSummary ? "No zero-hit queries recorded." : "—"}</small>}
        </article>
        <article className="activity-usage-card">
          <span>Top resources</span>
          {topResources.length > 0 ? (
            <ol>
              {topResources.map((resource) => <li key={`${resource.sourceService}:${resource.resourceType}:${resource.resourceId}`}><span>{resourceLabel(resource)}</span><strong>{resource.count}</strong></li>)}
            </ol>
          ) : <small>{usageSummary ? "No resource reads recorded." : "—"}</small>}
        </article>
      </div>

      {!nativeRuntimeAvailable ? (
        <div className="activity-empty-card">
          <h2>Activity is available in Workbench desktop</h2>
          <p>Connect the local daemon in Settings to review locally captured daily summaries.</p>
          <Link className="maintenance-link-button" to="/settings?tab=account&section=sync-daemon">Open Local Sync settings</Link>
        </div>
      ) : (
        <>
          <div className="activity-section-header">
            <div>
              <h2>Capture summaries</h2>
              <p>Daily local activity summaries stored by the desktop capture daemon.</p>
            </div>
            <button type="button" className="ghost-button" onClick={() => void loadSummaries()} disabled={summaryLoading}>
              {summaryLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {summaryError ? <p className="maintenance-error" role="alert">{summaryError}</p> : null}
          {summaryLoading ? <p className="maintenance-muted">Loading capture summaries...</p> : null}

          {!summaryLoading && !summaryError && summaries.length === 0 ? (
            <div className="activity-empty-card">
              <h2>No capture summaries yet</h2>
              <p>Daily summaries will appear here after Capture has collected local activity.</p>
            </div>
          ) : null}

          {summaries.length > 0 ? (
            <div className="activity-summary-layout">
              <div className="activity-summary-list">
                {summaries.map((summary) => (
                  <article className={selectedDate === summary.summaryDate ? "activity-summary-row selected" : "activity-summary-row"} key={summary.summaryDate}>
                    <button
                      type="button"
                      className="activity-summary-select"
                      aria-label={`Open summary ${summary.summaryDate}`}
                      aria-pressed={selectedDate === summary.summaryDate}
                      onClick={() => void openSummary(summary.summaryDate)}
                    >
                      <strong>{summary.summaryDate}</strong>
                      <span>{summary.sampleCount} sample{summary.sampleCount === 1 ? "" : "s"}</span>
                      <span className={summary.published ? "activity-published-badge published" : "activity-published-badge"}>
                        {summary.published ? "Published" : "Not published"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="activity-save-button"
                      disabled={publishingDate === summary.summaryDate}
                      onClick={() => void publishSummary(summary.summaryDate)}
                    >
                      {publishingDate === summary.summaryDate ? "Saving..." : summary.published ? "Update Note" : "Save to Notes"}
                    </button>
                  </article>
                ))}
                {nextCursor ? (
                  <div className="maintenance-load-more">
                    <button type="button" onClick={() => void loadSummaries(nextCursor)} disabled={loadingMore}>
                      {loadingMore ? "Loading..." : "Load more"}
                    </button>
                  </div>
                ) : null}
              </div>

              <aside className="activity-summary-detail" aria-live="polite">
                {detailLoading ? <p className="maintenance-muted">Loading summary...</p> : null}
                {!detailLoading && selectedSummary ? (
                  <>
                    <div className="activity-detail-heading">
                      <div>
                        <h2>{selectedSummary.summaryDate}</h2>
                        <p>{selectedSummary.sampleCount} sample{selectedSummary.sampleCount === 1 ? "" : "s"}</p>
                      </div>
                      <span className={selectedSummary.published ? "activity-published-badge published" : "activity-published-badge"}>
                        {selectedSummary.published ? "Published" : "Not published"}
                      </span>
                    </div>
                    <pre>{selectedSummary.summaryMarkdown || "No summary text is available."}</pre>
                  </>
                ) : null}
                {!detailLoading && !selectedSummary ? <p className="maintenance-muted">Select a daily summary to read it.</p> : null}
              </aside>
            </div>
          ) : null}

          <div className="activity-section-header activity-screenshots-header">
            <div>
              <h2>Screenshots</h2>
              <p>{screenshotDate} · Stored locally on this device.</p>
            </div>
          </div>
          {screenshotsLoading ? <p className="maintenance-muted">Loading screenshots...</p> : null}
          {screenshotsError ? <p className="maintenance-error" role="alert">{screenshotsError}</p> : null}
          {!screenshotsLoading && !screenshotsError && screenshots.length === 0 ? (
            <div className="activity-empty-card"><h2>No screenshots</h2><p>No local screenshots were captured for this date.</p></div>
          ) : null}
          {screenshots.length > 0 ? (
            <div className="activity-screenshot-grid" aria-label={`Screenshots for ${screenshotDate}`}>
              {screenshots.map((screenshot) => (
                <button type="button" className="activity-screenshot-card" key={screenshot.id} onClick={() => setExpandedScreenshot(screenshot)} aria-label={`Open screenshot at ${screenshotTime(screenshot.capturedAt)}`}>
                  <img src={localDaemonApi.captureScreenshotFileUrl(screenshot.id)} alt={`Screenshot captured at ${screenshotTime(screenshot.capturedAt)}`} loading="lazy" />
                  <span><strong>{screenshotTime(screenshot.capturedAt)}</strong>{screenshot.processName ? ` · ${screenshot.processName}` : ""}</span>
                </button>
              ))}
            </div>
          ) : null}
          {expandedScreenshot ? (
            <div className="activity-screenshot-lightbox" role="dialog" aria-modal="true" aria-label="Screenshot preview" onClick={() => setExpandedScreenshot(undefined)}>
              <div className="activity-screenshot-lightbox-content" onClick={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => setExpandedScreenshot(undefined)} aria-label="Close screenshot preview">×</button>
                <img src={localDaemonApi.captureScreenshotFileUrl(expandedScreenshot.id)} alt={`Screenshot captured at ${screenshotTime(expandedScreenshot.capturedAt)}`} />
                <p>{screenshotTime(expandedScreenshot.capturedAt)}{expandedScreenshot.processName ? ` · ${expandedScreenshot.processName}` : ""}</p>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function AnalyserPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") === "activity" ? "activity" : "review";
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(initialFilters);
  const [items, setItems] = useState<MaintenanceQueueItem[]>([]);
  const [totals, setTotals] = useState<MaintenanceQueueResult["totals"]>({ byReason: {} });
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queueOptions = (cursor?: string) => ({
    kind: appliedFilters.kind || undefined,
    reason: appliedFilters.reason || undefined,
    projectId: appliedFilters.projectId.trim() || undefined,
    cursor,
    limit: PAGE_SIZE
  });

  const load = async (cursor?: string) => {
    const loadingMore = Boolean(cursor);
    if (loadingMore) setIsLoadingMore(true);
    else setIsLoading(true);
    setError(null);

    try {
      const result = await maintenanceApi.queue(queueOptions(cursor));
      setItems((prev) => loadingMore ? [...prev, ...result.items] : result.items);
      setTotals(result.totals);
      setNextCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load maintenance queue.");
    } finally {
      if (loadingMore) setIsLoadingMore(false);
      else setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "review") return;
    void load();
  }, [activeTab, appliedFilters]);

  const selectTab = (tab: "review" | "activity") => {
    const next = new URLSearchParams(searchParams);
    if (tab === "activity") next.set("tab", "activity");
    else next.delete("tab");
    setSearchParams(next);
  };

  const visibleTotals = useMemo(
    () => QUEUE_REASONS.filter((reason) => (totals.byReason[reason] ?? 0) > 0),
    [totals]
  );
  const visibleItems = useMemo(
    () => items.filter((item) => itemMatchesReasonFilter(item, appliedFilters.reason)),
    [appliedFilters.reason, items]
  );
  const hasAppliedFilters = Boolean(
    appliedFilters.kind || appliedFilters.reason || appliedFilters.projectId.trim()
  );

  const patchDraft = (itemId: string, patch: ItemDraft) => {
    setDrafts((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }));
  };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setAppliedFilters({ ...filters, projectId: filters.projectId.trim() });
  };

  const clearFilters = () => {
    setFilters(initialFilters);
    setAppliedFilters(initialFilters);
  };

  const removeOptimistically = async (item: MaintenanceQueueItem, operation: () => Promise<unknown>) => {
    const previousItems = items;
    const previousTotals = totals;
    setBusyItemId(item.id);
    setError(null);
    setItems((prev) => prev.filter((entry) => entry.id !== item.id));
    setTotals((prev) => decrementTotals(prev, item.reasons));

    try {
      await operation();
    } catch (operationError) {
      setItems(previousItems);
      setTotals(previousTotals);
      setError(operationError instanceof Error ? operationError.message : "Maintenance action failed.");
    } finally {
      setBusyItemId(null);
    }
  };

  const confirmItem = (item: MaintenanceQueueItem) => {
    const draft = drafts[item.id] ?? {};
    const reviewAfter = dateInputToIso(draft.reviewAfter);
    if (item.kind === "memory") {
      return removeOptimistically(item, () =>
        maintenanceApi.confirmMemory(item.resourceId, reviewAfter ? { reviewAfter } : {})
      );
    }
    if (item.kind === "note") {
      return removeOptimistically(item, () =>
        maintenanceApi.confirmNote(item.resourceId, {
          lifecycleState: draft.noteLifecycle ?? "curated",
          ...(reviewAfter ? { reviewAfter } : {})
        })
      );
    }
    return Promise.resolve();
  };

  const snoozeItem = (item: MaintenanceQueueItem) => {
    const draft = drafts[item.id] ?? {};
    const until = draft.snoozePreset === "custom"
      ? dateInputToIso(draft.snoozeUntil)
      : nextSnoozeDate(draft.snoozePreset ?? "week");
    if (!until) {
      setError("Choose a snooze date.");
      return Promise.resolve();
    }
    if (item.kind === "memory") {
      return removeOptimistically(item, () => maintenanceApi.snoozeMemory(item.resourceId, { until }));
    }
    if (item.kind === "note") {
      return removeOptimistically(item, () => maintenanceApi.snoozeNote(item.resourceId, { until }));
    }
    return Promise.resolve();
  };

  const supersedeMemory = (item: MaintenanceQueueItem) => {
    const draft = drafts[item.id] ?? {};
    const bodyMarkdown = (draft.supersedeBody ?? item.excerpt).trim();
    if (!bodyMarkdown) {
      setError("Replacement memory text is required.");
      return Promise.resolve();
    }
    return removeOptimistically(item, () =>
      projectsApi.appendMemory(item.projectId, {
        kind: draft.supersedeKind ?? "observation",
        bodyMarkdown,
        authority: "user_confirmed",
        supersedesId: item.resourceId
      })
    );
  };

  const archiveMemory = (item: MaintenanceQueueItem) => {
    if (!window.confirm("Archive this memory item?")) return Promise.resolve();
    return removeOptimistically(item, () => projectsApi.archiveMemory(item.resourceId));
  };

  const deleteNote = (item: MaintenanceQueueItem) => {
    if (!window.confirm("Delete this note?")) return Promise.resolve();
    return removeOptimistically(item, () => notesApi.remove(item.resourceId));
  };

  const rebuildIndex = (item: MaintenanceQueueItem) =>
    removeOptimistically(item, () => projectsApi.rebuildIndex(item.projectId));

  const renderItemControls = (item: MaintenanceQueueItem) => {
    const draft = drafts[item.id] ?? {};
    const disabled = busyItemId === item.id;
    if (item.kind === "brief") {
      return (
        <div className="maintenance-actions">
          <Link className="maintenance-link-button" to={`/projects/${encodeURIComponent(item.projectId)}`}>Open brief</Link>
        </div>
      );
    }
    if (item.kind === "index_drift") {
      return (
        <div className="maintenance-actions">
          <button type="button" onClick={() => void rebuildIndex(item)} disabled={disabled}>Rebuild index</button>
        </div>
      );
    }

    return (
      <div className="maintenance-actions">
        <div className="maintenance-inline-field">
          <label htmlFor={`${item.id}-review-after`}>Review after</label>
          <input
            id={`${item.id}-review-after`}
            type="date"
            value={draft.reviewAfter ?? ""}
            onChange={(event) => patchDraft(item.id, { reviewAfter: event.target.value })}
          />
        </div>
        {item.kind === "note" ? (
          <div className="maintenance-inline-field">
            <label htmlFor={`${item.id}-lifecycle`}>Confirm as</label>
            <select
              id={`${item.id}-lifecycle`}
              value={draft.noteLifecycle ?? "curated"}
              onChange={(event) => patchDraft(item.id, { noteLifecycle: event.target.value as "curated" | "verified" })}
            >
              <option value="curated">Curated</option>
              <option value="verified">Verified</option>
            </select>
          </div>
        ) : null}
        <button type="button" onClick={() => void confirmItem(item)} disabled={disabled}>Confirm</button>
        <div className="maintenance-inline-field">
          <label htmlFor={`${item.id}-snooze`}>Snooze</label>
          <select
            id={`${item.id}-snooze`}
            value={draft.snoozePreset ?? "week"}
            onChange={(event) => patchDraft(item.id, { snoozePreset: event.target.value as ItemDraft["snoozePreset"] })}
          >
            <option value="week">1 week</option>
            <option value="month">1 month</option>
            <option value="quarter">3 months</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        {(draft.snoozePreset ?? "week") === "custom" ? (
          <input
            aria-label="Custom snooze date"
            type="date"
            value={draft.snoozeUntil ?? ""}
            onChange={(event) => patchDraft(item.id, { snoozeUntil: event.target.value })}
          />
        ) : null}
        <button type="button" className="ghost-button" onClick={() => void snoozeItem(item)} disabled={disabled}>Snooze</button>
        {item.kind === "memory" ? (
          <details className="maintenance-replace">
            <summary>Edit and replace</summary>
            <select
              value={draft.supersedeKind ?? "observation"}
              onChange={(event) => patchDraft(item.id, { supersedeKind: event.target.value as ProjectMemoryKind })}
              aria-label="Replacement memory kind"
            >
              {MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{label(kind)}</option>)}
            </select>
            <textarea
              aria-label="Replacement memory text"
              value={draft.supersedeBody ?? item.excerpt}
              onChange={(event) => patchDraft(item.id, { supersedeBody: event.target.value })}
              rows={3}
            />
            <button type="button" onClick={() => void supersedeMemory(item)} disabled={disabled}>Replace</button>
          </details>
        ) : null}
        {item.kind === "memory" ? (
          <button type="button" className="danger-button" onClick={() => void archiveMemory(item)} disabled={disabled}>Archive</button>
        ) : (
          <button type="button" className="danger-button" onClick={() => void deleteNote(item)} disabled={disabled}>Delete</button>
        )}
      </div>
    );
  };

  return (
    <div className="maintenance-page">
      <header className="maintenance-header">
        <div>
          <h1>Analyser</h1>
        </div>
        <div className="analyser-header-actions">
          <div className="analyser-tabs" role="tablist" aria-label="Analyser views">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "review"}
              className={activeTab === "review" ? "analyser-tab active" : "analyser-tab"}
              onClick={() => selectTab("review")}
            >
              Review
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "activity"}
              className={activeTab === "activity" ? "analyser-tab active" : "analyser-tab"}
              onClick={() => selectTab("activity")}
            >
              Activity
            </button>
          </div>
          {activeTab === "review" ? (
            <button type="button" className="ghost-button" onClick={() => void load()} disabled={isLoading}>Refresh</button>
          ) : null}
        </div>
      </header>

      {activeTab === "review" ? (
        <>
      <form className="maintenance-filter-bar" onSubmit={applyFilters}>
        <label>
          <span>Kind</span>
          <select
            value={filters.kind}
            onChange={(event) => setFilters((prev) => ({ ...prev, kind: event.target.value as FilterState["kind"] }))}
          >
            <option value="">All kinds</option>
            {QUEUE_KINDS.map((kind) => <option key={kind} value={kind}>{label(kind)}</option>)}
          </select>
        </label>
        <label>
          <span>Reason</span>
          <select
            value={filters.reason}
            onChange={(event) => setFilters((prev) => ({ ...prev, reason: event.target.value as FilterState["reason"] }))}
          >
            <option value="">All reasons</option>
            {QUEUE_REASONS.map((reason) => <option key={reason} value={reason}>{reasonLabel(reason)}</option>)}
          </select>
        </label>
        <label>
          <span>Project ID</span>
          <input
            value={filters.projectId}
            onChange={(event) => setFilters((prev) => ({ ...prev, projectId: event.target.value }))}
            placeholder="Optional project id"
          />
        </label>
        <button type="submit" disabled={isLoading}>Apply</button>
      </form>

      <div className="maintenance-totals" aria-label="Queue totals">
        {visibleTotals.length === 0 ? <span className="maintenance-total muted">No open reasons</span> : null}
        {visibleTotals.map((reason) => (
          <button
            type="button"
            key={reason}
            className={appliedFilters.reason === reason ? "maintenance-total active" : "maintenance-total"}
            onClick={() => {
              setFilters((prev) => ({ ...prev, reason }));
              setAppliedFilters((prev) => ({ ...prev, reason }));
            }}
          >
            {reasonLabel(reason)} <strong>{totals.byReason[reason]}</strong>
          </button>
        ))}
      </div>

      {error ? <p className="maintenance-error" role="alert">{error}</p> : null}

      <section className="maintenance-list" aria-label="Maintenance queue">
        {isLoading ? <p className="maintenance-muted">Loading maintenance queue...</p> : null}
        {!isLoading && visibleItems.length === 0 ? (
          <div className="maintenance-empty-card">
            <span className="maintenance-empty-icon"><EmptyStateIcon /></span>
            <h2>{hasAppliedFilters ? "No matching items" : "All clear"}</h2>
            <p>
              {hasAppliedFilters
                ? "No maintenance items match the current filters."
                : "No maintenance work is waiting right now."}
            </p>
            {hasAppliedFilters ? (
              <button type="button" className="ghost-button" onClick={clearFilters}>Clear filters</button>
            ) : (
              <button type="button" onClick={() => void load()} disabled={isLoading}>Refresh</button>
            )}
          </div>
        ) : null}
        {visibleItems.map((item) => (
          <article className="maintenance-item" key={item.id} aria-label={item.title}>
            <div className="maintenance-item-main">
              <div className="maintenance-item-top">
                <div className="maintenance-badges">
                  <span className={`maintenance-kind kind-${item.kind}`}>{label(item.kind)}</span>
                  {item.reasons.map((reason) => (
                    <span key={reason} className={`maintenance-reason reason-${reason}`}>{reasonLabel(reason)}</span>
                  ))}
                  {item.authority ? (
                    <span className={`maintenance-authority authority-${item.authority}`}>{label(item.authority)}</span>
                  ) : null}
                  {item.lifecycleState ? (
                    <span className={`maintenance-lifecycle lifecycle-${item.lifecycleState}`}>{label(item.lifecycleState)}</span>
                  ) : null}
                </div>
                <time>{formatDateTime(item.updatedAt)}</time>
              </div>
              <h2>{item.title}</h2>
              <p>{item.excerpt || "No excerpt available."}</p>
              <div className="maintenance-item-meta">
                <Link to={`/projects/${encodeURIComponent(item.projectId)}`}>{item.projectName}</Link>
                <span>{item.resourceId}</span>
                {item.reviewAfter ? <span>review after {formatDateTime(item.reviewAfter)}</span> : null}
                {item.lastConfirmedAt ? <span>confirmed {formatDateTime(item.lastConfirmedAt)}</span> : null}
              </div>
            </div>
            {renderItemControls(item)}
          </article>
        ))}
      </section>

      {nextCursor ? (
        <div className="maintenance-load-more">
          <button type="button" onClick={() => void load(nextCursor)} disabled={isLoadingMore}>
            {isLoadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      ) : null}
        </>
      ) : <ActivityTab />}
    </div>
  );
}

// Keep the legacy export for embedded callers while the visible product surface is Analyser.
export const MaintenancePage = AnalyserPage;
