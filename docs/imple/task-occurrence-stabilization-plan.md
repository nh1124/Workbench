# Task Occurrence Stabilization Implementation Plan

Last updated: 2026-06-29

## 1. Status legend

- `[pending]`: not started
- `[in-progress]`: implementation is underway
- `[review]`: waiting for root-agent review
- `[approved]`: reviewed and ready to merge into the integration branch
- `[implemented]`: merged and verified
- `[blocked]`: cannot proceed without a contract decision or dependency
- `[deferred]`: intentionally moved out of this stabilization pass

## 2. Objective

Stabilize the Tasks feature by making task identity, occurrence identity, planned-work dates, due/execution dates, and Today membership consistent across the Tasks service, Core facade, UI, and Local Mode.

The current architecture should be preserved:

- Task definition is stored in LBS and surfaced through `services/tasks`.
- Occurrence operations are recorded against an LBS execution date, `occurrenceDate`.
- Planned work is stored locally in `task_occurrence_schedule` with `scheduledDate`.
- Today is a scheduled-work view, not the same thing as task due date.

## 3. Non-goals

- Do not replace LBS or move the full task model into Workbench DB.
- Do not redesign the Tasks UI layout.
- Do not introduce a new shared package unless the root agent explicitly approves it.
- Do not change Project ownership or Project link semantics.
- Do not remove Local Mode. If parity cannot be completed in one pass, document the degraded behavior and keep routes compatible.

## 4. Contract freeze

These rules must be treated as the implementation contract for all workstreams.

### 4.1 Domain identity

| Concept | Stable identity | Notes |
|---|---|---|
| Task | `taskId` | LBS task id. |
| Occurrence | `taskId + occurrenceDate` | `occurrenceDate` is the LBS execution date used for completion/history/exception operations. |
| Schedule item | `scheduleId` when present, otherwise `taskId + occurrenceDate + scheduledDate` | A schedule item records when the user plans to work on an occurrence. |
| Today membership | schedule items where `scheduledDate === todayKey` | Today membership is occurrence-level, not task-level. |
| UI occurrence row | stable row key derived from schedule item or occurrence identity | A row must not use `taskId` alone for selection or Today membership. |

### 4.2 Date semantics

| Field | Meaning | Used by |
|---|---|---|
| `dueDate` | Task due date from LBS. For `ONCE`, usually the occurrence date. | Inbox and task detail. |
| `occurrenceDate` | LBS execution date for a specific occurrence. | Complete, skip, move occurrence, subtasks, history. |
| `scheduledDate` | Date the user plans to work on the occurrence. | Today and Schedule calendar. |
| `TaskOccurrenceRow.date` | Display/grouping date for the active view. | Today/Schedule use `scheduledDate`; Overdue uses `occurrenceDate`; Inbox uses `dueDate`. |

### 4.3 Mutation semantics

- Completing/skipping an occurrence must call occurrence APIs with `occurrenceDate`, not `scheduledDate`.
- Moving an occurrence date means creating/updating LBS exceptions.
- Changing planned work date means updating `task_occurrence_schedule.scheduled_date`.
- Removing from Today should remove exactly the selected schedule item or selected occurrence membership, not every schedule item for the task on that date.
- Adding to Today must be idempotent for the same `taskId + occurrenceDate + scheduledDate`.

### 4.4 Compatibility rule

Existing routes may stay, but their behavior must be made exact:

- `POST /api/tasks/today` may accept empty or missing `occurrenceDate`; the Tasks service resolves it to `scheduledDate`.
- `DELETE /api/tasks/today/:taskId` should accept `scheduledDate` plus optional `occurrenceDate` for exact deletion. UI should prefer `scheduleId` deletion when available.
- `DELETE /api/tasks/schedule-items/:id` remains the exact schedule-item deletion route.

### 4.5 Recurrence weekday boundary

The Tasks UI and Tasks service internal model use JavaScript weekday indexes:

- `weekdayMon1 = 0` means Sunday.
- `weekdayMon1 = 1..6` means Monday through Saturday.

The LBS service and LBS-compatible CSV use `weekday_mon1` with Monday-first numbering:

- `weekday_mon1 = 1..6` means Monday through Saturday.
- `weekday_mon1 = 7` means Sunday.

All LBS/CSV boundaries must convert between these representations. Internal UI, service recurrence helpers, and Local Mode generated recurrence should stay on the JavaScript weekday index representation.

## 5. Recommended branch/workstream split

Use separate branches or worktrees when assigning subagents. Agents must not merge their own branches. The root agent reviews and integrates.

