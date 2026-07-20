import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { analyserApi, ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type {
  AnalyserActivityAggregate,
  AnalyserMachineRecord,
  AnalyserObservationRecord,
  AnalyserObservationSource,
  AnalyserResourceRef,
  AnalyserStatusResult
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

function PlaceholderTab({ name }: { name: "Summaries" | "Proposals" | "Settings" }) {
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
      {activeTab === "summaries" ? <PlaceholderTab name="Summaries" /> : null}
      {activeTab === "proposals" ? <PlaceholderTab name="Proposals" /> : null}
      {activeTab === "settings" ? <PlaceholderTab name="Settings" /> : null}
    </div>
  );
}
