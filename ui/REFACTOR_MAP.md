# Tasks Page Refactor — Module Map

**Date:** 2026-03-29
**Original:** `src/pages/TasksPage.tsx` (3 363 lines) + `TasksPage.css` (1 070 lines)
**Constraint:** Zero feature regression, zero API/contract change, CSS class names preserved

---

## New File Structure

```
src/
├── lib/
│   ├── taskDateUtils.ts          (74 lines)   pure date helpers
│   ├── taskDisplayUtils.ts       (136 lines)  display/format helpers + ProjectOption
│   └── taskRecurrenceUtils.ts    (64 lines)   recurrence logic
├── tasks/
│   ├── types.ts                  (163 lines)  shared enums, constants, TaskDraft, TaskOccurrenceRow
│   ├── TasksPageContainer.tsx    (1 670 lines) container — wires hooks + renders JSX
│   ├── components/
│   │   ├── icons.tsx             (182 lines)  22 SVG icon components + StatusCircle
│   │   └── OccurrenceContextMenu.tsx (98 lines) context menu for batch occurrence ops
│   ├── hooks/
│   │   ├── useTaskDataLoader.ts  (215 lines)  primary data-fetch lifecycle
│   │   ├── useOccurrencePaging.ts(183 lines)  planned/overdue infinite-scroll paging
│   │   ├── useTaskSelection.ts   (180 lines)  multi-select + context menu state
│   │   └── useTaskMutations.ts   (912 lines)  all write operations
│   └── css/
│       ├── tasks-layout.css      (199 lines)  shell grid, sidebar, scrollbars
│       ├── tasks-list.css        (290 lines)  quick-add, list items, occurrence menu
│       ├── tasks-calendar.css    (267 lines)  month grid, week timeline, schedule
│       └── tasks-detail.css      (373 lines)  detail panel, cards, attachments, subtasks
└── pages/
    └── TasksPage.tsx             (435 lines)  thin entry point → <TasksPageContainer />
```

---

## State/Logic → New Home

| Old location (TasksPage.tsx) | New home |
|---|---|
| `tasks`, `setTasks` | `useTaskDataLoader` → returned, container destructures |
| `projectOptions`, `setProjectOptions` | `useTaskDataLoader` → returned |
| `todayTaskIds`, `myDayFlaggedIds` | `useTaskDataLoader` → returned |
| `todayRows`, `setTodayRows` | `useTaskDataLoader` → returned |
| `inboxUpcomingRows`, `inboxDoneRows` | `useTaskDataLoader` → returned |
| `plannedCount`, `overdueCount` | `useTaskDataLoader` → returned |
| `calendarStatusMap` | `useTaskDataLoader` → returned |
| `load()` — full data fetch | `useTaskDataLoader.load()` |
| `occurrenceRows`, `setOccurrenceRows` | `useOccurrencePaging` → returned |
| `loadOccurrencePage()` | `useOccurrencePaging.loadOccurrencePage()` |
| `resetOccurrences()` | `useOccurrencePaging.resetOccurrences()` |
| `hasMoreOccurrences`, `occurrencePage` | `useOccurrencePaging` → returned |
| `selectedOccurrenceKeys` | `useTaskSelection` → returned |
| `occurrenceMenu` (position/visibility) | `useTaskSelection` → returned |
| `handleOccurrenceClick()` | `useTaskSelection._handleOccurrenceClick()` (wrapped in container) |
| `handleMarkSelectedOccurrences()` | `useTaskMutations` → returned |
| `handleSkipSelectedTasks()` | `useTaskMutations` → returned |
| `handleConfirmMoveDate()` | `useTaskMutations` → returned |
| `handleDeleteSelectedFromMenu()` | `useTaskMutations` → returned |
| `handleToggleTodayForSelected()` | `useTaskMutations` → returned |
| `draft`, `setDraft`, `draftRef` | `useTaskMutations` → returned |
| `applyAndSave()` | `useTaskMutations` → returned |
| `saveDetail()` | `useTaskMutations` → returned |
| `handleAddTask()` | `useTaskMutations` → returned |
| `handleDeleteDetail()` | `useTaskMutations` → returned |
| `handleToggleDone()` | `useTaskMutations` → returned |
| `handleTogglePin()` | `useTaskMutations` → returned |
| `handleToggleOccurrenceDone()` | `useTaskMutations` → returned (wrapper in container) |
| `attachments`, `loadAttachments()` | `useTaskMutations` → returned |
| `handleAttachFiles()`, `handleAttachmentDrop()` | `useTaskMutations` → returned |
| `handleDeleteAttachment()` | `useTaskMutations` → returned |
| `subtasks`, `loadSubtasks()` | `useTaskMutations` → returned |
| `handleAddSubtask()`, `handleToggleSubtask()` | `useTaskMutations` → returned |
| `history`, `loadScheduleItem()` | `useTaskMutations` → returned |
| `handleSaveScheduleItem()` | `useTaskMutations` → returned |
| `handleExport()`, `handleImport()` | `useTaskMutations` → returned |
| `sidebarMode`, `calendarMode` | container-local `useState` |
| `quickFilter`, `calendarStatusFilter` | container-local `useState` |
| `contextFilter` | container-local `useState` |
| `selectedTaskId`, `selectedOccurrenceDate` | container-local `useState` |
| `monthCursor`, `weekCursor` | container-local `useState` |
| `nowMarker` | container-local `useState` (interval-updated) |
| `sortMode` | container-local `useState` |
| `todayCompletedOpen`, `inboxCompletedOpen` | container-local `useState` |
| `dayDetailDate` | container-local `useState` |
| `scheduleDays`, `scheduleLoading` | container-local `useState` |
| `filteredTasks` | container `useMemo` |
| `occurrenceProjectGroups` | container `useMemo` |
| `monthCells` | container `useMemo` |
| `weekDays` | container `useMemo` |
| `tasksByDate` | container `useMemo` |
| Timeline layout algorithm | `layoutTimedItems<T>()` — inline function in container |

