import { useEffect, useMemo, useState } from "react";
import { analyserApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { AnalyserSummaryListItem, AnalyserSummaryRecord } from "../../types/models";
import { ExportButton } from "./ExportButton";
import { NotConfiguredState } from "./NotConfiguredState";
import { ReferenceList } from "./ReferenceList";
import { ANALYSER_PAGE_SIZE, compactValue, errorMessage, isAnalyserNotConfigured, label } from "./shared";

export function SummaryTab() {
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


