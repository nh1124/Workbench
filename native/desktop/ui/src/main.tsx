import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeSessionStorage, syncNativeLocalDaemonToken } from "./lib/api";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Deliberately not awaited: nothing on screen needs the daemon token, and the first paint
// must not be hostage to an IPC call. Gating render on this produced a window that never
// drew at all when the call did not settle.
void syncNativeLocalDaemonToken();

// The session is different — the app has to know whether it is signed in before it decides
// what to render, so this one is worth waiting for.
void initializeSessionStorage()
  .catch(() => {
    // If secure session loading fails, the app still renders and user can re-authenticate.
  })
  .finally(() => {
    createRoot(rootElement).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  });

