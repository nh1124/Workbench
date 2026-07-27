import { useEffect, useMemo, useState } from "react";
import { analyserApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { AnalyserOperationRecord, AnalyserProposalListItem, AnalyserProposalRecord, AnalyserProposalStatus } from "../../types/models";
import { ExportButton } from "./ExportButton";
import { NotConfiguredState } from "./NotConfiguredState";
import { ReferenceList } from "./ReferenceList";
import { ANALYSER_PAGE_SIZE, compactValue, errorMessage, isAnalyserNotConfigured, isVersionConflict, label, optionalDate } from "./shared";

const PROPOSAL_STATUSES: AnalyserProposalStatus[] = ["open", "approved", "rejected", "executed", "superseded"];

const CONFIDENCE_FIELDS = [
  "deterministicTarget",
  "currentEvidence",
  "policyAllowed",
  "concurrencyProtected",
  "reversibleOrNonDestructive"
] as const;

export function ProposalTab() {
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


