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

function envHas(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

function resolveManifestPath(manifestPath, value) {
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(manifestPath), value);
}

function sidecarManifestExternalBins() {
  const manifestPath = path.resolve(
    desktopRoot,
    "../../services/sync-daemon/dist/tauri-sidecar/sidecar-manifest.json"
  );
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const externalBins = Array.isArray(manifest.externalBins)
    ? manifest.externalBins
    : typeof manifest.externalBin === "string"
      ? [manifest.externalBin]
      : [];

  if (externalBins.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Invalid externalBin entries in ${manifestPath}`);
  }

  if (typeof manifest.artifactPath === "string" && manifest.artifactPath.trim() !== "") {
    const artifactPath = resolveManifestPath(manifestPath, manifest.artifactPath);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Sync daemon sidecar manifest points to a missing artifact: ${artifactPath}`);
    }
  }

  if (externalBins.length > 0) {
    console.log(`Using sync daemon sidecar manifest ${manifestPath}`);
  }

  return externalBins.map((item) => item.trim());
}

const daemonExternalBins = envHas("WORKBENCH_DAEMON_EXTERNAL_BIN")
  ? optionalList("WORKBENCH_DAEMON_EXTERNAL_BIN")
  : sidecarManifestExternalBins();
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
