import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { deepResearchApi, projectsApi } from "../lib/api";
import type {
  DeepResearchDefaultsResponse,
  DeepResearchHistoryEntry,
  DeepResearchRunResponse,
  DeepResearchStatusResponse,
  ProjectRecord
} from "../types/models";
import "./ResearchPage.css";

type ResearchTab = "query" | "status" | "history";
type ProviderChoice = "auto" | "gemini" | "openai" | "anthropic";

interface ProviderOption {
  value: ProviderChoice;
  label: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface PendingRunItem {
  id: string;
  query: string;
  provider: ProviderChoice;
  speed: "deep" | "fast";
  startedAt: string;
}

interface RunningRow {
  key: string;
  query: string;
  provider: ProviderChoice;
  speed: "deep" | "fast";
  updatedAt: string;
  percent: number;
  message: string;
  jobId?: string;
  cancellable: boolean;
}

const HISTORY_LIMIT = 100;
const STATUS_POLL_MS = 3000;
const HISTORY_REFRESH_MS = 6000;

function normalizeProjects(records: ProjectRecord[]): ProjectOption[] {
  return records.map((record) => ({ id: record.id, name: record.name })).sort((a, b) => a.name.localeCompare(b.name));
}

function deriveRunStateLabel(status?: string): string {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Idle";
}

function providerDisplayName(provider: ProviderChoice): string {
  if (provider === "auto") return "Auto";
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  return "Anthropic";
}

function shortIso(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function makePendingRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function upsertHistoryEntry(list: DeepResearchHistoryEntry[], entry: DeepResearchHistoryEntry): DeepResearchHistoryEntry[] {
  const next = [entry, ...list.filter((item) => item.jobId !== entry.jobId)];
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function historyEntryFromRun(result: DeepResearchRunResponse): DeepResearchHistoryEntry {
  const now = new Date().toISOString();
  const isCompleted = result.status === "completed";
  return {
    jobId: result.jobId,
    status: isCompleted ? "completed" : "running",
    query: result.query,
    provider: result.provider,
    model: result.model,
    speed: result.speed,
    progress: isCompleted
      ? { stage: "completed", percent: 100, message: "Completed" }
      : { stage: "running", percent: 10, message: result.message || "Running" },
    artifact: result.artifact,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: result.completedAt,
    cancelledAt: undefined,
    eventLogs: []
  };
}

function historyEntryFromStatus(status: DeepResearchStatusResponse): DeepResearchHistoryEntry {
  return {
    jobId: status.jobId,
    status: status.status,
    query: status.query,
    provider: status.provider,
    model: status.model,
    speed: status.speed,
    progress: status.progress,
    artifact: status.artifact,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    cancelledAt: status.cancelledAt,
    eventLogs: status.eventLogs
  };
}

export function ResearchPage() {
  const [defaults, setDefaults] = useState<DeepResearchDefaultsResponse | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [history, setHistory] = useState<DeepResearchHistoryEntry[]>([]);
  const [activeTab, setActiveTab] = useState<ResearchTab>("query");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderChoice>("auto");
  const [speed, setSpeed] = useState<"deep" | "fast">("deep");
  const [timeoutSec, setTimeoutSec] = useState(120);
  const [asyncOnTimeout, setAsyncOnTimeout] = useState(true);
  const [saveToArtifacts, setSaveToArtifacts] = useState(true);
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactPath, setArtifactPath] = useState("");
  const [projectId, setProjectId] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<DeepResearchStatusResponse | null>(null);
  const [lastRunResponse, setLastRunResponse] = useState<DeepResearchRunResponse | null>(null);
  const [pendingRuns, setPendingRuns] = useState<PendingRunItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [historyUnsupported, setHistoryUnsupported] = useState(false);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [expandedRunningRows, setExpandedRunningRows] = useState<Record<string, boolean>>({});

  const configuredProviders = useMemo(() => {
    if (!defaults) return [] as Array<Exclude<ProviderChoice, "auto">>;
    const options: Array<Exclude<ProviderChoice, "auto">> = [];
    if (defaults.availableProviders.gemini) options.push("gemini");
    if (defaults.availableProviders.openai) options.push("openai");
    if (defaults.availableProviders.anthropic) options.push("anthropic");
    return options;
  }, [defaults]);

  const providerOptions = useMemo(() => {
    const options = configuredProviders.map((value) => ({
      value,
      label: providerDisplayName(value)
    })) as ProviderOption[];
    if (options.length > 1) {
      return [{ value: "auto", label: "Auto" } satisfies ProviderOption, ...options];
    }
    return options;
  }, [configuredProviders]);

  const hasAnyConfiguredProvider = providerOptions.length > 0;

  const selectedHistoryEntry = useMemo(
    () => (selectedJobId ? history.find((entry) => entry.jobId === selectedJobId) ?? null : null),
    [history, selectedJobId]
  );

  const currentJobId = jobStatus?.jobId ?? selectedHistoryEntry?.jobId ?? lastRunResponse?.jobId ?? null;
  const resultMarkdown = jobStatus?.resultMarkdown || "";
  const artifactRef = jobStatus?.artifact ?? selectedHistoryEntry?.artifact ?? lastRunResponse?.artifact;
  const runningJobs = useMemo(
    () =>
      history
        .filter((entry) => entry.status === "running")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [history]
  );
  const selectedJobState = jobStatus?.status ?? selectedHistoryEntry?.status;
  const selectedJobCompleted = selectedJobState === "completed";
  const runningRows = useMemo<RunningRow[]>(() => {
    const activeRows = runningJobs.map((entry) => ({
      key: entry.jobId,
      query: entry.query,
      provider: entry.provider,
      speed: entry.speed,
      updatedAt: entry.updatedAt,
      percent: entry.progress.percent,
      message: entry.progress.message,
      jobId: entry.jobId,
      cancellable: true
    }));
    const pendingRows = pendingRuns.map((item) => ({
      key: item.id,
      query: item.query,
      provider: item.provider,
      speed: item.speed,
      updatedAt: item.startedAt,
      percent: 0,
      message: "Starting...",
      jobId: undefined,
      cancellable: false
    }));
    return [...pendingRows, ...activeRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [pendingRuns, runningJobs]);
  const completedCount = useMemo(() => history.filter((entry) => entry.status === "completed").length, [history]);
  const logsByJobId = useMemo(() => {
    const mapping = new Map<string, DeepResearchHistoryEntry["eventLogs"]>();
    for (const entry of history) {
      mapping.set(entry.jobId, entry.eventLogs ?? []);
    }
    if (jobStatus?.jobId) {
      mapping.set(jobStatus.jobId, jobStatus.eventLogs ?? mapping.get(jobStatus.jobId) ?? []);
    }
    return mapping;
  }, [history, jobStatus]);

  const refreshHistory = useCallback(
    async (selectLatest = false): Promise<void> => {
      try {
        const response = await deepResearchApi.list(HISTORY_LIMIT);
        setHistoryUnsupported(Boolean(response.unsupported));
        if (response.unsupported && response.items.length === 0) {
          // Keep local in-memory history when backend list endpoint is unavailable.
          return;
        }
        setHistory((current) => {
          if (response.unsupported) {
            const merged = [...response.items];
            for (const item of current) {
              if (!merged.some((entry) => entry.jobId === item.jobId)) {
                merged.push(item);
              }
            }
            return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          }
          return response.items;
        });
        if (selectLatest && response.items[0]) {
          setSelectedJobId(response.items[0].jobId);
        } else if (selectedJobId && response.items.length > 0 && !response.items.some((entry) => entry.jobId === selectedJobId)) {
          setSelectedJobId(response.items[0]?.jobId ?? null);
        }
      } catch (historyError) {
        const message = historyError instanceof Error ? historyError.message : "Failed to load history";
        setError(message);
      }
    },
    [selectedJobId]
  );

  const refreshJobStatus = useCallback(
    async (jobId: string, silent = false): Promise<void> => {
      try {
        const status = await deepResearchApi.status(jobId);
        setJobStatus(status);
        setHistory((current) => upsertHistoryEntry(current, historyEntryFromStatus(status)));
      } catch (statusError) {
        const message = statusError instanceof Error ? statusError.message : "Failed to load status";
        setError(message);
      }
    },
    []
  );

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      setIsLoadingInitial(true);
      try {
        const [defaultsResponse, projectList, historyResponse] = await Promise.all([
          deepResearchApi.defaults(),
          projectsApi.list(undefined, undefined, 100).catch(() => ({ items: [] as ProjectRecord[] })),
          deepResearchApi
            .list(HISTORY_LIMIT)
            .catch(() => ({ items: [] as DeepResearchHistoryEntry[], unsupported: false }))
        ]);
        if (disposed) return;
        setDefaults(defaultsResponse);
        setSpeed(defaultsResponse.defaults.speed);
        setTimeoutSec(defaultsResponse.defaults.timeoutSec);
        setAsyncOnTimeout(defaultsResponse.defaults.asyncOnTimeout);
        setSaveToArtifacts(defaultsResponse.defaults.saveToArtifacts);
        setProjects(normalizeProjects(projectList.items));
        setHistoryUnsupported(Boolean(historyResponse.unsupported));
        setHistory(historyResponse.items);
        if (historyResponse.items.length > 0) {
          setSelectedJobId((prev) => prev ?? historyResponse.items[0].jobId);
        }
      } catch (loadError) {
        if (disposed) return;
        const message = loadError instanceof Error ? loadError.message : "Failed to load Deep Research defaults";
        setError(message);
      } finally {
        if (!disposed) {
          setIsLoadingInitial(false);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!defaults) return;
    setProvider((current) => {
      if (providerOptions.some((option) => option.value === current)) {
        return current;
      }
      if (providerOptions.some((option) => option.value === defaults.defaults.provider)) {
        return defaults.defaults.provider;
      }
      return providerOptions[0]?.value ?? "auto";
    });
  }, [defaults, providerOptions]);

  useEffect(() => {
    if (!selectedJobId) {
      setJobStatus(null);
      return;
    }
    void refreshJobStatus(selectedJobId, true);
  }, [refreshJobStatus, selectedJobId]);

  useEffect(() => {
    if (!selectedJobId) return;
    const running = (jobStatus?.status ?? selectedHistoryEntry?.status) === "running";
    if (!running) return;

    let disposed = false;
    const poll = async () => {
      try {
        const status = await deepResearchApi.status(selectedJobId);
        if (disposed) return;
        setJobStatus(status);
        if (status.status !== "running") {
          await refreshHistory();
        }
      } catch {
        // Silent polling failure. A visible error is shown on explicit refresh.
      }
    };

    const interval = window.setInterval(() => {
      void poll();
    }, STATUS_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [jobStatus?.status, refreshHistory, selectedHistoryEntry?.status, selectedJobId]);

  useEffect(() => {
    const hasRunningJobs = history.some((entry) => entry.status === "running");
    if (!hasRunningJobs) return;
    const interval = window.setInterval(() => {
      void refreshHistory();
    }, HISTORY_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [history, refreshHistory]);

  const runDeepResearchNow = async () => {
    if (!query.trim()) {
      setError("Query is required.");
      return;
    }
    if (!hasAnyConfiguredProvider) {
      setError("No provider key is configured. Please open Settings and add at least one API key.");
      return;
    }

    const pendingId = makePendingRunId();
    const selectedProvider = providerOptions.some((option) => option.value === provider)
      ? provider
      : providerOptions[0]?.value ?? "auto";
    setPendingRuns((current) => [
      {
        id: pendingId,
        query: query.trim(),
        provider: selectedProvider,
        speed,
        startedAt: new Date().toISOString()
      },
      ...current
    ]);
    setError(null);
    try {
      const result = await deepResearchApi.run({
        query: query.trim(),
        provider: selectedProvider,
        speed,
        timeoutSec,
        asyncOnTimeout,
        saveToArtifacts,
        artifactTitle: artifactTitle.trim() || undefined,
        artifactPath: artifactPath.trim() || undefined,
        projectId: projectId || undefined,
        projectName: projects.find((project) => project.id === projectId)?.name
      });
      setLastRunResponse(result);
      setHistory((current) => upsertHistoryEntry(current, historyEntryFromRun(result)));
      setSelectedJobId(result.jobId);
      setActiveTab("status");
      void refreshJobStatus(result.jobId, true);
      void refreshHistory(true);
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : "Deep Research failed";
      setError(message);
    } finally {
      setPendingRuns((current) => current.filter((item) => item.id !== pendingId));
    }
  };

  const cancelJob = async (jobId: string) => {
    setCancellingJobId(jobId);
    setError(null);
    try {
      await deepResearchApi.cancel(jobId);
      await refreshJobStatus(jobId, true);
      await refreshHistory();
    } catch (cancelError) {
      const message = cancelError instanceof Error ? cancelError.message : "Cancel failed";
      setError(message);
    } finally {
      setCancellingJobId((current) => (current === jobId ? null : current));
    }
  };

  if (isLoadingInitial) {
    return <p className="info">Loading Research...</p>;
  }

  return (
    <section className="research-shell">
      <header className="page-header">
        <h2>Research</h2>
      </header>

      <nav className="research-tabs" aria-label="Research tabs">
        <button
          type="button"
          className={activeTab === "query" ? "research-tab active" : "research-tab"}
          onClick={() => setActiveTab("query")}
        >
          Query
        </button>
        <button
          type="button"
          className={activeTab === "status" ? "research-tab active" : "research-tab"}
          onClick={() => setActiveTab("status")}
        >
          Run Status
        </button>
        <button
          type="button"
          className={activeTab === "history" ? "research-tab active" : "research-tab"}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
      </nav>

      {activeTab === "query" ? (
        <article className="panel research-form-panel">
          {!hasAnyConfiguredProvider ? (
            <div className="research-empty-state">
              <h3>No Provider Key Configured</h3>
              <p>Add Gemini, OpenAI, or Anthropic API key in Settings to start research runs.</p>
              <Link to="/settings">Open Settings</Link>
            </div>
          ) : null}

          <fieldset className="research-fieldset" disabled={!hasAnyConfiguredProvider}>
            <div className="research-grid">
              <label className="span-2">
                <span>Query</span>
                <textarea
                  rows={5}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Enter the topic or question to research..."
                />
              </label>

              <label>
                <span>Provider</span>
                <select
                  value={hasAnyConfiguredProvider ? provider : ""}
                  onChange={(event) => setProvider(event.target.value as ProviderChoice)}
                >
                  {!hasAnyConfiguredProvider ? <option value="">No provider configured</option> : null}
                  {providerOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Speed</span>
                <select value={speed} onChange={(event) => setSpeed(event.target.value as typeof speed)}>
                  <option value="deep">Deep</option>
                  <option value="fast">Fast</option>
                </select>
              </label>

              <label>
                <span>Timeout (sec)</span>
                <input
                  type="number"
                  min={10}
                  max={3600}
                  step={1}
                  value={timeoutSec}
                  onChange={(event) => setTimeoutSec(Number(event.target.value))}
                />
              </label>

              <label>
                <span>Project (Artifacts)</span>
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">Default Project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Artifact Title (optional)</span>
                <input
                  value={artifactTitle}
                  onChange={(event) => setArtifactTitle(event.target.value)}
                  placeholder="Research: ..."
                />
              </label>

              <label>
                <span>Artifact Path (optional)</span>
                <input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} placeholder="research/topic.md" />
              </label>
            </div>

            <div className="research-toggle-row">
              <button
                type="button"
                className={asyncOnTimeout ? "research-switch active" : "research-switch"}
                role="switch"
                aria-checked={asyncOnTimeout}
                onClick={() => setAsyncOnTimeout((prev) => !prev)}
              >
                <span className="research-switch-track" aria-hidden="true">
                  <span className="research-switch-thumb" />
                </span>
                <span className="research-switch-copy">
                  <strong>Background on timeout</strong>
                  <small>Continue run as a long-running job when sync timeout is hit</small>
                </span>
              </button>

              <button
                type="button"
                className={saveToArtifacts ? "research-switch active" : "research-switch"}
                role="switch"
                aria-checked={saveToArtifacts}
                onClick={() => setSaveToArtifacts((prev) => !prev)}
              >
                <span className="research-switch-track" aria-hidden="true">
                  <span className="research-switch-thumb" />
                </span>
                <span className="research-switch-copy">
                  <strong>Auto-save to Artifacts</strong>
                  <small>Persist completed output as a markdown artifact automatically</small>
                </span>
              </button>
            </div>

            <div className="research-provider-status">
              <small>
                Configured providers:
                {configuredProviders.map((p) => (
                  <strong key={p} className="available">
                    {" "}
                    {providerDisplayName(p)}
                  </strong>
                ))}
              </small>
            </div>

            <div className="actions-row research-actions-row">
              <button type="button" onClick={() => void runDeepResearchNow()} disabled={!hasAnyConfiguredProvider}>
                {pendingRuns.length > 0 ? `Starting... (${pendingRuns.length})` : "Start Deep Research"}
              </button>
            </div>
          </fieldset>

          {error ? <p className="error">{error}</p> : null}
        </article>
      ) : null}

      {activeTab === "status" ? (
        <article className="panel research-status-panel">
          <div className="research-metrics-tray">
            <div className="research-metric">
              <small>Completed</small>
              <strong>{completedCount}</strong>
            </div>
            <div className="research-metric">
              <small>Running</small>
              <strong>{runningRows.length}</strong>
            </div>
          </div>

          {jobStatus?.errorMessage ? <p className="error">{jobStatus.errorMessage}</p> : null}
          {jobStatus?.artifactSaveError ? <p className="error">{jobStatus.artifactSaveError}</p> : null}
          {error ? <p className="error">{error}</p> : null}

          <section className="research-running-section">
            <h4>Running Jobs</h4>
            {runningRows.length === 0 ? (
              <p className="muted">No running jobs.</p>
            ) : (
              <ul className="research-running-list">
                {runningRows.map((entry) => {
                  const rowLogs = entry.jobId ? logsByJobId.get(entry.jobId) ?? [] : [];
                  const expanded = Boolean(expandedRunningRows[entry.key]);
                  return (
                    <li key={entry.key} className="research-running-item">
                      <div className="research-running-item-head">
                        <button
                          type="button"
                          className="research-row-toggle"
                          onClick={() =>
                            setExpandedRunningRows((current) => ({
                              ...current,
                              [entry.key]: !current[entry.key]
                            }))
                          }
                          aria-expanded={expanded}
                        >
                          {expanded ? "Hide Logs" : "Show Logs"}
                        </button>
                        <div>
                          <strong>{entry.query}</strong>
                          <small>
                            {providerDisplayName(entry.provider)} / {entry.speed.toUpperCase()} / {entry.message}
                          </small>
                          {entry.jobId ? <small>Job ID: {entry.jobId}</small> : <small>Job ID: assigning...</small>}
                        </div>
                        <div className="research-running-actions">
                          {entry.jobId ? (
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => void cancelJob(entry.jobId!)}
                              disabled={cancellingJobId === entry.jobId || !entry.cancellable}
                            >
                              {cancellingJobId === entry.jobId ? "Cancelling..." : "Cancel"}
                            </button>
                          ) : (
                            <button type="button" className="ghost-button" disabled>
                              Starting...
                            </button>
                          )}
                        </div>
                      </div>
                      {expanded ? (
                        <div className="research-running-item-logs">
                          {rowLogs.length > 0 ? (
                            <ul className="research-log-list">
                              {rowLogs.map((logEntry, index) => (
                                <li key={`${entry.key}-${logEntry.at}-${logEntry.message}-${index}`}>
                                  <span className={`research-log-level ${logEntry.level}`}>{logEntry.level.toUpperCase()}</span>
                                  <span>{logEntry.message}</span>
                                  <small>{shortIso(logEntry.at)}</small>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted">No logs yet for this job.</p>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </article>
      ) : null}

      {activeTab === "history" ? (
        <article className="panel research-result-panel">
          <section className="research-history-panel">
            <div className="research-history-top">
              <h4>History</h4>
              <button type="button" className="ghost-button" onClick={() => void refreshHistory()}>
                Refresh History
              </button>
            </div>
            {historyUnsupported ? (
              <p className="muted">
                Persistent history endpoint is unavailable in the current Core runtime. Restart Core to enable DB-backed history.
              </p>
            ) : null}
            {history.length === 0 ? (
              <p className="muted">No runs yet.</p>
            ) : (
              <ul className="research-history-list">
                {history.map((entry) => (
                  <li key={entry.jobId}>
                    <button
                      type="button"
                      className={entry.jobId === currentJobId ? "research-history-item active" : "research-history-item"}
                      onClick={() => {
                        setSelectedJobId(entry.jobId);
                        setActiveTab("history");
                      }}
                    >
                      <strong>{entry.query}</strong>
                      <small>
                        {providerDisplayName(entry.provider)} / {entry.speed.toUpperCase()} / {deriveRunStateLabel(entry.status)}
                      </small>
                      <small>{shortIso(entry.createdAt)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="research-history-result-panel">
            <div className="research-status-top">
              <h3>Selected Result</h3>
              {currentJobId ? <small>Job ID: {currentJobId}</small> : null}
            </div>

            {artifactRef ? (
              <div className="research-artifact-link">
                <span>Saved Artifact: {artifactRef.title}</span>
                <Link to={`/artifacts?item=${encodeURIComponent(artifactRef.id)}`}>Open Saved Result</Link>
              </div>
            ) : null}

            {selectedJobId && !selectedJobCompleted ? (
              <p className="muted">Selected job is not completed yet.</p>
            ) : null}

            {selectedJobCompleted && resultMarkdown ? (
              <div className="research-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultMarkdown}</ReactMarkdown>
              </div>
            ) : null}

            {!selectedJobId ? <p className="muted">Select a history item to view result.</p> : null}
            {selectedJobId && selectedJobCompleted && !resultMarkdown ? (
              <p className="muted">Result body is not available for the selected job yet.</p>
            ) : null}
          </section>
        </article>
      ) : null}
    </section>
  );
}
