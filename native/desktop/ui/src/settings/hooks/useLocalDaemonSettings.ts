import { useEffect, useState } from "react";
import {
  localDaemonApi,
  nativeDaemonApi,
  syncNativeDaemonCoreUrl,
  syncNativeLocalDaemonToken
} from "../../lib/api";
import {
  getWorkbenchLocalDaemonUrlInitialValue,
  getWorkbenchLocalRoutingMode,
  setWorkbenchLocalRoutingMode,
  setWorkbenchLocalDaemonUrl,
  type WorkbenchLocalRoutingMode
} from "../../config/services";
import type {
  LocalDaemonConflictRecord,
  LocalDaemonPendingJobConfirmation,
  LocalDaemonPreferences,
  LocalDaemonStatus,
  WorkbenchUserSession
} from "../../types/models";

export function useLocalDaemonSettings({
  nativeRuntimeAvailable,
  session,
  refreshLocalClients
}: {
  nativeRuntimeAvailable: boolean;
  session: WorkbenchUserSession | undefined;
  refreshLocalClients: () => void | Promise<void>;
}) {
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
  const [localDaemonExitWhenIdle, setLocalDaemonExitWhenIdle] = useState(false);
  const [localDaemonPreferences, setLocalDaemonPreferences] = useState<LocalDaemonPreferences | undefined>(undefined);

  useEffect(() => {
    if (!nativeRuntimeAvailable) {
      setLocalDaemonAutoStart(false);
      return;
    }

    let cancelled = false;
    (async () => {
      await syncNativeDaemonCoreUrl().catch(() => undefined);
      // Re-read here as well as at startup: the daemon generates its token on first run, so
      // an app that started before it would otherwise stay unauthenticated until restarted.
      await syncNativeLocalDaemonToken();
      return nativeDaemonApi.readPreferences();
    })()
      .then((preferences) => {
        if (!cancelled) {
          setLocalDaemonResidentMode(preferences.residentMode ?? true);
          setLocalDaemonAutoStart(preferences.autoStart);
          setLocalDaemonExitWhenIdle(preferences.exitWhenIdle ?? false);
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

  /**
   * `keepMessage` is for callers that have just set their own confirmation and
   * only want the state refreshed behind it. Without it the refresh clears the
   * message immediately and, with showSuccess false, nothing replaces it — so
   * confirmations like "Daemon started." never reached the user. A failure
   * still overwrites the message, since that must be visible.
   */
  const refreshLocalDaemon = async (
    showSuccess = true,
    options: { keepMessage?: boolean } = {}
  ) => {
    setLocalDaemonLoading(true);
    if (!options.keepMessage) {
      setLocalDaemonMessage("");
    }
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

  const requestLocalDaemonRescan = async () => {
    setLocalDaemonLoading(true);
    setLocalDaemonMessage("");
    try {
      const result = await localDaemonApi.requestRescan();
      setLocalDaemonStatus(result.status);
      await loadLocalDaemonState();
      setLocalDaemonMessage("Full cloud snapshot rescan scheduled.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to schedule full rescan";
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
      void refreshLocalDaemon(false, { keepMessage: true });
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
        void refreshLocalDaemon(false, { keepMessage: true });
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

  /**
   * The daemon reads this at startup, so the confirmation says when it takes effect rather
   * than implying the running daemon just changed behaviour.
   */
  const toggleNativeDaemonExitWhenIdle = async (enabled: boolean) => {
    setLocalDaemonMessage("");
    try {
      const preferences = await nativeDaemonApi.setExitWhenIdle(enabled);
      setLocalDaemonExitWhenIdle(preferences.exitWhenIdle ?? false);
      setLocalDaemonPreferences(preferences);
      setLocalDaemonMessage(
        preferences.exitWhenIdle
          ? "The daemon will stop once no Workbench app is using it."
          : "The daemon will keep running with every app closed."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update idle shutdown";
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
      void refreshLocalDaemon(false, { keepMessage: true });
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
      void refreshLocalDaemon(false, { keepMessage: true });
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

  return {
    localDaemonStatus,
    localDaemonConflicts,
    localDaemonPendingJobConfirmations,
    localDaemonLoading,
    localDaemonMessage,
    localDaemonUrlInput,
    setLocalDaemonUrlInput,
    localRoutingMode,
    localDaemonResidentMode,
    localDaemonAutoStart,
    localDaemonPreferences,
    localDaemonResolving,
    localDaemonConfirmingJob,
    loadLocalDaemonState,
    refreshLocalDaemon,
    requestLocalDaemonRescan,
    saveLocalDaemonUrl,
    changeLocalRoutingMode,
    localDaemonExitWhenIdle,
    toggleNativeDaemonExitWhenIdle,
    toggleNativeDaemonResidentMode,
    toggleNativeDaemonAutoStart,
    refreshNativeDaemonPreferences,
    chooseNativeSyncFolder,
    chooseNativeDownloadsFolder,
    resetNativeSyncFolder,
    resetNativeDownloadsFolder,
    openNativeSyncFolder,
    openNativeDownloadsFolder,
    readNativeDaemonStatus,
    startNativeDaemon,
    stopNativeDaemon,
    resolveLocalDaemonConflict,
    approveLocalDaemonJobConfirmation,
    rejectLocalDaemonJobConfirmation
  };
}
