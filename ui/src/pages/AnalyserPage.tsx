import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { analyserApi, ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { ANALYSER_OPERATION_KINDS } from "../types/models";
import type {
  AnalyserActivityAggregate,
  AnalyserAutomationPolicy,
  AnalyserCollectionSettings,
  AnalyserCollectionSettingsOverride,
  AnalyserMachineRecord,
  AnalyserObservationRecord,
  AnalyserObservationSource,
  AnalyserOperationRecord,
  AnalyserProposalListItem,
  AnalyserProposalRecord,
  AnalyserProposalStatus,
  AnalyserResourceRef,
  AnalyserRoutineRecord,
  AnalyserSettingsResult,
  AnalyserStatusResult,
  AnalyserSummaryListItem,
  AnalyserSummaryRecord
} from "../types/models";
import "./AnalyserPage.css";

const TABS = ["overview", "activity", "summaries", "proposals", "settings"] as const;
const SOURCES: AnalyserObservationSource[] = [
  "workbench_change",
  "mcp_access",
  "ui_access",
  "agent_session",
  "pc_activity",
  "local_file"
];
const OBSERVATION_PAGE_SIZE = 50;
const ANALYSER_PAGE_SIZE = 50;
const PROPOSAL_STATUSES: AnalyserProposalStatus[] = ["open", "approved", "rejected", "executed", "superseded"];

type AnalyserTab = (typeof TABS)[number];
type ActivityPeriod = 7 | 14 | 30;

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function activityRange(period: ActivityPeriod): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (period - 1));
  return { from: localDateString(from), to: localDateString(to) };
}

function optionalDate(value: string | undefined): string {
  return value ? formatDateTime(value) : "—";
}

function machineName(machine: AnalyserMachineRecord): string {
  return machine.displayName?.trim() || machine.machineKey;
}

function isAnalyserNotConfigured(error: unknown): boolean {
  return error instanceof ApiError
    ? error.status === 503 && error.code === "ANALYSER_NOT_CONFIGURED"
    : error instanceof Error && /analyser service is not configured/i.test(error.message);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "VERSION_CONFLICT";
}

function NotConfiguredState() {
  return (
    <div className="analyser-empty-card">
      <h2>Analyser service is not configured</h2>
      <p>Configure the Analyser service on your Workbench server to use routines and activity history.</p>
    </div>
  );
}

