import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  coreApi,
  clearWorkbenchSession,
  fetchAllServiceManifests,
  readWorkbenchSession
} from "../lib/api";
import {
  getDefaultLocationPreset,
  getLocationPresetsForTimezone,
  loadUiSettings,
  SETTINGS_KEY,
  TIMEZONE_OPTIONS,
  type LocationMode,
  type UiSettings
} from "../lib/uiSettings";
import type {
  IntegrationConfigState,
  IntegrationManifest,
  StoredIntegrationConfig,
  WorkbenchUserSession
} from "../types/models";
import "./SettingsPage.css";

type SettingsTab = "general" | "services" | "account";
type CategoryChip = "all" | string;
const LOCAL_INTEGRATIONS_KEY = "workbench-integration-configs";

function formatCategoryLabel(category: string): string {
  if (category.toLowerCase() === "integration") return "Developer";
  return category
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeCategoryKey(category: string): string {
  return formatCategoryLabel(category).toLowerCase();
}

function serviceEmoji(manifestId: string, manifestIcon?: string): string {
  if (manifestIcon && /\p{Extended_Pictographic}/u.test(manifestIcon)) {
    return manifestIcon;
  }
  const id = manifestId.toLowerCase();
  if (id.includes("task")) return "📋";
  if (id.includes("note")) return "📝";
  if (id.includes("artifact")) return "📁";
  if (id.includes("calendar")) return "📅";
  if (id.includes("chat") || id.includes("message")) return "💬";
  return "⚙️";
}
const settingsTabIconMap: Record<SettingsTab, ReactNode> = {
  general: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4a14 14 0 0 1 0 16M12 4a14 14 0 0 0 0 16" />
    </svg>
  ),
  services: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="4" y="5" width="16" height="4" rx="1.5" />
      <rect x="4" y="15" width="16" height="4" rx="1.5" />
    </svg>
  ),
  account: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 19c1.4-2.6 4-4 7-4s5.6 1.4 7 4" />
    </svg>
  )
};

