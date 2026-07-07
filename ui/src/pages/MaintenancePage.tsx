import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { maintenanceApi, notesApi, projectsApi } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type {
  MaintenanceQueueItem,
  MaintenanceQueueKind,
  MaintenanceQueueReason,
  MaintenanceQueueResult,
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

export function MaintenancePage() {
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
    void load();
  }, [appliedFilters]);

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
          <h1>Maintenance</h1>
        </div>
        <button type="button" className="ghost-button" onClick={() => void load()} disabled={isLoading}>Refresh</button>
      </header>

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
    </div>
  );
}
