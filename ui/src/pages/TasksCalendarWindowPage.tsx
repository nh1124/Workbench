import { useSearchParams } from "react-router-dom";
import { TasksPageContainer } from "../tasks/TasksPageContainer";
import type { CalendarMode, SidebarMode } from "../tasks/types";

export function TasksCalendarWindowPage() {
  const [searchParams] = useSearchParams();
  const initialSidebarMode: SidebarMode = searchParams.get("calendar") === "schedule"
    ? "schedule"
    : "calendar";
  const initialCalendarMode: CalendarMode = searchParams.get("view") === "week"
    ? "week"
    : "month";

  return (
    <TasksPageContainer
      standalone
      initialSidebarMode={initialSidebarMode}
      initialCalendarMode={initialCalendarMode}
    />
  );
}
