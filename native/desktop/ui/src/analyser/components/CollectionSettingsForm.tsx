import type { AnalyserCollectionSettingsOverride, AnalyserObservationSource } from "../../types/models";
import { SOURCES, label } from "./shared";

const COLLECTION_ENUM_FIELDS = [
  { key: "workbenchChanges", name: "Workbench changes", options: ["off", "metadata"], caption: "Stores Workbench change action metadata and resource references on the server." },
  { key: "mcpAccess", name: "MCP access", options: ["off", "mutations", "reads_and_mutations"], caption: "Stores allowed MCP tool names, outcomes, and resource references on the server." },
  { key: "uiAccess", name: "UI access", options: ["off", "mutations", "reads_and_mutations"], caption: "Stores allowed UI action metadata and resource references on the server." },
  { key: "agentSessionEvents", name: "Agent session events", options: ["off", "explicit_only"], caption: "Stores metadata only for agent session events that are explicitly emitted." },
  { key: "localFileEvents", name: "Local file events", options: ["off", "metadata"], caption: "Captures file action and path metadata under allowed local roots; file contents are never stored." },
  { key: "screenshots", name: "Screenshots", options: ["off", "local_only"], caption: "Screenshots are captured and stored on this machine only — never uploaded" }
] as const;

const COLLECTION_BOOLEAN_FIELDS = [
  { key: "screenshotDerivedUpload", name: "Screenshot-derived text upload", caption: "Lets a local agent upload TEXT it derived from screenshots/captures to the server. The screenshot image itself is never uploaded." },
  { key: "foregroundAppCapture", name: "Foreground app capture", caption: "Captures app name + idle flag samples on this machine." },
  { key: "foregroundAppUpload", name: "Foreground app upload", caption: "Uploads app name + idle flag samples to the server" },
  { key: "windowTitleCapture", name: "Window title capture", caption: "Captures the active window title on this machine when explicitly enabled." },
  { key: "windowTitleUpload", name: "Window title upload", caption: "Uploads captured window titles to the server when explicitly enabled." },
  { key: "localFileUpload", name: "Local file upload", caption: "Uploads local file action and path metadata to the server; file contents are never uploaded." }
] as const;

const COLLECTION_ARRAY_FIELDS = [
  { key: "projectAllow", name: "Project allow list", caption: "Limits collection to these comma-separated project IDs when the list is not empty." },
  { key: "projectDeny", name: "Project deny list", caption: "Excludes these comma-separated project IDs from collection." },
  { key: "resourceTypeAllow", name: "Resource type allow list", caption: "Limits collection to these comma-separated resource types when the list is not empty." },
  { key: "resourceTypeDeny", name: "Resource type deny list", caption: "Excludes these comma-separated resource types from collection." },
  { key: "localRootAllow", name: "Local root allow list", caption: "Limits local file metadata capture to these comma-separated roots." },
  { key: "localRootDeny", name: "Local root deny list", caption: "Excludes these comma-separated local roots from capture." },
  { key: "excludePatterns", name: "Exclude patterns", caption: "Excludes paths matching these comma-separated patterns before metadata is produced." }
] as const;

const RETENTION_CAPTIONS: Record<AnalyserObservationSource, string> = {
  workbench_change: "Keeps raw Workbench change metadata on the server for this many days.",
  mcp_access: "Keeps raw MCP access metadata on the server for this many days.",
  ui_access: "Keeps raw UI access metadata on the server for this many days.",
  agent_session: "Keeps raw agent session metadata on the server for this many days.",
  pc_activity: "Keeps uploaded foreground app metadata on the server for this many days.",
  local_file: "Keeps uploaded local file metadata on the server for this many days."
};

type CollectionEnumField = (typeof COLLECTION_ENUM_FIELDS)[number]["key"];
type CollectionBooleanField = (typeof COLLECTION_BOOLEAN_FIELDS)[number]["key"];
type CollectionArrayField = (typeof COLLECTION_ARRAY_FIELDS)[number]["key"];

function omitCollectionField(
  settings: AnalyserCollectionSettingsOverride,
  field: keyof AnalyserCollectionSettingsOverride
): AnalyserCollectionSettingsOverride {
  const next = { ...settings };
  delete next[field];
  return next;
}

function parseCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}