| Workstream | Branch suggestion | Primary files | Depends on |
|---|---|---|---|
| A. Backend schedule contract | `codex/tasks-schedule-contract` | `services/tasks/src/db.ts`, `scheduleItemsStore.ts`, `taskScheduleStore.ts`, `httpServer.ts`, tests | Contract freeze |
| B. Core facade contract | `codex/tasks-core-facade-contract` | `services/workbench-core/src/httpServer.ts`, `internalClients.ts`, MCP task tools if needed | A API shape |
| C. UI occurrence identity and Today | `codex/tasks-ui-occurrence-identity` | `ui/src/tasks/**`, `ui/src/lib/api.ts`, tests | A/B route behavior |
| D. UI recurrence/date boundary | `codex/tasks-ui-date-recurrence` | `ui/src/lib/taskRecurrenceUtils.ts`, `TasksPageContainer.tsx`, tests | C helper shape |
| E. Local Mode parity | `codex/tasks-local-mode-parity` | `services/sync-daemon/src/index.ts`, sync-daemon tests | A contract, C row expectations |
| F. Integration verification | root branch | no primary ownership | A-E |

## 6. Shared progress board

Update this table as each subagent hands off work.

| ID | Status | Owner | Task | Verification |
|---|---|---|---|---|
| T0 | `[implemented]` | root | Add/confirm characterization tests for known unstable cases. | Added Tasks schedule contract, UI occurrence identity, recurrence, and sync-daemon Local Mode coverage. |
| T1 | `[implemented]` | A | Make schedule item creation idempotent and exact. | Tasks service tests cover duplicate add and exact delete. |
| T2 | `[implemented]` | A | Add safe DB uniqueness/dedupe for schedule items. | Schema startup dedupes existing rows and creates the natural-key unique index. |
| T3 | `[implemented]` | B | Align Core facade and internal client comments/validation with Tasks service behavior. | Core build and tests pass, with DB-dependent tests skipped when DB is unavailable. |
| T4 | `[implemented]` | C | Replace Today task-id membership with occurrence-level membership. | UI tests cover occurrence membership keys. |
| T5 | `[implemented]` | C | Add schedule metadata to `TaskOccurrenceRow`. | Today add/remove uses `scheduleId` or exact natural key. |
| T6 | `[implemented]` | C | Fix Today row display date to use `scheduledDate`. | Today rows carry both `scheduledDate` and `occurrenceDate`. |
| T7 | `[implemented]` | D | Align UI recurrence `EVERY_N_DAYS` with backend `anchorDate` behavior. | UI and service recurrence tests cover `anchorDate`. |
| T8 | `[implemented]` | D | Refresh Today boundary when date changes. | `TasksPageContainer` reloads only when `todayKey` changes. |
| T9 | `[implemented]` | E | Bring Local Mode schedule/today/occurrence behavior in line with the contract. | sync-daemon tests cover explicit schedule, generated recurrence, occurrence status, and natural-key collisions. |
| T10 | `[implemented]` | root | Run full targeted verification and review for regressions. | Commands in section 12 pass; UI build has the existing chunk-size warning. |
| T11 | `[implemented]` | root | Align `weekdayMon1` across UI/service internals, LBS, and Local Mode CSV. | Tasks service and sync-daemon tests cover Sunday conversion across boundaries. |

## 7. Workstream A: backend schedule contract

### Scope

Stabilize `task_occurrence_schedule` and Tasks service Today/Schedule behavior.

### Steps

1. Add service-level tests first.
   - Duplicate `POST /tasks/today` for same `taskId + occurrenceDate + scheduledDate` returns one logical schedule item.
   - Deleting with `scheduledDate + occurrenceDate` removes only that occurrence.
   - `GET /tasks/today?date=...` returns explicit planned work rows with `scheduledDate` and `occurrenceDate`.
2. Add a safe dedupe step before creating a uniqueness constraint.
   - Keep the newest row for duplicate `owner_username + task_id + occurrence_date + scheduled_date`.
   - Preserve `start_time`, `end_time`, and `timezone` from the kept row.
3. Add uniqueness for `owner_username + task_id + occurrence_date + scheduled_date`.
4. Change `createScheduleItem` to upsert on that natural key.
   - If the item already exists, update time fields only when provided.
   - Always return the authoritative row.
5. Add exact deletion support.
   - Prefer `deleteScheduleItem(owner, scheduleId)` for exact item removal.
   - Add or adjust a helper for `owner + taskId + scheduledDate + occurrenceDate`.
   - Keep broad `taskId + scheduledDate` deletion only as compatibility fallback.
6. Clean misleading comments.
   - Today is explicit scheduled work.
   - Due-today suggestions are a UI flow, not automatic Today membership.

### Review checklist

