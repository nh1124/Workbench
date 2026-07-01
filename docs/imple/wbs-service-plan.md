# WBS Independent Service Plan

Status: ready for independent implementation
Last updated: 2026-06-30

This plan covers only Work Breakdown Structure. Mindmap and Logical Tree are intentionally out of scope and have their own plan.

## 1. Decisions

D-001: WBS is an independent service.

- Source-of-truth records live in `services/wbs`.
- UI and agents access it through Workbench Core only.
- The service owns plans, work packages, hierarchy, codes, dependencies, rollups, versions, and export-content generation.

D-002: No Mindmap coupling.

- Do not import Mindmap schemas.
- Do not store canvas layout, node colors, logical-tree templates, or free-form graph links.
- Do not create a shared tree-domain package in MVP.

D-003: Tasks integration is future and explicit.

- WBS must not automatically create Tasks.
- Future publish-to-Tasks is an explicit Core-orchestrated command.
- WBS service records mapping/idempotency state, but Core calls Tasks.

D-004: Artifacts are export snapshots.

- WBS remains source of truth.
- Core creates Artifact snapshots from service-provided export content.
- Editing an exported Artifact does not update the source WBS plan.

## 2. Architecture

```text
UI / MCP / Agent
  -> Workbench Core (/api/wbs, MCP wbs tools)
  -> WBS Service (plans, items, dependencies, rollups, export content)
  -> WBS DB
  -> optional Core-orchestrated export to Artifacts
  -> future Core-orchestrated publish to Tasks
```

Reserved identifiers:

```text
service id: wbs
Core route prefix: /api/wbs
Project index sourceService: wbs
Project index resourceType: wbs_plan
MCP prefix: wbs.*
Suggested service port: 4107
Suggested DB port: 5549
```

## 3. Service Scope

Owns:

- WBS plans.
- Work package hierarchy.
- WBS code generation and recalculation.
- Item owner label.
- Start/due dates.
- Effort.
- Status and progress.
- Dependencies.
- Rollup calculations.
- Export content for JSON, Markdown, and CSV.
- Artifact export reference records.
- Future WBS item to Task mapping metadata.

Does not own:

- Mindmaps or Logical Trees.
- Artifact creation.
- Task creation.
- Project context writes.
- Canvas rendering.

## 4. Service Files

```text
services/wbs/
  package.json
  tsconfig.json
  Dockerfile
  .env.example
  src/
    auth.ts
    db.ts
    export.ts
    httpServer.ts
    rollup.ts
    store.ts
    taskMapping.ts
    types.ts
    __tests__/
```

Use `services/tasks`, `services/images`, and `services/projects` as patterns for:

- service-local account provisioning,
- JWT auth,
- PostgreSQL schema bootstrap,
- owner isolation,
- paged listing,
- TypeScript build setup.

## 5. Domain Model

WBS uses normalized tables in MVP because items need independent editing, dependencies, rollups, and future Task links.

```ts
export type WbsItemStatus = "todo" | "doing" | "blocked" | "done";

export interface WbsPlan {
  id: string;
  projectId?: string;
  projectName?: string;
  title: string;
  description: string;
  settings: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WbsItem {
  id: string;
  planId: string;
  parentId?: string;
  code: string;
  title: string;
  description: string;
  sortOrder: number;
  ownerLabel?: string;
  startDate?: string;
  dueDate?: string;
  effortHours?: number;
  status: WbsItemStatus;
  progress?: number;
  linkedTaskId?: string;
  version: number;
}

export interface WbsDependency {
  id: string;
  planId: string;
  fromItemId: string;
  toItemId: string;
  dependencyType: "finish_to_start" | "start_to_start" | "finish_to_finish" | "start_to_finish";
  lagDays: number;
}
```

Suggested tables:

```sql
service_accounts (
  id text primary key,
  core_user_id text unique,
  username_snapshot text,
  username text,
  password_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

wbs_plans (
  id text primary key,
  owner_core_user_id text not null,
  project_id text,
  project_name text,
  title text not null,
  description text not null default '',
  settings_json jsonb not null default '{}',
  version integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

wbs_items (
  id text primary key,
  owner_core_user_id text not null,
  plan_id text not null,
  parent_id text,
  code text not null,
  title text not null,
  description text not null default '',
  sort_order integer not null default 0,
  owner_label text,
  start_date text,
  due_date text,
  effort_hours numeric,
  status text not null default 'todo',
  progress integer,
  linked_task_id text,
  metadata_json jsonb not null default '{}',
  version integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

wbs_dependencies (
  id text primary key,
  owner_core_user_id text not null,
  plan_id text not null,
  from_item_id text not null,
  to_item_id text not null,
  dependency_type text not null,
  lag_days integer not null default 0,
  created_at timestamptz not null default now()
)

wbs_item_task_links (
  id text primary key,
  owner_core_user_id text not null,
  plan_id text not null,
  item_id text not null,
  task_id text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now()
)

wbs_artifact_exports (
  id text primary key,
  owner_core_user_id text not null,
  plan_id text not null,
  source_version integer not null,
  artifact_item_id text not null,
  artifact_path text,
  format text not null,
  exported_at timestamptz not null default now()
)
```

