import type { ReactElement } from "react";
import type { CalendarMode, SidebarMode } from "../types";
import { IcoCal, IcoClock, IcoList } from "./icons";

/**
 * The Task List / Due Calendar / Schedule switch, for the dedicated app's title bar.
 *
 * Which of the three you are looking at applies to the whole app, so in a dedicated window
 * it belongs in the frame rather than at the top of a sidebar that is otherwise about where
 * tasks live. The sidebar keeps its own copy in the main workspace, where the frame is not
 * ours to put things in.
 */

interface TasksViewSwitcherProps {
  sidebarMode: SidebarMode;
  setSidebarMode: (mode: SidebarMode) => void;
  calendarMode: CalendarMode;
  onOpenCalendarWindow: (calendar: "due" | "schedule", view: CalendarMode) => void;
}

const VIEWS: Array<{
  mode: SidebarMode;
  label: string;
  icon: () => ReactElement;
  /** Set for the two views that can also be opened in a window of their own. */
  calendar?: "due" | "schedule";
}> = [
  { mode: "list", label: "Task List", icon: IcoList },
  { mode: "calendar", label: "Due Calendar", icon: IcoCal, calendar: "due" },
  { mode: "schedule", label: "Schedule", icon: IcoClock, calendar: "schedule" }
];

export function TasksViewSwitcher({
  sidebarMode,
  setSidebarMode,
  calendarMode,
  onOpenCalendarWindow
}: TasksViewSwitcherProps) {
  return (
    <div className="chrome-segmented" role="group" aria-label="Task view">
      {VIEWS.map((view) => {
        const Icon = view.icon;
        const active = sidebarMode === view.mode;
        return (
          <button
            key={view.mode}
            type="button"
            className={active ? "chrome-icon-button active" : "chrome-icon-button"}
            aria-pressed={active}
            aria-label={view.label}
            // The sidebar offers its own window on right-click behind a context menu. Here
            // the same right-click opens it directly, so the capability survives the move
            // rather than disappearing with the menu it used to live in.
            title={view.calendar ? `${view.label} (right-click for its own window)` : view.label}
            onClick={() => setSidebarMode(view.mode)}
            onContextMenu={
              view.calendar
                ? (event) => {
                    event.preventDefault();
                    onOpenCalendarWindow(view.calendar!, calendarMode);
                  }
                : undefined
            }
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
