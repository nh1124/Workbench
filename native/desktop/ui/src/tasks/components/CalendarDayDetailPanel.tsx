import type { Task } from "../../types/models";
import { IcoPlus, IcoX, IcoZap, StatusCircle } from "./icons";

interface CalendarDayDetailPanelProps {
  dayDetailDate: Date;
  dayDetailTasks: Task[];
  onClose: () => void;
  onSelectTask: (task: Task) => void;
  resolveContextDisplayName: (context: string, contextName?: string) => string;
  contextColor: (context: string) => string;
}

export function CalendarDayDetailPanel({
  dayDetailDate,
  dayDetailTasks,
  onClose,
  onSelectTask,
  resolveContextDisplayName,
  contextColor,
}: CalendarDayDetailPanelProps) {
  return (
    <>
      <div className="day-tasks-backdrop" onClick={onClose} />
      <div className="day-tasks-panel">
        <div className="day-tasks-head">
          <div>
            <h3>{dayDetailDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h3>
          </div>
          <button
            type="button"
            className="tasks-detail-close"
            onClick={onClose}
            aria-label="Close day details"
            title="Close day details"
          >
            <IcoX />
          </button>
        </div>
        <div className="day-tasks-body">
          {dayDetailTasks.length === 0 ? (
            <div className="day-tasks-empty"><IcoPlus /><p>Clear Schedule</p></div>
          ) : dayDetailTasks.map((task) => (
            <div key={task.id} className="day-task-card" onClick={() => onSelectTask(task)}>
              <div className="day-task-card-top">
                <StatusCircle status={task.status} />
                <span>{task.title}</span>
              </div>
              <div className="day-task-card-meta">
                <span style={{ color: contextColor(task.context) }}>
                  {resolveContextDisplayName(task.context, task.contextName)}
                </span>
                <span><IcoZap /> {task.baseLoadScore}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
