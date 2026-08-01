import { useMemo, type MouseEvent, type RefCallback } from "react";
import { buildMonthCells } from "../../lib/taskDisplayUtils";
import { isSameDay, startOfDay, toDateKey } from "../../lib/taskDateUtils";
import type { ScheduleCalendarItem, Task, TaskStatus } from "../../types/models";
import { buildTasksByDate, calendarMonthKey } from "../lib/taskCalendarUtils";
import { weekdays } from "../types";

interface CalendarMonthGridProps {
  monthCursor: Date;
  mode: "due" | "schedule";
  today: Date;
  filteredTasks: Task[];
  calendarStatusMap: Map<string, Map<string, TaskStatus>>;
  scheduleItemsByDate: Map<string, ScheduleCalendarItem[]>;
  tasksById: Map<string, Task>;
  setMonthElement: (key: string, element: HTMLElement | null) => void;
  onOpenDayDetail: (date: Date) => void;
  onSelectDueTask: (task: Task, date: Date) => void;
  onSelectScheduleItem: (item: ScheduleCalendarItem, task: Task) => void;
  onOpenCreateMenu: (event: MouseEvent<HTMLDivElement>, date: Date) => void;
}

export function CalendarMonthGrid({
  monthCursor,
  mode,
  today,
  filteredTasks,
  calendarStatusMap,
  scheduleItemsByDate,
  tasksById,
  setMonthElement,
  onOpenDayDetail,
  onSelectDueTask,
  onSelectScheduleItem,
  onOpenCreateMenu,
}: CalendarMonthGridProps) {
  const monthKey = calendarMonthKey(monthCursor);
  const monthCells = useMemo(() => buildMonthCells(monthCursor), [monthCursor]);
  const tasksByDate = useMemo(
    () => mode === "due"
      ? buildTasksByDate(filteredTasks, monthCells.map((cell) => startOfDay(cell.date)), calendarStatusMap)
      : new Map<string, Task[]>(),
    [calendarStatusMap, filteredTasks, mode, monthCells]
  );
  const monthRef = useMemo<RefCallback<HTMLElement>>(
    () => (element) => setMonthElement(monthKey, element),
    [monthKey, setMonthElement]
  );

  return (
    <section ref={monthRef} className="calendar-month-section" data-month-key={monthKey}>
      <h3 className="calendar-month-heading">
        {monthCursor.toLocaleDateString("en-US", { year: "numeric", month: "long" })}
      </h3>
      <div className="calendar-weekdays">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
      <div className="calendar-month-grid">
        {monthCells.map((cell) => {
          const dueKey = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
          const dateKey = toDateKey(cell.date);
          const dayTasks = mode === "due" ? tasksByDate.get(dueKey) || [] : [];
          const dayItems = mode === "schedule" ? scheduleItemsByDate.get(dateKey) || [] : [];
          const isToday = isSameDay(cell.date, today);
          return (
            <div
              key={cell.key}
              className={["calendar-cell", !cell.inCurrentMonth ? "muted" : "", isToday ? "is-today" : ""].filter(Boolean).join(" ")}
              onClick={() => onOpenDayDetail(cell.date)}
              onContextMenu={(event) => {
                if ((event.target as HTMLElement).closest("button")) return;
                onOpenCreateMenu(event, cell.date);
              }}
            >
              <strong>{cell.date.getDate()}</strong>
              {mode === "due" ? dayTasks.slice(0, 3).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={`calendar-task-pill${task.status === "done" ? " done" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectDueTask(task, cell.date);
                  }}
                >
                  {task.title}
                </button>
              )) : dayItems.slice(0, 3).map((item) => {
                const fullTask = tasksById.get(item.taskId);
                return (
                  <button
                    key={`${item.scheduleId ?? "auto"}::${item.occurrenceDate}::${item.taskId}`}
                    type="button"
                    className={`calendar-task-pill${item.status === "done" ? " done" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (fullTask) onSelectScheduleItem(item, fullTask);
                    }}
                    title={item.startTime ? `${item.startTime}${item.endTime ? `–${item.endTime}` : ""} ${item.title}` : item.title}
                  >
                    {item.startTime ? <span className="schedule-pill-time">{item.startTime}</span> : null}
                    {item.title}
                  </button>
                );
              })}
              {mode === "due" && dayTasks.length > 3 && (
                <small className="calendar-cell-more">+{dayTasks.length - 3}</small>
              )}
              {mode === "schedule" && dayItems.length > 3 && (
                <small className="calendar-cell-more">+{dayItems.length - 3}</small>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
