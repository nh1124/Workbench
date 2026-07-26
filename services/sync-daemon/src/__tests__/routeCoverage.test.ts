import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

const uiApiSource = readFileSync(path.join(repoRoot, "ui/src/lib/api.ts"), "utf8");
const uiServicesSource = readFileSync(path.join(repoRoot, "ui/src/config/services.ts"), "utf8");
// Read the daemon's whole non-test source rather than index.ts alone, so the
// route contract keeps holding as index.ts is split into modules. Same reason
// as coreHttpSource below.
function readDaemonSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : readDaemonSources(full);
    return entry.name.endsWith(".ts") ? [readFileSync(full, "utf8")] : [];
  });
}
const daemonSource = readDaemonSources(path.join(repoRoot, "services/sync-daemon/src")).join("\n");
const daemonMcpSource = readFileSync(path.join(repoRoot, "services/sync-daemon/src/mcpServer.ts"), "utf8");
const daemonProjectContextExportSource = readFileSync(path.join(repoRoot, "services/sync-daemon/src/projectContextExport.ts"), "utf8");
// Core's routes were split out of httpServer.ts into routes/*.ts. The contract
// this test guards is "Core exposes these routes", not which file holds them,
// so read the whole HTTP surface rather than a single file.
const coreHttpSource = [
  path.join(repoRoot, "services/workbench-core/src/httpServer.ts"),
  ...readdirSync(path.join(repoRoot, "services/workbench-core/src/routes"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(repoRoot, "services/workbench-core/src/routes", name))
]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const coreSyncStoreSource = readFileSync(path.join(repoRoot, "services/workbench-core/src/syncStore.ts"), "utf8");

function assertIncludes(source: string, needle: string, label: string): void {
  assert.ok(source.includes(needle), `${label} must include: ${needle}`);
}

function assertRoutePair(label: string, uiNeedles: string[], daemonNeedles: string[]): void {
  for (const needle of uiNeedles) {
    assertIncludes(uiApiSource, needle, `${label} UI route`);
  }
  for (const needle of daemonNeedles) {
    assertIncludes(daemonSource, needle, `${label} daemon route`);
  }
}

describe("local mode route coverage", () => {
  it("keeps Tasks UI routes mirrored by the daemon loopback facade", () => {
    assertIncludes(uiServicesSource, "export type WorkbenchLocalRoutingMode = \"core\" | \"auto\" | \"local\";", "Local routing modes");
    assertIncludes(uiServicesSource, "export function resolveWorkbenchLocalRoutingTarget", "Local routing target resolver");
    assertIncludes(uiServicesSource, "if (mode === \"auto\" && !online) return \"local\";", "Auto offline routing rule");
    assertIncludes(uiApiSource, "function tasksFacadeEnabled(path: string, options?: RequestInit): boolean", "Tasks local routing gate");
    assertIncludes(uiApiSource, "async function fetchTasksFacadeJson<T>", "Tasks facade fetch helper");
    assertIncludes(uiApiSource, "requestLocalDaemonJson<T>(path, requestOptions)", "Tasks daemon JSON fetch path");
    assertIncludes(uiApiSource, "fetchJson<T>(corePath(path), requestOptions, {", "Shared Core fallback fetch path");
    assertIncludes(uiApiSource, "if (autoRoutingCanFallbackToLocal(error, path, requestOptions))", "Tasks Auto connection fallback path");

    const sharedDomainListRoute = "const remoteDomainListMatch = url.pathname.match(/^\\/api\\/(projects|notes|tasks)$/);";
    const sharedDomainItemRoute = "const remoteDomainItemMatch = url.pathname.match(/^\\/api\\/(projects|notes|tasks)\\/([^/]+)$/);";

    const routePairs: Array<{ label: string; ui: string[]; daemon: string[] }> = [
      {
        label: "task list",
        ui: ["fetchTasksFacadeJson<Task[]>(`/api/tasks"],
        daemon: [sharedDomainListRoute]
      },
      {
        label: "task item read/update/delete",
        ui: ["/api/tasks/${encodeURIComponent(id)}"],
        daemon: [
          sharedDomainItemRoute,
          "remoteDomainItemMatch[1] === \"tasks\" && req.method === \"PATCH\"",
          "remoteDomainItemMatch[1] === \"tasks\" && req.method === \"DELETE\"",
          "if (remoteDomainItemMatch && req.method === \"GET\")"
        ]
      },
      {
        label: "task create",
        ui: ["fetchTasksFacadeJson<Task>(\"/api/tasks\""],
        daemon: ["if (url.pathname === \"/api/tasks\" && req.method === \"POST\")"]
      },
      {
        label: "task projects and pins",
        ui: ["/api/tasks/projects", "/api/tasks/pins", "/api/tasks/${encodeURIComponent(id)}/pin"],
        daemon: [
          "url.pathname === \"/api/tasks/projects\"",
          "url.pathname === \"/api/tasks/pins\"",
          "const taskPinMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/pin$/);"
        ]
      },
      {
        label: "today routes",
        ui: ["/api/tasks/today?date=", "\"/api/tasks/today\"", "/api/tasks/today/${encodeURIComponent(taskId)}"],
        daemon: [
          "url.pathname === \"/api/tasks/today\"",
          "const taskTodayDeleteMatch = url.pathname.match(/^\\/api\\/tasks\\/today\\/([^/]+)$/);"
        ]
      },
      {
        label: "schedule routes",
        ui: [
          "/api/tasks/schedule-calendar?",
          "/api/tasks/schedule?${params.toString()}",
          "/api/tasks/schedule-items/${scheduleId}",
          "/api/tasks/${encodeURIComponent(taskId)}/schedule-items"
        ],
        daemon: [
          "url.pathname === \"/api/tasks/schedule-calendar\"",
          "url.pathname === \"/api/tasks/schedule\"",
          "const taskScheduleItemMatch = url.pathname.match(/^\\/api\\/tasks\\/schedule-items\\/(-?\\d+)$/);",
          "const taskScheduleItemsMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/schedule-items$/);"
        ]
      },
      {
        label: "occurrence routes",
        ui: [
          "/api/tasks/${encodeURIComponent(id)}/occurrences/complete",
          "/api/tasks/${encodeURIComponent(id)}/occurrences/move",
          "/api/tasks/${encodeURIComponent(id)}/occurrences/skip-exception"
        ],
        daemon: [
          "const taskOccurrenceMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/occurrences\\/(complete|move|skip-exception)$/);"
        ]
      },
      {
        label: "subtask routes",
        ui: [
          "/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks",
          "/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks/${encodeURIComponent(subtaskId)}"
        ],
        daemon: [
          "const taskSubtasksListMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/occurrences\\/([^/]+)\\/subtasks$/);",
          "const taskSubtaskItemMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/occurrences\\/([^/]+)\\/subtasks\\/([^/]+)$/);"
        ]
      },
      {
        label: "attachment routes",
        ui: [
          "/api/tasks/${encodeURIComponent(taskId)}/attachments",
          "/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download",
          "/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}"
        ],
        daemon: [
          "const taskAttachmentsMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/attachments$/);",
          "const taskAttachmentDownloadMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/attachments\\/([^/]+)\\/download$/);",
          "const taskAttachmentItemMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/attachments\\/([^/]+)$/);"
        ]
      },
      {
        label: "task import export and history",
        ui: ["/api/tasks/export", "/api/tasks/import", "/api/tasks/${encodeURIComponent(id)}/history"],
        daemon: [
          "url.pathname === \"/api/tasks/export\"",
          "url.pathname === \"/api/tasks/import\"",
          "const taskHistoryMatch = url.pathname.match(/^\\/api\\/tasks\\/([^/]+)\\/history$/);"
        ]
      }
    ];

    for (const routePair of routePairs) {
      assertRoutePair(routePair.label, routePair.ui, routePair.daemon);
    }
  });

  it("keeps Core sync endpoints, event store, blob ids, and checksum contracts wired", () => {
    for (const route of [
      "app.get(\"/api/sync/snapshot\"",
      "app.get(\"/api/sync/pull\"",
      "app.get(\"/api/sync/blobs/:blobId\"",
      "app.put(\"/api/sync/blobs/:blobId\"",
      "app.post(\"/api/sync/push\""
    ]) {
      assertIncludes(coreHttpSource, route, "Core sync route");
    }

    for (const blobContract of [
      "blobId.startsWith(\"artifact:\")",
      "blobId.startsWith(\"task-attachment:\")",
      "res.setHeader(\"X-Workbench-Content-Checksum\", sha256Checksum(buffer));",
      "code: \"SYNC_BLOB_CHECKSUM_MISMATCH\""
    ]) {
      assertIncludes(coreHttpSource, blobContract, "Core sync blob contract");
    }

    for (const storeContract of [
      "INSERT INTO sync_resource_versions",
      "INSERT INTO sync_events",
      "deleted_at",
      "export async function listSyncEvents",
      "export async function listSyncResourceVersions"
    ]) {
      assertIncludes(coreSyncStoreSource, storeContract, "Core sync event store");
    }
  });

  it("keeps the daemon Project context export route and MCP tool explicit", () => {
    assertIncludes(daemonSource, "url.pathname === \"/api/project-context/exports\" && req.method === \"POST\"", "Project context export loopback route");
    assertIncludes(daemonProjectContextExportSource, "/api/sync/projects/${encodeURIComponent(projectId)}/context-export", "Project context export live Core route");
    assertIncludes(daemonSource, "state.identity", "Project context export local identity");
    assertIncludes(daemonMcpSource, "\"workbench.local.project_context.export\"", "Project context export MCP tool");
    assertIncludes(daemonMcpSource, "never imports from disk or uses the daemon's local cache", "Project context export MCP warning");
    assertIncludes(daemonMcpSource, "\"workbench.local.artifact.open\"", "Artifact open MCP tool");
    assertIncludes(daemonMcpSource, "ARTIFACT_ITEM_ID_PATTERN", "Artifact open MCP input validation");
    assertIncludes(daemonSource, "url.pathname === \"/capture/status\" && req.method === \"GET\"", "Capture status loopback route");
    assertIncludes(daemonSource, "url.pathname === \"/capture/enable\" && req.method === \"POST\"", "Capture enable loopback route");
    assertIncludes(daemonSource, "url.pathname === \"/capture/disable\" && req.method === \"POST\"", "Capture disable loopback route");
    assertIncludes(daemonSource, "url.pathname === \"/capture/config\" && req.method === \"GET\"", "Capture config loopback route");
    assertIncludes(daemonSource, "url.pathname === \"/capture/config\" && req.method === \"PUT\"", "Capture config update loopback route");
    assertIncludes(daemonSource, "url.pathname === \"/capture/summarize\" && req.method === \"POST\"", "Capture summarize loopback route");
    assertIncludes(daemonSource, "capture: state.capture?.status()", "Daemon status capture summary");
    assertIncludes(daemonMcpSource, "\"workbench.capture.status\"", "Capture status MCP tool");
  });
});
