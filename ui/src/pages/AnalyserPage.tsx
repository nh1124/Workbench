import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { analyserApi, ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type {
  AnalyserActivityAggregate,
  AnalyserMachineRecord,
  AnalyserObservationRecord,
  AnalyserObservationSource,
  AnalyserOperationRecord,
  AnalyserProposalListItem,
  AnalyserProposalRecord,
  AnalyserProposalStatus,
  AnalyserResourceRef,
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

function ExportButton() {
  return <button type="button" disabled title="Export arrives with the publication pipeline">Export</button>;
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
          <header><div><span className="analyser-state analyser-kind-badge">{label(selected.kind)}</span><h2>{selected.title}</h2><p>{selected.periodStart} – {selected.periodEnd}</p></div><div className="analyser-actions"><ExportButton /></div></header>
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
              <ExportButton />
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

function PlaceholderTab({ name }: { name: "Settings" }) {
  return (
    <section className="analyser-placeholder" aria-label={name}>
      <h2>{name}</h2>
      <p>{name} are coming in this build.</p>
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
      {activeTab === "settings" ? <PlaceholderTab name="Settings" /> : null}
    </div>
  );
}
