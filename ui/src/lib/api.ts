import {
  getNativeGlobalShortcutRegistrations,
  type ShortcutBindings
} from "./keyboardShortcuts";
import {
  invokeNative,
  isTauriNativeRuntime
} from "./api/transport";
export {
  ApiError,
  autoRoutingCanFallbackToLocal,
  clearWorkbenchSession,
  coreApiPath,
  formatApiErrorMessage,
  initializeSessionStorage,
  isTauriNativeRuntime,
  localDaemonSupportsWriteRequest,
  nativeDaemonApi,
  readWorkbenchSession,
  saveWorkbenchSession,
  sessionAuthHeaders,
  syncNativeDaemonCoreUrl
} from "./api/transport";
export type { ApiBackend } from "./api/transport";
export { notesApi } from "./api/notes";
export { artifactsApi } from "./api/artifacts";
export { tasksApi, taskAttachmentsApi, taskSubtasksApi } from "./api/tasks";
export { projectsApi } from "./api/projects";
export { analyserApi } from "./api/analyser";
export { imagesApi } from "./api/images";
export { mindmapsApi } from "./api/mindmaps";
export { wbsApi } from "./api/wbs";
export { deepResearchApi } from "./api/deepResearch";
export { coreApi, localDaemonApi, checkServiceHealth, fetchServiceManifest, fetchAllServiceManifests } from "./api/core";

export async function closeQuickNoteWindow(): Promise<void> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>("close_quick_note_window");
    return;
  }
  if (typeof window !== "undefined") {
    window.close();
  }
}

export async function openQuickNoteWindow(): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("open_quick_note_window");
  return true;
}

export async function openCalendarWindow(url: string): Promise<boolean> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>("open_calendar_window", { url });
    return true;
  }
  if (typeof window === "undefined") return false;
  const calendarWindow = window.open(url, "workbench-calendar", "width=1100,height=800");
  calendarWindow?.focus();
  return calendarWindow !== null;
}

export async function openMainWindow(): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("open_main_window");
  return true;
}

export async function syncNativeGlobalShortcuts(bindings: ShortcutBindings): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("set_global_shortcuts", {
    shortcuts: getNativeGlobalShortcutRegistrations(bindings)
  });
  return true;
}

/**
 * Open a native Save-As dialog and write the blob to the chosen path.
 * Only available in Tauri desktop runtime. Returns true if saved, false if cancelled.
 * Falls back to browser download when not running in Tauri.
 */
export async function saveFileWithDialog(blob: Blob, defaultName: string): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  return invokeNative<boolean>("save_file_with_dialog", { bytes, defaultName });
}

/**
 * Save a temporary file and ask the OS to open it with the default associated app.
 * Intended for editing Office documents in their native editor from desktop runtime.
 */
export async function openFileWithDefaultApp(blob: Blob, defaultName: string): Promise<boolean> {
  if (isTauriNativeRuntime()) {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = Array.from(new Uint8Array(arrayBuffer));
    return invokeNative<boolean>("open_file_in_os_app", { bytes, defaultName });
  }

  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
