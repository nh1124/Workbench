import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");

const command = process.argv[2] ?? "help";
const args = new Set(process.argv.slice(3));

const canonicalRelative = "infra/workbench.env";
const canonicalExampleRelative = "infra/workbench.env.example";

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function writeText(relativePath, text) {
  fs.writeFileSync(path.join(root, relativePath), text);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    env[match[1]] = unquote(match[2].trim());
  }
  return env;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function valueForFile(value) {
  if (/[\s#"]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function canonicalEnv() {
  if (!exists(canonicalRelative)) {
    if (!exists(canonicalExampleRelative)) {
      throw new Error(`Missing ${canonicalExampleRelative}`);
    }
    writeText(canonicalRelative, readText(canonicalExampleRelative));
    console.log(`[CREATED] ${path.join(root, canonicalRelative)}`);
  }

  const env = {
    ...parseEnv(readText(canonicalExampleRelative)),
    ...parseEnv(readText(canonicalRelative)),
  };

  const required = [
    "WORKBENCH_HOST",
    "CORE_BIND_HOST",
    "CORE_PORT",
    "NOTES_PORT",
    "ARTIFACTS_PORT",
    "TASKS_PORT",
    "PROJECTS_PORT",
    "IMAGES_PORT",
    "MINDMAPS_PORT",
    "LBS_PORT",
    "LBS_API_PREFIX",
    "LBS_BIND_HOST",
    "UI_DEV_HOST",
    "UI_DEV_PORT",
  ];

  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing ${key} in ${canonicalRelative}`);
    }
  }

  return env;
}

function serviceUrl(env, portKey) {
  return `http://${env.WORKBENCH_HOST}:${env[portKey]}`;
}

function lbsUrl(env) {
  const prefix = env.LBS_API_PREFIX.startsWith("/") ? env.LBS_API_PREFIX : `/${env.LBS_API_PREFIX}`;
  return `${serviceUrl(env, "LBS_PORT")}${prefix}`.replace(/\/+$/, "");
}

function desiredRuntimeUpdates(env) {
  const coreUrl = serviceUrl(env, "CORE_PORT");
  const notesUrl = serviceUrl(env, "NOTES_PORT");
  const artifactsUrl = serviceUrl(env, "ARTIFACTS_PORT");
  const tasksUrl = serviceUrl(env, "TASKS_PORT");
  const projectsUrl = serviceUrl(env, "PROJECTS_PORT");
  const imagesUrl = serviceUrl(env, "IMAGES_PORT");
  const mindmapsUrl = serviceUrl(env, "MINDMAPS_PORT");
  const lbsBaseUrl = lbsUrl(env);
  const uiDevUrl = `http://${env.UI_DEV_HOST}:${env.UI_DEV_PORT}`;
  const requireCoreMutationOrigin = env.WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN || "false";
  const coreMutationToken = env.WORKBENCH_CORE_MUTATION_TOKEN || "";

  return [
    {
      file: "services/notes/.env",
      sample: "services/notes/.env.example",
      updates: {
        NOTES_SERVICE_HOST: env.WORKBENCH_HOST,
        NOTES_SERVICE_PORT: env.NOTES_PORT,
        WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN: requireCoreMutationOrigin,
        WORKBENCH_CORE_MUTATION_TOKEN: coreMutationToken,
      },
    },
    {
      file: "services/artifacts/.env",
      sample: "services/artifacts/.env.example",
      updates: {
        ARTIFACTS_SERVICE_HOST: env.WORKBENCH_HOST,
        ARTIFACTS_SERVICE_PORT: env.ARTIFACTS_PORT,
        PROJECTS_SERVICE_URL: projectsUrl,
        WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN: requireCoreMutationOrigin,
        WORKBENCH_CORE_MUTATION_TOKEN: coreMutationToken,
      },
    },
    {
      file: "services/tasks/.env",
      sample: "services/tasks/.env.example",
      updates: {
        TASKS_SERVICE_HOST: env.WORKBENCH_HOST,
        TASKS_SERVICE_PORT: env.TASKS_PORT,
        TASKS_LBS_BASE_URL: lbsBaseUrl,
        TASKS_LBS_AUTH_BASE_URL: lbsBaseUrl,
        WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN: requireCoreMutationOrigin,
        WORKBENCH_CORE_MUTATION_TOKEN: coreMutationToken,
      },
    },
    {
      file: "services/projects/.env",
      sample: "services/projects/.env.example",
      updates: {
        PROJECTS_SERVICE_HOST: env.WORKBENCH_HOST,
        PROJECTS_SERVICE_PORT: env.PROJECTS_PORT,
        WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN: requireCoreMutationOrigin,
        WORKBENCH_CORE_MUTATION_TOKEN: coreMutationToken,
      },
    },
    {
      file: "services/images/.env",
      sample: "services/images/.env.example",
      updates: {
        IMAGES_SERVICE_HOST: env.WORKBENCH_HOST,
        IMAGES_SERVICE_PORT: env.IMAGES_PORT,
      },
    },
    {
      file: "services/mindmaps/.env",
      sample: "services/mindmaps/.env.example",
      updates: {
        MINDMAPS_SERVICE_HOST: env.WORKBENCH_HOST,
        MINDMAPS_SERVICE_PORT: env.MINDMAPS_PORT,
      },
    },
    {
      file: "services/lbs/.env",
      sample: "services/lbs/.env.example",
      updates: {
        API_V1_STR: env.LBS_API_PREFIX,
        BACKEND_PORT: env.LBS_PORT,
        LBS_HOST_PORT: env.LBS_PORT,
        LBS_BIND_HOST: env.LBS_BIND_HOST,
        VITE_API_BASE_URL: lbsBaseUrl,
      },
    },
    {
      file: "services/workbench-core/.env",
      sample: "services/workbench-core/.env.example",
      updates: {
        CORE_SERVICE_HOST: env.CORE_BIND_HOST,
        CORE_SERVICE_PORT: env.CORE_PORT,
        NOTES_SERVICE_URL: notesUrl,
        ARTIFACTS_SERVICE_URL: artifactsUrl,
        TASKS_SERVICE_URL: tasksUrl,
        PROJECTS_SERVICE_URL: projectsUrl,
        IMAGES_SERVICE_URL: imagesUrl,
        MINDMAPS_SERVICE_URL: mindmapsUrl,
        LBS_SERVICE_URL: lbsBaseUrl,
        INTERNAL_API_KEY_IMAGES: "workbench-internal-images",
        INTERNAL_API_KEY_MINDMAPS: "workbench-internal-mindmaps",
        WORKBENCH_CORE_MUTATION_TOKEN: coreMutationToken,
      },
    },
    {
      file: "ui/.env",
      sample: "ui/.env.example",
      updates: {
        UI_DEV_HOST: env.UI_DEV_HOST,
        UI_DEV_PORT: env.UI_DEV_PORT,
        VITE_WORKBENCH_CORE_URL: coreUrl,
      },
    },
    {
      file: "native/desktop/.env",
      sample: "native/desktop/.env.example",
      updates: {
        NATIVE_DEV_URL: uiDevUrl,
      },
    },
  ];
}

function desiredExampleUpdates(env) {
  return [
    ...desiredRuntimeUpdates(env).map((target) => ({
      file: `${target.file}.example`,
      updates: target.updates,
    })),
    {
      file: "infra/env_samples/notes.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/notes/.env").updates,
    },
    {
      file: "infra/env_samples/artifacts.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/artifacts/.env").updates,
    },
    {
      file: "infra/env_samples/core.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/workbench-core/.env").updates,
    },
    {
      file: "infra/env_samples/projects.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/projects/.env").updates,
    },
    {
      file: "infra/env_samples/tasks.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/tasks/.env").updates,
    },
    {
      file: "infra/env_samples/images.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/images/.env").updates,
    },
    {
      file: "infra/env_samples/mindmaps.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/mindmaps/.env").updates,
    },
    {
      file: "infra/env_samples/lbs.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "services/lbs/.env").updates,
    },
    {
      file: "infra/env_samples/ui.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "ui/.env").updates,
    },
    {
      file: "infra/env_samples/native.env.example",
      updates: desiredRuntimeUpdates(env).find((target) => target.file === "native/desktop/.env").updates,
    },
  ].filter((target) => exists(target.file));
}