function OverviewTab() {
  const [status, setStatus] = useState<AnalyserStatusResult>();
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<"seed" | "flush">();
  const [error, setError] = useState<string>();
  const [notConfigured, setNotConfigured] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    setNotConfigured(false);
    try {
      setStatus(await analyserApi.status());
    } catch (requestError) {
      setStatus(undefined);
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Analyser status is unavailable."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const runAction = async (action: "seed" | "flush") => {
    setBusyAction(action);
    setError(undefined);
    try {
      if (action === "seed") await analyserApi.seedRoutines();
      else await analyserApi.projectorFlush();
      await load();
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, `Unable to ${action} Analyser data.`));
    } finally {
      setBusyAction(undefined);
    }
  };

  if (notConfigured) return <NotConfiguredState />;

  return (
    <section className="analyser-overview" aria-label="Analyser overview">
      <div className="analyser-section-header">
        <div>
          <h2>Routine status</h2>
          <p>Scheduled analysis work, recent outcomes, and current leases.</p>
        </div>
        <div className="analyser-actions">
          <button type="button" className="ghost-button analyser-small-action" onClick={() => void runAction("flush")} disabled={Boolean(busyAction) || loading}>
            {busyAction === "flush" ? "Flushing..." : "Flush projector"}
          </button>
          <button type="button" onClick={() => void load()} disabled={loading || Boolean(busyAction)}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error ? <p className="analyser-error" role="alert">{error}</p> : null}
      {loading && !status ? <p className="analyser-muted">Loading Analyser status...</p> : null}

      {status ? (
        <>
          <div className={status.hasOpenProposals ? "analyser-proposal-indicator open" : "analyser-proposal-indicator"}>
            <span>{status.hasOpenProposals ? "Open proposals need review" : "No open proposals"}</span>
            <Link to="/analyser?tab=proposals">Open Proposals</Link>
          </div>

          {status.routines.length === 0 ? (
            <div className="analyser-empty-card">
              <h2>No routines are configured</h2>
              <p>Seed the default routines to begin scheduled analysis.</p>
              <button type="button" onClick={() => void runAction("seed")} disabled={Boolean(busyAction)}>
                {busyAction === "seed" ? "Seeding..." : "Seed routines"}
              </button>
            </div>
          ) : (
            <div className="analyser-table-wrap">
              <table className="analyser-table">
                <thead>
                  <tr>
                    <th>Routine</th>
                    <th>State</th>
                    <th>Next run</th>
                    <th>Last completed</th>
                    <th>Last failed</th>
                    <th>Active run</th>
                  </tr>
                </thead>
                <tbody>
                  {status.routines.map((routine) => (
                    <tr key={routine.key}>
                      <td><strong>{routine.key}</strong></td>
                      <td><span className={routine.enabled ? "analyser-state enabled" : "analyser-state disabled"}>{routine.enabled ? "Enabled" : "Disabled"}</span></td>
                      <td>{optionalDate(routine.nextRunAt)}</td>
                      <td>{optionalDate(routine.lastCompletedAt)}</td>
                      <td>
                        <span title={routine.lastErrorSummary}>{optionalDate(routine.lastFailedAt)}</span>
                        {routine.lastErrorSummary ? <small className="analyser-error-summary">{routine.lastErrorSummary}</small> : null}
                      </td>
                      <td>
                        {routine.activeRun ? (
                          <span title={`Run ${routine.activeRun.id}`}>
                            {routine.activeRun.holder}<small>lease {formatDateTime(routine.activeRun.leaseExpiresAt)}</small>
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <section className="analyser-machines" aria-labelledby="analyser-machines-heading">
            <div className="analyser-section-header">
              <div>
                <h2 id="analyser-machines-heading">Machines</h2>
                <p>Devices that have registered with Analyser.</p>
              </div>
            </div>
            {status.machines.length === 0 ? <p className="analyser-muted">No machines are registered.</p> : (
              <div className="analyser-machine-grid">
                {status.machines.map((machine) => (
                  <article className="analyser-machine-card" key={machine.id}>
                    <strong>{machineName(machine)}</strong>
                    <span>{machine.platform || "Unknown platform"}</span>
                    <small>Last seen {formatDateTime(machine.lastSeenAt)}</small>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}

function aggregateApps(apps: Record<string, number>): Array<{ name: string; count: number }> {
  const sorted = Object.entries(apps).sort((left, right) => right[1] - left[1]);
  const visible = sorted.slice(0, 8).map(([name, count]) => ({ name, count }));
  const other = sorted.slice(8).reduce((total, [, count]) => total + count, 0);
  if (other > 0) visible.push({ name: "other", count: other });
  return visible;
}

function metadataValue(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

function resourceRefLabel(ref: AnalyserResourceRef): string {
  return ref.pathSnapshot || `${ref.service}/${ref.resourceType}/${ref.resourceId}`;
}

function ResourceReference({ resource }: { resource: AnalyserResourceRef }) {
  const labelText = resourceRefLabel(resource);
  if (resource.service === "notes") {
    return <Link to={`/notes?noteId=${encodeURIComponent(resource.resourceId)}`}>{labelText}</Link>;
  }
  if (resource.service === "artifacts") {
    return <Link to="/artifacts">{labelText}</Link>;
  }
  if (resource.service === "projects") {
    return <Link to={`/projects?projectId=${encodeURIComponent(resource.resourceId)}`}>{labelText}</Link>;
  }
  return <span>{labelText}</span>;
}

function ActivityTab() {
  const [period, setPeriod] = useState<ActivityPeriod>(7);
  const [machineId, setMachineId] = useState("");
  const [source, setSource] = useState<AnalyserObservationSource | "">("");
  const [machines, setMachines] = useState<AnalyserMachineRecord[]>([]);
  const [aggregate, setAggregate] = useState<AnalyserActivityAggregate>();
  const [observations, setObservations] = useState<AnalyserObservationRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [aggregateLoading, setAggregateLoading] = useState(true);
  const [observationLoading, setObservationLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [notConfigured, setNotConfigured] = useState(false);
  const range = useMemo(() => activityRange(period), [period]);

  useEffect(() => {
    let cancelled = false;
    void analyserApi.machines().then((result) => {
      if (!cancelled) setMachines(result.items);
    }).catch((requestError: unknown) => {
      if (cancelled) return;
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Machines are unavailable."));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAggregateLoading(true);
    setError(undefined);
    void analyserApi.activityAggregate({
      ...range,
      machineId: machineId || undefined
    }).then((result) => {
      if (!cancelled) setAggregate(result);
    }).catch((requestError: unknown) => {
      if (cancelled) return;
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Activity aggregate is unavailable."));
    }).finally(() => {
      if (!cancelled) setAggregateLoading(false);
    });
    return () => { cancelled = true; };
  }, [machineId, range]);

  useEffect(() => {
    let cancelled = false;
    setObservationLoading(true);
    setObservations([]);
    setNextCursor(undefined);
    setError(undefined);
    void analyserApi.observations({
      ...range,
      machineId: machineId || undefined,
      source: source || undefined,
      limit: OBSERVATION_PAGE_SIZE
    }).then((result) => {
      if (cancelled) return;
      setObservations(result.items);
      setNextCursor(result.nextCursor);
    }).catch((requestError: unknown) => {
      if (cancelled) return;
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Observations are unavailable."));
    }).finally(() => {
      if (!cancelled) setObservationLoading(false);
    });
    return () => { cancelled = true; };
  }, [machineId, range, source]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const result = await analyserApi.observations({
        ...range,
        machineId: machineId || undefined,
        source: source || undefined,
        limit: OBSERVATION_PAGE_SIZE,
        cursor: nextCursor
      });
      setObservations((current) => [...current, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "More observations could not be loaded."));
    } finally {
      setLoadingMore(false);
    }
  };

  if (notConfigured) return <NotConfiguredState />;

  return (
    <section className="analyser-activity" aria-label="Activity">
      <div className="analyser-section-header analyser-activity-heading">
        <div>
          <h2>Activity</h2>
          <p>Observation rows contain metadata and references only; bodies are never stored.</p>
        </div>
      </div>

      <div className="analyser-filter-bar">
        <label>
          <span>Period</span>
          <select aria-label="Period" value={period} onChange={(event) => setPeriod(Number(event.target.value) as ActivityPeriod)}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </label>
        <label>
          <span>Machine</span>
          <select aria-label="Machine" value={machineId} onChange={(event) => setMachineId(event.target.value)}>
            <option value="">All machines</option>
            {machines.map((machine) => <option key={machine.id} value={machine.id}>{machineName(machine)}</option>)}
          </select>
        </label>
        <label>
          <span>Source</span>
          <select aria-label="Source" value={source} onChange={(event) => setSource(event.target.value as AnalyserObservationSource | "")}>
            <option value="">All sources</option>
            {SOURCES.map((item) => <option key={item} value={item}>{label(item)}</option>)}
          </select>
        </label>
        <span className="analyser-range">{range.from} – {range.to}</span>
      </div>

      {error ? <p className="analyser-error" role="alert">{error}</p> : null}

      <section aria-labelledby="activity-aggregate-heading">
        <div className="analyser-section-header">
          <div>
            <h2 id="activity-aggregate-heading">Server aggregate</h2>
            <p>Count-based activity for the selected period and machine.</p>
          </div>
        </div>
        {aggregateLoading && !aggregate ? <p className="analyser-muted">Loading activity aggregate...</p> : null}
        {aggregate ? (
          <>
            <div className="analyser-total-grid" aria-label="Activity totals">
              <article><span>Samples</span><strong>{aggregate.totals.sampleCount}</strong></article>
              <article><span>Active</span><strong>{aggregate.totals.activeCount}</strong></article>
              <article><span>Idle</span><strong>{aggregate.totals.idleCount}</strong></article>
            </div>
            {aggregate.days.length === 0 ? <div className="analyser-empty-card compact"><h2>No activity in this period</h2><p>Daily aggregates appear after matching observations are collected.</p></div> : (
              <div className="analyser-day-list">
                {aggregate.days.map((day) => {
                  const apps = aggregateApps(day.apps);
                  const maximum = Math.max(1, ...apps.map((app) => app.count));
                  return (
                    <article className="analyser-day-row" key={`${day.date}:${day.machineId ?? "all"}`}>
                      <div className="analyser-day-summary">
                        <strong>{day.date}</strong>
                        <span>{day.sampleCount} samples · {day.activeCount} active · {day.idleCount} idle</span>
                      </div>
                      <div className="analyser-app-list">
                        {apps.length === 0 ? <span className="analyser-muted">No app counts</span> : apps.map((app) => (
                          <div className="analyser-app-row" key={app.name}>
                            <span title={app.name}>{app.name}</span>
                            <div className="analyser-app-track"><i style={{ width: `${Math.max(4, (app.count / maximum) * 100)}%` }} /></div>
                            <strong>{app.count}</strong>
                          </div>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        ) : null}
      </section>

      <section aria-labelledby="raw-observations-heading">
        <div className="analyser-section-header">
          <div>
            <h2 id="raw-observations-heading">Raw observations</h2>
            <p>Newest metadata events first.</p>
          </div>
        </div>
        {observationLoading ? <p className="analyser-muted">Loading observations...</p> : null}
        {!observationLoading && observations.length === 0 ? <div className="analyser-empty-card compact"><h2>No observations found</h2><p>Try a longer period or a different source.</p></div> : null}
        <div className="analyser-observation-list">
          {observations.map((observation) => (
            <article className="analyser-observation-row" key={observation.id} aria-label={`${observation.source} ${observation.action}`}>
              <div className="analyser-observation-top">
                <time>{formatDateTime(observation.occurredAt)}</time>
                <span className={`analyser-source source-${observation.source}`}>{label(observation.source)}</span>
                <strong>{observation.action}</strong>
              </div>
              {observation.metadata && Object.keys(observation.metadata).length > 0 ? (
                <div className="analyser-metadata" aria-label="Observation metadata">
                  {Object.entries(observation.metadata).map(([key, value]) => (
                    <span key={key}><strong>{key}:</strong> {metadataValue(value)}</span>
                  ))}
                </div>
              ) : null}
              {observation.resourceRefs && observation.resourceRefs.length > 0 ? (
                <div className="analyser-resource-refs" aria-label="Resource references">
                  {observation.resourceRefs.map((resource, index) => (
                    <ResourceReference key={`${resource.service}:${resource.resourceType}:${resource.resourceId}:${index}`} resource={resource} />
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
        {nextCursor ? (
          <div className="analyser-load-more">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}

function compactValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ReferenceList({ refs, labelText }: { refs: AnalyserResourceRef[]; labelText: string }) {
  if (refs.length === 0) return <p className="analyser-muted">No {labelText.toLowerCase()}.</p>;
  return (
    <div className="analyser-resource-refs" aria-label={labelText}>
      {refs.map((resource, index) => (
        <ResourceReference key={`${resource.service}:${resource.resourceType}:${resource.resourceId}:${index}`} resource={resource} />
      ))}
    </div>
  );
}

type ExportButtonProps = {
  sourceKind: "summary" | "proposal";
  sourceId: string;
  disabled?: boolean;
  disabledTitle?: string;
  onSuccess: (message: string) => void;
};

function ExportButton({ sourceKind, sourceId, disabled = false, disabledTitle, onSuccess }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [targetKind, setTargetKind] = useState<"note" | "artifact">("note");
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const show = () => {
    setTargetKind("note");
    setTitle("");
    setProjectId("");
    setPath("");
    setError(undefined);
    setOpen(true);
  };

  const close = () => {
    if (!busy) setOpen(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await analyserApi.export({
        sourceKind,
        sourceId,
        targetKind,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
        ...(targetKind === "artifact" && path.trim() ? { path: path.trim() } : {})
      });
      setOpen(false);
      onSuccess(result.created
        ? `Exported to ${result.target.kind === "artifact" ? "Artifact" : "Note"}.`
        : "Already exported (identical content).");
    } catch (requestError) {
      setError(errorMessage(requestError, "Unable to export Analyser record."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={show} disabled={disabled} title={disabled ? disabledTitle : undefined}>Export</button>
      {open ? (
        <div className="modal-backdrop" role="presentation" onClick={close}>
          <section
            className="analyser-export-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Export ${sourceKind}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div><h3>Export {sourceKind}</h3><p>Publish this record as durable Workbench knowledge.</p></div>
              <button type="button" className="analyser-export-close" onClick={close} disabled={busy} aria-label="Close export dialog">×</button>
            </header>
            <form onSubmit={(event) => void submit(event)}>
              <label><span>Target kind</span><select aria-label="Export target kind" value={targetKind} onChange={(event) => setTargetKind(event.target.value as "note" | "artifact")} disabled={busy}><option value="note">Note</option><option value="artifact">Artifact</option></select></label>
              <label><span>Title override</span><input aria-label="Export title override" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Use source title" disabled={busy} /></label>
              <label><span>Project ID</span><input aria-label="Export project ID" value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="Optional" disabled={busy} /></label>
              {targetKind === "artifact" ? <label><span>Artifact path</span><input aria-label="Export artifact path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="Auto-generated when empty" disabled={busy} /></label> : null}
              {error ? <p className="analyser-error" role="alert">{error}</p> : null}
              <footer><button type="button" className="ghost-button" onClick={close} disabled={busy}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Exporting..." : "Export record"}</button></footer>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}

function SummaryTab() {
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [routineKey, setRoutineKey] = useState("");
  const [summaries, setSummaries] = useState<AnalyserSummaryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<AnalyserSummaryRecord>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [notConfigured, setNotConfigured] = useState(false);
  const kinds = useMemo(() => Array.from(new Set([...summaries.map((item) => item.kind), ...(kind ? [kind] : [])])).sort(), [kind, summaries]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSummaries([]);
    setNextCursor(undefined);
    setSelectedId(undefined);
    setSelected(undefined);
    setNotice(undefined);
    setError(undefined);
    void analyserApi.summaries({
      kind: kind || undefined,
      from: from || undefined,
      to: to || undefined,
      routineKey: routineKey.trim() || undefined,
      limit: ANALYSER_PAGE_SIZE
    }).then((result) => {
      if (cancelled) return;
      setSummaries(result.items);
      setNextCursor(result.nextCursor);
    }).catch((requestError: unknown) => {
      if (cancelled) return;
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Summaries are unavailable."));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [from, kind, routineKey, to]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const result = await analyserApi.summaries({
        kind: kind || undefined,
        from: from || undefined,
        to: to || undefined,
        routineKey: routineKey.trim() || undefined,
        limit: ANALYSER_PAGE_SIZE,
        cursor: nextCursor
      });
      setSummaries((current) => [...current, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "More summaries could not be loaded."));
    } finally {
      setLoadingMore(false);
    }
  };

  const selectSummary = async (id: string) => {
    setSelectedId(id);
    setSelected(undefined);
    setDetailLoading(true);
    setError(undefined);
    try {
      setSelected(await analyserApi.summary(id));
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Summary detail is unavailable."));
    } finally {
      setDetailLoading(false);
    }
  };

  if (notConfigured) return <NotConfiguredState />;

  return (
    <section className="analyser-record-tab" aria-label="Summaries">
      <div className="analyser-section-header">
        <div><h2>Summaries</h2><p>Generated analysis grouped by period and routine.</p></div>
      </div>

      <div className="analyser-filter-bar analyser-summary-filters">
        <label><span>Kind</span><select aria-label="Summary kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All kinds</option>{kinds.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
        <label><span>From</span><input aria-label="Summary period from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>To</span><input aria-label="Summary period to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label><span>Routine key</span><input aria-label="Summary routine key" value={routineKey} onChange={(event) => setRoutineKey(event.target.value)} placeholder="Optional" /></label>
      </div>

      {error ? <p className="analyser-error" role="alert">{error}</p> : null}
      {notice ? <p className="analyser-notice" role="status">{notice}</p> : null}
      {loading ? <p className="analyser-muted">Loading summaries...</p> : null}
      {!loading && summaries.length === 0 ? <div className="analyser-empty-card compact"><h2>No summaries found</h2><p>Adjust the filters or wait for a routine to publish a summary.</p></div> : null}

      {summaries.length > 0 ? (
        <div className="analyser-table-wrap">
          <table className="analyser-table analyser-selectable-table">
            <thead><tr><th>Period</th><th>Kind</th><th>Title</th><th>Body chars</th><th>Updated</th><th>Routine</th></tr></thead>
            <tbody>{summaries.map((summary) => (
              <tr
                key={summary.id}
                className={selectedId === summary.id ? "selected" : undefined}
                aria-selected={selectedId === summary.id}
                tabIndex={0}
                onClick={() => void selectSummary(summary.id)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void selectSummary(summary.id); }}
              >
                <td>{summary.periodStart} – {summary.periodEnd}</td>
                <td><span className="analyser-state analyser-kind-badge">{label(summary.kind)}</span></td>
                <td><strong>{summary.title}</strong></td>
                <td>{summary.bodyChars}</td>
                <td>{formatDateTime(summary.updatedAt)}</td>
                <td>{summary.routineKey || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}

      {nextCursor ? <div className="analyser-load-more"><button type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading..." : "Load more"}</button></div> : null}

      {detailLoading ? <p className="analyser-muted">Loading summary detail...</p> : null}
      {selected ? (
        <article className="analyser-detail-panel" aria-label="Summary detail">
          <header><div><span className="analyser-state analyser-kind-badge">{label(selected.kind)}</span><h2>{selected.title}</h2><p>{selected.periodStart} – {selected.periodEnd}</p></div><div className="analyser-actions"><ExportButton sourceKind="summary" sourceId={selected.id} onSuccess={setNotice} /></div></header>
          {selected.metrics && Object.keys(selected.metrics).length > 0 ? <section><h3>Metrics</h3><div className="analyser-key-value-grid">{Object.entries(selected.metrics).map(([key, value]) => <span key={key}><strong>{key}</strong><span>{compactValue(value)}</span></span>)}</div></section> : null}
          <section><h3>Summary</h3><pre className="analyser-markdown">{selected.bodyMarkdown || "No summary text is available."}</pre></section>
          <section><h3>Evidence</h3><ReferenceList refs={selected.evidenceRefs} labelText="Evidence references" /></section>
        </article>
      ) : null}
    </section>
  );
}

const CONFIDENCE_FIELDS = [
  "deterministicTarget",
  "currentEvidence",
  "policyAllowed",
  "concurrencyProtected",
  "reversibleOrNonDestructive"
] as const;

function ProposalTab() {
  const [status, setStatus] = useState<AnalyserProposalStatus>("open");
  const [kind, setKind] = useState("");
  const [proposals, setProposals] = useState<AnalyserProposalListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<AnalyserProposalRecord>();
  const [operations, setOperations] = useState<AnalyserOperationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<"approve" | "reject" | "supersede">();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [notConfigured, setNotConfigured] = useState(false);
  const kinds = useMemo(() => Array.from(new Set([...proposals.map((item) => item.kind), ...(kind ? [kind] : [])])).sort(), [kind, proposals]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProposals([]);
    setNextCursor(undefined);
    setSelectedId(undefined);
    setSelected(undefined);
    setOperations([]);
    setNotice(undefined);
    setError(undefined);
    void analyserApi.proposals({ status, kind: kind || undefined, limit: ANALYSER_PAGE_SIZE }).then((result) => {
      if (cancelled) return;
      setProposals(result.items);
      setNextCursor(result.nextCursor);
    }).catch((requestError: unknown) => {
      if (cancelled) return;
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Proposals are unavailable."));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [kind, status]);

  const loadProposalOperations = async (proposal: AnalyserProposalRecord) => {
    setOperations([]);
    if (proposal.status !== "executed") return;
    setOperationLoading(true);
    try {
      const result = await analyserApi.operations({ proposalId: proposal.id });
      setOperations(result.items);
    } catch (requestError) {
      setError(errorMessage(requestError, "Recorded operation is unavailable."));
    } finally {
      setOperationLoading(false);
    }
  };

  const selectProposal = async (id: string, keepNotice = false) => {
    setSelectedId(id);
    setSelected(undefined);
    setOperations([]);
    setDetailLoading(true);
    if (!keepNotice) setNotice(undefined);
    setError(undefined);
    try {
      const proposal = await analyserApi.proposal(id);
      setSelected(proposal);
      await loadProposalOperations(proposal);
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Proposal detail is unavailable."));
    } finally {
      setDetailLoading(false);
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const result = await analyserApi.proposals({ status, kind: kind || undefined, limit: ANALYSER_PAGE_SIZE, cursor: nextCursor });
      setProposals((current) => [...current, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "More proposals could not be loaded."));
    } finally {
      setLoadingMore(false);
    }
  };

  const reloadConflict = async (id: string) => {
    setNotice("Proposal changed elsewhere — reloaded.");
    await selectProposal(id, true);
  };

  const resolve = async (resolution: "approved" | "rejected") => {
    if (!selected) return;
    const verb = resolution === "approved" ? "Approve" : "Reject";
    if (!window.confirm(`${verb} “${selected.title}”?`)) return;
    setBusyAction(resolution === "approved" ? "approve" : "reject");
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await analyserApi.resolveProposal(selected.id, {
        status: resolution,
        provenance: "workbench-ui",
        expectedVersion: selected.version
      });
      setSelected(updated);
      setProposals((current) => current.filter((item) => item.id !== updated.id));
      setNotice(`Proposal ${resolution}.`);
    } catch (requestError) {
      if (isVersionConflict(requestError)) await reloadConflict(selected.id);
      else setError(errorMessage(requestError, `Unable to ${verb.toLowerCase()} proposal.`));
    } finally {
      setBusyAction(undefined);
    }
  };

  const supersede = async () => {
    if (!selected || !window.confirm(`Supersede “${selected.title}”?`)) return;
    setBusyAction("supersede");
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await analyserApi.supersedeProposal(selected.id, { expectedVersion: selected.version });
      setSelected(updated);
      setProposals((current) => current.filter((item) => item.id !== updated.id));
      setNotice("Proposal superseded.");
    } catch (requestError) {
      if (isVersionConflict(requestError)) await reloadConflict(selected.id);
      else setError(errorMessage(requestError, "Unable to supersede proposal."));
    } finally {
      setBusyAction(undefined);
    }
  };

  if (notConfigured) return <NotConfiguredState />;

  return (
    <section className="analyser-record-tab" aria-label="Proposals">
      <div className="analyser-section-header"><div><h2>Proposals</h2><p>Review recommendations and record user approval or rejection.</p></div></div>

      <div className="analyser-proposal-filters">
        <div className="analyser-status-chips" aria-label="Proposal status filter">{PROPOSAL_STATUSES.map((item) => <button type="button" key={item} aria-pressed={status === item} className={status === item ? `active status-${item}` : `status-${item}`} onClick={() => setStatus(item)}>{label(item)}</button>)}</div>
        <label><span>Kind</span><select aria-label="Proposal kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All kinds</option>{kinds.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
      </div>

      {notice ? <p className="analyser-notice" role="status">{notice}</p> : null}
      {error ? <p className="analyser-error" role="alert">{error}</p> : null}
      {loading ? <p className="analyser-muted">Loading proposals...</p> : null}
      {!loading && proposals.length === 0 ? <div className="analyser-empty-card compact"><h2>No {label(status)} proposals</h2><p>Choose another status or kind.</p></div> : null}

      {proposals.length > 0 ? (
        <div className="analyser-table-wrap">
          <table className="analyser-table analyser-selectable-table">
            <thead><tr><th>Status</th><th>Kind</th><th>Title</th><th>Updated</th><th>Routine</th></tr></thead>
            <tbody>{proposals.map((proposal) => (
              <tr key={proposal.id} className={selectedId === proposal.id ? "selected" : undefined} aria-selected={selectedId === proposal.id} tabIndex={0} onClick={() => void selectProposal(proposal.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void selectProposal(proposal.id); }}>
                <td><span className={`analyser-state analyser-proposal-status status-${proposal.status}`}>{label(proposal.status)}</span></td>
                <td>{label(proposal.kind)}</td>
                <td><strong>{proposal.title}</strong></td>
                <td>{formatDateTime(proposal.updatedAt)}</td>
                <td>{proposal.routineKey || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}

      {nextCursor ? <div className="analyser-load-more"><button type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading..." : "Load more"}</button></div> : null}

      {detailLoading ? <p className="analyser-muted">Loading proposal detail...</p> : null}
      {selected ? (
        <article className="analyser-detail-panel" aria-label="Proposal detail">
          <header>
            <div><span className={`analyser-state analyser-proposal-status status-${selected.status}`}>{label(selected.status)}</span><h2>{selected.title}</h2><p>{label(selected.kind)} · updated {formatDateTime(selected.updatedAt)}</p></div>
            <div className="analyser-actions">
              {selected.status === "open" ? <><button type="button" onClick={() => void resolve("approved")} disabled={Boolean(busyAction)}>{busyAction === "approve" ? "Approving..." : "Approve"}</button><button type="button" className="analyser-reject-action" onClick={() => void resolve("rejected")} disabled={Boolean(busyAction)}>{busyAction === "reject" ? "Rejecting..." : "Reject"}</button><details className="analyser-secondary-menu"><summary>More</summary><button type="button" onClick={() => void supersede()} disabled={Boolean(busyAction)}>{busyAction === "supersede" ? "Superseding..." : "Supersede"}</button></details></> : null}
              <ExportButton
                sourceKind="proposal"
                sourceId={selected.id}
                disabled={selected.status !== "approved" && selected.status !== "executed"}
                disabledTitle="Only approved or executed proposals can be exported as durable knowledge"
                onSuccess={setNotice}
              />
            </div>
          </header>

          <section><h3>Proposal</h3><pre className="analyser-markdown">{selected.bodyMarkdown || "No proposal text is available."}</pre></section>
          <section><h3>Evidence</h3><ReferenceList refs={selected.evidenceRefs} labelText="Evidence references" /></section>

          <section><h3>Proposed action</h3>{selected.proposedAction ? <div className="analyser-proposed-action"><strong>{label(selected.proposedAction.kind)}</strong>{selected.proposedAction.params && Object.keys(selected.proposedAction.params).length > 0 ? <div className="analyser-key-value-grid">{Object.entries(selected.proposedAction.params).map(([key, value]) => <span key={key}><strong>{key}</strong><span>{compactValue(value)}</span></span>)}</div> : <p className="analyser-muted">No parameters.</p>}</div> : <p className="analyser-muted">No proposed action is recorded.</p>}</section>

          <section><h3>Confidence evidence</h3>{selected.confidenceEvidence ? <div className="analyser-confidence-list">{CONFIDENCE_FIELDS.map((field) => <span key={field} className={selected.confidenceEvidence?.[field] ? "yes" : "no"}><b aria-hidden="true">{selected.confidenceEvidence?.[field] ? "✓" : "✕"}</b>{label(field.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase())}</span>)}{selected.confidenceEvidence.notes ? <p><strong>Notes:</strong> {selected.confidenceEvidence.notes}</p> : null}</div> : <p className="analyser-muted">No confidence evidence is recorded.</p>}</section>

          {selected.status === "approved" ? <section className="analyser-approval"><h3>Approval</h3><div className="analyser-key-value-grid"><span><strong>Provenance</strong><span>{selected.approvalProvenance || "—"}</span></span><span><strong>Approved by</strong><span>{selected.approvedBy || "—"}</span></span><span><strong>Approved at</strong><span>{optionalDate(selected.approvedAt)}</span></span></div><p>Execution is performed by agents via allow-listed operations; this screen only records approval.</p></section> : null}

          {selected.status === "executed" ? <section><h3>Recorded operation</h3>{operationLoading ? <p className="analyser-muted">Loading recorded operation...</p> : null}{!operationLoading && operations.length === 0 ? <p className="analyser-muted">No recorded operation was found.</p> : operations.map((operation) => <article className="analyser-operation" key={operation.id}><div className="analyser-key-value-grid"><span><strong>Kind</strong><span>{label(operation.operationKind)}</span></span><span><strong>Result</strong><span>{label(operation.result)}</span></span><span><strong>Created</strong><span>{formatDateTime(operation.createdAt)}</span></span></div><div><h4>Before references</h4><ReferenceList refs={operation.beforeRefs} labelText="Before references" /></div><div><h4>After references</h4><ReferenceList refs={operation.afterRefs} labelText="After references" /></div></article>)}</section> : null}
        </article>
      ) : null}
    </section>
  );
}

const COLLECTION_ENUM_FIELDS = [
  { key: "workbenchChanges", name: "Workbench changes", options: ["off", "metadata"], caption: "Stores Workbench change action metadata and resource references on the server." },
  { key: "mcpAccess", name: "MCP access", options: ["off", "mutations", "reads_and_mutations"], caption: "Stores allowed MCP tool names, outcomes, and resource references on the server." },
  { key: "uiAccess", name: "UI access", options: ["off", "mutations", "reads_and_mutations"], caption: "Stores allowed UI action metadata and resource references on the server." },
  { key: "agentSessionEvents", name: "Agent session events", options: ["off", "explicit_only"], caption: "Stores metadata only for agent session events that are explicitly emitted." },
  { key: "localFileEvents", name: "Local file events", options: ["off", "metadata"], caption: "Captures file action and path metadata under allowed local roots; file contents are never stored." },
  { key: "screenshots", name: "Screenshots", options: ["off", "local_only"], caption: "Screenshots are captured and stored on this machine only — never uploaded" }
] as const;

const COLLECTION_BOOLEAN_FIELDS = [
  { key: "foregroundAppCapture", name: "Foreground app capture", caption: "Captures app name + idle flag samples on this machine." },
  { key: "foregroundAppUpload", name: "Foreground app upload", caption: "Uploads app name + idle flag samples to the server" },
  { key: "windowTitleCapture", name: "Window title capture", caption: "Captures the active window title on this machine when explicitly enabled." },
  { key: "windowTitleUpload", name: "Window title upload", caption: "Uploads captured window titles to the server when explicitly enabled." },
  { key: "localFileUpload", name: "Local file upload", caption: "Uploads local file action and path metadata to the server; file contents are never uploaded." }
] as const;

const COLLECTION_ARRAY_FIELDS = [
  { key: "projectAllow", name: "Project allow list", caption: "Limits collection to these comma-separated project IDs when the list is not empty." },
  { key: "projectDeny", name: "Project deny list", caption: "Excludes these comma-separated project IDs from collection." },
  { key: "resourceTypeAllow", name: "Resource type allow list", caption: "Limits collection to these comma-separated resource types when the list is not empty." },
  { key: "resourceTypeDeny", name: "Resource type deny list", caption: "Excludes these comma-separated resource types from collection." },
  { key: "localRootAllow", name: "Local root allow list", caption: "Limits local file metadata capture to these comma-separated roots." },
  { key: "localRootDeny", name: "Local root deny list", caption: "Excludes these comma-separated local roots from capture." },
  { key: "excludePatterns", name: "Exclude patterns", caption: "Excludes paths matching these comma-separated patterns before metadata is produced." }
] as const;

const RETENTION_CAPTIONS: Record<AnalyserObservationSource, string> = {
  workbench_change: "Keeps raw Workbench change metadata on the server for this many days.",
  mcp_access: "Keeps raw MCP access metadata on the server for this many days.",
  ui_access: "Keeps raw UI access metadata on the server for this many days.",
  agent_session: "Keeps raw agent session metadata on the server for this many days.",
  pc_activity: "Keeps uploaded foreground app metadata on the server for this many days.",
  local_file: "Keeps uploaded local file metadata on the server for this many days."
};

type CollectionEnumField = (typeof COLLECTION_ENUM_FIELDS)[number]["key"];
type CollectionBooleanField = (typeof COLLECTION_BOOLEAN_FIELDS)[number]["key"];
type CollectionArrayField = (typeof COLLECTION_ARRAY_FIELDS)[number]["key"];

function omitCollectionField(
  settings: AnalyserCollectionSettingsOverride,
  field: keyof AnalyserCollectionSettingsOverride
): AnalyserCollectionSettingsOverride {
  const next = { ...settings };
  delete next[field];
  return next;
}

function parseCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function CollectionSettingsForm({
  value,
  sparse,
  disabled,
  onChange
}: {
  value: AnalyserCollectionSettingsOverride;
  sparse: boolean;
  disabled: boolean;
  onChange: (next: AnalyserCollectionSettingsOverride) => void;
}) {
  const changeEnum = (field: CollectionEnumField, nextValue: string) => {
    if (sparse && nextValue === "") onChange(omitCollectionField(value, field));
    else onChange({ ...value, [field]: nextValue });
  };

  const changeBoolean = (field: CollectionBooleanField, nextValue: string | boolean) => {
    if (sparse && nextValue === "") onChange(omitCollectionField(value, field));
    else onChange({ ...value, [field]: typeof nextValue === "boolean" ? nextValue : nextValue === "true" });
  };

  const changeRetention = (source: AnalyserObservationSource, raw: string) => {
    const retentionDays = { ...(value.retentionDays ?? {}) };
    if (sparse && raw === "") delete retentionDays[source];
    else retentionDays[source] = Number(raw);
    onChange(Object.keys(retentionDays).length > 0
      ? { ...value, retentionDays }
      : omitCollectionField(value, "retentionDays"));
  };

  const changeArray = (field: CollectionArrayField, raw: string) => {
    if (sparse && raw.trim() === "") onChange(omitCollectionField(value, field));
    else onChange({ ...value, [field]: parseCommaList(raw) });
  };

  return (
    <div className="analyser-settings-form-grid">
      {COLLECTION_ENUM_FIELDS.map((field) => (
        <label className="analyser-setting-control" key={field.key}>
          <span>{field.name}</span>
          <select
            aria-label={field.name}
            value={String(value[field.key] ?? "")}
            disabled={disabled}
            onChange={(event) => changeEnum(field.key, event.target.value)}
          >
            {sparse ? <option value="">inherit</option> : null}
            {field.options.map((option) => <option value={option} key={option}>{label(option)}</option>)}
          </select>
          <small>{field.caption}</small>
        </label>
      ))}

      {COLLECTION_BOOLEAN_FIELDS.map((field) => (
        <label className="analyser-setting-control" key={field.key}>
          <span>{field.name}</span>
          {sparse ? (
            <select
              aria-label={field.name}
              value={value[field.key] === undefined ? "" : String(value[field.key])}
              disabled={disabled}
              onChange={(event) => changeBoolean(field.key, event.target.value)}
            >
              <option value="">inherit</option>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          ) : (
            <input
              aria-label={field.name}
              type="checkbox"
              checked={Boolean(value[field.key])}
              disabled={disabled}
              onChange={(event) => changeBoolean(field.key, event.target.checked)}
            />
          )}
          <small>{field.caption}</small>
        </label>
      ))}

      {SOURCES.map((source) => (
        <label className="analyser-setting-control" key={source}>
          <span>{label(source)} retention days</span>
          <input
            aria-label={`${label(source)} retention days`}
            type="number"
            min={1}
            max={90}
            value={value.retentionDays?.[source] ?? ""}
            placeholder={sparse ? "inherit" : undefined}
            disabled={disabled}
            onChange={(event) => changeRetention(source, event.target.value)}
          />
          <small>{RETENTION_CAPTIONS[source]}</small>
        </label>
      ))}

      <label className="analyser-setting-control">
        <span>Local screenshot retention days</span>
        <input
          aria-label="Local screenshot retention days"
          type="number"
          min={1}
          max={30}
          value={value.localScreenshotRetentionDays ?? ""}
          placeholder={sparse ? "inherit" : undefined}
          disabled={disabled}
          onChange={(event) => {
            if (sparse && event.target.value === "") onChange(omitCollectionField(value, "localScreenshotRetentionDays"));
            else onChange({ ...value, localScreenshotRetentionDays: Number(event.target.value) });
          }}
        />
        <small>Keeps screenshots on this machine for this many days; screenshots are never uploaded.</small>
      </label>

      {COLLECTION_ARRAY_FIELDS.map((field) => (
        <label className="analyser-setting-control analyser-setting-wide" key={field.key}>
          <span>{field.name}</span>
          <input
            aria-label={field.name}
            value={(value[field.key] ?? []).join(", ")}
            placeholder={sparse ? "inherit" : "Comma-separated values"}
            disabled={disabled}
            onChange={(event) => changeArray(field.key, event.target.value)}
          />
          <small>{field.caption}</small>
        </label>
      ))}
    </div>
  );
}

type RoutineDraft = Pick<AnalyserRoutineRecord,
  "enabled" | "scheduleKind" | "scheduleExpr" | "timezone" | "maxRetries" | "backoffMinutes"
>;

function routineDraft(routine: AnalyserRoutineRecord): RoutineDraft {
  return {
    enabled: routine.enabled,
    scheduleKind: routine.scheduleKind,
    scheduleExpr: routine.scheduleExpr,
    timezone: routine.timezone,
    maxRetries: routine.maxRetries,
    backoffMinutes: routine.backoffMinutes
  };
}

function SettingsTab() {
  const [settings, setSettings] = useState<AnalyserSettingsResult>();
  const [machines, setMachines] = useState<AnalyserMachineRecord[]>([]);
  const [routines, setRoutines] = useState<AnalyserRoutineRecord[]>([]);
  const [ownerForm, setOwnerForm] = useState<AnalyserCollectionSettingsOverride>();
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [machineForm, setMachineForm] = useState<AnalyserCollectionSettingsOverride>({});
  const [automationForm, setAutomationForm] = useState<AnalyserAutomationPolicy>();
  const [routineDrafts, setRoutineDrafts] = useState<Record<string, RoutineDraft>>({});
  const [routineErrors, setRoutineErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [notConfigured, setNotConfigured] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    setNotConfigured(false);
    try {
      const [settingsResult, machineResult, routineResult] = await Promise.all([
        analyserApi.settings(),
        analyserApi.machines(),
        analyserApi.routines()
      ]);
      setSettings(settingsResult);
      setMachines(machineResult.items);
      setRoutines(routineResult.items);
      setOwnerForm({
        ...settingsResult.effective.settings,
        retentionDays: { ...settingsResult.effective.settings.retentionDays }
      });
      setAutomationForm({
        ...settingsResult.automation.policy,
        allowedOperationKinds: [...settingsResult.automation.policy.allowedOperationKinds]
      });
      setRoutineDrafts(Object.fromEntries(routineResult.items.map((routine) => [routine.key, routineDraft(routine)])));
      setSelectedMachineId((current) => current && machineResult.items.some((machine) => machine.id === current)
        ? current
        : machineResult.items[0]?.id ?? "");
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Analyser settings are unavailable."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const row = settings?.rows.find((item) => item.machineId === selectedMachineId);
    setMachineForm(row ? {
      ...row.settings,
      ...(row.settings.retentionDays ? { retentionDays: { ...row.settings.retentionDays } } : {})
    } : {});
  }, [selectedMachineId, settings]);

  const reloadConflict = async (message: string) => {
    await load();
    setNotice(message);
  };

  const saveOwner = async () => {
    if (!ownerForm || !settings) return;
    setBusy("owner");
    setError(undefined);
    setNotice(undefined);
    try {
      await analyserApi.updateCollectionPolicy({
        machineId: null,
        settings: ownerForm,
        ...(settings.effective.ownerVersion === undefined ? {} : { expectedVersion: settings.effective.ownerVersion })
      });
      await load();
      setNotice("Collection settings saved.");
    } catch (requestError) {
      if (isVersionConflict(requestError)) await reloadConflict("Collection settings changed elsewhere — reloaded.");
      else setError(errorMessage(requestError, "Unable to save collection settings."));
    } finally {
      setBusy(undefined);
    }
  };

  const saveMachine = async () => {
    if (!selectedMachineId || !settings) return;
    const row = settings.rows.find((item) => item.machineId === selectedMachineId);
    setBusy("machine");
    setError(undefined);
    setNotice(undefined);
    try {
      await analyserApi.updateCollectionPolicy({
        machineId: selectedMachineId,
        settings: machineForm,
        ...(row ? { expectedVersion: row.version } : {})
      });
      await load();
      setNotice("Machine overrides saved.");
    } catch (requestError) {
      if (isVersionConflict(requestError)) await reloadConflict("Machine overrides changed elsewhere — reloaded.");
      else setError(errorMessage(requestError, "Unable to save machine overrides."));
    } finally {
      setBusy(undefined);
    }
  };

  const saveAutomation = async () => {
    if (!automationForm || !settings) return;
    setBusy("automation");
    setError(undefined);
    setNotice(undefined);
    try {
      await analyserApi.updateAutomationPolicy({
        policy: automationForm,
        ...(settings.automation.version === undefined ? {} : { expectedVersion: settings.automation.version })
      });
      await load();
      setNotice("Automation policy saved.");
    } catch (requestError) {
      if (isVersionConflict(requestError)) await reloadConflict("Automation policy changed elsewhere — reloaded.");
      else setError(errorMessage(requestError, "Unable to save automation policy."));
    } finally {
      setBusy(undefined);
    }
  };

  const updateRoutineDraft = <K extends keyof RoutineDraft>(key: string, field: K, nextValue: RoutineDraft[K]) => {
    setRoutineDrafts((current) => ({ ...current, [key]: { ...current[key], [field]: nextValue } }));
  };

  const changedRoutineFields = (routine: AnalyserRoutineRecord, draft: RoutineDraft) => {
    const changed: Partial<RoutineDraft> = {};
    (Object.keys(draft) as Array<keyof RoutineDraft>).forEach((field) => {
      if (draft[field] !== routine[field]) Object.assign(changed, { [field]: draft[field] });
    });
    return changed;
  };

  const saveRoutine = async (routine: AnalyserRoutineRecord) => {
    const draft = routineDrafts[routine.key];
    if (!draft) return;
    const changed = changedRoutineFields(routine, draft);
    if (Object.keys(changed).length === 0) return;
    setBusy(`routine:${routine.key}`);
    setRoutineErrors((current) => ({ ...current, [routine.key]: "" }));
    setNotice(undefined);
    try {
      await analyserApi.updateRoutine(routine.key, { ...changed, expectedVersion: routine.version });
      await load();
      setNotice(`${routine.name} saved.`);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 400 && requestError.code === "INVALID_SCHEDULE") {
        setRoutineErrors((current) => ({
          ...current,
          [routine.key]: requestError.responseMessage || requestError.message
        }));
      } else if (isVersionConflict(requestError)) {
        await reloadConflict(`${routine.name} changed elsewhere — reloaded.`);
      } else {
        setRoutineErrors((current) => ({ ...current, [routine.key]: errorMessage(requestError, "Unable to save routine.") }));
      }
    } finally {
      setBusy(undefined);
    }
  };

  if (notConfigured) return <NotConfiguredState />;

  return (
    <section className="analyser-settings" aria-label="Settings">
      <div className="analyser-section-header">
        <div><h2>Settings</h2><p>Control collection, per-machine overrides, automation, and routine schedules.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading || Boolean(busy)}>{loading ? "Loading..." : "Reload"}</button>
      </div>
      {error ? <p className="analyser-error" role="alert">{error}</p> : null}
      {notice ? <p className="analyser-notice" role="status">{notice}</p> : null}
      {loading && !settings ? <p className="analyser-muted">Loading Analyser settings...</p> : null}

      {settings && ownerForm && automationForm ? (
        <>
          <section className="analyser-settings-section" aria-labelledby="collection-settings-heading">
            <header><h2 id="collection-settings-heading">Collection</h2><p>Owner defaults applied before any machine-specific override.</p></header>
            <CollectionSettingsForm value={ownerForm} sparse={false} disabled={Boolean(busy)} onChange={setOwnerForm} />
            <div className="analyser-settings-actions"><button type="button" onClick={() => void saveOwner()} disabled={Boolean(busy)}>{busy === "owner" ? "Saving..." : "Save collection settings"}</button></div>
          </section>

          <section className="analyser-settings-section" aria-labelledby="machine-settings-heading">
            <header><h2 id="machine-settings-heading">Machine overrides</h2><p>Only non-inherited fields are stored for the selected machine.</p></header>
            {machines.length === 0 ? <p className="analyser-muted">No machines are registered.</p> : (
              <>
                <label className="analyser-machine-select"><span>Machine</span><select aria-label="Machine" value={selectedMachineId} onChange={(event) => setSelectedMachineId(event.target.value)}>{machines.map((machine) => <option value={machine.id} key={machine.id}>{machineName(machine)}</option>)}</select></label>
                {!settings.rows.some((row) => row.machineId === selectedMachineId) ? <p className="analyser-muted">This machine currently inherits every owner default.</p> : null}
                <CollectionSettingsForm value={machineForm} sparse disabled={Boolean(busy)} onChange={setMachineForm} />
                <div className="analyser-settings-actions"><button type="button" onClick={() => void saveMachine()} disabled={Boolean(busy) || !selectedMachineId}>{busy === "machine" ? "Saving..." : "Save machine overrides"}</button></div>
              </>
            )}
          </section>

          <section className="analyser-settings-section" aria-labelledby="automation-settings-heading">
            <header><h2 id="automation-settings-heading">Automation policy</h2><p>Agents can only read this policy; only you can change it here.</p></header>
            <div className="analyser-automation-grid">
              {(["enabled", "requireHighConfidence", "destructiveAllowed", "bulkAllowed"] as const).map((field) => (
                <label className={field === "destructiveAllowed" || field === "bulkAllowed" ? "analyser-automation-toggle warning" : "analyser-automation-toggle"} key={field}>
                  <input type="checkbox" checked={automationForm[field]} disabled={Boolean(busy)} onChange={(event) => setAutomationForm({ ...automationForm, [field]: event.target.checked })} />
                  <span>{label(field.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase())}</span>
                </label>
              ))}
            </div>
            <fieldset className="analyser-operation-kinds"><legend>Allowed operation kinds</legend>{ANALYSER_OPERATION_KINDS.map((kind) => <label key={kind}><input type="checkbox" checked={automationForm.allowedOperationKinds.includes(kind)} disabled={Boolean(busy)} onChange={(event) => setAutomationForm({ ...automationForm, allowedOperationKinds: event.target.checked ? [...automationForm.allowedOperationKinds, kind] : automationForm.allowedOperationKinds.filter((item) => item !== kind) })} /><span>{label(kind)}</span></label>)}</fieldset>
            <div className="analyser-settings-actions"><button type="button" onClick={() => void saveAutomation()} disabled={Boolean(busy)}>{busy === "automation" ? "Saving..." : "Save automation policy"}</button></div>
          </section>

          <section className="analyser-settings-section" aria-labelledby="routine-settings-heading">
            <header><h2 id="routine-settings-heading">Routines</h2><p>Enable routines and edit their interval or cron schedules.</p></header>
            <div className="analyser-routine-settings-list">
              {routines.length === 0 ? <p className="analyser-muted">No routines are configured.</p> : routines.map((routine) => {
                const draft = routineDrafts[routine.key] ?? routineDraft(routine);
                const changed = Object.keys(changedRoutineFields(routine, draft)).length > 0;
                return (
                  <article className="analyser-routine-setting" key={routine.key}>
                    <header><div><strong>{routine.name}</strong><small>{routine.key}</small></div><label className="analyser-inline-toggle"><input aria-label={`${routine.name} enabled`} type="checkbox" checked={draft.enabled} disabled={Boolean(busy)} onChange={(event) => updateRoutineDraft(routine.key, "enabled", event.target.checked)} /><span>Enabled</span></label></header>
                    <div className="analyser-routine-editor">
                      <label><span>Schedule kind</span><select aria-label={`${routine.name} schedule kind`} value={draft.scheduleKind} disabled={Boolean(busy)} onChange={(event) => updateRoutineDraft(routine.key, "scheduleKind", event.target.value as RoutineDraft["scheduleKind"])}><option value="interval">interval</option><option value="cron">cron</option></select></label>
                      <label><span>Expression</span><input aria-label={`${routine.name} schedule expression`} value={draft.scheduleExpr} disabled={Boolean(busy)} onChange={(event) => updateRoutineDraft(routine.key, "scheduleExpr", event.target.value)} /></label>
                      <label><span>Timezone</span><input aria-label={`${routine.name} timezone`} value={draft.timezone} disabled={Boolean(busy)} onChange={(event) => updateRoutineDraft(routine.key, "timezone", event.target.value)} /></label>
                      <label><span>Max retries</span><input aria-label={`${routine.name} max retries`} type="number" min={0} max={10} value={draft.maxRetries} disabled={Boolean(busy)} onChange={(event) => updateRoutineDraft(routine.key, "maxRetries", Number(event.target.value))} /></label>
                      <label><span>Backoff minutes</span><input aria-label={`${routine.name} backoff minutes`} type="number" min={1} max={1440} value={draft.backoffMinutes} disabled={Boolean(busy)} onChange={(event) => updateRoutineDraft(routine.key, "backoffMinutes", Number(event.target.value))} /></label>
                    </div>
                    {routineErrors[routine.key] ? <p className="analyser-error analyser-routine-error" role="alert">{routineErrors[routine.key]}</p> : null}
                    <div className="analyser-settings-actions"><button type="button" onClick={() => void saveRoutine(routine)} disabled={Boolean(busy) || !changed}>{busy === `routine:${routine.key}` ? "Saving..." : "Save routine"}</button></div>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

export function AnalyserPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab: AnalyserTab = TABS.includes(requestedTab as AnalyserTab)
    ? requestedTab as AnalyserTab
    : "overview";

  const selectTab = (tab: AnalyserTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === "overview") next.delete("tab");
    else next.set("tab", tab);
    setSearchParams(next);
  };

  return (
    <div className="analyser-page">
      <header className="analyser-header">
        <h1>Analyser</h1>
        <div className="analyser-tabs" role="tablist" aria-label="Analyser views">
          {TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={activeTab === tab ? "analyser-tab active" : "analyser-tab"}
              onClick={() => selectTab(tab)}
              key={tab}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {activeTab === "overview" ? <OverviewTab /> : null}
      {activeTab === "activity" ? <ActivityTab /> : null}
      {activeTab === "summaries" ? <SummaryTab /> : null}
      {activeTab === "proposals" ? <ProposalTab /> : null}
      {activeTab === "settings" ? <SettingsTab /> : null}
    </div>
  );
}
