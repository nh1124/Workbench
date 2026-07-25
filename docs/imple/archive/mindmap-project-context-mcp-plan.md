# Mindmap Project Context and MCP Implementation Plan

Last updated: 2026-06-30

## 1. Status legend

- `[pending]`: not started
- `[in-progress]`: implementation is underway
- `[review]`: waiting for root-agent review
- `[implemented]`: implemented and verified
- `[blocked]`: cannot proceed without a contract decision or dependency
- `[deferred]`: intentionally moved out of this pass

## 2. Objective

Make independently stored Mindmap documents visible as first-class Project resources through Project context, Project index search, and MCP tools.

The current separation remains fixed:

- Mindmap documents live in `services/mindmaps`.
- Workbench Core is the only external boundary.
- Project index entries use `sourceService="mindmaps"` and `resourceType="mindmap_document"`.
- Artifact exports remain snapshots, not the source of truth.
- WBS remains out of scope.

## 3. Non-goals

- Do not merge Mindmap and WBS service models.
- Do not move Mindmap document bodies into Projects or Artifacts storage.
- Do not make Artifact export mandatory for Project discovery.
- Do not redesign the Mindmap UI in this pass.

## 4. Contract freeze

| Concept | Contract |
|---|---|
| Source service | `mindmaps` |
| Resource type | `mindmap_document` |
| Association | Primary Project only in this pass |
| Source version | Mindmap document `version` |
| Content hash | Deterministic hash of title, description, mode, tags, and body |
| Index mutation path | Core-owned best-effort index maintenance through Projects |
| MCP prefix | `mindmaps.*` |

## 5. Shared progress board

| ID | Status | Owner | Task | Verification |
|---|---|---|---|---|
| MCTX0 | `[implemented]` | root | Commit completed independent Mindmap service MVP. | Commit `60e400d` created. |
| MCTX1 | `[implemented]` | root | Create this progress plan with labeled statuses. | This file added. |
| MCTX2 | `[implemented]` | root | Add Mindmap Project index builder, upsert, tombstone, and rebuild helpers in Core. | Implemented in `projectContext.ts`; pending final verification. |
| MCTX3 | `[implemented]` | root | Wire Mindmap Core CRUD/export routes to Project index invalidation. | Core routes maintain/tombstone Mindmap index entries and invalidate Project context. |
| MCTX4 | `[implemented]` | root | Add MCP `mindmaps.*` tools and register them in HTTP/stdio MCP. | `registerMindmapTools.ts` added and registered. |
| MCTX5 | `[implemented]` | root | Add/adjust tests or targeted contract verification. | Core Mindmap index/MCP tests added; targeted builds/tests pass. |
| MCTX6 | `[implemented]` | review-agent | Review implementation for context/index/MCP regressions. | Review completed; P2/P3 findings addressed. |
| MCTX7 | `[implemented]` | root | Remediate review findings. | MCP provisioning shared with HTTP, Project index rebuild decouples Mindmap failures from Artifact repair, Mindmap mutation/rebuild tests added. |

## 6. Implementation checklist

1. Add Mindmap index entry helpers in `services/workbench-core/src/projectContext.ts`.
2. Add Core route-side invalidation around Mindmap create/update/delete.
3. Add explicit Project index rebuild support for Mindmap documents.
4. Add MCP tools:
   - `mindmaps.list`
   - `mindmaps.get`
   - `mindmaps.create`
   - `mindmaps.update`
   - `mindmaps.delete`
   - `mindmaps.export`
   - `mindmaps.artifact.save`
   - `mindmaps.projectIndex.rebuild`
5. Register the tools in HTTP MCP and stdio MCP.
6. Run focused build and test verification.

## 7. Residual risks

- Direct body expansion inside Project context is still represented by compact Project index entries; agents should use `mindmaps.get` after discovering an index hit.
- Secondary Project membership for Mindmap documents is deferred until a clear user workflow exists.
- `projects.index.rebuild` returns a per-service Mindmap error when the Mindmap service is unavailable, while preserving Artifact rebuild results.

## 8. Verification

- `npm run build --workspace services/workbench-core`
- `npm run test --workspace services/workbench-core` (57 tests: 44 passed, 13 skipped because Core DB was unavailable at `127.0.0.1:5542`)
- `npm run build --workspace services/mindmaps`
- `npm run test --workspace services/mindmaps` was not available because the Mindmap package has no `test` script.
- `npm run test --workspace ui`
- `npm run build --workspace ui` (succeeds with existing Vite chunk-size warning)
- `node infra/scripts/workbench-env.mjs check`
- `git diff --check` (line-ending warnings only)
