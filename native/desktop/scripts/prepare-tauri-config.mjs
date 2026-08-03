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

const variants = {
  tasks: {
    productName: "Workbench Tasks",
    identifier: "com.workbench.desktop.tasks",
    windowTitle: "Workbench Tasks",
    iconDir: "icons/tasks"
  },
  notes: {
    productName: "Workbench Notes",
    identifier: "com.workbench.desktop.notes",
    windowTitle: "Workbench Notes",
    iconDir: "icons/notes"
  },
  artifacts: {
    productName: "Workbench Artifacts",
    identifier: "com.workbench.desktop.artifacts",
    windowTitle: "Workbench Artifacts",
    iconDir: "icons/artifacts"
  }
};

const appVariant = process.env.NATIVE_APP_VARIANT?.trim() ?? "";
if (appVariant !== "" && !Object.prototype.hasOwnProperty.call(variants, appVariant)) {
  throw new Error(
    `Unknown NATIVE_APP_VARIANT: ${appVariant}. Valid variants: tasks, notes, artifacts, or unset/empty for main.`
  );
}

const appConfig = appVariant === ""
  ? {
      productName: required("NATIVE_APP_NAME"),
      identifier: required("NATIVE_APP_IDENTIFIER"),
      windowTitle: required("NATIVE_WINDOW_TITLE"),
      iconDir: "icons"
    }
  : variants[appVariant];

function resolveManifestPath(manifestPath, value) {
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(manifestPath), value);
}

/**
 * Reads one build's manifest and returns the `externalBin` entries it declares.
 *
 * Two things ship beside the app now — the Node sync daemon and the Rust resident — and
 * each writes its own manifest at build time so this file never has to know the target
 * triple or the output layout.
 */
function manifestExternalBins(manifestPath, label) {
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
      throw new Error(`${label} manifest points to a missing artifact: ${artifactPath}`);
    }
  }

  if (externalBins.length > 0) {
    console.log(`Using ${label} manifest ${manifestPath}`);
  }

  return externalBins.map((item) => item.trim());
}

function sidecarManifestExternalBins() {
  return manifestExternalBins(
    path.resolve(desktopRoot, "../sync-daemon/dist/tauri-sidecar/sidecar-manifest.json"),
    "sync daemon sidecar"
  );
}

function residentManifestExternalBins() {
  return manifestExternalBins(
    path.resolve(desktopRoot, "../resident/dist/resident-manifest.json"),
    "resident"
  );
}

const daemonExternalBins = envHas("WORKBENCH_DAEMON_EXTERNAL_BIN")
  ? optionalList("WORKBENCH_DAEMON_EXTERNAL_BIN")
  : sidecarManifestExternalBins();
const residentExternalBins = residentManifestExternalBins();
const externalBins = [...daemonExternalBins, ...residentExternalBins];
const bundleActive = optionalBoolean("NATIVE_BUNDLE_ACTIVE", externalBins.length > 0 ? true : false);

const config = {
  $schema: "https://schema.tauri.app/config/2",
  productName: appConfig.productName,
  version: "0.1.0",
  identifier: appConfig.identifier,
  build: {
    beforeDevCommand: "",
    beforeBuildCommand: "",
    devUrl: required("NATIVE_DEV_URL"),
    frontendDist: required("NATIVE_FRONTEND_DIST")
  },
  app: {
    // Declare no windows here. Every window is created in Rust (window.rs) so it can carry
    // the shared WebView2 data directory. A window declared in this config would be created
    // first on the per-identifier default path, and because a process can only use ONE user
    // data folder, the next window would fail to build and the app would exit on startup.
    windows: []
  },
  bundle: {
    active: bundleActive,
    // Paths are relative to src-tauri/. The bundler needs an explicit list:
    // without it there is no .ico to embed and `tauri build` fails at bundle time.
    icon: [
      `${appConfig.iconDir}/32x32.png`,
      `${appConfig.iconDir}/128x128.png`,
      `${appConfig.iconDir}/128x128@2x.png`,
      `${appConfig.iconDir}/icon.icns`,
      `${appConfig.iconDir}/icon.ico`
    ]
  }
};

if (externalBins.length > 0) {
  config.bundle.externalBin = externalBins;
}

if (appVariant === "") {
  // Only the main build creates an installer; it uses the vendored components-page template.
  config.bundle.windows = {
    nsis: {
      template: "nsis/installer.nsi"
    }
  };
}

// Validated for the sake of the .env contract even though window.rs owns the real geometry.
if (
  !Number.isFinite(Number(required("NATIVE_WINDOW_WIDTH"))) ||
  !Number.isFinite(Number(required("NATIVE_WINDOW_HEIGHT")))
) {
  throw new Error("NATIVE_WINDOW_WIDTH and NATIVE_WINDOW_HEIGHT must be numeric values.");
}

const output = path.resolve(desktopRoot, "src-tauri/tauri.conf.json");
fs.writeFileSync(output, JSON.stringify(config, null, 2), "utf8");
console.log(`Generated ${output}`);
