import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const residentRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(residentRoot, "../..");
const srcTauriRoot = path.resolve(repoRoot, "native/desktop/src-tauri");
const outputDir = path.resolve(residentRoot, "dist");
const manifestPath = path.resolve(outputDir, "resident-manifest.json");

const residentName = "workbench-resident";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? residentRoot,
    env: process.env,
    stdio: "inherit",
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runCaptured(command, args) {
  const result = spawnSync(command, args, {
    cwd: residentRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function hostTargetTriple() {
  const output = runCaptured("rustc", ["-Vv"]);
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error("Unable to determine the Rust host target triple from `rustc -Vv`.");
  }
  return match[1].trim();
}

function executableExtension(targetTriple) {
  return targetTriple.includes("windows") ? ".exe" : "";
}

function toTauriPath(value) {
  return value.split(path.sep).join("/");
}

/**
 * The resident locks its own executable while it runs, and it is designed to keep running
 * — so a plain rebuild during development fails with a link error that says nothing about
 * why. Say what it is instead.
 */
function checkOutputIsWritable(artifactPath) {
  if (process.platform !== "win32" || !fs.existsSync(artifactPath)) return;
  let handle;
  try {
    handle = fs.openSync(artifactPath, "r+");
  } catch (error) {
    if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) return;
    console.error(
      [
        `Cannot overwrite ${artifactPath}.`,
        "A resident started from this build is still running and holds it.",
        "Quit it from the tray, or:",
        '  powershell -Command "Get-Process workbench-resident | Stop-Process"'
      ].join("\n")
    );
    process.exit(1);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

const targetTriple = process.env.TAURI_TARGET_TRIPLE?.trim() || process.env.CARGO_BUILD_TARGET?.trim() || hostTargetTriple();
const extension = executableExtension(targetTriple);
const builtBinary = path.resolve(residentRoot, "target/release", `${residentName}${extension}`);
const artifactPath = path.resolve(outputDir, `${residentName}-${targetTriple}${extension}`);
// Relative to src-tauri/, which is how Tauri resolves `externalBin`.
const externalBin = toTauriPath(path.relative(srcTauriRoot, path.resolve(outputDir, residentName)));

checkOutputIsWritable(artifactPath);

run("cargo", ["build", "--release"]);

if (!fs.existsSync(builtBinary)) {
  throw new Error(`cargo reported success but ${builtBinary} does not exist.`);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(builtBinary, artifactPath);
if (process.platform !== "win32") {
  fs.chmodSync(artifactPath, 0o755);
}

fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      version: 1,
      residentName,
      targetTriple,
      externalBin,
      artifactPath: toTauriPath(path.relative(outputDir, artifactPath)),
      generatedAt: new Date().toISOString()
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Built resident: ${artifactPath}`);
console.log(`Tauri externalBin: ${externalBin}`);
console.log(`Wrote resident manifest: ${manifestPath}`);
