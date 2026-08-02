import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const prepareConfigScript = path.resolve(scriptDir, "prepare-tauri-config.mjs");
const releaseDir = path.resolve(scriptDir, "../src-tauri/target/release");
const mainBinary = path.resolve(releaseDir, "workbench-native.exe");
const variantsDir = path.resolve(releaseDir, "variants");

/**
 * The sync daemon outlives the app that spawned it, so one started from `target/release`
 * keeps holding `workbench-sync-daemon.exe` there. `tauri build` copies the sidecar over
 * that path and dies with an unexplained `PermissionDenied` panic from its build script.
 * Fail early with something actionable instead.
 */
function checkSidecarIsWritable() {
  if (process.platform !== "win32") return;

  const sidecar = path.resolve(
    scriptDir,
    "../src-tauri/target/release/workbench-sync-daemon.exe"
  );
  if (!fs.existsSync(sidecar)) return;

  let handle;
  try {
    handle = fs.openSync(sidecar, "r+");
  } catch (error) {
    if (error.code !== "EBUSY" && error.code !== "EPERM" && error.code !== "EACCES") return;
    console.error(
      [
        `Cannot overwrite ${sidecar}.`,
        "A sync daemon started from target/release is still running and holds it.",
        "Stop that process (it survives closing the app), then run this again:",
        '  powershell -Command "Get-Process workbench-sync-daemon | Stop-Process"'
      ].join("\n")
    );
    process.exit(1);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

const variants = [
  { name: "tasks", executable: "Workbench Tasks.exe" },
  { name: "notes", executable: "Workbench Notes.exe" },
  { name: "artifacts", executable: "Workbench Artifacts.exe" }
];
const dryRun = process.argv.includes("--dry-run");

// A dry run only prints the pipeline, so a locked sidecar must not stop it.
if (!dryRun) {
  checkSidecarIsWritable();
}

const npmExecPath = process.env.npm_execpath;
const useNpmExecPath = typeof npmExecPath === "string" && npmExecPath.trim() !== "";
const command = useNpmExecPath
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
// Selected by package name, not path: `--workspace native/desktop` also matches the UI
// workspace nested inside it, and npm would then run this script there too.
const baseCommandArgs = useNpmExecPath
  ? [npmExecPath, "run", "tauri:build", "--workspace", "workbench-native-desktop"]
  : ["run", "tauri:build", "--workspace", "workbench-native-desktop"];
const useShell = !useNpmExecPath && process.platform === "win32";

function displayCommandPart(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function commandArgs(tauriArgs) {
  return [...baseCommandArgs, "--", ...tauriArgs];
}

function runBuild(variant, tauriArgs) {
  const label = variant === "" ? "main" : variant;
  const args = commandArgs(tauriArgs);
  const displayedCommand = [command, ...args].map(displayCommandPart).join(" ");
  console.log(`Starting native build: ${label}`);
  console.log(`  NATIVE_APP_VARIANT=${JSON.stringify(variant)}`);

  if (dryRun) {
    console.log(`  Would run: ${displayedCommand}`);
    return;
  }

  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      NATIVE_APP_VARIANT: variant
    },
    shell: useShell
  });

  if (result.error) {
    throw new Error(`Native build failed for ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const error = new Error(
      `Native build failed for ${label} with exit code ${result.status ?? 1}.`
    );
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function clearStaleInstallers() {
  const bundleOutputs = [
    path.resolve(releaseDir, "bundle/nsis"),
    path.resolve(releaseDir, "bundle/msi")
  ];

  for (const outputDir of bundleOutputs) {
    if (dryRun) {
      console.log(`Would clear stale installer artifacts from ${outputDir}`);
      continue;
    }
    if (!fs.existsSync(outputDir)) continue;
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith("-setup.exe") || entry.name.endsWith(".msi"))) {
        fs.rmSync(path.resolve(outputDir, entry.name));
      }
    }
  }
}

function restoreMainConfig() {
  console.log("Restoring the main tauri config");
  const restore = spawnSync(process.execPath, [prepareConfigScript], {
    stdio: "inherit",
    env: { ...process.env, NATIVE_APP_VARIANT: "" }
  });
  if (restore.status !== 0) {
    const error = new Error("Failed to restore the main tauri config.");
    error.exitCode = restore.status ?? 1;
    throw error;
  }
}

let buildError;
try {
  clearStaleInstallers();

  if (!dryRun) {
    fs.mkdirSync(variantsDir, { recursive: true });
  }

  for (const variant of variants) {
    runBuild(variant.name, ["--no-bundle"]);
    const stagedBinary = path.resolve(variantsDir, variant.executable);
    if (dryRun) {
      console.log(`  Would copy: ${mainBinary} -> ${stagedBinary}`);
    } else {
      fs.copyFileSync(mainBinary, stagedBinary);
      console.log(`Staged ${stagedBinary}`);
    }
  }

  runBuild("", ["--bundles", "nsis"]);
} catch (error) {
  buildError = error;
} finally {
  if (!dryRun) {
    try {
      restoreMainConfig();
    } catch (error) {
      buildError ??= error;
    }
  }
}

if (buildError) {
  console.error(buildError.message);
  process.exitCode = buildError.exitCode ?? 1;
}
