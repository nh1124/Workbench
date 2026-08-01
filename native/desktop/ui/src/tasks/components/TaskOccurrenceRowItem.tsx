import type { MouseEvent as ReactMouseEvent } from "react";
import { formatDateHeading } from "../../lib/taskDateUtils";
import { loadScoreColor } from "../../lib/taskDisplayUtils";
import type { TaskOccurrenceRow } from "../types";
import { IcoChevron, IcoClock, IcoLock, IcoZap, StatusCircle } from "./icons";

interface TaskOccurrenceRowItemProps {
  row: TaskOccurrenceRow;
  selected: boolean;
  contextName: string;
  contextColorValue: string;
  onToggleDone: (row: TaskOccurrenceRow) => void;
  onOpen: (event: ReactMouseEvent<HTMLButtonElement>, row: TaskOccurrenceRow) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, row: TaskOccurrenceRow) => void;
}

export function TaskOccurrenceRowItem({
  row,
  selected,
  contextName,
  contextColorValue,
  onToggleDone,
  onOpen,
  onOpenContextMenu,
}: TaskOccurrenceRowItemProps) {
  const itemClass = [
    selected ? "task-list-item active" : "task-list-item",
    selected ? "occurrence-selected" : "",
  ].filter(Boolean).join(" ");

  return (
    <li>
      <div className={itemClass}>
        <button type="button" className="task-circle"
          onClick={() => onToggleDone(row)} aria-label="Toggle done">
          <StatusCircle status={row.status} />
        </button>
        <button type="button" className="task-list-main"
          onClick={(event) => onOpen(event, row)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenContextMenu(event, row);
          }}>
          <span className={`task-title${row.status === "done" ? " done" : ""}`}>{row.title}</span>
          <span className="task-meta-row">
            {typeof row.load === "number" && (
              <span className="load-badge" style={{ color: loadScoreColor(row.load), borderColor: loadScoreColor(row.load) }}>
                <IcoZap />{row.load}
              </span>
            )}
            <span className="context-badge" style={{ color: contextColorValue }}>{contextName}</span>
            {row.status !== "done" && <span className="due-badge">{formatDateHeading(row.date)}</span>}
            {(row.startTime || row.endTime) && (
              <span className="time-badge"><IcoClock />{row.startTime || "--:--"}{row.endTime ? ` - ${row.endTime}` : ""}</span>
            )}
            {row.isLocked && <span style={{ color: "#fbbf24" }}><IcoLock /></span>}
          </span>
        </button>
        <span style={{ color: "#374151", flexShrink: 0 }}><IcoChevron /></span>
      </div>
    </li>
  );
}
