import { useEffect, useState } from "react";
import { analyserApi, ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { AnalyserRoutineRecord, AnalyserRoutineStatusSummary } from "../../types/models";
import { NotConfiguredState } from "./NotConfiguredState";
import { errorMessage, isAnalyserNotConfigured, isVersionConflict, label, optionalDate } from "./shared";

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


const EMPTY_ROUTINE_FORM = {
  key: "",
  name: "",
  skillKey: "",
  scheduleKind: "cron" as "interval" | "cron",
  scheduleExpr: "",
  timezone: "Asia/Tokyo",
  enabled: true,
  maxRetries: 3,
  backoffMinutes: 15
};


export function RoutinesTab() {
  const [routines, setRoutines] = useState<AnalyserRoutineRecord[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AnalyserRoutineStatusSummary>>({});
  const [skillCatalog, setSkillCatalog] = useState<{
    skills: Set<string>;
    loaded: boolean;
    unavailable: boolean;
  }>({ skills: new Set<string>(), loaded: false, unavailable: false });
  const [drafts, setDrafts] = useState<Record<string, RoutineDraft>>({});
  const [routineErrors, setRoutineErrors] = useState<Record<string, string>>({});
  const [createForm, setCreateForm] = useState({ ...EMPTY_ROUTINE_FORM });
  const [createError, setCreateError] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
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
      const [routineResult, statusResult] = await Promise.all([
        analyserApi.routines(),
        analyserApi.routineStatus()
      ]);
      setRoutines(routineResult.items);
      setStatuses(Object.fromEntries(statusResult.items.map((item) => [item.key, item])));
      setDrafts(Object.fromEntries(routineResult.items.map((routine) => [routine.key, routineDraft(routine)])));
    } catch (requestError) {
      if (isAnalyserNotConfigured(requestError)) setNotConfigured(true);
      else setError(errorMessage(requestError, "Analyser routines are unavailable."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const loadSkillCatalog = async () => {
    try {
      const result = await analyserApi.skillCatalog();
      setSkillCatalog({
        skills: new Set(result.skills),
        loaded: true,
        unavailable: Boolean(result.unavailable)
      });
    } catch {
      setSkillCatalog({ skills: new Set<string>(), loaded: false, unavailable: false });
    }
  };

  useEffect(() => { void loadSkillCatalog(); }, []);

  const reloadConflict = async (message: string) => {
    await load();
    setNotice(message);
  };

  const updateDraft = <K extends keyof RoutineDraft>(key: string, field: K, nextValue: RoutineDraft[K]) => {
    setDrafts((current) => ({ ...current, [key]: { ...current[key], [field]: nextValue } }));
  };

  const changedFields = (routine: AnalyserRoutineRecord, draft: RoutineDraft) => {
    const changed: Partial<RoutineDraft> = {};
    (Object.keys(draft) as Array<keyof RoutineDraft>).forEach((field) => {
      if (draft[field] !== routine[field]) Object.assign(changed, { [field]: draft[field] });
    });
    return changed;
  };

  const seed = async () => {
    setBusy("seed");
    setError(undefined);
    setNotice(undefined);
    try {
      await analyserApi.seedRoutines();
      await load();
      setNotice("Default routines seeded.");
    } catch (requestError) {
      setError(errorMessage(requestError, "Unable to seed routines."));
    } finally {
      setBusy(undefined);
    }
  };

  const runIntegrity = async () => {
    setBusy("integrity");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await analyserApi.runSkillIntegrity();
      await Promise.all([load(), loadSkillCatalog()]);
      setNotice(`Skill integrity: blocked ${result.missing.length}, drift ${result.drifted.length}, proposals ${result.proposalsCreated}.`);
    } catch (requestError) {
      setError(errorMessage(requestError, "Unable to run the skill integrity check."));
    } finally {
      setBusy(undefined);
    }
  };

  const saveRoutine = async (routine: AnalyserRoutineRecord) => {
    const draft = drafts[routine.key];
    if (!draft) return;
    const changed = changedFields(routine, draft);
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
        setRoutineErrors((current) => ({ ...current, [routine.key]: requestError.responseMessage || requestError.message }));
      } else if (isVersionConflict(requestError)) {
        await reloadConflict(`${routine.name} changed elsewhere — reloaded.`);
      } else {
        setRoutineErrors((current) => ({ ...current, [routine.key]: errorMessage(requestError, "Unable to save routine.") }));
      }
    } finally {
      setBusy(undefined);
    }
  };

  const removeRoutine = async (routine: AnalyserRoutineRecord) => {
    if (!window.confirm(`Delete routine "${routine.name}" (${routine.key})? Its run history is removed too.`)) return;
    setBusy(`delete:${routine.key}`);
    setError(undefined);
    setNotice(undefined);
    try {
      await analyserApi.deleteRoutine(routine.key);
      await load();
      setNotice(`${routine.name} deleted.`);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) {
        setError(requestError.responseMessage || "Routine has an active run; wait for it to finish.");
      } else {
        setError(errorMessage(requestError, "Unable to delete routine."));
      }
    } finally {
      setBusy(undefined);
    }
  };

  const createRoutine = async () => {
    setBusy("create");
    setCreateError(undefined);
    setNotice(undefined);
    try {
      await analyserApi.createRoutine({
        key: createForm.key.trim(),
        name: createForm.name.trim(),
        skillKey: createForm.skillKey.trim(),
        scheduleKind: createForm.scheduleKind,
        scheduleExpr: createForm.scheduleExpr.trim(),
        timezone: createForm.timezone.trim(),
        enabled: createForm.enabled,
        maxRetries: createForm.maxRetries,
        backoffMinutes: createForm.backoffMinutes
      });
      setCreateForm({ ...EMPTY_ROUTINE_FORM });
      setShowCreate(false);
      await load();
      setNotice("Routine created.");
    } catch (requestError) {
      if (requestError instanceof ApiError && (requestError.status === 400 || requestError.status === 409)) {
        setCreateError(requestError.responseMessage || requestError.message);
      } else {
        setCreateError(errorMessage(requestError, "Unable to create routine."));
      }
    } finally {
      setBusy(undefined);
    }
  };

  const createValid = createForm.key.trim() && createForm.name.trim() && createForm.skillKey.trim() && createForm.scheduleExpr.trim() && createForm.timezone.trim();

  if (notConfigured) return <NotConfiguredState />;

  return (
    <section className="analyser-settings" aria-label="Routines">
      <div className="analyser-section-header">
        <div><h2>Routines</h2><p>Scheduled analysis work. Workbench holds the schedule; agents only claim due routines.</p></div>
        <div className="analyser-header-actions">
          <button type="button" onClick={() => setShowCreate((value) => !value)} disabled={Boolean(busy)}>{showCreate ? "Cancel new" : "New routine"}</button>
          <button type="button" onClick={() => void runIntegrity()} disabled={Boolean(busy)}>{busy === "integrity" ? "Running integrity..." : "Run skill integrity check"}</button>
          <button type="button" onClick={() => void load()} disabled={loading || Boolean(busy)}>{loading ? "Loading..." : "Reload"}</button>
        </div>
      </div>
      {error ? <p className="analyser-error" role="alert">{error}</p> : null}
      {notice ? <p className="analyser-notice" role="status">{notice}</p> : null}
      {loading && routines.length === 0 ? <p className="analyser-muted">Loading routines...</p> : null}

      {showCreate ? (
        <section className="analyser-settings-section" aria-label="Create routine">
          <header><h2>New routine</h2><p>The skill key must match a canonical AgentSkills skill the executing agent can follow.</p></header>
          <div className="analyser-routine-editor">
            <label><span>Key</span><input aria-label="New routine key" value={createForm.key} onChange={(event) => setCreateForm({ ...createForm, key: event.target.value })} placeholder="my-custom-routine" /></label>
            <label><span>Name</span><input aria-label="New routine name" value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} placeholder="My custom routine" /></label>
            <label><span>Skill key</span><input aria-label="New routine skill key" value={createForm.skillKey} onChange={(event) => setCreateForm({ ...createForm, skillKey: event.target.value })} placeholder="workbench-analyser-cycle" /></label>
            <label><span>Schedule kind</span><select aria-label="New routine schedule kind" value={createForm.scheduleKind} onChange={(event) => setCreateForm({ ...createForm, scheduleKind: event.target.value as "interval" | "cron" })}><option value="cron">cron</option><option value="interval">interval</option></select></label>
            <label><span>Expression</span><input aria-label="New routine schedule expression" value={createForm.scheduleExpr} onChange={(event) => setCreateForm({ ...createForm, scheduleExpr: event.target.value })} placeholder={createForm.scheduleKind === "cron" ? "0 9 * * 1" : "60"} /></label>
            <label><span>Timezone</span><input aria-label="New routine timezone" value={createForm.timezone} onChange={(event) => setCreateForm({ ...createForm, timezone: event.target.value })} /></label>
            <label><span>Max retries</span><input aria-label="New routine max retries" type="number" min={0} max={10} value={createForm.maxRetries} onChange={(event) => setCreateForm({ ...createForm, maxRetries: Number(event.target.value) })} /></label>
            <label><span>Backoff minutes</span><input aria-label="New routine backoff minutes" type="number" min={1} max={1440} value={createForm.backoffMinutes} onChange={(event) => setCreateForm({ ...createForm, backoffMinutes: Number(event.target.value) })} /></label>
            <label className="analyser-inline-toggle"><input aria-label="New routine enabled" type="checkbox" checked={createForm.enabled} onChange={(event) => setCreateForm({ ...createForm, enabled: event.target.checked })} /><span>Enabled</span></label>
          </div>
          {createError ? <p className="analyser-error analyser-routine-error" role="alert">{createError}</p> : null}
          <div className="analyser-settings-actions"><button type="button" onClick={() => void createRoutine()} disabled={Boolean(busy) || !createValid}>{busy === "create" ? "Creating..." : "Create routine"}</button></div>
        </section>
      ) : null}

      {!loading && routines.length === 0 ? (
        <div className="analyser-empty-card">
          <h2>No routines are configured</h2>
          <p>Seed the standard set (daily summaries, maintenance, digest, skill materialization) or create your own.</p>
          <button type="button" onClick={() => void seed()} disabled={Boolean(busy)}>{busy === "seed" ? "Seeding..." : "Seed default routines"}</button>
        </div>
      ) : null}

      <div className="analyser-routine-settings-list">
        {routines.map((routine) => {
          const draft = drafts[routine.key] ?? routineDraft(routine);
          const changed = Object.keys(changedFields(routine, draft)).length > 0;
          const routineStatus = statuses[routine.key];
          const catalogSkillMissing = !routine.skillMissing
            && skillCatalog.loaded
            && !skillCatalog.unavailable
            && !skillCatalog.skills.has(routine.skillKey);
          return (
            <article className="analyser-routine-setting" key={routine.key}>
              <header>
                <div>
                  <strong>{routine.name}</strong>
                  <small>
                    {routine.key} · {routine.skillKey}
                    {routine.skillMissing ? (
                      <span
                        role="status"
                        title="Claiming is blocked because this routine's canonical skill is missing."
                        style={{
                          display: "inline-flex",
                          marginLeft: "0.4rem",
                          padding: "0.08rem 0.4rem",
                          border: "1px solid #ef4444",
                          borderRadius: "999px",
                          color: "#ffffff",
                          background: "#b91c1c",
                          fontWeight: 700
                        }}
                      >
                        blocked · skill missing
                      </span>
                    ) : catalogSkillMissing ? (
                      <span
                        role="status"
                        title="This routine's skill was not found in the canonical AgentSkills store."
                        style={{
                          display: "inline-flex",
                          marginLeft: "0.4rem",
                          padding: "0.05rem 0.35rem",
                          border: "1px solid rgba(248, 113, 113, 0.45)",
                          borderRadius: "999px",
                          color: "#fca5a5",
                          background: "rgba(127, 29, 29, 0.2)"
                        }}
                      >
                        skill missing
                      </span>
                    ) : null}
                  </small>
                </div>
                <label className="analyser-inline-toggle"><input aria-label={`${routine.name} enabled`} type="checkbox" checked={draft.enabled} disabled={Boolean(busy)} onChange={(event) => updateDraft(routine.key, "enabled", event.target.checked)} /><span>Enabled</span></label>
              </header>
              {routineStatus ? (
                <dl className="analyser-routine-status">
                  <div><dt>Next run</dt><dd>{optionalDate(routineStatus.nextRunAt)}</dd></div>
                  <div><dt>Last completed</dt><dd>{optionalDate(routineStatus.lastCompletedAt)}</dd></div>
                  <div><dt>Last failed</dt><dd title={routineStatus.lastErrorSummary}>{optionalDate(routineStatus.lastFailedAt)}</dd></div>
                  <div><dt>Active run</dt><dd>{routineStatus.activeRun ? `${routineStatus.activeRun.holder} (lease ${formatDateTime(routineStatus.activeRun.leaseExpiresAt)})` : "—"}</dd></div>
                </dl>
              ) : null}
              <div className="analyser-routine-editor">
                <label><span>Schedule kind</span><select aria-label={`${routine.name} schedule kind`} value={draft.scheduleKind} disabled={Boolean(busy)} onChange={(event) => updateDraft(routine.key, "scheduleKind", event.target.value as RoutineDraft["scheduleKind"])}><option value="interval">interval</option><option value="cron">cron</option></select></label>
                <label><span>Expression</span><input aria-label={`${routine.name} schedule expression`} value={draft.scheduleExpr} disabled={Boolean(busy)} onChange={(event) => updateDraft(routine.key, "scheduleExpr", event.target.value)} /></label>
                <label><span>Timezone</span><input aria-label={`${routine.name} timezone`} value={draft.timezone} disabled={Boolean(busy)} onChange={(event) => updateDraft(routine.key, "timezone", event.target.value)} /></label>
                <label><span>Max retries</span><input aria-label={`${routine.name} max retries`} type="number" min={0} max={10} value={draft.maxRetries} disabled={Boolean(busy)} onChange={(event) => updateDraft(routine.key, "maxRetries", Number(event.target.value))} /></label>
                <label><span>Backoff minutes</span><input aria-label={`${routine.name} backoff minutes`} type="number" min={1} max={1440} value={draft.backoffMinutes} disabled={Boolean(busy)} onChange={(event) => updateDraft(routine.key, "backoffMinutes", Number(event.target.value))} /></label>
              </div>
              {routineErrors[routine.key] ? <p className="analyser-error analyser-routine-error" role="alert">{routineErrors[routine.key]}</p> : null}
              <div className="analyser-settings-actions">
                <button type="button" onClick={() => void saveRoutine(routine)} disabled={Boolean(busy) || !changed}>{busy === `routine:${routine.key}` ? "Saving..." : "Save routine"}</button>
                <button type="button" className="analyser-danger" onClick={() => void removeRoutine(routine)} disabled={Boolean(busy)}>{busy === `delete:${routine.key}` ? "Deleting..." : "Delete"}</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}