## 6. Internal HTTP Contract

Internal service routes:

```text
GET    /health
POST   /internal/accounts

GET    /wbs/plans?q=&projectId=&limit=&cursor=
POST   /wbs/plans
GET    /wbs/plans/:planId
PATCH  /wbs/plans/:planId
DELETE /wbs/plans/:planId

GET    /wbs/plans/:planId/items
POST   /wbs/plans/:planId/items
PATCH  /wbs/items/:itemId
DELETE /wbs/items/:itemId
POST   /wbs/items/:itemId/move

GET    /wbs/plans/:planId/dependencies
POST   /wbs/plans/:planId/dependencies
DELETE /wbs/dependencies/:dependencyId

POST   /wbs/plans/:planId/export-content
GET    /wbs/plans/:planId/exports
POST   /wbs/plans/:planId/exports
```

Plan create payload:

```ts
{
  title: string;
  description?: string;
  projectId?: string;
  projectName?: string;
  settings?: Record<string, unknown>;
}
```

Plan patch payload:

```ts
{
  expectedVersion: number;
  title?: string;
  description?: string;
  projectId?: string | null;
  projectName?: string | null;
  settings?: Record<string, unknown>;
}
```

Item create payload:

```ts
{
  parentId?: string;
  title: string;
  description?: string;
  ownerLabel?: string;
  startDate?: string;
  dueDate?: string;
  effortHours?: number;
  status?: "todo" | "doing" | "blocked" | "done";
  progress?: number;
}
```

Item patch payload:

```ts
{
  expectedVersion: number;
  title?: string;
  description?: string;
  ownerLabel?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  effortHours?: number | null;
  status?: "todo" | "doing" | "blocked" | "done";
  progress?: number | null;
}
```

Move payload:

```ts
{
  expectedVersion: number;
  parentId?: string | null;
  beforeItemId?: string;
  afterItemId?: string;
}
```

Export-content payload:

```ts
{
  format: "json" | "markdown" | "csv";
}
```

Mutation routes must reject stale versions with `409 VERSION_CONFLICT`.

## 7. Core Integration

Core files:

```text
services/workbench-core/src/internalClients.ts
services/workbench-core/src/httpServer.ts
services/workbench-core/src/integrations/types.ts
services/workbench-core/src/integrations/manifests/catalog.ts
services/workbench-core/src/integrations/manifests/wbsManifest.ts
```

Core environment keys:

```text
WBS_SERVICE_URL
INTERNAL_API_KEY_WBS
```

Core tasks:

- Extend Core `ServiceId` with `wbs`.
- Add WBS to `serviceTargets`.
- Add WBS provisioning to register/login.
- Genericize image-only on-demand provisioning or add WBS-specific on-demand provisioning.
- Add `wbsClient`.
- Add external routes:
  - `GET /api/wbs/plans`
  - `POST /api/wbs/plans`
  - `GET /api/wbs/plans/:planId`
  - `PATCH /api/wbs/plans/:planId`
  - `DELETE /api/wbs/plans/:planId`
  - `GET /api/wbs/plans/:planId/items`
  - `POST /api/wbs/plans/:planId/items`
  - `PATCH /api/wbs/items/:itemId`
  - `DELETE /api/wbs/items/:itemId`
  - `POST /api/wbs/items/:itemId/move`
  - `GET /api/wbs/plans/:planId/dependencies`
  - `POST /api/wbs/plans/:planId/dependencies`
  - `DELETE /api/wbs/dependencies/:dependencyId`
  - `POST /api/wbs/plans/:planId/artifact-export`
- Orchestrate Artifact export in Core.

Core must not:

- Read WBS DB directly.
- Ask WBS service to call Artifacts.
- Ask WBS service to call Tasks.
- Add Mindmap routes during this track.

## 8. Artifact Export

Default paths:

```text
wbs/<plan-title>.md
wbs/<plan-title>.csv
wbs/<plan-title>.json
```

Core route:

```text
POST /api/wbs/plans/:planId/artifact-export
```

Payload:

```ts
{
  format: "markdown" | "csv" | "json";
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
  createNew?: boolean;
}
```

Core flow:

