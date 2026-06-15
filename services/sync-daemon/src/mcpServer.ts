import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  listConflicts,
  openManifestStore,
  readManifestFromStore,
  resolveConflict,
  writeManifestDebugSnapshot,
  type ConflictResolution,
  type ConflictStatus
} from "./manifestStore.js";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

const syncRoot = resolve(env("WORKBENCH_SYNC_ROOT") ?? join(homedir(), "WorkbenchSync"));
const downloadsDir = resolve(env("WORKBENCH_DOWNLOADS_DIR") ?? join(homedir(), "Downloads"));
const coreUrl = (env("WORKBENCH_CORE_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
const manifestStore = openManifestStore(syncRoot);

function asText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function readIdentity(): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(join(syncRoot, ".workbench", "client-identity.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const server = new McpServer({
  name: "workbench-sync-daemon-mcp",
  version: "0.1.0"
});

server.registerTool(
  "workbench.local.clients.current",
  {
    title: "Current Workbench Local Client",
    description: "Return the current daemon local client identity and configured local folders.",
    inputSchema: {}
  },
  async () => asText({
    identity: await readIdentity(),
    host: hostname(),
    coreUrl,
    syncRoot,
    downloadsDir
  })
);

server.registerTool(
  "workbench.sync.status",
  {
    title: "Workbench Sync Status",
    description: "Read local daemon manifest and summarize sync state.",
    inputSchema: {}
  },
  async () => {
    const manifestPath = join(syncRoot, ".workbench", "manifest.json");
    const manifestDbPath = join(syncRoot, ".workbench", "manifest.sqlite");
    return asText({
      coreUrl,
      syncRoot,
      downloadsDir,
      manifestDbPath,
      manifestSnapshotPath: manifestPath,
      manifest: readManifestFromStore(manifestStore)
    });
  }
);

server.registerTool(
  "workbench.sync.conflicts.list",
  {
    title: "List Workbench Sync Conflicts",
    description: "List local sync conflicts recorded by the daemon manifest database.",
    inputSchema: {
      status: z.enum(["open", "resolved", "ignored", "all"]).optional(),
      limit: z.number().int().positive().max(200).optional()
    }
  },
  async ({ status, limit }) => asText({
    syncRoot,
    manifestDbPath: join(syncRoot, ".workbench", "manifest.sqlite"),
    items: listConflicts(manifestStore, {
      status: (status ?? "open") as ConflictStatus | "all",
      limit: limit ?? 50
    })
  })
);

server.registerTool(
  "workbench.sync.conflicts.resolve",
  {
    title: "Resolve Workbench Sync Conflict",
    description: "Resolve a local sync conflict. retry requeues the failed outbox item, ignore clears it, and close only closes the conflict record.",
    inputSchema: {
      id: z.string().min(1),
      resolution: z.enum(["retry", "ignore", "close"]),
      note: z.string().optional()
    }
  },
  async ({ id, resolution, note }) => {
    const conflict = resolveConflict(manifestStore, id, resolution as ConflictResolution, note);
    if (!conflict) {
      throw new Error("Conflict not found.");
    }
    await writeManifestDebugSnapshot(syncRoot, manifestStore);
    return asText({
      status: "resolved",
      resolution,
      conflict,
      nextStep: resolution === "retry" ? "The running daemon will retry this outbox item on its next tick." : undefined
    });
  }
);

server.registerTool(
  "workbench.local.path.resolve",
  {
    title: "Resolve Workbench Local Path",
    description: "Resolve a safe path inside the Workbench sync folder or configured downloads directory.",
    inputSchema: {
      target: z.enum(["sync-folder", "downloads"]).optional(),
      relativePath: z.string().optional()
    }
  },
  async ({ target, relativePath }) => {
    const root = target === "downloads" ? downloadsDir : syncRoot;
    const resolved = resolve(root, relativePath ?? ".");
    const rootWithSep = root.endsWith("\\") || root.endsWith("/") ? root : `${root}${process.platform === "win32" ? "\\" : "/"}`;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new Error("Resolved path escapes the allowed Workbench local root.");
    }
    return asText({ path: resolved });
  }
);

server.registerTool(
  "workbench.local.materialize",
  {
    title: "Materialize Workbench Resource",
    description: "Create a local materialization request scaffold. Cloud job creation is handled by HTTPS MCP tools.",
    inputSchema: {
      id: z.string().min(1),
      domain: z.string().optional()
    }
  },
  async ({ id, domain }) => asText({
    status: "not_queued",
    message: "Use the cloud MCP artifacts.download.to_client tool to create a daemon-pulled materialization job.",
    id,
    domain
  })
);

server.registerTool(
  "workbench.local.import",
  {
    title: "Import Local File Into Workbench",
    description: "Validate that a local path is inside an allowed Workbench local folder. Upload queueing is a later sync phase.",
    inputSchema: {
      path: z.string().min(1)
    }
  },
  async ({ path }) => {
    const resolved = resolve(path);
    const syncRootWithSep = syncRoot.endsWith("\\") || syncRoot.endsWith("/") ? syncRoot : `${syncRoot}${process.platform === "win32" ? "\\" : "/"}`;
    if (resolved !== syncRoot && !resolved.startsWith(syncRootWithSep)) {
      throw new Error("Only files inside the Workbench sync folder can be imported by this daemon MCP tool.");
    }
    await fs.access(resolved);
    return asText({
      status: "validated",
      path: resolved
    });
  }
);

server.registerTool(
  "workbench.local.job.claim",
  {
    title: "Claim Local Workbench Jobs",
    description: "Ask the running daemon loop to claim jobs on its next polling tick.",
    inputSchema: {}
  },
  async () => asText({
    status: "daemon_polling",
    message: "The sync daemon claims jobs on its configured interval."
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
