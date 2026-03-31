import type { ReactNode } from "react";
import { formatDateHeading } from "../../lib/taskDateUtils";
import { contextColor } from "../../lib/taskDisplayUtils";
import type { Task } from "../../types/models";
import type { OccurrenceProjectGroup } from "../lib/taskOccurrenceDisplayUtils";
import type { SortMode, TaskOccurrenceRow } from "../types";
import { IcoChevron, IcoPlus } from "./icons";

interface TaskListContentProps {
  quickFilter: "today" | "myday" | "planned" | "overdue" | "inbox";
  sortMode: SortMode;
  isLoading: boolean;
  activeOccurrenceRows: TaskOccurrenceRow[];
  tasks: Task[];
  inboxUpcomingRows: TaskOccurrenceRow[];
  inboxDoneRows: TaskOccurrenceRow[];
  inboxCompletedOpen: boolean;
  setInboxCompletedOpen: (open: boolean) => void;
  todayCompletedOpen: boolean;
  setTodayCompletedOpen: (open: boolean) => void;
  occurrenceProjectGroups: OccurrenceProjectGroup[];
  occurrenceDateGroups: { date: string; rows: TaskOccurrenceRow[] }[];
  occurrenceLoading: boolean;
  resolveContextDisplayName: (context: string, contextName?: string) => string;
  renderOccurrenceRow: (row: TaskOccurrenceRow) => ReactNode;
}

export function TaskListContent({
  quickFilter,
  sortMode,
  isLoading,
  activeOccurrenceRows,
  tasks,
  inboxUpcomingRows,
  inboxDoneRows,
  inboxCompletedOpen,
  setInboxCompletedOpen,
  todayCompletedOpen,
  setTodayCompletedOpen,
  occurrenceProjectGroups,
  occurrenceDateGroups,
  occurrenceLoading,
  resolveContextDisplayName,
  renderOccurrenceRow,
}: TaskListContentProps) {
  return (
    <section className="task-list-section">
      {activeOccurrenceRows.length === 0 && !isLoading && (
        <div style={{ textAlign: "center", opacity: 0.35, padding: "3rem 0" }}>
          <IcoPlus />
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.7rem", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.15em" }}>
            No Tasks
          </p>
        </div>
      )}

      {quickFilter === "inbox" ? (
        (() => {
          let upcomingGroups: { key: string; label: string; color?: string; rows: TaskOccurrenceRow[] }[];
          if (sortMode === "project") {
            const projectGroupMap = new Map<string, TaskOccurrenceRow[]>();
            for (const row of inboxUpcomingRows) {
              const key = row.context || "";
              projectGroupMap.set(key, [...(projectGroupMap.get(key) || []), row]);
            }
            upcomingGroups = Array.from(projectGroupMap.entries())
              .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
              .map(([key, rows]) => {
                const masterTask = tasks.find((t) => t.context === key);
                return {
                  key,
                  label: resolveContextDisplayName(key, masterTask?.contextName),
                  color: contextColor(key),
                  rows,
                };
              });
          } else {
            const dateGroupMap = new Map<string, TaskOccurrenceRow[]>();
            for (const row of inboxUpcomingRows) {
              dateGroupMap.set(row.date, [...(dateGroupMap.get(row.date) || []), row]);
            }
            upcomingGroups = Array.from(dateGroupMap.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, rows]) => ({ key: date, label: formatDateHeading(date), rows }));
          }
          return (
            <>
              {upcomingGroups.map((group) => (
                <article key={group.key} className="task-date-group">
                  <header>
                    <h4 style={group.color ? { color: group.color } : undefined}>{group.label}</h4>
                    <small>{group.rows.length}</small>
                  </header>
                  <ul>{group.rows.map(renderOccurrenceRow)}</ul>
                </article>
              ))}
              {inboxDoneRows.length > 0 && (
                <article className="task-project-block task-completed-section">
                  <header style={{ cursor: "pointer" }} onClick={() => setInboxCompletedOpen(!inboxCompletedOpen)}>
                    <h4 style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                      <span className={inboxCompletedOpen ? "task-add-more-chevron open" : "task-add-more-chevron"}><IcoChevron /></span>
                      Completed
                    </h4>
                    <small>{inboxDoneRows.length}</small>
                  </header>
                  {inboxCompletedOpen && <ul className="task-flat-occurrence-list">{inboxDoneRows.map(renderOccurrenceRow)}</ul>}
                </article>
              )}
            </>
          );
        })()
      ) : (quickFilter === "today" || quickFilter === "myday") ? (
        (() => {
          const activeRows = activeOccurrenceRows.filter((row) => row.status !== "done");
          const doneRows = activeOccurrenceRows.filter((row) => row.status === "done");
          return (
            <>
              {activeRows.length > 0 && <ul className="task-flat-occurrence-list">{activeRows.map(renderOccurrenceRow)}</ul>}
              {doneRows.length > 0 && (
                <article className="task-project-block task-completed-section">
                  <header style={{ cursor: "pointer" }} onClick={() => setTodayCompletedOpen(!todayCompletedOpen)}>
                    <h4 style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                      <span className={todayCompletedOpen ? "task-add-more-chevron open" : "task-add-more-chevron"}><IcoChevron /></span>
                      Completed
                    </h4>
                    <small>{doneRows.length}</small>
                  </header>
                  {todayCompletedOpen && <ul className="task-flat-occurrence-list">{doneRows.map(renderOccurrenceRow)}</ul>}
                </article>
              )}
            </>
          );
        })()
      ) : (quickFilter === "planned" || quickFilter === "overdue") ? (
        <>
          {(sortMode === "project"
            ? occurrenceProjectGroups.map((group) => ({
              key: group.context,
              label: group.contextName,
              dotColor: contextColor(group.context) as string | undefined,
              rows: group.rows,
            }))
            : occurrenceDateGroups.map((group) => ({
              key: group.date,
              label: formatDateHeading(group.date),
              dotColor: undefined as string | undefined,
              rows: group.rows,
            }))
          ).map((group) => (
            <article key={group.key} className="task-date-group">
              <header>
                <h4 style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                  {group.dotColor && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: group.dotColor,
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                  )}
                  {group.label}
                </h4>
                <small>{group.rows.length}</small>
              </header>
              <ul>{group.rows.map(renderOccurrenceRow)}</ul>
            </article>
          ))}
          {occurrenceLoading && (
            <p style={{ color: "#64748b", fontSize: "0.74rem", margin: "0.5rem 0 0.25rem" }}>
              Loading more...
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