- No mutation bypasses owner scoping.
- No duplicate schedule items can be created by repeated clicks.
- Existing empty `occurrenceDate` compatibility is preserved by resolving to `scheduledDate`.
- Tests cover both normal service mode and edge cases with repeated recurring occurrences.

## 8. Workstream B: Core facade contract

### Scope

Keep Core facade, sync events, and task MCP wording aligned with the Tasks service contract.

### Steps

1. Review `POST /api/tasks/today` validation.
   - Allow string `occurrenceDate`, including empty string for compatibility.
   - Document that downstream resolves empty to `scheduledDate`.
2. Extend `DELETE /api/tasks/today/:taskId` forwarding if Workstream A adds `occurrenceDate`.
3. Ensure sync event payloads include enough identity for exact replay.
   - `taskId`
   - `scheduledDate`
   - `occurrenceDate`
   - `scheduleId` when available
4. Update MCP task tool descriptions if they imply task-level Today membership.
5. Run route coverage tests.

### Review checklist

- Core route behavior matches Tasks service route behavior.
- Sync payloads can be replayed without broad deletion.
- No route ordering regression around `/api/tasks/today`, `/api/tasks/schedule-calendar`, or `/api/tasks/:id`.

## 9. Workstream C: UI occurrence identity and Today

### Scope

Make the UI use occurrence-level identity everywhere the user interacts with occurrences.

### Steps

1. Add a small identity helper module under `ui/src/tasks/lib/`.
   - `scheduleItemKey(scheduleId)`
   - `occurrenceMembershipKey(taskId, occurrenceDate, scheduledDate)`
   - `rowTodayMembershipKey(row, todayKey)`
   - Keep this pure and heavily tested.
2. Extend `TaskOccurrenceRow`.
   - Add `occurrenceDate: string` where possible.
   - Add `scheduledDate?: string`.
   - Add `scheduleId?: number`.
   - Update comments so `date` is clearly display/grouping date.
3. Fix Today row construction in `useTaskDataLoader`.
   - `date = t.scheduledDate`.
   - `occurrenceDate = t.occurrenceDate`.
   - `scheduledDate = t.scheduledDate`.
   - `scheduleId = t.scheduleId`.
4. Replace `myDayFlaggedIds: Set<string>` with occurrence-level state.
   - Suggested name: `todayMembershipKeys`.
   - Today count should be the number of Today rows or membership keys.
   - Context menu should use membership keys, not `taskId`.
5. Fix Add to Today.
   - Use `scheduledDate = todayKey`.
   - Use `occurrenceDate = row.occurrenceDate ?? row.date`.
   - Add the returned `scheduleId` to the new row.
   - New Today row must display on `todayKey`, even if the source row was overdue or planned for another date.
6. Fix Remove from Today.
   - If row has `scheduleId`, call `removeScheduleItem(scheduleId)`.
   - Otherwise call the exact Today delete route with `taskId + scheduledDate + occurrenceDate`.
7. Update selection/range behavior only if row keys change.
   - Selection keys must remain stable within the current rendered list.
   - Do not use `taskId` alone as a selection key.

### Review checklist

- A recurring task can have two different occurrences and only one can be in Today.
- Removing one Today occurrence does not remove another occurrence for the same task.
- Overdue occurrence added to Today displays today's planned-work date while completion still targets the overdue `occurrenceDate`.
- Sidebar Today count matches visible Today rows.

## 10. Workstream D: UI recurrence and date boundary

### Scope

Remove UI/backend recurrence drift and prevent stale Today boundaries.

### Steps

1. Update `ui/src/lib/taskRecurrenceUtils.ts`.
   - `EVERY_N_DAYS` anchor must be `anchorDate || activeFrom || createdAt`.
   - Keep weekly fallback aligned with backend: selected weekdays, then `activeFrom || dueDate`.
2. Add UI tests mirroring service recurrence tests.
   - Include `anchorDate` with an `activeFrom` that would otherwise produce a different answer.
   - Include `MONTHLY_NTH_WEEKDAY` with Sunday represented as internal `weekdayMon1 = 0`.
3. Change `TasksPageContainer` Today calculation.
   - Derive `today` and `todayKey` from `nowMarker`, not a mount-only memo.
   - On `todayKey` change, reload tasks and reset planned/overdue paging.
4. Ensure Today suggestion localStorage key changes with the new day.
5. Avoid reload loops.
   - The 30-second now marker may update often, but reload should happen only when `todayKey` changes.

### Review checklist

- UI and Tasks service recurrence tests agree for `EVERY_N_DAYS`.
- Leaving the app open past midnight refreshes Today/Overdue/Planned boundaries.
- No excessive polling or repeated reload occurs every 30 seconds.

## 11. Workstream E: Local Mode parity

### Scope

