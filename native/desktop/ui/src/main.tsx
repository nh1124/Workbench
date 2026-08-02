import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeSessionStorage, syncNativeLocalDaemonToken } from "./lib/api";
import "./styles.css";

/**
 * Sends webview failures to the app's log file.
 *
 * Installed before anything else runs: a page that throws on its way to the first render
 * leaves a blank window and no trace, which looks identical to a window that never loaded
 * at all. That ambiguity is what made a blank Quick Note window take several rounds to
 * pin down.
 */
function reportToAppLog(message: string) {
  try {
    window.__TAURI_INTERNALS__?.invoke("log_ui_error", { message });
  } catch {
    // Reporting a failure must never become one.
  }
}

window.addEventListener("error", (event) => {
  reportToAppLog(`window.onerror: ${event.message} @ ${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  reportToAppLog(`unhandledrejection: ${String(event.reason)}`);
});
reportToAppLog(
  `boot url=${window.location.href} quickNote=${Boolean(window.__WORKBENCH_QUICK_NOTE__)} variant=${window.__WORKBENCH_VARIANT__ ?? "none"}`
);

const container = document.getElementById("root");
if (!container) {
  reportToAppLog("root element missing");
  throw new Error("Root element not found");
}
// Narrowed here so the deferred paint below sees a non-null container.
const rootElement: HTMLElement = container;

// Deliberately not awaited: nothing on screen needs the daemon token, and the first paint
// must not be hostage to an IPC call. Gating render on this produced a window that never
// drew at all when the call did not settle.
void syncNativeLocalDaemonToken();

/**
 * How long the session restore may hold up the first paint.
 *
 * Waiting is worth it — the app renders differently signed in — but not unconditionally.
 * A window that paints nothing is indistinguishable from a hung one, and that is exactly
 * what a stalled IPC call produced. Past this point the app draws signed-out and corrects
 * itself when the session lands.
 */
const SESSION_RESTORE_PAINT_BUDGET_MS = 3000;

let painted = false;
function paint() {
  if (painted) return;
  painted = true;
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

setTimeout(paint, SESSION_RESTORE_PAINT_BUDGET_MS);

void initializeSessionStorage()
  .catch(() => {
    // If secure session loading fails, the app still renders and user can re-authenticate.
  })
  .finally(paint);

