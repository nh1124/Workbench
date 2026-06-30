# Mindmap and WBS Split Implementation Index

Status: split plan index
Last updated: 2026-06-30

Mindmap/Logical Tree and WBS must be implemented separately.

Detailed plans:

- [Mindmap / Logical Tree Independent Service Plan](mindmap-logical-tree-service-plan.md)
- [WBS Independent Service Plan](wbs-service-plan.md)

## 1. Shared Decisions

D-001: Mindmap/Logical Tree and WBS are separate implementation tracks.

- Mindmap/Logical Tree owns free-form thinking, concept trees, and logical decomposition templates.
- WBS owns work packages, effort, dates, progress, dependencies, and future Tasks publishing.
- Do not use one shared domain model.
- Do not build a shared tree engine package in MVP.
- Low-level UI atoms can be reused, but service stores, APIs, Core clients, MCP tools, and UI domain state stay separate.

D-002: Logical Tree belongs to Mindmap.

- Logical Tree is a Mindmap mode/template.
- Do not create a third service for Logical Tree.

D-003: Artifacts are export targets.

- Mindmap and WBS services own their source-of-truth records.
- Artifact export creates snapshots/deliverables.
- Editing an exported Artifact does not update the source Mindmap or WBS record.

D-004: Workbench Core remains the only public boundary.

- UI, MCP, agent runtimes, and future clients call Core.
- New services expose internal HTTP APIs only.
- Core owns auth, service provisioning, public facades, MCP registration, and cross-service export orchestration.

## 2. Reserved Identifiers

Mindmap:

```text
service id: mindmaps
Core route prefix: /api/mindmaps
Project index sourceService: mindmaps
Project index resourceType: mindmap_document
MCP prefix: mindmaps.*
Suggested service port: 4106
Suggested DB port: 5548
```

WBS:

```text
service id: wbs
Core route prefix: /api/wbs
Project index sourceService: wbs
Project index resourceType: wbs_plan
MCP prefix: wbs.*
Suggested service port: 4107
Suggested DB port: 5549
```

## 3. Implementation Sequencing

Implement Mindmap and WBS independently. Either can start first.

Recommended order inside each track:

1. Contract freeze.
2. Internal service scaffold.
3. Domain API and tests.
4. Core facade and Artifact export.
5. UI page and API client.
6. MCP tools after HTTP contracts are stable.
7. Project index/link integration only if explicitly approved for that track.

Do not block Mindmap on WBS, or WBS on Mindmap, unless a shared Core/infra file has an active conflict.

## 4. Root Agent Coordination

Root agent responsibilities:

- Own cross-track contracts.
- Assign subagents to one bounded write scope at a time.
- Prevent accidental model sharing.
- Review each track independently.
- Integrate shared Core/infra edits deliberately.

Suggested independent branches:

```text
codex/mindmap-service
codex/mindmap-core-ui
codex/mindmap-mcp
codex/wbs-service
codex/wbs-core-ui
codex/wbs-mcp
```

Shared-file caution:

```text
services/workbench-core/src/internalClients.ts
services/workbench-core/src/httpServer.ts
services/workbench-core/src/mcpServer.ts
services/workbench-core/src/integrations/**
ui/src/App.tsx
ui/src/config/services.ts
ui/src/components/Layout.tsx
ui/src/lib/api.ts
ui/src/types/models.ts
infra/**
package.json
package-lock.json
docker-compose.yml
```

When both tracks need the same shared file, root agent should sequence or integrate those changes rather than letting two workers edit the same file in parallel.

## 5. Shared Infrastructure Rule

The first implemented track may add only its own service wiring.

Examples:

- Mindmap implementation should add `MINDMAPS_PORT`, `MINDMAPS_SERVICE_URL`, and `INTERNAL_API_KEY_MINDMAPS`, but should not add WBS env keys unless WBS work has also been approved.
- WBS implementation should add `WBS_PORT`, `WBS_SERVICE_URL`, and `INTERNAL_API_KEY_WBS`, but should not add Mindmap env keys unless Mindmap work has also been approved.

The combined port reservations in this index are planning defaults, not permission to implement both tracks at once.

## 6. Shared Review Checklist

- No UI direct calls to internal services.
- No service direct calls to another service database.
- No service direct calls to Artifacts or Tasks.
- Artifact exports are snapshots.
- Owner isolation is enforced by service-local account mapping.
- Mutations use optimistic concurrency.
- New services are included in Core provisioning.
- Core test env is updated for only the implemented track.
- MCP registration is added only after HTTP facade tests pass.
