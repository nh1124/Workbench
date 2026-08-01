import { useEffect, useMemo, useState } from "react";
import { analyserApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { AnalyserActivityAggregate, AnalyserDerivedCapture, AnalyserMachineRecord, AnalyserObservationRecord, AnalyserObservationSource } from "../../types/models";
import { NotConfiguredState } from "./NotConfiguredState";
import { ReferenceList, ResourceReference } from "./ReferenceList";
import { ANALYSER_PAGE_SIZE, OBSERVATION_PAGE_SIZE, SOURCES, errorMessage, isAnalyserNotConfigured, label, machineName } from "./shared";

type ActivityPeriod = 7 | 14 | 30;

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

function resolveTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function localDayStartInstant(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

function localDayEndInstant(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
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


export function ActivityTab() {
  const [period, setPeriod] = useState<ActivityPeriod>(7);
  const [machineId, setMachineId] = useState("");
  const [source, setSource] = useState<AnalyserObservationSource | "">("");
  const [machines, setMachines] = useState<AnalyserMachineRecord[]>([]);
  const [aggregate, setAggregate] = useState<AnalyserActivityAggregate>();
  const [observations, setObservations] = useState<AnalyserObservationRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [derivedCaptures, setDerivedCaptures] = useState<AnalyserDerivedCapture[]>([]);
  const [derivedNextCursor, setDerivedNextCursor] = useState<string>();
  const [aggregateLoading, setAggregateLoading] = useState(true);
  const [observationLoading, setObservationLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [derivedLoading, setDerivedLoading] = useState(true);
  const [derivedLoadingMore, setDerivedLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [notConfigured, setNotConfigured] = useState(false);
  const range = useMemo(() => activityRange(period), [period]);
  const instantRange = useMemo(() => ({
    from: localDayStartInstant(range.from),
    to: localDayEndInstant(range.to)
  }), [range]);

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
      machineId: machineId || undefined,
      timezone: resolveTimezone()
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
      ...instantRange,
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
  }, [instantRange, machineId, source]);

  useEffect(() => {
    let cancelled = false;
    setDerivedLoading(true);
    setDerivedCaptures([]);
    setDerivedNextCursor(undefined);
    setError(undefined);
    void analyserApi.derivedCaptures({
      ...instantRange,
      machineId: machineId || undefined,
      limit: ANALYSER_PAGE_SIZE
    }).then((result) => {
      if (cancelled) return;
      setDerivedCaptures(result.items);
      setDerivedNextCursor(result.nextCursor);
    }).catch((requestError: unknown) => {
      if (cancelled) return;
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Derived captures are unavailable."));
    }).finally(() => {
      if (!cancelled) setDerivedLoading(false);
    });
    return () => { cancelled = true; };
  }, [instantRange, machineId]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const result = await analyserApi.observations({
        ...instantRange,
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

  const loadMoreDerived = async () => {
    if (!derivedNextCursor) return;
    setDerivedLoadingMore(true);
    setError(undefined);
    try {
      const result = await analyserApi.derivedCaptures({
        ...instantRange,
        machineId: machineId || undefined,
        limit: ANALYSER_PAGE_SIZE,
        cursor: derivedNextCursor
      });
      setDerivedCaptures((current) => [...current, ...result.items]);
      setDerivedNextCursor(result.nextCursor);
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "More derived captures could not be loaded."));
    } finally {
      setDerivedLoadingMore(false);
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

      <section aria-labelledby="derived-captures-heading">
        <div className="analyser-section-header">
          <div>
            <h2 id="derived-captures-heading">Derived captures</h2>
            <p>Text a local agent derived from screenshots/captures. Images stay on the machine and are never uploaded.</p>
          </div>
        </div>
        {derivedLoading ? <p className="analyser-muted">Loading derived captures...</p> : null}
        {!derivedLoading && derivedCaptures.length === 0 ? (
          <div className="analyser-empty-card compact">
            <h2>No derived captures found</h2>
            <p>No screenshot-derived text matches the selected period and machine.</p>
          </div>
        ) : null}
        <div className="analyser-observation-list">
          {derivedCaptures.map((capture) => (
            <article className="analyser-observation-row" key={capture.id} aria-label={`${capture.kind} ${capture.title}`}>
              <div className="analyser-observation-top">
                <time>{formatDateTime(capture.occurredAt)}</time>
                <span className="analyser-state analyser-kind-badge">{label(capture.kind)}</span>
                <strong>{capture.title}</strong>
              </div>
              <pre className="analyser-markdown">{capture.summaryMarkdown || "No derived text is available."}</pre>
              <ReferenceList refs={capture.evidenceRefs} labelText="Evidence references" />
            </article>
          ))}
        </div>
        {derivedNextCursor ? (
          <div className="analyser-load-more">
            <button type="button" onClick={() => void loadMoreDerived()} disabled={derivedLoadingMore}>
              {derivedLoadingMore ? "Loading..." : "Load more"}
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}

