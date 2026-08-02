import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeSessionStorage, syncNativeLocalDaemonToken } from "./lib/api";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Both are best-effort and must not hold up the first paint any longer than they already
// do: without the daemon token every local request 401s, but a machine that has never run
// the daemon simply has no token to fetch.
void Promise.allSettled([initializeSessionStorage(), syncNativeLocalDaemonToken()])
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