function loadLocalIntegrationConfigs(): Record<string, IntegrationConfigState> {
  try {
    const raw = localStorage.getItem(LOCAL_INTEGRATIONS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, IntegrationConfigState>;
  } catch {
    return {};
  }
}

function normalizeManifestConfigs(
  manifests: IntegrationManifest[],
  current: Record<string, IntegrationConfigState>
): Record<string, IntegrationConfigState> {
  const next = { ...current };
  for (const manifest of manifests) {
    if (!next[manifest.id]) {
      next[manifest.id] = {
        enabled: manifest.defaultEnabled,
        values: {}
      };
    }

    for (const field of manifest.fields) {
      if (next[manifest.id].values[field.key] === undefined) {
        if (field.defaultValue !== undefined) {
          next[manifest.id].values[field.key] = field.defaultValue;
        } else if (field.type === "boolean") {
          next[manifest.id].values[field.key] = false;
        } else {
          next[manifest.id].values[field.key] = "";
        }
      }
    }
  }
  return next;
}

function toStateMapFromDb(configs: StoredIntegrationConfig[]): Record<string, IntegrationConfigState> {
  return Object.fromEntries(
    configs.map((config) => [
      config.integrationId,
      {
        enabled: config.enabled,
        values: config.values
      }
    ])
  );
}

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("services");
  const [settings, setSettings] = useState<UiSettings>(() => loadUiSettings());
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [integrationConfigs, setIntegrationConfigs] = useState<Record<string, IntegrationConfigState>>({});
  const [activeCategory, setActiveCategory] = useState<CategoryChip>("all");
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(null);
  const [serviceSaveMessage, setServiceSaveMessage] = useState<Record<string, string>>({});
  const [serviceSaving, setServiceSaving] = useState<Record<string, boolean>>({});
  const [generalMessage, setGeneralMessage] = useState("");
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);

  const [session, setSession] = useState<WorkbenchUserSession | undefined>(undefined);
  const [profileUsername, setProfileUsername] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [accountMessage, setAccountMessage] = useState("");

  useEffect(() => {
    setSettings(loadUiSettings());
    setIntegrationConfigs(loadLocalIntegrationConfigs());
    const currentSession = readWorkbenchSession();
    setSession(currentSession);
    if (currentSession) {
      setProfileUsername(currentSession.username);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    window.dispatchEvent(new Event("workbench-ui-settings-changed"));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(LOCAL_INTEGRATIONS_KEY, JSON.stringify(integrationConfigs));
  }, [integrationConfigs]);

  const refreshManifests = async () => {
    const loaded = await fetchAllServiceManifests();
    setManifests(loaded);
    setIntegrationConfigs((current) => normalizeManifestConfigs(loaded, current));
  };

  const loadAccountScopedData = async () => {
    try {
      const [, configRows] = await Promise.all([coreApi.me(), coreApi.listIntegrationConfigs()]);
      setIntegrationConfigs((current) =>
        normalizeManifestConfigs(manifests, {
          ...current,
          ...toStateMapFromDb(configRows)
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load account data";
      setAccountMessage(message);
    }
  };

  useEffect(() => {
    void refreshManifests();
  }, []);

  useEffect(() => {
    if (session) {
      void loadAccountScopedData();
      setProfileUsername((current) => current || session.username);
    }
  }, [session, manifests]);

  const tabItems: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: "General" },
    { id: "services", label: "Services" },
    { id: "account", label: "Account" }
  ];

  const sortedManifests = useMemo(
    () => [...manifests].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [manifests]
  );

  const categoryChips = useMemo(() => {
    const base = ["developer", "communication", "productivity"];
    const manifestCategories = sortedManifests.map((manifest) => normalizeCategoryKey(manifest.category || "Developer"));
    const merged = Array.from(new Set([...base, ...manifestCategories]));
    return ["all", ...merged] as CategoryChip[];
  }, [sortedManifests]);

  const filteredManifests = useMemo(() => {
    if (activeCategory === "all") return sortedManifests;
    return sortedManifests.filter(
      (manifest) => normalizeCategoryKey(manifest.category || "Developer") === String(activeCategory).toLowerCase()
    );
  }, [activeCategory, sortedManifests]);

  const saveProfile = () => {
    if (!profileUsername.trim()) {
      setAccountMessage("Username is required.");
      return;
    }
    setAccountMessage("Profile updated locally.");
  };

  const changePassword = () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setAccountMessage("Fill in all password fields.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setAccountMessage("New password and confirmation do not match.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setAccountMessage("Password updated locally.");
  };

  const deleteAccount = async () => {
    if (deleteConfirmation.trim().toUpperCase() !== "DELETE") {
      setAccountMessage('Type "DELETE" to confirm account deletion.');
      return;
    }
    await clearWorkbenchSession();
    setSession(undefined);
    setProfileUsername("");
    setProfileEmail("");
    setDeleteConfirmation("");
    setAccountMessage("Account session cleared.");
  };

  const setServiceFieldValue = (manifestId: string, fieldKey: string, value: string | number | boolean) => {
    setIntegrationConfigs((prev) => {
      const current = prev[manifestId] ?? { enabled: false, values: {} };
      return {
        ...prev,
        [manifestId]: {
          ...current,
          values: {
            ...current.values,
            [fieldKey]: value
          }
        }
      };
    });
  };

  const setServiceEnabled = (manifestId: string, enabled: boolean, fallbackDefault = false) => {
    setIntegrationConfigs((prev) => {
      const current = prev[manifestId] ?? { enabled: fallbackDefault, values: {} };
      return {
        ...prev,
        [manifestId]: {
          ...current,
          enabled
        }
      };
    });
  };

  const saveOneServiceConfig = async (manifestId: string) => {
    if (!session) {
      setServiceSaveMessage((prev) => ({ ...prev, [manifestId]: "Saved locally (sign in to sync to DB)." }));
      return;
    }

    const config = integrationConfigs[manifestId];
    if (!config) return;

    setServiceSaving((prev) => ({ ...prev, [manifestId]: true }));
    setServiceSaveMessage((prev) => ({ ...prev, [manifestId]: "" }));
    try {
      await coreApi.saveIntegrationConfig(manifestId, config);
      setServiceSaveMessage((prev) => ({ ...prev, [manifestId]: "Saved." }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save";
      setServiceSaveMessage((prev) => ({ ...prev, [manifestId]: message }));
    } finally {
      setServiceSaving((prev) => ({ ...prev, [manifestId]: false }));
    }
  };

  const timezoneLocationOptions = useMemo(
    () => getLocationPresetsForTimezone(settings.timezone),
    [settings.timezone]
  );

  const updateTimezone = (timezone: string) => {
    const safeTimezone = TIMEZONE_OPTIONS.includes(timezone as (typeof TIMEZONE_OPTIONS)[number])
      ? timezone
      : "Asia/Tokyo";
    const fallback = getDefaultLocationPreset(safeTimezone);

    setSettings((prev) => {
      const hasPreset = getLocationPresetsForTimezone(safeTimezone).some((preset) => preset.id === prev.locationPresetId);
      if (prev.locationMode === "auto") {
        return {
          ...prev,
          timezone: safeTimezone
        };
      }

      const selected = hasPreset
        ? getLocationPresetsForTimezone(safeTimezone).find((preset) => preset.id === prev.locationPresetId) ?? fallback
        : fallback;

      return {
        ...prev,
        timezone: safeTimezone,
        locationMode: "preset",
        locationPresetId: selected.id,
        location: selected.label,
        locationLatitude: selected.latitude,
        locationLongitude: selected.longitude
      };
    });
  };

  const updateLocationSelection = (value: string) => {
    if (value === "auto") {
      setSettings((prev) => ({
        ...prev,
        locationMode: "auto" as LocationMode,
        location: prev.locationMode === "auto" ? prev.location : "Auto Detect",
        locationLatitude: prev.locationMode === "auto" ? prev.locationLatitude : null,
        locationLongitude: prev.locationMode === "auto" ? prev.locationLongitude : null
      }));
      setGeneralMessage('Location will be detected when you click "Save".');
      return;
    }

    const selected = timezoneLocationOptions.find((option) => option.id === value);
    if (!selected) {
      return;
    }

    setSettings((prev) => ({
      ...prev,
      locationMode: "preset",
      locationPresetId: selected.id,
      location: selected.label,
      locationLatitude: selected.latitude,
      locationLongitude: selected.longitude
    }));
    setGeneralMessage(`Location set to ${selected.label}.`);
  };

  const detectDeviceLocation = async (): Promise<{
    label: string;
    latitude: number;
    longitude: number;
  }> => {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("Geolocation is not available on this device."));
        return;
      }

      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 3 * 60 * 1000
      });
    });

    const latitude = Number(position.coords.latitude.toFixed(4));
    const longitude = Number(position.coords.longitude.toFixed(4));
    let label = `Auto (${latitude}, ${longitude})`;

    try {
      const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${latitude}&longitude=${longitude}&language=en&count=1`
      );
      if (response.ok) {
        const payload = await response.json() as {
          results?: Array<{ name?: string; admin1?: string; country?: string }>;
        };
        const place = payload.results?.[0];
        if (place) {
          const segments = [place.name, place.admin1, place.country].filter(Boolean);
          if (segments.length > 0) {
            label = segments.join(", ");
          }
        }
      }
    } catch {
      // Keep coordinate label when reverse geocoding is unavailable.
    }

    return { label, latitude, longitude };
  };

  const saveGeneralSettings = async () => {
    if (settings.locationMode !== "auto") {
      setGeneralMessage("General settings saved.");
      return;
    }

    setIsDetectingLocation(true);
    setGeneralMessage("Detecting your location...");
    try {
      const detected = await detectDeviceLocation();
      setSettings((prev) => ({
        ...prev,
        location: detected.label,
        locationLatitude: detected.latitude,
        locationLongitude: detected.longitude
      }));
      setGeneralMessage(`Location detected: ${detected.label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to detect location.";
      setGeneralMessage(message);
    } finally {
      setIsDetectingLocation(false);
    }
  };

  return (
    <section className="settings-shell">
      <aside className="settings-nav">
        <p>Settings</p>
        <div className="settings-nav-items">
          {tabItems.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={activeTab === tab.id ? "settings-tab active" : "settings-tab"}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="settings-tab-icon" aria-hidden="true">
                {settingsTabIconMap[tab.id]}
              </span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="settings-content stack">
        {activeTab === "general" ? null : (
          <header className={activeTab === "services" ? "page-header services-page-header" : "page-header"}>
            {activeTab === "services" ? (
              <h2 className="services-page-title">Services</h2>
            ) : (
              <h2 className={activeTab === "account" ? "account-page-title" : undefined}>
                {tabItems.find((item) => item.id === activeTab)?.label ?? "Settings"}
              </h2>
            )}
          </header>
        )}

        {activeTab === "general" ? (
          <article className="panel services-manifest-panel general-localization-panel">
            <h3>General &amp; Localization</h3>
            <p className="integration-subtitle">Language, timezone and location preferences.</p>
            <div className="general-localization-fields">
              <label>
                LANGUAGE
                <select
                  value={settings.language}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      language: event.target.value
                    }))
                  }
                >
                  <option value="English (US)">English (US)</option>
                  <option value="Japanese (JP)">Japanese (JP)</option>
                </select>
              </label>

              <label>
                TIMEZONE
                <select
                  value={settings.timezone}
                  onChange={(event) => updateTimezone(event.target.value)}
                >
                  {TIMEZONE_OPTIONS.map((timezone) => (
                    <option key={timezone} value={timezone}>{timezone}</option>
                  ))}
                </select>
              </label>

              <label>
                LOCATION
                <select
                  value={settings.locationMode === "auto" ? "auto" : settings.locationPresetId}
                  onChange={(event) => updateLocationSelection(event.target.value)}
                >
                  <option value="auto">Auto Detect from this device</option>
                  {timezoneLocationOptions.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.label}
                    </option>
                  ))}
                </select>
                <small className="general-localization-hint">
                  {settings.locationMode === "auto"
                    ? `Current: ${settings.location}`
                    : `Selected: ${settings.location}`}
                </small>
              </label>
            </div>
            <div className="general-localization-actions">
              <button type="button" onClick={() => void saveGeneralSettings()} disabled={isDetectingLocation}>
                {isDetectingLocation ? "Detecting..." : "Save"}
              </button>
            </div>
            {generalMessage ? <p className="general-localization-message">{generalMessage}</p> : null}
          </article>
        ) : null}

        {activeTab === "services" ? (
          <article className="panel services-manifest-panel">
            <p className="integration-subtitle">Connect external tools and services. Toggle to enable, then expand to configure.</p>

            <div className="integration-category-chips">
              {categoryChips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className={activeCategory === chip ? "integration-chip active" : "integration-chip"}
                  onClick={() => setActiveCategory(chip)}
                >
                  {chip === "all" ? "All" : formatCategoryLabel(String(chip))}
                </button>
              ))}
            </div>

            <div className="integration-list-surface">
              <div className="integration-list">
                {filteredManifests.length === 0 ? (
                  <div className="integration-empty-state">
                    <p>No service manifests discovered for this category.</p>
                    <small>Service cards will appear here automatically when manifests are available.</small>
                    <div className="integration-empty-skeletons" aria-hidden="true">
                      <div className="integration-skeleton-card" />
                      <div className="integration-skeleton-card" />
                    </div>
                  </div>
                ) : null}
                {filteredManifests.map((manifest) => {
                const config = integrationConfigs[manifest.id] ?? {
                  enabled: manifest.defaultEnabled,
                  values: {}
                };
                const isExpanded = expandedServiceId === manifest.id;
                const saveMessage = serviceSaveMessage[manifest.id];

                return (
                  <article key={manifest.id} className="integration-card">
                    <header>
                      <div className="integration-card-main">
                        <div className="integration-card-icon" aria-hidden="true">
                          <span>{serviceEmoji(manifest.id, manifest.icon)}</span>
                        </div>
                        <div>
                          <div className="integration-card-title-row">
                            <h4>{manifest.displayName}</h4>
                            {manifest.badge ? <span className="integration-badge">{manifest.badge}</span> : null}
                          </div>
                          <p>{manifest.description}</p>
                        </div>
                      </div>

                      <div className="integration-card-actions">
                        <label className="integration-toggle integration-switch">
                          <input
                            type="checkbox"
                            checked={config.enabled}
                            onChange={(event) => {
                              setServiceEnabled(manifest.id, event.target.checked, manifest.defaultEnabled);
                              void saveOneServiceConfig(manifest.id);
                            }}
                          />
                          <span className="integration-switch-slider" aria-hidden="true" />
                          <span className="sr-only">{config.enabled ? "Enabled" : "Disabled"}</span>
                        </label>
                        <button
                          type="button"
                          className={isExpanded ? "integration-expand-toggle expanded" : "integration-expand-toggle"}
                          aria-label={isExpanded ? "Collapse configuration" : "Expand configuration"}
                          onClick={() => setExpandedServiceId((prev) => (prev === manifest.id ? null : manifest.id))}
                        >
                          <span aria-hidden="true">&gt;</span>
                        </button>
                      </div>
                    </header>

                    {isExpanded ? (
                      <div className="integration-expanded">
                        {manifest.setupInstructions ? (
                          <div className="integration-setup-note">
                            <strong>Setup</strong>
                            <p>{manifest.setupInstructions}</p>
                          </div>
                        ) : null}

                        <div className="integration-fields">
                          {manifest.fields.map((field) => {
                            const fieldId = `${manifest.id}-${field.key}`;
                            const raw = config.values[field.key];
                            const value =
                              raw ?? (field.defaultValue ?? (field.type === "boolean" ? false : ""));

                            return (
                              <div key={fieldId} className="integration-field">
                                <label htmlFor={fieldId}>{field.label}</label>
                                {field.type === "select" ? (
                                  <select
                                    id={fieldId}
                                    value={String(value)}
                                    onChange={(event) => setServiceFieldValue(manifest.id, field.key, event.target.value)}
                                  >
                                    <option value="">Select</option>
                                    {(field.options ?? []).map((option) => {
                                      if (typeof option === "string") {
                                        return (
                                          <option key={option} value={option}>
                                            {option}
                                          </option>
                                        );
                                      }
                                      return (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      );
                                    })}
                                  </select>
                                ) : field.type === "textarea" ? (
                                  <textarea
                                    id={fieldId}
                                    rows={4}
                                    value={String(value)}
                                    placeholder={field.placeholder}
                                    onChange={(event) => setServiceFieldValue(manifest.id, field.key, event.target.value)}
                                  />
                                ) : field.type === "boolean" ? (
                                  <label className="check-row integration-boolean-field" htmlFor={fieldId}>
                                    <input
                                      id={fieldId}
                                      type="checkbox"
                                      checked={Boolean(value)}
                                      onChange={(event) => setServiceFieldValue(manifest.id, field.key, event.target.checked)}
                                    />
                                    <span>Enabled</span>
                                  </label>
                                ) : (
                                  <input
                                    id={fieldId}
                                    type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                                    value={String(value)}
                                    placeholder={field.placeholder}
                                    required={field.required}
                                    min={field.min}
                                    max={field.max}
                                    step={field.step}
                                    onChange={(event) =>
                                      setServiceFieldValue(
                                        manifest.id,
                                        field.key,
                                        field.type === "number" ? Number(event.target.value || 0) : event.target.value
                                      )
                                    }
                                  />
                                )}
                                {field.helperText || field.description ? <small>{field.helperText ?? field.description}</small> : null}
                              </div>
                            );
                          })}
                        </div>

                        <div className="integration-expanded-actions">
                          <button
                            type="button"
                            onClick={() => void saveOneServiceConfig(manifest.id)}
                            disabled={serviceSaving[manifest.id]}
                          >
                            {serviceSaving[manifest.id] ? "Saving..." : "Save Service Config"}
                          </button>
                          {saveMessage ? <p className="info">{saveMessage}</p> : null}
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
                })}
              </div>
            </div>
          </article>
        ) : null}

        {activeTab === "account" ? (
          <article className="panel services-manifest-panel account-page-panel">
            <p className="integration-subtitle">Profile and security settings.</p>

            <div className="account-tiles">
              <section className="account-tile">
                <h3>Profile</h3>
                <label>
                  USERNAME
                  <input value={profileUsername} onChange={(event) => setProfileUsername(event.target.value)} />
                </label>
                <label>
                  EMAIL
                  <input
                    type="email"
                    value={profileEmail}
                    onChange={(event) => setProfileEmail(event.target.value)}
                    placeholder="name@example.com"
                  />
                </label>
                <div className="account-tile-actions">
                  <button type="button" className="account-primary-action" onClick={saveProfile}>Save Profile</button>
                </div>
              </section>

              <section className="account-tile">
                <h3>Change Password</h3>
                <label>
                  CURRENT PASSWORD
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </label>
                <label>
                  NEW PASSWORD
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <label>
                  CONFIRM PASSWORD
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </label>
                <div className="account-tile-actions">
                  <button type="button" className="account-primary-action" onClick={changePassword}>Change Password</button>
                </div>
              </section>

              <section className="account-tile">
                <h3>Account Delete</h3>
                <p className="muted">Type DELETE to confirm account session removal.</p>
                <label>
                  CONFIRMATION
                  <input
                    value={deleteConfirmation}
                    onChange={(event) => setDeleteConfirmation(event.target.value)}
                    placeholder="DELETE"
                  />
                </label>
                <div className="account-tile-actions">
                  <button type="button" className="danger-button" onClick={() => void deleteAccount()}>Delete Account</button>
                </div>
              </section>
            </div>

            {session ? <p className="info">Signed in as {session.username}</p> : null}
            {accountMessage ? <p className="info">{accountMessage}</p> : null}
          </article>
        ) : null}
      </div>
    </section>
  );
}

