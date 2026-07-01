# WBS Implementation Progress Plan

Last updated: 2026-07-01

## 1. Status Legend

- `[pending]`: not started
- `[in-progress]`: implementation is underway
- `[review]`: waiting for root-agent review
- `[implemented]`: implemented and verified for the current gate
- `[blocked]`: cannot proceed without a contract decision or dependency
- `[deferred]`: intentionally moved out of this pass

## 2. Current Document State

| Document | State | Notes |
|---|---|---|
| `docs/imple/mindmap-wbs-independent-services-plan.md` | `[implemented]` | Confirms Mindmap/Logical Tree and WBS are separate service tracks. |
| `docs/imple/wbs-service-plan.md` | `[implemented]` | WBS independent service design is ready for implementation. |
| `docs/imple/mindmap-project-context-mcp-plan.md` | `[implemented]` | Useful reference for Project index and MCP progress tracking style. |
| `docs/imple/wbs-implementation-progress-plan.md` | `[in-progress]` | Implementation wiring is in place; final verification and review are ongoing. |

## 3. Objective

Implement Work Breakdown Structure as an independent Workbench tool and service.

The current separation remains fixed:

- WBS source-of-truth records live in `services/wbs`.
- Workbench Core is the only external boundary for UI, MCP, and agents.
- Project index entries use `sourceService="wbs"` and `resourceType="wbs_plan"`.
- Artifact exports are snapshots, not the source of truth.
- Mindmap and Logical Tree remain out of scope.

## 4. Contract Freeze

| Concept | Contract |
|---|---|
| Service id | `wbs` |
| Internal route prefix | `/wbs` |
| Core route prefix | `/api/wbs` |
| Project index source service | `wbs` |
| Project index resource type | `wbs_plan` |
| MCP prefix | `wbs.*` |
| UI route | `/wbs` |
| Primary UI metaphor | Table-first WBS grid with hierarchical rows and WBS codes |
| Export formats | `markdown`, `csv`, `json` |
| Task publishing | `[deferred]` explicit future Core-orchestrated flow |

## 5. Shared Progress Board

| ID | Status | Owner | Task | Verification |
|---|---|---|---|---|
| WBS0 | `[implemented]` | root | Review existing WBS/Mindmap split docs and create this progress plan. | Existing docs inspected; this tracker added. |
| WBS1 | `[implemented]` | root | Freeze MVP contract as independent table-first WBS. | Section 4 records the implementation contract. |
| WBS2 | `[implemented]` | service-worker | Add `services/wbs` scaffold, auth, DB bootstrap, and health/account routes. | `npm run build --workspace services/wbs` passed; DB smoke remains for runtime. |
| WBS3 | `[implemented]` | service-worker | Implement WBS plans/items/dependencies, code recalculation, rollups, and optimistic concurrency. | Service build passed; rollup/code tests pass; DB-backed CRUD smoke remains. |
| WBS4 | `[implemented]` | service-worker | Implement WBS export content and artifact export recording. | `npm run test --workspace services/wbs` passed for Markdown/CSV/JSON export. |
| WBS5 | `[implemented]` | core-worker | Add Core service target, provisioning, internal client, and `/api/wbs` facade routes. | `npm run build --workspace services/workbench-core` passed. |
| WBS6 | `[implemented]` | core-worker | Add WBS Artifact export orchestration in Core. | `saveWbsExportArtifact` implemented with Artifact snapshot and WBS export record. |
| WBS7 | `[implemented]` | core-worker | Add Project index helpers, invalidation, rebuild support, and project-context visibility. | Core build passed; WBS rebuild integrated into Project index rebuild. |
| WBS8 | `[implemented]` | mcp-worker | Add MCP `wbs.*` tools after Core HTTP contracts are stable. | MCP registration included in Core build. |
| WBS9 | `[implemented]` | ui-worker | Add UI types/API route/nav and WBS page shell. | `npm run build --workspace ui` passed. |
| WBS10 | `[implemented]` | ui-worker | Implement table-first WBS grid, row editing, inspector, and export controls. | UI build passed; manual localhost check remains. |
| WBS11 | `[implemented]` | review-agent | Review implementation for independence, owner isolation, index/MCP regressions, and UI usability. | Root review found and fixed service account table, item response, and export payload mismatches. |
| WBS12 | `[implemented]` | root | Run final focused verification and update this tracker. | Focused build/test commands passed; DB/manual smoke remains documented as residual risk. |

## 6. Workstream Ownership

| Workstream | Primary Write Scope | Notes |
|---|---|---|
| Service | `services/wbs/**` | Do not edit Mindmap files or Core facade directly. |
| Core | `services/workbench-core/src/**` | Root reviews shared files and sequencing. |
| UI | `ui/src/pages/WbsPage.*`, `ui/src/wbs/**`, selected route/nav/API/type files | Table-first UI; do not reuse Mindmap page state. |
| Infra | `package.json`, `package-lock.json`, `docker-compose.yml`, `infra/**` | Root owns final integration because these are shared files. |
| MCP | `services/workbench-core/src/mcp/registerWbsTools.ts` and registration points | Starts after Core HTTP facade is stable. |

## 7. MVP UI Shape

WBS is a hierarchical table, not a canvas.

Initial columns:

- Code
- Work item
- Owner
- Status
- Start
- Due
- Effort
- Progress

Initial interactions:

- Create/select WBS plan.
- Add root item, child item, and sibling item.
- Inline edit common cells.
- Select row to edit details in an inspector.
- Move rows by indent/outdent and up/down actions in MVP.
- Export to Markdown, CSV, JSON.

## 8. Review Checklist

- WBS does not import Mindmap schemas, stores, UI state, or export logic.
- UI and MCP call Core only.
- WBS service does not call Artifacts, Tasks, Projects, or any other service directly.
- WBS service account storage follows existing service conventions; use `service_accounts` unless a migration decision changes it.
- Owner scoping is enforced in every service query.
- Mutations use optimistic concurrency where records have versions.
- WBS codes are deterministic after add, move, delete, and reorder.
- Rollups are derived, not manually edited.
- Artifact exports are snapshots and record source plan/version.
- Project index failures do not corrupt source WBS mutations.

## 9. Verification Plan

```text
npm run build --workspace services/wbs
npm run test --workspace services/wbs
npm run build --workspace services/workbench-core
npm run test --workspace services/workbench-core
npm run build --workspace ui
npm run test --workspace ui
node infra/scripts/workbench-env.mjs check
```

Known acceptable warning:

- UI Vite build may emit the existing large chunk-size warning.

Current verification log:

| Command | Status | Notes |
|---|---|---|
| `node infra/scripts/workbench-env.mjs check` | `[implemented]` | Workbench service config is in sync. |
| `npm run build --workspace services/wbs` | `[implemented]` | TypeScript build passed. |
| `npm run test --workspace services/wbs` | `[implemented]` | 3 tests passed. |
| `npm run build --workspace services/workbench-core` | `[implemented]` | Core HTTP and MCP build passed. |
| `npm run build --workspace ui` | `[implemented]` | Build passed with the existing Vite chunk-size warning. |
| `npm run test --workspace services/workbench-core` | `[implemented]` | 58 tests passed; 13 existing DB-dependent tests skipped because Core DB is not reachable. |
| `npm run test --workspace ui` | `[implemented]` | 15 files / 94 tests passed. |

## 10. Deferred Items

- Publishing WBS items to Tasks.
- Gantt/timeline view.
- Drag-and-drop row reordering.
- Secondary Project memberships for WBS plans.
- Bidirectional Artifact-to-WBS synchronization.
