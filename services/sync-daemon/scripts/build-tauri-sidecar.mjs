import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const daemonRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(daemonRoot, "../..");
const desktopRoot = path.resolve(repoRoot, "native/desktop");
const srcTauriRoot = path.resolve(desktopRoot, "src-tauri");
const sourceEntry = path.resolve(daemonRoot, "src/index.ts");
const outputDir = path.resolve(daemonRoot, "dist/tauri-sidecar");
const generatedEntry = path.resolve(outputDir, "index.sidecar.ts");
const bundlePath = path.resolve(outputDir, "workbench-sync-daemon.cjs");
const seaConfigPath = path.resolve(outputDir, "sea-config.json");
const seaBlobPath = path.resolve(outputDir, "workbench-sync-daemon.blob");
const manifestPath = path.resolve(outputDir, "sidecar-manifest.json");

const defaultSidecarName = "workbench-sync-daemon";
const esbuildPackage = process.env.WORKBENCH_SIDECAR_ESBUILD_PACKAGE?.trim() || "esbuild@0.27.4";
const postjectPackage = process.env.WORKBENCH_SIDECAR_POSTJECT_PACKAGE?.trim() || "postject@1.0.0-alpha.6";
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: options.shell ?? false
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

function localBin(name) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  return path.resolve(repoRoot, "node_modules/.bin", `${name}${extension}`);
}

function runPackageBin(packageSpec, binName, args) {
  const binPath = localBin(binName);
  if (fs.existsSync(binPath)) {
    run(binPath, args, { shell: process.platform === "win32" });
    return;
  }

  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  run(npxCommand, ["--yes", packageSpec, ...args], { shell: process.platform === "win32" });
}

function getRustHostTriple() {
  const output = runCaptured("rustc", ["-Vv"]);
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error("Unable to determine Rust host target triple from `rustc -Vv`.");
  }
  return match[1].trim();
}

function targetPlatform(targetTriple) {
  if (targetTriple.includes("windows")) return "win32";
  if (targetTriple.includes("apple-darwin")) return "darwin";
  if (targetTriple.includes("linux")) return "linux";
  return process.platform;
}

function targetArch(targetTriple) {
  if (targetTriple.startsWith("x86_64-")) return "x64";
  if (targetTriple.startsWith("aarch64-")) return "arm64";
  if (targetTriple.startsWith("i686-")) return "ia32";
  return process.arch;
}

function executableExtension(targetTriple) {
  return targetTriple.includes("windows") ? ".exe" : "";
}

function toTauriPath(value) {
  return value.split(path.sep).join("/");
}

function validateSidecarName(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("WORKBENCH_DAEMON_SIDECAR_NAME may contain only letters, numbers, dots, underscores, and hyphens.");
  }
}

function validateTarget(targetTriple) {
  if (!/^[A-Za-z0-9_.-]+$/.test(targetTriple)) {
    throw new Error(`Invalid target triple: ${targetTriple}`);
  }
  const expectedPlatform = targetPlatform(targetTriple);
  const expectedArch = targetArch(targetTriple);
  if (expectedPlatform !== process.platform || expectedArch !== process.arch) {
    throw new Error(
      `Node SEA sidecars must be built on the target platform. ` +
        `Requested ${targetTriple}, but this Node runtime is ${process.platform}/${process.arch}.`
    );
  }
}

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Unable to prepare sidecar entry; expected ${label} was not found in src/index.ts.`);
  }
  return source.replace(search, replacement);
}

function makeSidecarEntry() {
  let source = fs.readFileSync(sourceEntry, "utf8");
  source = replaceOnce(
    source,
    'const __filename = fileURLToPath(import.meta.url);',
    'const __filename = process.execPath;',
    "import.meta filename initialization"
  );
  source = replaceOnce(
    source,
    '} from "./manifestStore.js";',
    '} from "../../src/manifestStore.ts";',
    "manifestStore import"
  );

  const mainBlockPattern = /if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === __filename\) \{\r?\n  await main\(\);\r?\n\}\s*$/;
  if (!mainBlockPattern.test(source)) {
    throw new Error("Unable to prepare sidecar entry; expected daemon main block was not found in src/index.ts.");
  }
  source = source.replace(
    mainBlockPattern,
    [
      "void main().catch((error) => {",
      "  console.error(error instanceof Error ? error.stack ?? error.message : String(error));",
      "  process.exitCode = 1;",
      "});",
      ""
    ].join("\n")
  );

  fs.writeFileSync(generatedEntry, source, "utf8");
}

const sidecarName = process.env.WORKBENCH_DAEMON_SIDECAR_NAME?.trim() || defaultSidecarName;
validateSidecarName(sidecarName);

const targetTriple =
  process.env.TAURI_TARGET_TRIPLE?.trim() || process.env.CARGO_BUILD_TARGET?.trim() || getRustHostTriple();
validateTarget(targetTriple);

const artifactPath = path.resolve(outputDir, `${sidecarName}-${targetTriple}${executableExtension(targetTriple)}`);
const externalBin = toTauriPath(path.relative(srcTauriRoot, path.resolve(outputDir, sidecarName)));

fs.mkdirSync(outputDir, { recursive: true });
makeSidecarEntry();

runPackageBin(esbuildPackage, "esbuild", [
  generatedEntry,
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  `--outfile=${bundlePath}`,
  "--log-level=warning"
]);

fs.writeFileSync(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: bundlePath,
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false
    },
    null,
    2
  )}\n`,
  "utf8"
);

run(process.execPath, [`--experimental-sea-config=${seaConfigPath}`]);
fs.copyFileSync(process.execPath, artifactPath);
runPackageBin(postjectPackage, "postject", [artifactPath, "NODE_SEA_BLOB", seaBlobPath, "--sentinel-fuse", seaFuse]);

if (process.platform !== "win32") {
  fs.chmodSync(artifactPath, 0o755);
}

fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      version: 1,
      sidecarName,
      targetTriple,
      externalBin,
      artifactPath: toTauriPath(path.relative(outputDir, artifactPath)),
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Built sync daemon sidecar: ${artifactPath}`);
console.log(`Tauri externalBin: ${externalBin}`);
console.log(`Wrote sidecar manifest: ${manifestPath}`);
