import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const host = env.UI_DEV_HOST;
  const portRaw = env.UI_DEV_PORT;

  if (!host) {
    throw new Error("Missing required environment variable: UI_DEV_HOST");
  }
  if (!portRaw || Number.isNaN(Number(portRaw))) {
    throw new Error("Missing or invalid required environment variable: UI_DEV_PORT");
  }

  // In production Core serves ui/dist, so the browser talks to a single origin
  // and the HttpOnly refresh cookie just works. Dev splits UI and Core across
  // ports, which would drop that cookie, so proxy Core's routes through Vite.
  // Only takes effect when VITE_WORKBENCH_CORE_URL points at this dev server;
  // pointing it straight at Core keeps the previous cross-origin behaviour.
  const coreProxyTarget = env.VITE_WORKBENCH_CORE_PROXY_TARGET || "http://127.0.0.1:4100";
  const corePrefixes = [
    "/api",
    "/auth",
    "/accounts",
    "/oauth",
    "/authorize",
    "/integrations",
    "/health",
    "/.well-known",
    "/mcp"
  ];

  return {
    plugins: [react()],
    server: {
      host,
      port: Number(portRaw),
      proxy: Object.fromEntries(
        corePrefixes.map((prefix) => [prefix, { target: coreProxyTarget, changeOrigin: true }])
      ),
      // Cloudflare quick tunnels mint a new random subdomain on every restart
      // (see docs/imple/workbench-analyser-migration-runbook.md and CLAUDE.md
      // notes on the ephemeral trycloudflare.com URL); allow the whole suffix
      // instead of pinning one hostname that will go stale on the next tunnel.
      allowedHosts: [".trycloudflare.com"]
    }
  };
});
