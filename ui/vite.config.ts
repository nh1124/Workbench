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

  return {
    plugins: [react()],
    server: {
      host,
      port: Number(portRaw),
      // Cloudflare quick tunnels mint a new random subdomain on every restart
      // (see docs/imple/workbench-analyser-migration-runbook.md and CLAUDE.md
      // notes on the ephemeral trycloudflare.com URL); allow the whole suffix
      // instead of pinning one hostname that will go stale on the next tunnel.
      allowedHosts: [".trycloudflare.com"]
    }
  };
});