Make daemon-backed Local Mode respect the same occurrence and schedule contracts as normal Core mode.

### Steps

1. Update local schedule item identity.
   - Normalize local schedule items with `taskId`, `occurrenceDate`, `scheduledDate`, `scheduleId`.
   - Add/update by natural key when `scheduleId` is local or missing.
   - Remove exact items instead of all task items for a scheduled date.
2. Update `localTodayTasks`.
   - Return explicit schedule items for `scheduledDate`.
   - Include `scheduleId`, `occurrenceDate`, `scheduledDate`, time fields, and task fields.
3. Update `localScheduleCalendar`.
   - Include explicit schedule items.
   - Generate recurring scheduled items consistently enough for offline UI display.
   - If full LBS parity is not possible, document exactly which generated LBS behavior is unavailable offline.
4. Update `localTaskSchedule`.
   - Resolve occurrence-level status from local occurrence actions.
   - Do not set the whole task status from one recurring occurrence.
5. Update local occurrence mutation.
   - `complete` records occurrence-level status.
   - `move` records source and target dates and should not leave stale explicit schedule entries when a schedule item references the moved occurrence.
   - `skipException` hides/removes the target occurrence from generated local schedule results.
6. Ensure outbox payloads include exact identity fields for Core replay.
7. Convert `weekdayMon1` at Local Mode CSV boundaries.
   - Export internal Sunday `0` as LBS-compatible `weekday_mon1 = 7`.
   - Import LBS-compatible `weekday_mon1 = 7` as internal Sunday `0`.

### Review checklist

- Local Mode add/remove Today mirrors normal mode for repeated occurrences.
- Completing one recurring occurrence does not mark the whole task done in Local Mode.
- Local outbox replay uses exact schedule item or occurrence identity.
- Existing sync-daemon route coverage stays green.

## 12. Integration verification

Run these from the repository root unless noted.

```powershell
npm test --workspace services/tasks
npm test --workspace ui -- taskRecurrenceUtils taskFilterUtils taskCalendarUtils occurrencePagingUtils taskOccurrenceDisplayUtils inboxBuilder taskOccurrenceIdentity
npm test --workspace services/sync-daemon
npm test --workspace services/workbench-core
npm run build --workspace services/tasks
npm run build --workspace services/workbench-core
npm run build --workspace services/sync-daemon
npm run build --workspace ui
```

If the full workbench-core or sync-daemon suites are too slow during subagent iteration, each subagent must still run the narrow tests for the files they changed and state what remains for root verification.

## 13. Manual verification scenarios

Use these as the final review script.

1. Repeated recurring occurrence Today isolation
   - Create or use a recurring task with at least two future occurrences.
   - Add only one occurrence to Today.
   - Verify the context menu shows only that occurrence as Today-added.
   - Remove it and verify the other occurrence is untouched.
2. Overdue occurrence planned for today
   - Pick an overdue occurrence.
   - Add it to Today.
   - Verify the Today row displays today as the planned work date.
   - Complete it and verify completion applies to the overdue occurrence date.
3. Duplicate click idempotency
   - Double-click or rapidly trigger Add to Today for the same occurrence.
   - Verify only one schedule item exists and only one row appears.
4. Schedule date edit
   - Open task detail for a scheduled occurrence.
   - Change planned work date.
   - Verify the row moves to the new `scheduledDate` without changing `occurrenceDate`.
5. Occurrence move
   - Move an occurrence date.
   - Verify old occurrence is skipped, target occurrence is forced, and any explicit schedule item remains coherent.
6. Day rollover
   - Simulate or wait for date change.
   - Verify Today/Overdue/Planned counts refresh without reloading the whole app manually.
7. Local Mode
   - Enable Local Mode.
   - Repeat add/remove Today and occurrence completion for a recurring task.
   - Verify queued outbox entries contain exact identity fields.

## 14. Subagent handoff template

Each subagent should report back with this structure:

```text
Workstream:
Branch/worktree:
Files changed:
Contract decisions needed:
Behavior changed:
Tests added:
Tests run:
Known risks:
Review notes:
```

## 15. Root-agent review policy

The root agent should review in this order:

1. Contract and schema changes before UI changes.
2. UI identity changes before Local Mode parity.
3. Local Mode after normal Core mode behavior is stable.
4. Integration tests only after all workstreams have handed off.

Reject or return work for revision if any of these happen:

- A change uses `taskId` alone as Today membership identity.
- A delete path removes multiple schedule items when the selected row has enough identity for exact removal.
- A UI row displays `occurrenceDate` where the view contract requires `scheduledDate`.
- A recurring occurrence completion mutates task-wide status without occurrence context.
- A new route or payload shape is not reflected in Core facade and Local Mode replay.
