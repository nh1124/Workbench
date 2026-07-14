import { useEffect, useState } from "react";
import { contextColor } from "../../lib/taskDisplayUtils";
import type { ProjectOption } from "../../lib/taskDisplayUtils";
import type { CalendarMode, CalendarStatusFilter, QuickFilter, SidebarMode } from "../types";
import type { TaskCounters } from "../lib/taskFilterUtils";
import {
  IcoCal,
  IcoCheckCircle,
  IcoCircle,
  IcoClipboard,
  IcoClock,
  IcoFolder,
  IcoInbox,
  IcoList,
  IcoSun,
} from "./icons";

interface TasksSecondarySidebarProps {
  sidebarMode: SidebarMode;
  setSidebarMode: (mode: SidebarMode) => void;
  quickFilter: QuickFilter;
  setQuickFilter: (filter: QuickFilter) => void;
  counters: TaskCounters;
  contextFilter: string;
  setContextFilter: (value: string) => void;
  projectOptions: ProjectOption[];
  calendarStatusFilter: CalendarStatusFilter;
  setCalendarStatusFilter: (value: CalendarStatusFilter) => void;
  calendarMode: CalendarMode;
  onOpenCalendarWindow: (calendar: "due" | "schedule", view: CalendarMode) => void;
}

export function TasksSecondarySidebar({
  sidebarMode,
  setSidebarMode,
  quickFilter,
  setQuickFilter,
  counters,
  contextFilter,
  setContextFilter,
  projectOptions,
  calendarStatusFilter,
  setCalendarStatusFilter,
  calendarMode,
  onOpenCalendarWindow,
}: TasksSecondarySidebarProps) {
  const [calendarMenu, setCalendarMenu] = useState<{
    calendar: "due" | "schedule";
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!calendarMenu) return;
    const close = () => setCalendarMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [calendarMenu]);

  const openContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    calendar: "due" | "schedule"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setCalendarMenu({ calendar, x: event.clientX, y: event.clientY });
  };

  return (
    <aside className="tasks-secondary">
      <header className="tasks-secondary-head">
        <h2><IcoClipboard /> Tasks</h2>
      </header>
      <div className="tasks-secondary-group" style={{ borderTop: 0, paddingTop: 0 }}>
        <button type="button" className={sidebarMode === "list" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setSidebarMode("list")}><IcoList /> Task List</button>
        <button type="button" className={sidebarMode === "calendar" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setSidebarMode("calendar")} onContextMenu={(event) => openContextMenu(event, "due")}><IcoCal /> Due Calendar</button>
        <button type="button" className={sidebarMode === "schedule" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setSidebarMode("schedule")} onContextMenu={(event) => openContextMenu(event, "schedule")}><IcoCal /> Schedule</button>
      </div>

      {sidebarMode === "list" && (
        <>
          <div className="tasks-secondary-group">
            <p>Task Filters</p>
            <button type="button" className={quickFilter === "today" ? "filter-item quick-filter active" : "filter-item quick-filter"} onClick={() => setQuickFilter("today")}>
              <span className="filter-item-left"><IcoSun /><span>Today</span></span><small>{counters.today}</small>
            </button>
            <button type="button" className={quickFilter === "myday" ? "filter-item quick-filter active" : "filter-item quick-filter"} onClick={() => setQuickFilter("myday")}>
              <span className="filter-item-left"><IcoCheckCircle /><span>My Day</span></span><small>{counters.myday}</small>
            </button>
            <button type="button" className={quickFilter === "planned" ? "filter-item quick-filter active" : "filter-item quick-filter"} onClick={() => setQuickFilter("planned")}>
              <span className="filter-item-left"><IcoCal /><span>Planned</span></span><small>{counters.planned}</small>
            </button>
            <button type="button" className={quickFilter === "overdue" ? "filter-item quick-filter active" : "filter-item quick-filter"} onClick={() => setQuickFilter("overdue")}>
              <span className="filter-item-left"><IcoClock /><span>Overdue</span></span><small>{counters.overdue}</small>
            </button>
            <button type="button" className={quickFilter === "inbox" ? "filter-item quick-filter active" : "filter-item quick-filter"} onClick={() => setQuickFilter("inbox")}>
              <span className="filter-item-left"><IcoInbox /><span>Inbox</span></span><small>{counters.inbox}</small>
            </button>
          </div>
          <div className="tasks-secondary-group">
            <p>Projects</p>
            <button type="button" className={contextFilter === "" ? "filter-item active" : "filter-item"} onClick={() => setContextFilter("")}>
              <span className="filter-item-left"><IcoFolder /><span>All Projects</span></span>
            </button>
            {projectOptions.map((p) => (
              <button key={p.projectId} type="button"
                className={contextFilter === p.projectId ? "filter-item project-filter-item active" : "filter-item project-filter-item"}
                onClick={() => setContextFilter(p.projectId)}>
                <span className="filter-item-left">
                  <span
                    className="project-color-dot"
                    style={{ background: contextColor(p.projectId) }}
                  />
                  <span>{p.projectName || p.projectId}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {(sidebarMode === "calendar" || sidebarMode === "schedule") && (
        <>
          <div className="tasks-secondary-group">
            <p>Calendar Status</p>
            <button type="button" className={calendarStatusFilter === "all" ? "filter-item active" : "filter-item"} onClick={() => setCalendarStatusFilter("all")}>
              <span className="filter-item-left"><IcoFolder /><span>All Status</span></span>
            </button>
            <button type="button" className={calendarStatusFilter === "open" ? "filter-item active" : "filter-item"} onClick={() => setCalendarStatusFilter("open")}>
              <span className="filter-item-left"><IcoCircle /><span>Open Only</span></span>
            </button>
            <button type="button" className={calendarStatusFilter === "done" ? "filter-item active" : "filter-item"} onClick={() => setCalendarStatusFilter("done")}>
              <span className="filter-item-left"><IcoCheckCircle /><span>Done Only</span></span>
            </button>
          </div>
          <div className="tasks-secondary-group">
            <p>Projects</p>
            <button type="button" className={contextFilter === "" ? "filter-item active" : "filter-item"} onClick={() => setContextFilter("")}>
              <span className="filter-item-left"><IcoFolder /><span>All Projects</span></span>
            </button>
            {projectOptions.map((p) => (
              <button key={p.projectId} type="button"
                className={contextFilter === p.projectId ? "filter-item project-filter-item active" : "filter-item project-filter-item"}
                onClick={() => setContextFilter(p.projectId)}>
                <span className="filter-item-left">
                  <span
                    className="project-color-dot"
                    style={{ background: contextColor(p.projectId) }}
                  />
                  <span>{p.projectName || p.projectId}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {calendarMenu && (
        <div
          className="task-occurrence-menu"
          style={{ left: calendarMenu.x, top: calendarMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              onOpenCalendarWindow(calendarMenu.calendar, calendarMode);
              setCalendarMenu(null);
            }}
          >
            別ウィンドウで開く
          </button>
        </div>
      )}
    </aside>
  );
}
