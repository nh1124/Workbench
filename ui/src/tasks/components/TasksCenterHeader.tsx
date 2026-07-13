import type { ChangeEvent, RefObject } from "react";
import type { CalendarMode, SidebarMode, SortMode } from "../types";
import { IcoCal, IcoDownload, IcoList, IcoRefresh, IcoUpload } from "./icons";

interface TasksCenterHeaderProps {
  sidebarMode: SidebarMode;
  calendarMode: CalendarMode;
  periodLabel: string;
  onMovePrevPeriod: () => void;
  onJumpToday: () => void;
  onMoveNextPeriod: () => void;
  onSetCalendarMode: (mode: CalendarMode) => void;
  onRefreshList: () => void;
  onRefreshSchedule: () => void;
  sortMode: SortMode;
  onSetSortMode: (mode: SortMode) => void;
  onExport: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  importRef: RefObject<HTMLInputElement | null>;
  onOpenAddPanel: () => void;
  standalone?: boolean;
  onSetCalendarKind?: (mode: "calendar" | "schedule") => void;
}

export function TasksCenterHeader({
  sidebarMode,
  calendarMode,
  periodLabel,
  onMovePrevPeriod,
  onJumpToday,
  onMoveNextPeriod,
  onSetCalendarMode,
  onRefreshList,
  onRefreshSchedule,
  sortMode,
  onSetSortMode,
  onExport,
  onImport,
  importRef,
  onOpenAddPanel,
  standalone = false,
  onSetCalendarKind,
}: TasksCenterHeaderProps) {
  if (sidebarMode === "calendar" || sidebarMode === "schedule") {
    return (
      <header className="tasks-center-head tasks-center-head-calendar">
        <div className="calendar-nav-cluster">
          <button type="button" className="calendar-nav-btn" onClick={onMovePrevPeriod} aria-label="Previous period" title="Previous period">{"<"}</button>
          <button type="button" className="calendar-nav-today" onClick={onJumpToday} aria-label="Jump to today" title="Jump to today">Today</button>
          <button type="button" className="calendar-nav-btn" onClick={onMoveNextPeriod} aria-label="Next period" title="Next period">{">"}</button>
          <strong>{periodLabel}</strong>
        </div>
        <div className="tasks-head-actions calendar-head-actions">
          {standalone && (
            <div className="calendar-kind-toggle" aria-label="Calendar kind">
              <button type="button" className={sidebarMode === "calendar" ? "active" : ""} onClick={() => onSetCalendarKind?.("calendar")}>Due</button>
              <button type="button" className={sidebarMode === "schedule" ? "active" : ""} onClick={() => onSetCalendarKind?.("schedule")}>Schedule</button>
            </div>
          )}
          <div className="calendar-view-toggle">
            <button type="button" className={calendarMode === "month" ? "active" : ""} onClick={() => onSetCalendarMode("month")} aria-label="Month view" title="Month view"><IcoCal /></button>
            <button type="button" className={calendarMode === "week" ? "active" : ""} onClick={() => onSetCalendarMode("week")} aria-label="Week view" title="Week view"><IcoList /></button>
          </div>
          {sidebarMode === "schedule"
            ? <button type="button" className="icon-button" onClick={onRefreshSchedule} title="Refresh Schedule" aria-label="Refresh schedule"><IcoRefresh /></button>
            : <button type="button" className="icon-button" onClick={onRefreshList} title="Refresh" aria-label="Refresh list"><IcoRefresh /></button>
          }
        </div>
      </header>
    );
  }

  return (
    <header className="tasks-center-head">
      <div>
        <p>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
      </div>
      <div className="tasks-head-actions">
        <select className="sort-select" value={sortMode} onChange={(e) => onSetSortMode(e.target.value as SortMode)} aria-label="Sort task list">
          <option value="load">Sort: Load</option>
          <option value="due">Sort: Due Date</option>
          <option value="project">Sort: Project</option>
        </select>
        <button type="button" className="icon-button" onClick={onExport} title="Export CSV" aria-label="Export CSV"><IcoDownload /></button>
        <button type="button" className="icon-button" onClick={() => importRef.current?.click()} title="Import CSV" aria-label="Import CSV"><IcoUpload /></button>
        <input ref={importRef} type="file" accept=".csv" style={{ display: "none" }} onChange={onImport} aria-label="Import CSV file" />
        <button type="button" className="icon-button" onClick={onRefreshList} title="Refresh" aria-label="Refresh list"><IcoRefresh /></button>
        <button type="button" className="tasks-add-btn" onClick={onOpenAddPanel}>+ Add</button>
      </div>
    </header>
  );
}
