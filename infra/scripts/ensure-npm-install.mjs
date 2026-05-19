import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

const installMarker = path.join(root, "node_modules", ".package-lock.json");
const nodeModulesPath = path.join(root, "node_modules");
const lockfilePath = path.join(root, "package-lock.json");
const lockfileMtime = statMtimeMs(lockfilePath);
const installMarkerMtime = statMtimeMs(installMarker);

if (fs.existsSync(nodeModulesPath) && installMarkerMtime >= lockfileMtime) {
  console.log("[OK] npm dependencies are up to date.");
  process.exit(0);
}

console.log("Installing root dependencies...");
const result = spawnSync("npm install", {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

if (result.error) {
  console.error(`[ERROR] npm install failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
