import { useState, type FormEvent } from "react";
import { analyserApi } from "../../lib/api";
import { errorMessage } from "./shared";

type ExportButtonProps = {
  sourceKind: "summary" | "proposal";
  sourceId: string;
  disabled?: boolean;
  disabledTitle?: string;
  onSuccess: (message: string) => void;
};

export function ExportButton({ sourceKind, sourceId, disabled = false, disabledTitle, onSuccess }: ExportButtonProps) {
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