---

## Pure Helper Functions → `src/lib/`

| Function | Old file (TasksPage.tsx line) | New file |
|---|---|---|
| `startOfDay()` | ~line 110 | `taskDateUtils.ts` |
| `toDateKey()` | ~line 115 | `taskDateUtils.ts` |
| `addDays()` | ~line 120 | `taskDateUtils.ts` |
| `addMonths()` | ~line 125 | `taskDateUtils.ts` |
| `startOfWeek()` | ~line 130 | `taskDateUtils.ts` |
| `startOfMonth()` | ~line 140 | `taskDateUtils.ts` |
| `isSameDay()` | ~line 145 | `taskDateUtils.ts` |
| `formatDateHeading()` | ~line 134 | `taskDateUtils.ts` |
| `loadScoreColor()` | inline | `taskDisplayUtils.ts` |
| `contextColor()` | inline | `taskDisplayUtils.ts` |
| `buildMonthCells()` | inline | `taskDisplayUtils.ts` |
| `parseTimeToMinutes()` | inline | `taskDisplayUtils.ts` |
| `hourLabel()` | inline | `taskDisplayUtils.ts` |
| `normalizeText()` | inline | `taskDisplayUtils.ts` |
| `mergeProjectOptions()` | inline | `taskDisplayUtils.ts` |
| `isAuthErrorMessage()` | inline | `taskDisplayUtils.ts` |
| `taskOccursOnDate()` | inline | `taskRecurrenceUtils.ts` |
| `taskWithinActivePeriod()` | inline | `taskRecurrenceUtils.ts` |

---

## Shared Types → `src/tasks/types.ts`

`SortMode`, `SidebarMode`, `CalendarMode`, `QuickFilter`, `CalendarStatusFilter`,
`RECURRENCE_TYPES`, `RECURRENCE_LABELS`, `weekdays`, `OCCURRENCE_PAGE_DAYS`,
`TIMELINE_START_HOUR`, `TIMELINE_END_HOUR`, `TIMELINE_HOUR_HEIGHT`,
`TaskDraft`, `emptyDraft()`, `taskToDraft()`, `TaskOccurrenceRow`, `toTaskStatus()`

---

## CSS Split

| New file | Rules moved from TasksPage.css |
|---|---|
| `tasks-layout.css` | `.tasks-page`, three-column grid, `.tasks-sidebar`, scrollbars, responsive breakpoints |
| `tasks-list.css` | `.task-add-panel`, `.task-list-item`, `.task-occurrence-menu`, project/date groups, occurrence rows |
| `tasks-calendar.css` | `.task-calendar-shell`, month grid, week timeline, schedule view, day-tasks panel |
| `tasks-detail.css` | `.tasks-detail`, edit sections, detail cards, status/lock toggles, weekday picker, history, attachments, subtasks, file viewer modal |

CSS class names are **100% preserved** — no renames. `TasksPage.css` (original) is kept in place but is no longer imported; `TasksPageContainer.tsx` imports the four split files instead.

---

## Unchanged API Surface

- All `tasksApi.*` call sites: identical
- All endpoint contracts: unchanged
- `TasksPage` export from `pages/TasksPage.tsx`: unchanged (router still works)
- All CSS class names: unchanged
- LBS project: not touched

---

## Key Design Decisions

**draftRef pattern**: `useTaskMutations` owns `draftRef = useRef<TaskDraft>(emptyDraft)`. The container sets `draftRef.current = draft` every render so `applyAndSave` (memoized) always reads the freshest draft without stale closure issues.

**Setter threading**: `useTaskDataLoader` exposes `setTodayRows`, `setInboxUpcomingRows`, `setInboxDoneRows`. The container passes these directly to mutation wrapper calls that need to optimistically update row state.

**Multi-select wiring**: `useTaskSelection.handleOccurrenceClick` takes 4 arguments `(event, row, orderedKeys, onOpenCallback)`. The container creates a thin closure `handleOccurrenceClick = (e, row) => _handleOccurrenceClick(e, row, orderedKeys, openCallback)`.

**selectTask / clearDetail**: Remain in the container because they set `selectedTaskId` and `selectedOccurrenceDate`, which are container-local UI state. They're passed as `onSelectTask` / `clearDetail` to `useTaskMutations`.

---

## Bug Fixes Applied During Refactor

1. **`draftRef` and `attachmentInputRef` as plain objects**: In the original extraction they were `{ current: X }` (new object each render). Fixed to `useRef<T>(init)` so the ref identity is stable and `applyAndSave`'s closure always reads the live value.

2. **`setProjectOptions` not exposed**: `useTaskDataLoader` didn't return `setProjectOptions`, but `useTaskMutations.ensureAddContextProject` needs it to update project options after creating a new project. Fixed by adding to `TaskDataLoaderActions` interface and return.

3. **`nextStatus` narrowing**: `row.status === "done" ? "todo" : "done"` was widened to `string` by TypeScript. Fixed with `as TaskStatus` cast so it satisfies `SetStateAction<TaskOccurrenceRow[]>`.

4. **`attachmentInputRef` interface type**: Declared as `RefObject<HTMLInputElement>` but `useRef<HTMLInputElement>(null)` produces `RefObject<HTMLInputElement | null>` in the React types used. Fixed the interface to `RefObject<HTMLInputElement | null>`.

5. **`formatDateHeading` import**: Was erroneously imported from `taskDisplayUtils`; it lives in `taskDateUtils`. Fixed the import in `TasksPageContainer.tsx`.
