import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");

loadEnv({ path: path.resolve(desktopRoot, ".env"), override: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean-like value.`);
}

function optionalList(name) {
  const value = process.env[name];
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

const daemonExternalBins = optionalList("WORKBENCH_DAEMON_EXTERNAL_BIN");
const bundleActive = optionalBoolean("NATIVE_BUNDLE_ACTIVE", daemonExternalBins.length > 0 ? true : false);

const config = {
  $schema: "https://schema.tauri.app/config/2",
  productName: required("NATIVE_APP_NAME"),
  version: "0.1.0",
  identifier: required("NATIVE_APP_IDENTIFIER"),
  build: {
    beforeDevCommand: "",
    beforeBuildCommand: "",
    devUrl: required("NATIVE_DEV_URL"),
    frontendDist: required("NATIVE_FRONTEND_DIST")
  },
  app: {
    windows: [
      {
        title: required("NATIVE_WINDOW_TITLE"),
        width: Number(required("NATIVE_WINDOW_WIDTH")),
        height: Number(required("NATIVE_WINDOW_HEIGHT")),
        resizable: true,
        fullscreen: false
      }
    ]
  },
  bundle: {
    active: bundleActive
  }
};

if (daemonExternalBins.length > 0) {
  config.bundle.externalBin = daemonExternalBins;
}

if (!Number.isFinite(config.app.windows[0].width) || !Number.isFinite(config.app.windows[0].height)) {
  throw new Error("NATIVE_WINDOW_WIDTH and NATIVE_WINDOW_HEIGHT must be numeric values.");
}

const output = path.resolve(desktopRoot, "src-tauri/tauri.conf.json");
fs.writeFileSync(output, JSON.stringify(config, null, 2), "utf8");
console.log(`Generated ${output}`);