function ensureTargetFile(target) {
  if (exists(target.file)) return;
  if (!target.sample || !exists(target.sample)) {
    throw new Error(`Missing ${target.file} and sample ${target.sample ?? "(none)"}`);
  }
  writeText(target.file, readText(target.sample));
  console.log(`[CREATED] ${path.join(root, target.file)}`);
}

function updateEnvText(text, updates) {
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  let changed = false;

  const nextLines = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/);
    if (!match || !(match[2] in updates)) {
      return line;
    }
    seen.add(match[2]);
    const nextLine = `${match[1]}${match[2]}${match[3]}=${valueForFile(updates[match[2]])}`;
    if (nextLine !== line) changed = true;
    return nextLine;
  });

  const missing = Object.keys(updates).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    const hasTrailingEmpty = nextLines.length > 0 && nextLines[nextLines.length - 1] === "";
    if (!hasTrailingEmpty) nextLines.push("");
    nextLines.push("# Synchronized from infra/workbench.env");
    for (const key of missing) {
      nextLines.push(`${key}=${valueForFile(updates[key])}`);
    }
    changed = true;
  }

  return { text: nextLines.join("\n").replace(/\n*$/, "\n"), changed };
}

function syncTargets(targets) {
  for (const target of targets) {
    ensureTargetFile(target);
    const current = readText(target.file);
    const next = updateEnvText(current, target.updates);
    if (next.changed) {
      writeText(target.file, next.text);
      console.log(`[SYNCED] ${path.join(root, target.file)}`);
    } else {
      console.log(`[OK] ${path.join(root, target.file)}`);
    }
  }
}