export function CollectionSettingsForm({
  value,
  sparse,
  disabled,
  onChange
}: {
  value: AnalyserCollectionSettingsOverride;
  sparse: boolean;
  disabled: boolean;
  onChange: (next: AnalyserCollectionSettingsOverride) => void;
}) {
  const changeEnum = (field: CollectionEnumField, nextValue: string) => {
    if (sparse && nextValue === "") onChange(omitCollectionField(value, field));
    else onChange({ ...value, [field]: nextValue });
  };

  const changeBoolean = (field: CollectionBooleanField, nextValue: string | boolean) => {
    if (sparse && nextValue === "") onChange(omitCollectionField(value, field));
    else onChange({ ...value, [field]: typeof nextValue === "boolean" ? nextValue : nextValue === "true" });
  };

  const changeRetention = (source: AnalyserObservationSource, raw: string) => {
    const retentionDays = { ...(value.retentionDays ?? {}) };
    if (sparse && raw === "") delete retentionDays[source];
    else retentionDays[source] = Number(raw);
    onChange(Object.keys(retentionDays).length > 0
      ? { ...value, retentionDays }
      : omitCollectionField(value, "retentionDays"));
  };

  const changeArray = (field: CollectionArrayField, raw: string) => {
    if (sparse && raw.trim() === "") onChange(omitCollectionField(value, field));
    else onChange({ ...value, [field]: parseCommaList(raw) });
  };

  return (
    <div className="analyser-settings-form-grid">
      {COLLECTION_ENUM_FIELDS.map((field) => (
        <label className="analyser-setting-control" key={field.key}>
          <span>{field.name}</span>
          <select
            aria-label={field.name}
            value={String(value[field.key] ?? "")}
            disabled={disabled}
            onChange={(event) => changeEnum(field.key, event.target.value)}
          >
            {sparse ? <option value="">inherit</option> : null}
            {field.options.map((option) => <option value={option} key={option}>{label(option)}</option>)}
          </select>
          <small>{field.caption}</small>
        </label>
      ))}

      {COLLECTION_BOOLEAN_FIELDS.map((field) => (
        <label className="analyser-setting-control" key={field.key}>
          <span>{field.name}</span>
          {sparse ? (
            <select
              aria-label={field.name}
              value={value[field.key] === undefined ? "" : String(value[field.key])}
              disabled={disabled}
              onChange={(event) => changeBoolean(field.key, event.target.value)}
            >
              <option value="">inherit</option>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          ) : (
            <input
              aria-label={field.name}
              type="checkbox"
              checked={Boolean(value[field.key])}
              disabled={disabled}
              onChange={(event) => changeBoolean(field.key, event.target.checked)}
            />
          )}
          <small>{field.caption}</small>
        </label>
      ))}

      {SOURCES.map((source) => (
        <label className="analyser-setting-control" key={source}>
          <span>{label(source)} retention days</span>
          <input
            aria-label={`${label(source)} retention days`}
            type="number"
            min={1}
            max={90}
            value={value.retentionDays?.[source] ?? ""}
            placeholder={sparse ? "inherit" : undefined}
            disabled={disabled}
            onChange={(event) => changeRetention(source, event.target.value)}
          />
          <small>{RETENTION_CAPTIONS[source]}</small>
        </label>
      ))}

      <label className="analyser-setting-control">
        <span>Local screenshot retention days</span>
        <input
          aria-label="Local screenshot retention days"
          type="number"
          min={1}
          max={30}
          value={value.localScreenshotRetentionDays ?? ""}
          placeholder={sparse ? "inherit" : undefined}
          disabled={disabled}
          onChange={(event) => {
            if (sparse && event.target.value === "") onChange(omitCollectionField(value, "localScreenshotRetentionDays"));
            else onChange({ ...value, localScreenshotRetentionDays: Number(event.target.value) });
          }}
        />
        <small>Keeps screenshots on this machine for this many days; screenshots are never uploaded.</small>
      </label>

      {COLLECTION_ARRAY_FIELDS.map((field) => (
        <label className="analyser-setting-control analyser-setting-wide" key={field.key}>
          <span>{field.name}</span>
          <input
            aria-label={field.name}
            value={(value[field.key] ?? []).join(", ")}
            placeholder={sparse ? "inherit" : "Comma-separated values"}
            disabled={disabled}
            onChange={(event) => changeArray(field.key, event.target.value)}
          />
          <small>{field.caption}</small>
        </label>
      ))}
    </div>
  );
}


