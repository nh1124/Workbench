import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { TasksPageContainer } from "../tasks/TasksPageContainer";
import { resolveStandaloneCalendarOptions } from "../tasks/lib/calendarInteractionUtils";
import type { CalendarMode, SidebarMode } from "../tasks/types";

export function TasksCalendarWindowPage() {
  const [searchParams] = useSearchParams();
  const options = resolveStandaloneCalendarOptions(searchParams);
  const initialSidebarMode: SidebarMode = options.calendar === "today"
    ? "list"
    : options.calendar === "due" ? "calendar" : "schedule";
  const initialCalendarMode: CalendarMode = options.view;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Workbench Tasks";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <TasksPageContainer
      standalone
      initialSidebarMode={initialSidebarMode}
      initialCalendarMode={initialCalendarMode}
    />
  );
}
