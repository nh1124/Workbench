import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { analyserApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { AnalyserStatusResult } from "../../types/models";
import { NotConfiguredState } from "./NotConfiguredState";
import { errorMessage, isAnalyserNotConfigured, label, machineName, optionalDate } from "./shared";

function relativeFromNow(value: string): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}


export function OverviewTab() {
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

          {status.runnerHealth ? (
            <section className="analyser-machines" aria-labelledby="analyser-runner-health-heading">
              <div className={status.runnerHealth.state === "healthy" ? "analyser-proposal-indicator" : "analyser-proposal-indicator open"}>
                <div>
                  <h2 id="analyser-runner-health-heading">Runner health</h2>
                  {status.runnerHealth.state === "never_claimed" ? (
                    <p className="analyser-error">Analyser routines only run when an external scheduler periodically calls analyser.routines.claim. Nothing has polled yet.</p>
                  ) : null}
                  {status.runnerHealth.state === "stalled" ? (
                    <p>Routines are overdue and no runner has claimed recently.</p>
                  ) : null}
                </div>
                <span className={`analyser-state ${status.runnerHealth.state === "healthy" ? "enabled" : "disabled"}`}>
                  {status.runnerHealth.state === "never_claimed"
                    ? "No runner has ever claimed a routine"
                    : status.runnerHealth.state === "stalled"
                      ? "Runner may have stopped"
                      : "Runner active"}
                </span>
              </div>

              <div className="analyser-key-value-grid">
                <span>
                  <strong>Last claim</strong>
                  <span>
                    {status.runnerHealth.lastClaimAt
                      ? `${relativeFromNow(status.runnerHealth.lastClaimAt)} (${formatDateTime(status.runnerHealth.lastClaimAt)})`
                      : "never"}
                  </span>
                </span>
              </div>

              <h3>Runners</h3>
              {status.runnerHealth.runners.length === 0 ? (
                <p className="analyser-muted">No runner has claimed a routine yet.</p>
              ) : (
                <div className="analyser-table-wrap">
                  <table className="analyser-table">
                    <thead>
                      <tr>
                        <th>Runner</th>
                        <th>Last seen</th>
                        <th>Last status</th>
                        <th>Runs in last 24h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.runnerHealth.runners.map((runner) => (
                        <tr key={runner.runner}>
                          <td><strong>{runner.runner}</strong></td>
                          <td>{formatDateTime(runner.lastSeenAt)}</td>
                          <td>{runner.lastStatus}</td>
                          <td>{runner.runsLast24h}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {status.runnerHealth.overdueRoutines.length > 0 ? (
                <>
                  <h3>Overdue routines</h3>
                  <div className="analyser-table-wrap">
                    <table className="analyser-table">
                      <thead>
                        <tr>
                          <th>Routine</th>
                          <th>Delay</th>
                        </tr>
                      </thead>
                      <tbody>
                        {status.runnerHealth.overdueRoutines.map((routine) => (
                          <tr key={routine.key}>
                            <td><strong>{routine.key}</strong></td>
                            <td>overdue {routine.overdueMinutes} min</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

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


