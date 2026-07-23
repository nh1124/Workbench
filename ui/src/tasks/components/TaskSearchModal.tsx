import { useEffect, useMemo, useState } from "react";
import {
  contextColor,
  type ProjectOption,
} from "../../lib/taskDisplayUtils";
import type { Task } from "../../types/models";
import { searchTasks } from "../lib/taskFilterUtils";
import { IcoX } from "./icons";

export interface TaskSearchModalProps {
  open: boolean;
  tasks: Task[];
  loading: boolean;
  projectOptions: ProjectOption[];
  onClose: () => void;
  onSelectTask: (task: Task) => void;
  resolveContextDisplayName: (context: string, contextName?: string) => string;
}

export function TaskSearchModal({
  open,
  tasks,
  loading,
  projectOptions,
  onClose,
  onSelectTask,
  resolveContextDisplayName,
}: TaskSearchModalProps) {
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [status, setStatus] = useState<Task["status"] | "all">("all");

  const results = useMemo(
    () => searchTasks(tasks, { query, projectId, status }).slice(0, 50),
    [projectId, query, status, tasks]
  );

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="file-viewer-overlay" role="presentation" onClick={onClose}>
      <section
        className="file-viewer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-search-title"
        onClick={(event) => event.stopPropagation()}
        style={{ width: "min(92vw, 760px)", height: "min(82vh, 680px)" }}
      >
        <header className="file-viewer-header">
          <strong id="task-search-title">Search tasks</strong>
          <button
            type="button"
            className="file-viewer-close"
            onClick={onClose}
            aria-label="Close task search"
            title="Close task search"
          >
            <IcoX />
          </button>
        </header>

        <div
          className="file-viewer-body"
          style={{
            alignItems: "stretch",
            justifyContent: "flex-start",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "1rem",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, notes, or project…"
              aria-label="Search all tasks"
              style={{
                flex: "1 1 16rem",
                minWidth: "12rem",
                border: "1px solid rgba(71, 85, 105, 0.6)",
                borderRadius: "6px",
                background: "rgba(30, 41, 59, 0.8)",
                color: "#e2e8f0",
                padding: "0.45rem 0.6rem",
                outline: "none",
              }}
            />
            <select
              className="sort-select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label="Filter search by project"
            >
              <option value="all">All projects</option>
              {projectOptions.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.projectName?.trim() || project.projectId}
                </option>
              ))}
            </select>
            <select
              className="sort-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as Task["status"] | "all")}
              aria-label="Filter search by status"
            >
              <option value="all">All statuses</option>
              <option value="todo">todo</option>
              <option value="done">done</option>
              <option value="skipped">skipped</option>
            </select>
          </div>

          {loading && tasks.length === 0 ? (
            <p style={{ margin: "auto", color: "#94a3b8" }}>Loading…</p>
          ) : results.length === 0 ? (
            <p style={{ margin: "auto", color: "#94a3b8" }}>No results</p>
          ) : (
            <ul
              className="task-flat-occurrence-list"
              style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
            >
              {results.map((task) => (
                <li key={task.id} className="task-list-item">
                  <button
                    type="button"
                    className="task-list-main"
                    onClick={() => {
                      onSelectTask(task);
                      onClose();
                    }}
                    style={{ width: "100%", textAlign: "left" }}
                  >
                    <span className={`task-title${task.status === "done" ? " done" : ""}`}>
                      {task.title}
                    </span>
                    <span
                      className="context-badge"
                      style={{ color: contextColor(task.context) }}
                    >
                      {resolveContextDisplayName(task.context, task.contextName)}
                    </span>
                    <span
                      style={{
                        marginLeft: "auto",
                        color: "#94a3b8",
                        fontSize: "0.7rem",
                        textTransform: "capitalize",
                      }}
                    >
                      {task.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
