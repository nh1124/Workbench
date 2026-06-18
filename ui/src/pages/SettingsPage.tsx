import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  coreApi,
  clearWorkbenchSession,
  fetchAllServiceManifests,
  isTauriNativeRuntime,
  localDaemonApi,
  nativeDaemonApi,
  readWorkbenchSession,
  syncNativeDaemonCoreUrl
} from "../lib/api";
import {
  getWorkbenchLocalDaemonUrlInitialValue,
  getWorkbenchLocalRoutingMode,
  setWorkbenchLocalRoutingMode,
  setWorkbenchLocalDaemonUrl,
  type WorkbenchLocalRoutingMode
} from "../config/services";
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
  LocalClientAuditEventRecord,
  LocalClientRecord,
  LocalDaemonConflictRecord,
  LocalDaemonPendingJobConfirmation,
  LocalDaemonPreferences,
  LocalDaemonStatus,
  LocalJobRecord,
  StoredIntegrationConfig,
  WorkbenchUserSession
} from "../types/models";
import "./SettingsPage.css";

type SettingsTab = "general" | "services" | "account" | "sync" | "activity";
type CategoryChip = "all" | string;
const LOCAL_INTEGRATIONS_KEY = "workbench-integration-configs";
const SETTINGS_TABS: SettingsTab[] = ["general", "services", "account", "sync", "activity"];

function parseSettingsTab(search: string): SettingsTab | undefined {
  const value = new URLSearchParams(search).get("tab");
  return SETTINGS_TABS.includes(value as SettingsTab) ? (value as SettingsTab) : undefined;
}

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