function checkTargets(targets) {
  const errors = [];
  for (const target of targets) {
    if (!exists(target.file)) {
      errors.push(`${target.file}: missing`);
      continue;
    }
    const actual = parseEnv(readText(target.file));
    for (const [key, expected] of Object.entries(target.updates)) {
      if ((actual[key] ?? "") !== expected) {
        errors.push(`${target.file}: ${key}=${actual[key] ?? "(missing)"} expected ${expected}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("[ERROR] Workbench service config is out of sync with infra/workbench.env:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error("Run: node infra/scripts/workbench-env.mjs sync");
    process.exit(1);
  }

  console.log("[OK] Workbench service config is in sync.");
}

function printPorts(env) {
  if (args.has("--only-ui")) {
    console.log(env.UI_DEV_PORT);
    return;
  }

  const ports = [
    env.CORE_PORT,
    env.NOTES_PORT,
    env.ARTIFACTS_PORT,
    env.TASKS_PORT,
    env.PROJECTS_PORT,
    env.IMAGES_PORT,
    env.MINDMAPS_PORT,
    env.LBS_PORT,
  ];
  if (args.has("--ui")) {
    ports.push(env.UI_DEV_PORT);
  }
  console.log(ports.join(" "));
}

function usage() {
  console.log(`Usage:
  node infra/scripts/workbench-env.mjs sync [--examples]
  node infra/scripts/workbench-env.mjs check
  node infra/scripts/workbench-env.mjs ports [--ui|--only-ui]`);
}

try {
  const env = canonicalEnv();
  if (command === "sync") {
    syncTargets(desiredRuntimeUpdates(env));
    if (args.has("--examples")) {
      syncTargets(desiredExampleUpdates(env));
    }
  } else if (command === "check") {
    checkTargets(desiredRuntimeUpdates(env));
  } else if (command === "ports") {
    printPorts(env);
  } else {
    usage();
    process.exit(command === "help" ? 0 : 1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}
