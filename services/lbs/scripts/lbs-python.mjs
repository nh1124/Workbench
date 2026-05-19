import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDir, "..");
const requirementsPath = path.join(serviceRoot, "requirements.txt");
const defaultVenvDir = process.platform === "win32" ? ".venv-win32" : ".venv";
const venvDir = path.resolve(serviceRoot, process.env.LBS_VENV_DIR || defaultVenvDir);
const binDir = process.platform === "win32" ? "Scripts" : "bin";
const venvPython = path.join(
  venvDir,
  binDir,
  process.platform === "win32" ? "python.exe" : "python",
);
const stampDir = path.join(venvDir, ".workbench");
const stampPath = path.join(stampDir, "requirements.sha256");

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: serviceRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, {
    cwd: serviceRoot,
    stdio: "ignore",
    shell: false,
  });
  return !result.error && result.status === 0;
}

function findPython() {
  if (process.env.LBS_PYTHON) {
    return { command: process.env.LBS_PYTHON, args: [] };
  }

  const candidates =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3"] },
          { command: "python", args: [] },
          { command: "python3", args: [] },
        ]
      : [
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];

  for (const candidate of candidates) {
    if (commandWorks(candidate.command, [...candidate.args, "--version"])) {
      return candidate;
    }
  }

  console.error(
    "[LBS] Python 3 was not found. Install Python 3 or set LBS_PYTHON to the interpreter path.",
  );
  process.exit(1);
}

function requirementsHash() {
  return createHash("sha256").update(readFileSync(requirementsPath)).digest("hex");
}

function hasUsableVenv(expectedHash) {
  if (!existsSync(venvPython) || !existsSync(stampPath)) {
    return false;
  }
  if (readFileSync(stampPath, "utf8").trim() !== expectedHash) {
    return false;
  }
  return commandWorks(venvPython, ["-c", "import uvicorn"]);
}

function ensureVenv() {
  const expectedHash = requirementsHash();
  if (hasUsableVenv(expectedHash)) {
    return;
  }

  if (!existsSync(venvPython)) {
    const python = findPython();
    console.log(`[LBS] Creating Python virtual environment at ${venvDir}`);
    runChecked(python.command, [...python.args, "-m", "venv", venvDir]);
  }

  console.log("[LBS] Installing Python dependencies from requirements.txt");
  runChecked(venvPython, ["-m", "pip", "install", "-r", requirementsPath]);
  mkdirSync(stampDir, { recursive: true });
  writeFileSync(stampPath, `${expectedHash}\n`);
}

function runPython(args) {
  if (args.length === 0) {
    console.error("[LBS] No Python command was provided.");
    process.exit(1);
  }

  const child = spawn(venvPython, args, {
    cwd: serviceRoot,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      PATH: `${path.join(venvDir, binDir)}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("error", (error) => {
    console.error(`[LBS] Failed to start Python command: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

ensureVenv();
runPython(process.argv.slice(2));
