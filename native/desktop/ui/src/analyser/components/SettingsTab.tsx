import { useEffect, useState } from "react";
import { analyserApi } from "../../lib/api";
import { ANALYSER_OPERATION_KINDS } from "../../types/models";
import type { AnalyserAutomationPolicy, AnalyserCollectionSettingsOverride, AnalyserMachineRecord, AnalyserSettingsResult } from "../../types/models";
import { CollectionSettingsForm } from "./CollectionSettingsForm";
import { NotConfiguredState } from "./NotConfiguredState";
import { errorMessage, isAnalyserNotConfigured, isVersionConflict, label, machineName } from "./shared";

export function SettingsTab() {
  const [settings, setSettings] = useState<AnalyserSettingsResult>();
  const [machines, setMachines] = useState<AnalyserMachineRecord[]>([]);
  const [ownerForm, setOwnerForm] = useState<AnalyserCollectionSettingsOverride>();
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [machineForm, setMachineForm] = useState<AnalyserCollectionSettingsOverride>({});
  const [automationForm, setAutomationForm] = useState<AnalyserAutomationPolicy>();
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
      const [settingsResult, machineResult] = await Promise.all([
        analyserApi.settings(),
        analyserApi.machines()
      ]);
      setSettings(settingsResult);
      setMachines(machineResult.items);
      setOwnerForm({
        ...settingsResult.effective.settings,
        retentionDays: { ...settingsResult.effective.settings.retentionDays }
      });
      setAutomationForm({
        ...settingsResult.automation.policy,
        allowedOperationKinds: [...settingsResult.automation.policy.allowedOperationKinds]
      });
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

  if (notConfigured) return <NotConfiguredState />;

  return (
    <section className="analyser-settings" aria-label="Settings">
      <div className="analyser-section-header">
        <div><h2>Settings</h2><p>Control collection, per-machine overrides, and automation policy. Routine schedules live in the Routines tab.</p></div>
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
        </>
      ) : null}
    </section>
  );
}