1. Read export content from WBS service.
2. Create an Artifact note/file through Artifacts facade/client.
3. Record export reference in WBS service.
4. Return source plan id/version and Artifact item.

Exported Artifact must include a metadata header or JSON fields for:

- source service: `wbs`,
- source plan id,
- source version,
- exported timestamp.

## 9. UI Plan

UI files:

```text
ui/src/pages/WbsPage.tsx
ui/src/pages/WbsPage.css
ui/src/wbs/
ui/src/App.tsx
ui/src/config/services.ts
ui/src/components/Layout.tsx
ui/src/lib/api.ts
ui/src/types/models.ts
```

Navigation:

- Add `WBS` under Tool.

Page layout:

- Left sidebar: plan list and project filter.
- Main area: outline table.
- Right inspector: item detail, dependency editor, export controls.

MVP interactions:

- Create plan.
- Add root/child/sibling item.
- Edit title, description, owner, dates, effort, status, progress.
- Move item.
- Delete item.
- Recalculate WBS codes.
- Display rollups for effort/date/progress.
- Add/delete dependency.
- Export to Artifact.

## 10. MCP Plan

Add only after Core HTTP tests pass.

Files:

```text
services/workbench-core/src/mcp/registerWbsTools.ts
services/workbench-core/src/httpServer.ts
services/workbench-core/src/mcpServer.ts
```

Tools:

```text
wbs.plans.list
wbs.plans.get
wbs.plans.create
wbs.plans.update
wbs.items.create
wbs.items.update
wbs.items.move
wbs.export_artifact
```

Deferred:

```text
wbs.publish_tasks
wbs.dependencies.add
wbs.dependencies.remove
```

## 11. Infra Plan

Files:

```text
package.json
package-lock.json
docker-compose.yml
infra/workbench.env.example
infra/env_samples/core.env.example
infra/env_samples/wbs.env.example
infra/scripts/workbench-env.mjs
infra/start_services.*
infra/start_all.*
infra/start_gateway_stdio.*
infra/build_all.*
```

Suggested env:

```text
WBS_PORT=4107
WBS_SERVICE_URL=http://127.0.0.1:4107
INTERNAL_API_KEY_WBS=workbench-internal-wbs
```

Suggested DB:

```text
local Postgres port: 5549
database: wbs_db
user: wbs_user
```

Do not add Mindmap env or DB wiring in the WBS implementation unless the Mindmap track is also approved for the same branch.

## 12. Future Tasks Publishing

Not in MVP.

When approved:

- Add a Core route such as `POST /api/wbs/plans/:planId/publish-tasks`.
- Core reads WBS items from WBS service.
- Core creates/updates Tasks through Tasks facade/client.
- WBS service records `wbs_item_task_links` with idempotency keys.
- Re-running publish must not duplicate tasks.
- Publishing must be explicit and user-triggered.

## 13. Implementation Gates

Gate 0: Contract freeze.

- Final route names.
- Final public TypeScript models.
- Final error codes.
- Final export formats.
- Subagent ownership.

Gate 1: Service scaffold.

- `services/wbs` package builds.
- Health route works.
- `/internal/accounts` works.
- Schema bootstrap works.

Gate 2: Domain implementation.

- Plans.
- Items.
- Move/reorder.
- Dependencies.
- Code recalculation.
- Rollups.
- Version conflicts.
- Owner isolation.
- Export content.

Gate 3: Core facade.

- Provisioning.
- Facade routes.
- Artifact export.
- Integration manifest.

Gate 4: UI.

- Route/nav.
- API wrapper and types.
- WBS page.
- Artifact export action.

Gate 5: MCP.

- Tools registered in HTTP MCP and stdio MCP.
- Registration tests pass.

## 14. Tests

Service tests:

- Plan CRUD.
- Item CRUD.
- Move/reorder.
- WBS code recalculation.
- Rollups.
- Dependency validation.
- Version conflict.
- Owner isolation.
- Markdown/CSV/JSON export.

Core tests:

- Provisioning.
- Facade routes.
- Artifact export.
- MCP registration after Gate 5.

UI tests:

- Route/nav display.
- API wrapper.
- Basic plan/item/export flows.

Verification:

```text
npm run build --workspace services/wbs
npm run test --workspace services/wbs
npm run test --workspace services/workbench-core
npm run test --workspace ui
node infra/scripts/workbench-env.mjs check
```

## 15. Definition of Done

- WBS service runs independently.
- Core exposes WBS through `/api/wbs`.
- UI has an independent WBS tool page.
- WBS plans and items persist outside Artifacts.
- WBS code/rollup behavior is tested.
- Artifact export creates snapshots.
- Build and focused tests pass.
