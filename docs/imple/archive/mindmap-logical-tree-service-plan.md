# Mindmap / Logical Tree Independent Service Plan

Status: ready for independent implementation
Last updated: 2026-06-30

This plan covers only Mindmap and Logical Tree. WBS is intentionally out of scope and has its own plan.

## 1. Decisions

D-001: Mindmap is an independent service.

- Source-of-truth records live in `services/mindmaps`.
- UI and agents access it through Workbench Core only.
- The service owns documents, nodes, visual layout, links, versions, and export-content generation.

D-002: Logical Tree is a Mindmap mode.

- Store `mode: "mindmap" | "logical_tree"` on each document.
- Logical Tree templates are data/templates inside Mindmap.
- Do not create a separate Logical Tree service.

D-003: No WBS coupling.

- Do not add WBS fields such as effort, owner, dates, progress, status, dependencies, or linked Task IDs.
- Do not import WBS code or schemas.
- Do not create a shared tree-domain package in MVP.

D-004: Artifacts are export snapshots.

- Mindmap remains source of truth.
- Core creates Artifact snapshots from service-provided export content.
- The Mindmaps service records created Artifact references after Core export succeeds.

## 2. Architecture

```text
UI / MCP / Agent
  -> Workbench Core (/api/mindmaps, MCP mindmaps tools)
  -> Mindmaps Service (documents, layout, versions, export content)
  -> Mindmaps DB
  -> optional Core-orchestrated export to Artifacts
```

Reserved identifiers:

```text
service id: mindmaps
Core route prefix: /api/mindmaps
Project index sourceService: mindmaps
Project index resourceType: mindmap_document
MCP prefix: mindmaps.*
Suggested service port: 4106
Suggested DB port: 5548
```

## 3. Service Scope

Owns:

- Mindmap documents.
- Logical Tree templates.
- Node hierarchy.
- Node positions and side assignments.
- Collapsed state.
- Node styles.
- Non-hierarchical links between nodes.
- Export content for JSON, Markdown, and SVG.
- Artifact export reference records.

Does not own:

- WBS plans or work packages.
- Artifacts creation.
- Project context writes.
- Tasks publishing.
- Image generation.

## 4. Service Files

```text
services/mindmaps/
  package.json
  tsconfig.json
  Dockerfile
  .env.example
  src/
    auth.ts
    db.ts
    export.ts
    httpServer.ts
    store.ts
    templates.ts
    types.ts
    __tests__/
```

Use `services/images` and `services/projects` as patterns for:

- service-local account provisioning,
- JWT auth,
- PostgreSQL schema bootstrap,
- owner isolation,
- TypeScript build setup.

## 5. Domain Model

MVP stores the editable document body as JSONB. This keeps the first implementation small and preserves visual layout data.

```ts
export type MindmapMode = "mindmap" | "logical_tree";

export interface MindmapDocument {
  id: string;
  projectId?: string;
  projectName?: string;
  title: string;
  mode: MindmapMode;
  body: MindmapDocumentBody;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MindmapDocumentBody {
  schemaVersion: 1;
  mode: MindmapMode;
  rootNodeId: string;
  nodes: Record<string, MindmapNode>;
  links: MindmapLink[];
  viewport?: MindmapViewport;
  template?: "blank" | "issue_tree" | "why_tree" | "how_tree";
}

export interface MindmapNode {
  id: string;
  parentId?: string;
  title: string;
  note?: string;
  sortOrder: number;
  collapsed?: boolean;
  nodeType?: "topic" | "question" | "hypothesis" | "cause" | "action" | "evidence";
  style?: {
    color?: string;
    icon?: string;
  };
  layout?: {
    x: number;
    y: number;
    side?: "left" | "right";
  };
}

export interface MindmapLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  relationType?: "related" | "supports" | "contradicts" | "depends_on";
}
```

Suggested tables:

```sql
mindmap_service_accounts (
  core_user_id text primary key,
  username_snapshot text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

mindmap_documents (
  id text primary key,
  owner_core_user_id text not null,
  project_id text,
  project_name text,
  title text not null,
  mode text not null,
  document_json jsonb not null,
  search_text text not null default '',
  version integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

mindmap_artifact_exports (
  id text primary key,
  owner_core_user_id text not null,
  document_id text not null,
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

GET    /mindmaps?q=&projectId=&mode=&limit=&cursor=
POST   /mindmaps
GET    /mindmaps/:id
PATCH  /mindmaps/:id
DELETE /mindmaps/:id

POST   /mindmaps/:id/export-content
GET    /mindmaps/:id/exports
POST   /mindmaps/:id/exports
```

Create payload:

```ts
{
  title: string;
  projectId?: string;
  projectName?: string;
  mode?: "mindmap" | "logical_tree";
  template?: "blank" | "issue_tree" | "why_tree" | "how_tree";
  body?: MindmapDocumentBody;
}
```

Patch payload:

```ts
{
  expectedVersion: number;
  title?: string;
  projectId?: string | null;
  projectName?: string | null;
  mode?: "mindmap" | "logical_tree";
  body?: MindmapDocumentBody;
}
```

Export-content payload:

```ts
{
  format: "json" | "markdown" | "svg";
}
```

Export-content response:

```ts
{
  documentId: string;
  sourceVersion: number;
  format: "json" | "markdown" | "svg";
  filename: string;
  mimeType: string;
  contentText?: string;
  contentBase64?: string;
}
```

`PATCH /mindmaps/:id` must reject stale versions with `409 VERSION_CONFLICT`.

## 7. Core Integration

Core files:

```text
services/workbench-core/src/internalClients.ts
services/workbench-core/src/httpServer.ts
services/workbench-core/src/integrations/types.ts
services/workbench-core/src/integrations/manifests/catalog.ts
services/workbench-core/src/integrations/manifests/mindmapsManifest.ts
```

Core environment keys:

```text
MINDMAPS_SERVICE_URL
INTERNAL_API_KEY_MINDMAPS
```

Core tasks:

- Extend Core `ServiceId` with `mindmaps`.
- Add Mindmaps to `serviceTargets`.
- Add Mindmaps provisioning to register/login.
- Genericize image-only on-demand provisioning or add Mindmaps-specific on-demand provisioning.
- Add `mindmapsClient`.
- Add external routes:
  - `GET /api/mindmaps`
  - `POST /api/mindmaps`
  - `GET /api/mindmaps/:id`
  - `PATCH /api/mindmaps/:id`
  - `DELETE /api/mindmaps/:id`
  - `POST /api/mindmaps/:id/artifact-export`
- Orchestrate Artifact export in Core.

Core must not:

- Read Mindmaps DB directly.
- Ask Mindmaps service to call Artifacts.
- Add WBS routes during this track.

## 8. Artifact Export

Default paths:

```text
mindmaps/<document-title>.md
mindmaps/<document-title>.json
mindmaps/<document-title>.svg
```

Core route:

```text
POST /api/mindmaps/:id/artifact-export
```

Payload:

```ts
{
  format: "markdown" | "json" | "svg";
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
  createNew?: boolean;
}
```

Core flow:

1. Read export content from Mindmaps service.
2. Create an Artifact note/file through Artifacts facade/client.
3. Record export reference in Mindmaps service.
4. Return source document id/version and Artifact item.

Exported Artifact must include a metadata header or JSON fields for:

- source service: `mindmaps`,
- source document id,
- source version,
- exported timestamp.

## 9. UI Plan

UI files:

```text
ui/src/pages/MindmapsPage.tsx
ui/src/pages/MindmapsPage.css
ui/src/mindmaps/
ui/src/App.tsx
ui/src/config/services.ts
ui/src/components/Layout.tsx
ui/src/lib/api.ts
ui/src/types/models.ts
```

Navigation:

- Add `Mindmap` under Tool.
- Optional later: `Logical Tree` nav entry can open Mindmap with `mode=logical_tree`.

Page layout:

- Left sidebar: document list, project filter, mode filter.
- Main area: editable map canvas.
- Right inspector: selected node details, style, logical-tree controls.

MVP interactions:

- Create document.
- Create from logical-tree template.
- Add child/sibling node.
- Rename node.
- Edit note.
- Move node.
- Collapse branch.
- Edit node style.
- Save document.
- Export to Artifact.

## 10. MCP Plan

Add only after Core HTTP tests pass.

Files:

```text
services/workbench-core/src/mcp/registerMindmapTools.ts
services/workbench-core/src/httpServer.ts
services/workbench-core/src/mcpServer.ts
```

Tools:

```text
mindmaps.list
mindmaps.get
mindmaps.create
mindmaps.update
mindmaps.export_artifact
```

Deferred:

```text
mindmaps.layout
mindmaps.logical_tree.generate
```

## 11. Infra Plan

Files:

```text
package.json
package-lock.json
docker-compose.yml
infra/workbench.env.example
infra/env_samples/core.env.example
infra/env_samples/mindmaps.env.example
infra/scripts/workbench-env.mjs
infra/start_services.*
infra/start_all.*
infra/start_gateway_stdio.*
infra/build_all.*
```

Suggested env:

```text
MINDMAPS_PORT=4106
MINDMAPS_SERVICE_URL=http://127.0.0.1:4106
INTERNAL_API_KEY_MINDMAPS=workbench-internal-mindmaps
```

Suggested DB:

```text
local Postgres port: 5548
database: mindmaps_db
user: mindmaps_user
```

Do not add WBS env or DB wiring in the Mindmap implementation unless the WBS track is also approved for the same branch.

## 12. Implementation Gates

Gate 0: Contract freeze.

- Final route names.
- Final public TypeScript models.
- Final error codes.
- Final export formats.
- Subagent ownership.

Gate 1: Service scaffold.

- `services/mindmaps` package builds.
- Health route works.
- `/internal/accounts` works.
- Schema bootstrap works.

Gate 2: Domain implementation.

- CRUD.
- Version conflicts.
- Owner isolation.
- Templates.
- Export content.

Gate 3: Core facade.

- Provisioning.
- Facade routes.
- Artifact export.
- Integration manifest.

Gate 4: UI.

- Route/nav.
- API wrapper and types.
- Mindmap page.
- Artifact export action.

Gate 5: MCP.

- Tools registered in HTTP MCP and stdio MCP.
- Registration tests pass.

## 13. Tests

Service tests:

- CRUD.
- `mode=logical_tree` validation.
- Template creation.
- Version conflict.
- Owner isolation.
- Markdown/JSON/SVG export.

Core tests:

- Provisioning.
- Facade routes.
- Artifact export.
- MCP registration after Gate 5.

UI tests:

- Route/nav display.
- API wrapper.
- Basic create/edit/export flows.

Verification:

```text
npm run build --workspace services/mindmaps
npm run test --workspace services/mindmaps
npm run test --workspace services/workbench-core
npm run test --workspace ui
node infra/scripts/workbench-env.mjs check
```

## 14. Definition of Done

- Mindmaps service runs independently.
- Core exposes Mindmaps through `/api/mindmaps`.
- UI has an independent Mindmap tool page.
- Logical Tree works as a Mindmap mode/template.
- Mindmap documents persist outside Artifacts.
- Artifact export creates snapshots.
- Build and focused tests pass.