function formatSyncErrorCategory(category?: LocalDaemonStatus["lastErrorCategory"]): string {
  if (!category) return "Unknown";
  return category
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatLocalJobKind(kind: LocalJobRecord["kind"] | LocalDaemonPendingJobConfirmation["kind"]): string {
  return kind
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function serviceEmoji(manifestId: string, manifestIcon?: string): string {
  if (manifestIcon && /\p{Extended_Pictographic}/u.test(manifestIcon)) {
    return manifestIcon;
  }
  const id = manifestId.toLowerCase();
  if (id.includes("task")) return "📋";
  if (id.includes("note")) return "📝";
  if (id.includes("artifact")) return "📁";
  if (id.includes("image")) return "IMG";
  if (id.includes("calendar")) return "📅";
  if (id.includes("chat") || id.includes("message")) return "💬";
  return "⚙️";
}

function InfoHint({ label }: { label: string }) {
  return (
    <span className="settings-info-icon" tabIndex={0} role="img" aria-label={label} title={label}>
      i
    </span>
  );
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
  ),
  sync: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7 7h9.5a3.5 3.5 0 0 1 0 7H15" />
      <path d="m10 4-3 3 3 3" />
      <path d="M17 17H7.5a3.5 3.5 0 0 1 0-7H9" />
      <path d="m14 20 3-3-3-3" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 19h16" />
      <path d="M7 16V8" />
      <path d="M12 16V5" />
      <path d="M17 16v-6" />
      <circle cx="7" cy="8" r="1.4" />
      <circle cx="12" cy="5" r="1.4" />
      <circle cx="17" cy="10" r="1.4" />
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
  const location = useLocation();
  const localDaemonSectionRef = useRef<HTMLElement>(null);
  const nativeRuntimeAvailable = isTauriNativeRuntime();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => parseSettingsTab(location.search) ?? "services");
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
  const [localClients, setLocalClients] = useState<LocalClientRecord[]>([]);
  const [localClientAuditEvents, setLocalClientAuditEvents] = useState<LocalClientAuditEventRecord[]>([]);
  const [localJobs, setLocalJobs] = useState<LocalJobRecord[]>([]);
  const [localClientsMessage, setLocalClientsMessage] = useState("");
  const [localClientsLoading, setLocalClientsLoading] = useState(false);
  const [localRoutingMode, setLocalRoutingMode] = useState<WorkbenchLocalRoutingMode>(getWorkbenchLocalRoutingMode());
  const [localDaemonUrlInput, setLocalDaemonUrlInput] = useState(getWorkbenchLocalDaemonUrlInitialValue());
  const [localDaemonStatus, setLocalDaemonStatus] = useState<LocalDaemonStatus | undefined>(undefined);
  const [localDaemonConflicts, setLocalDaemonConflicts] = useState<LocalDaemonConflictRecord[]>([]);
  const [localDaemonPendingJobConfirmations, setLocalDaemonPendingJobConfirmations] = useState<
    LocalDaemonPendingJobConfirmation[]
  >([]);
  const [localDaemonMessage, setLocalDaemonMessage] = useState("");
  const [localDaemonLoading, setLocalDaemonLoading] = useState(false);
  const [localDaemonResolving, setLocalDaemonResolving] = useState<Record<string, boolean>>({});
  const [localDaemonConfirmingJob, setLocalDaemonConfirmingJob] = useState<Record<string, boolean>>({});
  const [localDaemonResidentMode, setLocalDaemonResidentMode] = useState(true);
  const [localDaemonAutoStart, setLocalDaemonAutoStart] = useState(false);
  const [localDaemonPreferences, setLocalDaemonPreferences] = useState<LocalDaemonPreferences | undefined>(undefined);

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

  useEffect(() => {
    const nextTab = parseSettingsTab(location.search);
    if (nextTab) {
      setActiveTab(nextTab);
    }
  }, [location.search]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("section") !== "sync-daemon") {
      return;
    }

    if (activeTab !== "sync") {
      setActiveTab("sync");
      return;
    }

    window.setTimeout(() => {
      localDaemonSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 0);
  }, [activeTab, location.search]);

  useEffect(() => {
    if (!nativeRuntimeAvailable) {
      setLocalDaemonAutoStart(false);
      return;
    }

    let cancelled = false;
    (async () => {
      await syncNativeDaemonCoreUrl().catch(() => undefined);
      return nativeDaemonApi.readPreferences();
    })()
      .then((preferences) => {
        if (!cancelled) {
          setLocalDaemonResidentMode(preferences.residentMode ?? true);
          setLocalDaemonAutoStart(preferences.autoStart);
          setLocalDaemonPreferences(preferences);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Failed to load daemon preferences";
          setLocalDaemonMessage(message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [nativeRuntimeAvailable]);

  const refreshManifests = async () => {
    const loaded = await fetchAllServiceManifests();
    setManifests(loaded);
    setIntegrationConfigs((current) => normalizeManifestConfigs(loaded, current));
  };

  const loadAccountScopedData = async () => {
    try {
      const [, configRows, clientsResult, jobsResult, auditResult] = await Promise.all([
        coreApi.me(),
        coreApi.listIntegrationConfigs(),
        coreApi.listLocalClients(),
        coreApi.listLocalJobs({ limit: 25, includeLocalPaths: true }),
        coreApi.listLocalClientAuditEvents({ limit: 25 })
      ]);
      setIntegrationConfigs((current) =>
        normalizeManifestConfigs(manifests, {
          ...current,
          ...toStateMapFromDb(configRows)
        })
      );
      setLocalClients(clientsResult.items);
      setLocalJobs(jobsResult.items);
      setLocalClientAuditEvents(auditResult.items);
      void refreshLocalDaemon(false);
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
    { id: "account", label: "Account" },
    { id: "sync", label: "Local Sync" },
    { id: "activity", label: "Activity" }
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

  const refreshLocalClients = async () => {
    if (!session) {
      setLocalClients([]);
      setLocalClientAuditEvents([]);
      setLocalJobs([]);
      return;
    }
    setLocalClientsLoading(true);
    setLocalClientsMessage("");
    try {
      const [clientsResult, jobsResult, auditResult] = await Promise.all([
        coreApi.listLocalClients(),
        coreApi.listLocalJobs({ limit: 25, includeLocalPaths: true }),
        coreApi.listLocalClientAuditEvents({ limit: 25 })
      ]);
      setLocalClients(clientsResult.items);
      setLocalJobs(jobsResult.items);
      setLocalClientAuditEvents(auditResult.items);
      setLocalClientsMessage("Local clients refreshed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load local clients";
      setLocalClientsMessage(message);
    } finally {
      setLocalClientsLoading(false);
    }
  };

  const loadLocalDaemonState = async () => {
    const [status, conflicts, pendingJobs] = await Promise.all([
      localDaemonApi.status(),
      localDaemonApi.listConflicts({ status: "open", limit: 25 }),
      localDaemonApi.listPendingJobConfirmations()
    ]);
    setLocalDaemonStatus(status);
    setLocalDaemonConflicts(conflicts.items);
    setLocalDaemonPendingJobConfirmations(pendingJobs.items);
    return { status, conflicts, pendingJobs };
  };

  const refreshLocalDaemon = async (showSuccess = true) => {
    setLocalDaemonLoading(true);
    setLocalDaemonMessage("");
    try {
      await loadLocalDaemonState();
      if (showSuccess) {
        setLocalDaemonMessage("Local daemon refreshed.");
      }
    } catch (error) {
      setLocalDaemonStatus(undefined);
      setLocalDaemonConflicts([]);
      setLocalDaemonPendingJobConfirmations([]);
      const message = error instanceof Error ? error.message : "Failed to reach local daemon";
      setLocalDaemonMessage(message);
    } finally {
      setLocalDaemonLoading(false);
    }
  };

  const saveLocalDaemonUrl = () => {
    try {
      const normalized = setWorkbenchLocalDaemonUrl(localDaemonUrlInput);
      setLocalDaemonUrlInput(normalized);
      setLocalDaemonMessage(
        localRoutingMode === "core"
          ? "Local daemon URL saved."
          : "Local daemon URL saved. Local routing can use this daemon."
      );
      void refreshLocalDaemon(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid local daemon URL";
      setLocalDaemonMessage(message);
    }
  };

  const changeLocalRoutingMode = (mode: WorkbenchLocalRoutingMode) => {
    try {
      if (mode !== "core" && !nativeRuntimeAvailable) {
        const normalized = setWorkbenchLocalDaemonUrl(localDaemonUrlInput);
        setLocalDaemonUrlInput(normalized);
      }
      const persisted = setWorkbenchLocalRoutingMode(mode);
      setLocalRoutingMode(persisted);
      const messages: Record<WorkbenchLocalRoutingMode, string> = {
        core: "Core API mode enabled.",
        auto: "Auto mode enabled. Core is used online; the daemon is used offline.",
        local: "Local mode enabled. Supported routes use the daemon."
      };
      setLocalDaemonMessage(messages[persisted]);
      if (persisted !== "core") {
        void refreshLocalDaemon(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid local daemon URL";
      setLocalDaemonMessage(message);
    }
  };

  const toggleNativeDaemonResidentMode = async (enabled: boolean) => {
    setLocalDaemonMessage("");
    try {
      const preferences = await nativeDaemonApi.setResidentMode(enabled);
      setLocalDaemonResidentMode(preferences.residentMode ?? true);
      setLocalDaemonAutoStart(preferences.autoStart);
      setLocalDaemonPreferences(preferences);
      setLocalDaemonMessage(
        preferences.residentMode === false
          ? "Background resident mode disabled."
          : "Workbench will stay available from the tray."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update resident mode";
      setLocalDaemonMessage(message);
    }
  };

  const toggleNativeDaemonAutoStart = async (enabled: boolean) => {
    setLocalDaemonMessage("");
    try {
      const preferences = await nativeDaemonApi.setAutoStart(enabled);
      setLocalDaemonResidentMode(preferences.residentMode ?? true);
      setLocalDaemonAutoStart(preferences.autoStart);
      setLocalDaemonPreferences(preferences);
      setLocalDaemonMessage(preferences.autoStart ? "Daemon auto-start enabled." : "Daemon auto-start disabled.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update daemon auto-start";
      setLocalDaemonMessage(message);
    }
  };

  const refreshNativeDaemonPreferences = async () => {
    if (!nativeRuntimeAvailable) {
      return undefined;
    }
    await syncNativeDaemonCoreUrl();
    const preferences = await nativeDaemonApi.readPreferences();
    setLocalDaemonResidentMode(preferences.residentMode ?? true);
    setLocalDaemonAutoStart(preferences.autoStart);
    setLocalDaemonPreferences(preferences);
    return preferences;
  };

  const chooseNativeSyncFolder = async () => {
    setLocalDaemonMessage("");
    try {
      const path = await nativeDaemonApi.chooseSyncFolder();
      if (path) {
        await refreshNativeDaemonPreferences();
      }
      setLocalDaemonMessage(
        path
          ? `Sync folder base saved: ${path}. The account folder is created under it. Restart the daemon if it is already running.`
          : "Sync folder selection cancelled."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to choose sync folder";
      setLocalDaemonMessage(message);
    }
  };

  const chooseNativeDownloadsFolder = async () => {
    setLocalDaemonMessage("");
    try {
      const path = await nativeDaemonApi.chooseDownloadsFolder();
      if (path) {
        await refreshNativeDaemonPreferences();
      }
      setLocalDaemonMessage(
        path
          ? `Downloads folder base saved: ${path}. The account folder is created under it. Restart the daemon if it is already running.`
          : "Downloads folder selection cancelled."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to choose downloads folder";
      setLocalDaemonMessage(message);
    }
  };

  const resetNativeSyncFolder = async () => {
    setLocalDaemonMessage("");
    try {
      const preferences = await nativeDaemonApi.resetSyncFolder();
      setLocalDaemonPreferences(preferences);
      setLocalDaemonResidentMode(preferences.residentMode ?? true);
      setLocalDaemonAutoStart(preferences.autoStart);
      setLocalDaemonMessage("Sync folder reset to the per-user default. Restart the daemon if it is already running.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset sync folder";
      setLocalDaemonMessage(message);
    }
  };

  const resetNativeDownloadsFolder = async () => {
    setLocalDaemonMessage("");
    try {
      const preferences = await nativeDaemonApi.resetDownloadsFolder();
      setLocalDaemonPreferences(preferences);
      setLocalDaemonResidentMode(preferences.residentMode ?? true);
      setLocalDaemonAutoStart(preferences.autoStart);
      setLocalDaemonMessage("Downloads folder reset to the per-user default. Restart the daemon if it is already running.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset downloads folder";
      setLocalDaemonMessage(message);
    }
  };

  const openNativeSyncFolder = async () => {
    setLocalDaemonMessage("");
    try {
      await nativeDaemonApi.openSyncFolder();
      setLocalDaemonMessage("Sync folder opened.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open sync folder";
      setLocalDaemonMessage(message);
    }
  };

  const openNativeDownloadsFolder = async () => {
    setLocalDaemonMessage("");
    try {
      await nativeDaemonApi.openDownloadsFolder();
      setLocalDaemonMessage("Downloads folder opened.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open downloads folder";
      setLocalDaemonMessage(message);
    }
  };

  const readNativeDaemonStatus = async () => {
    setLocalDaemonLoading(true);
    setLocalDaemonMessage("");
    try {
      const status = await nativeDaemonApi.readStatus();
      setLocalDaemonStatus(status);
      try {
        const pendingJobs = await localDaemonApi.listPendingJobConfirmations();
        setLocalDaemonPendingJobConfirmations(pendingJobs.items);
      } catch {
        setLocalDaemonPendingJobConfirmations([]);
      }
      setLocalDaemonMessage("Native daemon status loaded.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read native daemon status";
      setLocalDaemonMessage(message);
    } finally {
      setLocalDaemonLoading(false);
    }
  };

  const startNativeDaemon = async () => {
    setLocalDaemonMessage("");
    try {
      await syncNativeDaemonCoreUrl();
      const started = await nativeDaemonApi.start();
      setLocalDaemonMessage(started ? "Daemon started." : "Daemon is already running.");
      void refreshLocalDaemon(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start daemon";
      setLocalDaemonMessage(message);
    }
  };

  const stopNativeDaemon = async () => {
    setLocalDaemonMessage("");
    try {
      const stopped = await nativeDaemonApi.stop();
      setLocalDaemonMessage(stopped ? "Daemon stopped." : "Daemon was not started by this app.");
      void refreshLocalDaemon(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to stop daemon";
      setLocalDaemonMessage(message);
    }
  };

  const resolveLocalDaemonConflict = async (
    conflict: LocalDaemonConflictRecord,
    resolution: "retry" | "ignore" | "close"
  ) => {
    setLocalDaemonResolving((current) => ({ ...current, [conflict.id]: true }));
    setLocalDaemonMessage("");
    try {
      await localDaemonApi.resolveConflict(conflict.id, { resolution });
      await loadLocalDaemonState();
      setLocalDaemonMessage(resolution === "retry" ? "Conflict requeued." : "Conflict updated.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update conflict";
      setLocalDaemonMessage(message);
    } finally {
      setLocalDaemonResolving((current) => ({ ...current, [conflict.id]: false }));
    }
  };

  const approveLocalDaemonJobConfirmation = async (job: LocalDaemonPendingJobConfirmation) => {
    setLocalDaemonConfirmingJob((current) => ({ ...current, [job.jobId]: true }));
    setLocalDaemonMessage("");
    try {
      await localDaemonApi.approveJobConfirmation(job.jobId);
      await loadLocalDaemonState();
      if (session) {
        void refreshLocalClients();
      }
      setLocalDaemonMessage("Local job approved.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to approve local job";
      setLocalDaemonMessage(message);
    } finally {
      setLocalDaemonConfirmingJob((current) => ({ ...current, [job.jobId]: false }));
    }
  };

  const rejectLocalDaemonJobConfirmation = async (job: LocalDaemonPendingJobConfirmation) => {
    setLocalDaemonConfirmingJob((current) => ({ ...current, [job.jobId]: true }));
    setLocalDaemonMessage("");
    try {
      await localDaemonApi.rejectJobConfirmation(job.jobId);
      await loadLocalDaemonState();
      if (session) {
        void refreshLocalClients();
      }
      setLocalDaemonMessage("Local job rejected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reject local job";
      setLocalDaemonMessage(message);
    } finally {
      setLocalDaemonConfirmingJob((current) => ({ ...current, [job.jobId]: false }));
    }
  };

  const setDefaultLocalClient = async (client: LocalClientRecord) => {
    setLocalClientsMessage("");
    try {
      const updated = await coreApi.updateLocalClient(client.id, { default: true });
      setLocalClients((current) => current.map((item) => ({
        ...item,
        default: item.id === updated.id
      })));
      setLocalClientsMessage("Default local client updated.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update local client";
      setLocalClientsMessage(message);
    }
  };

  const toggleLocalClientEnabled = async (client: LocalClientRecord) => {
    setLocalClientsMessage("");
    try {
      const updated = await coreApi.updateLocalClient(client.id, { enabled: !client.enabled });
      setLocalClients((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setLocalClientsMessage(updated.enabled ? "Local client enabled." : "Local client disabled.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update local client";
      setLocalClientsMessage(message);
    }
  };

  const revokeLocalClient = async (client: LocalClientRecord) => {
    setLocalClientsMessage("");
    try {
      const result = await coreApi.revokeLocalClient(client.id);
      const revokedClient = result.client;
      if (revokedClient) {
        setLocalClients((current) => current.map((item) => (item.id === revokedClient.id ? revokedClient : item)));
      }
      setLocalClientsMessage("Local client token revoked.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke local client";
      setLocalClientsMessage(message);
    }
  };

  const deleteLocalClient = async (client: LocalClientRecord) => {
    setLocalClientsMessage("");
    try {
      await coreApi.deleteLocalClient(client.id);
      setLocalClients((current) => current.filter((item) => item.id !== client.id));
      setLocalJobs((current) => current.filter((item) => item.localClientId !== client.id));
      setLocalClientsMessage("Local client deleted.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete local client";
      setLocalClientsMessage(message);
    }
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

  const savedSyncRootBase = localDaemonPreferences?.syncRootBase || "";
  const savedDownloadsDirBase = localDaemonPreferences?.downloadsDirBase || "";
  const legacySavedSyncRoot = localDaemonPreferences?.syncRoot || "";
  const legacySavedDownloadsDir = localDaemonPreferences?.downloadsDir || "";
  const savedSyncRoot = savedSyncRootBase || legacySavedSyncRoot;
  const savedDownloadsDir = savedDownloadsDirBase || legacySavedDownloadsDir;
  const effectiveSyncRoot =
    localDaemonStatus?.syncRoot || localDaemonPreferences?.effectiveSyncRoot || savedSyncRoot || "WorkbenchSync";
  const effectiveDownloadsDir =
    localDaemonStatus?.downloadsDir || localDaemonPreferences?.effectiveDownloadsDir || savedDownloadsDir || "Downloads";
  const folderPathSource = localDaemonStatus ? "Current daemon" : "Next daemon start";
  const accountFolderLabel = localDaemonPreferences?.accountLabel || session?.username || "Guest";

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

        {activeTab === "sync" ? (
          <article className="panel services-manifest-panel account-page-panel settings-wide-panel">
            <div className="settings-tile-grid">
            <section className="account-local-clients">
              <div className="account-local-clients-header">
                <div>
                  <div className="settings-title-with-info">
                    <h3>Local Clients</h3>
                    <InfoHint label="Registered sync daemons that can receive local jobs and keep this account's local workspace in sync." />
                  </div>
                </div>
                <button type="button" onClick={() => void refreshLocalClients()} disabled={localClientsLoading}>
                  {localClientsLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              {localClients.length === 0 ? (
                <p className="info">No local clients registered yet.</p>
              ) : (
                <div className="account-local-client-list">
                  {localClients.map((client) => (
                    <article key={client.id} className="account-local-client-card">
                      <div>
                        <div className="account-local-client-title">
                          <strong>{client.clientName}</strong>
                          {client.default ? <span>Default</span> : null}
                          <span className={client.heartbeat?.online ? "online" : "offline"}>
                            {client.heartbeat?.online ? "Online" : "Offline"}
                          </span>
                        </div>
                        <p>{client.platform} / {client.syncRootLabel}</p>
                        <small>{client.id}</small>
                      </div>
                      <div className="account-local-client-actions">
                        <button type="button" onClick={() => void setDefaultLocalClient(client)} disabled={client.default}>
                          Set Default
                        </button>
                        <button type="button" onClick={() => void toggleLocalClientEnabled(client)}>
                          {client.enabled ? "Disable" : "Enable"}
                        </button>
                        <button type="button" onClick={() => void revokeLocalClient(client)}>
                          Revoke
                        </button>
                        <button type="button" className="danger-button" onClick={() => void deleteLocalClient(client)}>
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {localClientsMessage ? <p className="info">{localClientsMessage}</p> : null}
            </section>
            </div>
          </article>
        ) : null}

        {activeTab === "activity" ? (
          <article className="panel services-manifest-panel account-page-panel settings-wide-panel">
            <p className="integration-subtitle">Recent local client, daemon and file job events.</p>

            <div className="settings-tile-grid">
            <section className="account-local-audit">
              <div className="account-local-clients-header">
                <div>
                  <h3>Local Client Audit</h3>
                  <p className="muted">Recent local client and daemon job lifecycle events.</p>
                </div>
              </div>
              {localClientAuditEvents.length === 0 ? (
                <p className="info">No local client audit events recorded yet.</p>
              ) : (
                <div className="account-local-audit-list">
                  {localClientAuditEvents.map((event) => {
                    const client = event.localClientId
                      ? localClients.find((item) => item.id === event.localClientId)
                      : undefined;
                    const changedFields = Array.isArray(event.detail.changedFields)
                      ? event.detail.changedFields.filter((item): item is string => typeof item === "string")
                      : [];
                    const jobId = typeof event.detail.jobId === "string" ? event.detail.jobId : "";
                    return (
                      <article key={event.id} className="account-local-audit-row">
                        <div>
                          <strong>{event.eventType.replaceAll("_", " ")}</strong>
                          <p>{client?.clientName ?? event.localClientId ?? "Deleted client"} / {event.actorType}</p>
                          {changedFields.length > 0 ? <small>{changedFields.join(", ")}</small> : jobId ? <small>{jobId}</small> : null}
                        </div>
                        <time>{new Date(event.createdAt).toLocaleString()}</time>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="account-local-jobs">
              <div className="account-local-clients-header">
                <div>
                  <h3>Local Job History</h3>
                  <p className="muted">Recent daemon-claimed download and materialization jobs.</p>
                </div>
              </div>
              {localJobs.length === 0 ? (
                <p className="info">No local jobs recorded yet.</p>
              ) : (
                <div className="account-local-job-list">
                  {localJobs.map((job) => {
                    const client = localClients.find((item) => item.id === job.localClientId);
                    const localPath = typeof job.result.localPath === "string" ? job.result.localPath : "";
                    return (
                      <article key={job.id} className="account-local-job-row">
                        <div>
                          <strong>{job.kind.replaceAll("_", " ")}</strong>
                          <p>{client?.clientName ?? job.localClientId} / {job.target}</p>
                          {localPath ? <small>{localPath}</small> : job.errorMessage ? <small>{job.errorMessage}</small> : null}
                        </div>
                        <div className={`account-local-job-status ${job.status}`}>
                          <span>{job.status}</span>
                          <small>{new Date(job.updatedAt).toLocaleString()}</small>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            </div>
          </article>
        ) : null}

        {activeTab === "sync" ? (
          <article className="panel services-manifest-panel account-page-panel settings-wide-panel">
            <section className="account-local-daemon" ref={localDaemonSectionRef}>
              <div className="account-local-clients-header">
                <div>
                  <div className="settings-title-with-info">
                    <h3>Sync Daemon</h3>
                    <InfoHint label="Controls the local resident daemon, routing mode, sync folder, downloads folder and local conflict handling." />
                  </div>
                </div>
                <button type="button" onClick={() => void refreshLocalDaemon()} disabled={localDaemonLoading}>
                  {localDaemonLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              <div className="account-local-mode-control">
                <div>
                  <div className="settings-title-with-info">
                    <strong>Routing Mode</strong>
                    <InfoHint label="Auto uses Core while online and falls back to the local daemon when Core is unreachable. Core always uses the cloud API. Local uses daemon-backed routes where supported." />
                  </div>
                </div>
                <div className="account-local-routing-segmented" role="radiogroup" aria-label="Workbench routing mode">
                  {(["auto", "core", "local"] as WorkbenchLocalRoutingMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={localRoutingMode === mode}
                      className={localRoutingMode === mode ? "active" : ""}
                      onClick={() => changeLocalRoutingMode(mode)}
                    >
                      {mode === "core" ? "Core" : mode === "auto" ? "Auto" : "Local"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="account-local-mode-control">
                <div>
                  <div className="settings-title-with-info">
                    <strong>Background Resident</strong>
                    <InfoHint label="Keeps Workbench available from the tray when the last main window is closed. Desktop runtime only." />
                  </div>
                </div>
                <label className="integration-switch">
                  <input
                    type="checkbox"
                    checked={localDaemonResidentMode}
                    disabled={!nativeRuntimeAvailable}
                    onChange={(event) => void toggleNativeDaemonResidentMode(event.target.checked)}
                  />
                  <span className="integration-switch-slider" aria-hidden="true" />
                  <span className="sr-only">
                    {localDaemonResidentMode ? "Disable background resident mode" : "Enable background resident mode"}
                  </span>
                </label>
              </div>

              <div className="account-local-mode-control">
                <div>
                  <div className="settings-title-with-info">
                    <strong>Auto-start Daemon</strong>
                    <InfoHint label="Starts the local sync daemon automatically when the desktop app launches. Desktop runtime only." />
                  </div>
                </div>
                <label className="integration-switch">
                  <input
                    type="checkbox"
                    checked={localDaemonAutoStart}
                    disabled={!nativeRuntimeAvailable}
                    onChange={(event) => void toggleNativeDaemonAutoStart(event.target.checked)}
                  />
                  <span className="integration-switch-slider" aria-hidden="true" />
                  <span className="sr-only">
                    {localDaemonAutoStart ? "Disable daemon auto-start" : "Enable daemon auto-start"}
                  </span>
                </label>
              </div>

              <div className="account-local-folder-grid">
                <article className="account-local-folder-card">
                  <div>
                    <div className="settings-title-with-info">
                      <strong>Sync Folder</strong>
                      <InfoHint
                        label={
                          savedSyncRootBase
                            ? `Custom base: ${savedSyncRootBase}. Workbench uses an account folder for ${accountFolderLabel} under that base.`
                            : legacySavedSyncRoot
                              ? `Legacy custom folder for ${accountFolderLabel}.`
                              : `Per-account default folder for ${accountFolderLabel}.`
                        }
                      />
                    </div>
                  </div>
                  <code>{effectiveSyncRoot}</code>
                  {localDaemonStatus && localDaemonStatus.syncRoot !== effectiveSyncRoot ? (
                    <small className="account-local-folder-next">Next start: {effectiveSyncRoot}</small>
                  ) : null}
                  <div className="account-local-folder-meta">
                    <span>{folderPathSource}</span>
                    {localDaemonStatus && localDaemonStatus.syncRoot !== effectiveSyncRoot ? (
                      <span>Restart pending</span>
                    ) : null}
                  </div>
                  <div className="account-local-folder-actions">
                    <button type="button" onClick={() => void chooseNativeSyncFolder()} disabled={!nativeRuntimeAvailable}>
                      Choose
                    </button>
                    <button type="button" onClick={() => void openNativeSyncFolder()} disabled={!nativeRuntimeAvailable}>
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void resetNativeSyncFolder()}
                      disabled={!nativeRuntimeAvailable || !savedSyncRoot}
                    >
                      Use Default
                    </button>
                  </div>
                </article>

                <article className="account-local-folder-card">
                  <div>
                    <div className="settings-title-with-info">
                      <strong>Downloads Folder</strong>
                      <InfoHint
                        label={
                          savedDownloadsDirBase
                            ? `Custom base: ${savedDownloadsDirBase}. Workbench uses an account folder for ${accountFolderLabel} under that base.`
                            : legacySavedDownloadsDir
                              ? `Legacy custom downloads folder for ${accountFolderLabel}.`
                              : `Per-account default downloads folder for ${accountFolderLabel}.`
                        }
                      />
                    </div>
                  </div>
                  <code>{effectiveDownloadsDir}</code>
                  {localDaemonStatus && localDaemonStatus.downloadsDir !== effectiveDownloadsDir ? (
                    <small className="account-local-folder-next">Next start: {effectiveDownloadsDir}</small>
                  ) : null}
                  <div className="account-local-folder-meta">
                    <span>{folderPathSource}</span>
                    {localDaemonStatus && localDaemonStatus.downloadsDir !== effectiveDownloadsDir ? (
                      <span>Restart pending</span>
                    ) : null}
                  </div>
                  <div className="account-local-folder-actions">
                    <button
                      type="button"
                      onClick={() => void chooseNativeDownloadsFolder()}
                      disabled={!nativeRuntimeAvailable}
                    >
                      Choose
                    </button>
                    <button type="button" onClick={() => void openNativeDownloadsFolder()} disabled={!nativeRuntimeAvailable}>
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void resetNativeDownloadsFolder()}
                      disabled={!nativeRuntimeAvailable || !savedDownloadsDir}
                    >
                      Use Default
                    </button>
                  </div>
                </article>
              </div>

              {nativeRuntimeAvailable ? (
                <div className="account-local-native-managed">
                  <div className="account-local-native-managed-head">
                    <div className="settings-title-with-info">
                      <strong>Desktop Link</strong>
                      <InfoHint label="The desktop app manages daemon startup and the local endpoint automatically. Cloud sync uses the current Workbench Core URL from sign-in." />
                    </div>
                    <span className="account-local-native-badge">Automatic</span>
                  </div>
                  <div className="account-local-native-actions">
                    <button
                      type="button"
                      onClick={() => void readNativeDaemonStatus()}
                      disabled={!nativeRuntimeAvailable || localDaemonLoading}
                    >
                      Native Status
                    </button>
                    <button type="button" onClick={() => void startNativeDaemon()} disabled={!nativeRuntimeAvailable}>
                      Start
                    </button>
                    <button type="button" onClick={() => void stopNativeDaemon()} disabled={!nativeRuntimeAvailable}>
                      Stop
                    </button>
                  </div>
                </div>
              ) : (
                <div className="account-local-daemon-url">
                  <input
                    value={localDaemonUrlInput}
                    onChange={(event) => setLocalDaemonUrlInput(event.target.value)}
                    placeholder="http://127.0.0.1:35780"
                  />
                  <button type="button" onClick={saveLocalDaemonUrl}>Save URL</button>
                </div>
              )}

              {localDaemonStatus ? (
                <div className="account-local-daemon-status">
                  <span className={localDaemonStatus.watcherActive ? "online" : "offline"}>
                    {localDaemonStatus.watcherActive ? "Watcher On" : "Watcher Off"}
                  </span>
                  <span>{localDaemonStatus.outboxPending ?? 0} pending</span>
                  <span>{localDaemonStatus.outboxFailed ?? 0} failed</span>
                  <span>{localDaemonStatus.conflictsOpen ?? 0} conflicts</span>
                  <span>{localDaemonStatus.localJobConfirmationPolicy ?? "off"} confirmation</span>
                  <span>{localDaemonStatus.localJobConfirmationsPending ?? 0} approvals</span>
                  {localDaemonStatus.lastError ? (
                    <small>
                      {localDaemonStatus.lastErrorCategory
                        ? `${formatSyncErrorCategory(localDaemonStatus.lastErrorCategory)}${localDaemonStatus.lastErrorRetryable ? " retryable" : ""}: `
                        : ""}
                      {localDaemonStatus.lastError}
                    </small>
                  ) : null}
                </div>
              ) : (
                <p className="info">Local daemon status is not loaded.</p>
              )}

              <div className="account-local-confirmations">
                <div className="account-local-conflicts-head">
                  <strong>Pending Local Jobs</strong>
                  <small>{localDaemonPendingJobConfirmations.length} items</small>
                </div>
                {localDaemonPendingJobConfirmations.length === 0 ? (
                  <p className="info">No local jobs are waiting for approval.</p>
                ) : (
                  <div className="account-local-confirmation-list">
                    {localDaemonPendingJobConfirmations.map((job) => (
                      <article key={job.jobId} className="account-local-confirmation-row">
                        <div>
                          <strong>{formatLocalJobKind(job.kind)}</strong>
                          <p>{job.requestedFilename ?? job.payload.filename ?? job.jobId}</p>
                          <div className="account-local-conflict-meta">
                            <span>{job.target}</span>
                            <span>{new Date(job.requestedAt).toLocaleString()}</span>
                          </div>
                          <small>{job.destinationRoot}</small>
                          <small>{job.reason}</small>
                        </div>
                        <div className="account-local-confirmation-actions">
                          <button
                            type="button"
                            disabled={localDaemonConfirmingJob[job.jobId]}
                            onClick={() => void approveLocalDaemonJobConfirmation(job)}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            disabled={localDaemonConfirmingJob[job.jobId]}
                            onClick={() => void rejectLocalDaemonJobConfirmation(job)}
                          >
                            Reject
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="account-local-conflicts">
                <div className="account-local-conflicts-head">
                  <strong>Open Conflicts</strong>
                  <small>{localDaemonConflicts.length} items</small>
                </div>
                {localDaemonConflicts.length === 0 ? (
                  <p className="info">No open local sync conflicts.</p>
                ) : (
                  <div className="account-local-conflict-list">
                    {localDaemonConflicts.map((conflict) => (
                      <article key={conflict.id} className="account-local-conflict-row">
                        <div>
                          <strong>{conflict.relativePath}</strong>
                          <p>{conflict.action} / {conflict.domain}</p>
                          <div className="account-local-conflict-meta">
                            {conflict.errorCategory ? <span>{formatSyncErrorCategory(conflict.errorCategory)}</span> : null}
                            {conflict.errorCode ? <span>{conflict.errorCode}</span> : null}
                            {typeof conflict.retryable === "boolean" ? (
                              <span className={conflict.retryable ? "retryable" : "blocking"}>
                                {conflict.retryable ? "Retryable" : "Needs review"}
                              </span>
                            ) : null}
                          </div>
                          <small>{conflict.errorMessage}</small>
                        </div>
                        <div className="account-local-conflict-actions">
                          <button
                            type="button"
                            disabled={localDaemonResolving[conflict.id]}
                            onClick={() => void resolveLocalDaemonConflict(conflict, "retry")}
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            disabled={localDaemonResolving[conflict.id]}
                            onClick={() => void resolveLocalDaemonConflict(conflict, "ignore")}
                          >
                            Ignore
                          </button>
                          <button
                            type="button"
                            disabled={localDaemonResolving[conflict.id]}
                            onClick={() => void resolveLocalDaemonConflict(conflict, "close")}
                          >
                            Close
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
              {localDaemonMessage ? <p className="info">{localDaemonMessage}</p> : null}
            </section>
          </article>
        ) : null}
      </div>
    </section>
  );
}

