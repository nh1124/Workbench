import type {
  Dispatch,
  DragEvent,
  RefObject,
  SetStateAction
} from "react";
import { formatDateTime } from "../../lib/format";
import { loadScoreColor, type ProjectOption } from "../../lib/taskDisplayUtils";
import type {
  Task,
  TaskAttachment,
  TaskHistoryEntry,
  TaskSubtask
} from "../../types/models";
import {
  RECURRENCE_LABELS,
  RECURRENCE_TYPES,
  weekdays,
  type TaskDraft
} from "../types";
import type { ScheduleDraft } from "../hooks/useTaskMutations";
import {
  IcoCheckCircle,
  IcoChevronDown,
  IcoCircle,
  IcoFile,
  IcoHistory,
  IcoLock,
  IcoSkipped,
  IcoTrash,
  IcoUnlock,
  IcoX
} from "./icons";

function formatScheduleTime(draft: TaskDraft): string {
  const start = draft.startTime || "--:--";
  const end = draft.endTime || "--:--";
  return `${start} - ${end} / ${draft.timezone || "Asia/Tokyo"}`;
}

function describeRecurringSchedule(draft: TaskDraft): string {
  if (draft.recurrence === "WEEKLY") {
    const selected = [
      draft.sun, draft.mon, draft.tue, draft.wed, draft.thu, draft.fri, draft.sat
    ]
      .map((enabled, index) => enabled ? weekdays[index] : "")
      .filter(Boolean);
    return selected.length > 0 ? `Every ${selected.join(", ")}` : "Weekly";
  }
  if (draft.recurrence === "EVERY_N_DAYS") {
    const anchor = draft.anchorDate ? ` from ${draft.anchorDate}` : "";
    return `Every ${Math.max(1, draft.intervalDays || 1)} day(s)${anchor}`;
  }
  if (draft.recurrence === "MONTHLY_DAY") {
    return `Day ${Math.min(31, Math.max(1, draft.monthDay || 1))} of each month`;
  }
  if (draft.recurrence === "MONTHLY_NTH_WEEKDAY") {
    const nth = Math.min(5, Math.max(1, draft.nthInMonth || 1));
    const weekday = weekdays[Math.min(6, Math.max(0, draft.weekdayMon1 || 0))];
    return `${nth}${nth === 1 ? "st" : nth === 2 ? "nd" : nth === 3 ? "rd" : "th"} ${weekday} of each month`;
  }
  return "Once";
}

export interface TaskDetailPanelProps {
  selectedTask: Task;
  draft: TaskDraft;
  setDraft: Dispatch<SetStateAction<TaskDraft>>;
  isSaving: boolean;
  displayError: string | null;
  clearDetail: () => void;
  applyAndSave: (update: Partial<TaskDraft>) => void;

  subtasksLoading: boolean;
  subtasks: TaskSubtask[];
  newSubtaskTitle: string;
  setNewSubtaskTitle: Dispatch<SetStateAction<string>>;
  handleAddSubtask: () => Promise<void>;
  handleToggleSubtask: (subtask: TaskSubtask) => Promise<void>;
  handleDeleteSubtask: (subtaskId: string) => Promise<void>;

  projectOptions: ProjectOption[];

  scheduleItemId: number | null;
  scheduleItemLoading: boolean;
  scheduleDraft: ScheduleDraft | null;
  setScheduleDraft: Dispatch<SetStateAction<ScheduleDraft | null>>;
  handleSaveScheduleItem: () => Promise<void>;
  handleRemoveScheduleItem: () => Promise<void>;

  advancedOpen: boolean;
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>;

  attachmentsLoading: boolean;
  attachments: TaskAttachment[];
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  isDraggingOver: boolean;
  setIsDraggingOver: Dispatch<SetStateAction<boolean>>;
  handleAttachFiles: (files: FileList | File[]) => Promise<void>;
  handleAttachmentDrop: (e: DragEvent<HTMLDivElement>) => void;
  handleOpenFileViewer: (att: TaskAttachment) => Promise<void>;
  handleDeleteAttachment: (attachmentId: string) => Promise<void>;

  historyOpen: boolean;
  historyLoading: boolean;
  history: TaskHistoryEntry[];
  handleHistoryToggle: () => void;

  handleDeleteDetail: () => Promise<void>;
}

export function TaskDetailPanel({
  selectedTask,
  draft,
  setDraft,
  isSaving,
  displayError,
  clearDetail,
  applyAndSave,
  subtasksLoading,
  subtasks,
  newSubtaskTitle,
  setNewSubtaskTitle,
  handleAddSubtask,
  handleToggleSubtask,
  handleDeleteSubtask,
  projectOptions,
  scheduleItemId,
  scheduleItemLoading,
  scheduleDraft,
  setScheduleDraft,
  handleSaveScheduleItem,
  handleRemoveScheduleItem,
  advancedOpen,
  setAdvancedOpen,
  attachmentsLoading,
  attachments,
  attachmentInputRef,
  isDraggingOver,
  setIsDraggingOver,
  handleAttachFiles,
  handleAttachmentDrop,
  handleOpenFileViewer,
  handleDeleteAttachment,
  historyOpen,
  historyLoading,
  history,
  handleHistoryToggle,
  handleDeleteDetail
}: TaskDetailPanelProps) {
  return (
    <>
      <button
        type="button"
        className="tasks-detail-backdrop"
        onClick={clearDetail}
        aria-label="Close detail panel"
      />
      <aside className="tasks-detail">
        <div className="tasks-detail-head">
          <div className="tasks-detail-head-left">
            <button
              type="button"
              className={`detail-status-btn ${draft.status}`}
              onClick={() =>
                applyAndSave({
                  status:
                    draft.status === "todo"
                      ? "done"
                      : draft.status === "done"
                      ? "skipped"
                      : "todo"
                })
              }
              title={`Status: ${draft.status}`}
              aria-label={`Task status ${draft.status}`}
            >
              {draft.status === "done" ? (
                <IcoCheckCircle />
              ) : draft.status === "skipped" ? (
                <IcoSkipped />
              ) : (
                <IcoCircle />
              )}
            </button>
            <input
              className="tasks-detail-title-input"
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              onBlur={(e) => applyAndSave({ title: e.target.value })}
              placeholder="Task title"
              aria-label="Task title"
            />
          </div>
          <div className="tasks-detail-head-actions">
            {isSaving && <span className="auto-save-dot" title="Saving..." />}
            <button
              type="button"
              className={`detail-lock-btn${draft.isLocked ? " active" : ""}`}
              onClick={() => applyAndSave({ isLocked: !draft.isLocked })}
              title={
                draft.isLocked
                  ? "Locked - click to unlock"
                  : "Unlocked - click to lock"
              }
              aria-label={draft.isLocked ? "Unlock task" : "Lock task"}
            >
              {draft.isLocked ? <IcoLock /> : <IcoUnlock />}
            </button>
            <button
              type="button"
              className="tasks-detail-close"
              onClick={clearDetail}
              aria-label="Close"
            >
              <IcoX />
            </button>
          </div>
        </div>

        <div className="tasks-detail-body">
          {displayError && (
            <p className="error" style={{ margin: 0, fontSize: "0.8rem" }}>
              {displayError}
            </p>
          )}

          <div className="edit-section subtask-section-top">
            {subtasksLoading ? (
              <p style={{ color: "#6b7280", fontSize: "0.75rem", margin: "0.4rem 0" }}>
                Loading...
              </p>
            ) : (
              <div className="subtask-list">
                {subtasks.map((s) => (
                  <div key={s.id} className="subtask-row">
                    <button
                      type="button"
                      className={`subtask-check${s.isDone ? " done" : ""}`}
                      onClick={() => {
                        void handleToggleSubtask(s);
                      }}
                      aria-label={s.isDone ? `Mark subtask not done: ${s.title}` : `Mark subtask done: ${s.title}`}
                      title={s.isDone ? "Mark as not done" : "Mark as done"}
                    >
                      {s.isDone ? <IcoCheckCircle /> : <IcoCircle />}
                    </button>
                    <span className={`subtask-title${s.isDone ? " done" : ""}`}>{s.title}</span>
                    <button
                      type="button"
                      className="attachment-delete"
                      onClick={() => {
                        void handleDeleteSubtask(s.id);
                      }}
                      aria-label={`Delete subtask: ${s.title}`}
                      title="Delete subtask"
                    >
                      <IcoX />
                    </button>
                  </div>
                ))}
                <div className="subtask-add-row">
                  <input
                    className="subtask-add-input"
                    placeholder="+ Next step"
                    value={newSubtaskTitle}
                    aria-label="Add subtask"
                    onChange={(e) => setNewSubtaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void handleAddSubtask();
                      }
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="edit-two-col">
            <div className="edit-section">
              <div className="edit-section-label">Context</div>
              <select
                className="edit-input"
                value={draft.context}
                aria-label="Context"
                onChange={(e) => applyAndSave({ context: e.target.value })}
              >
                <option value="">Select context</option>
                {projectOptions.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.projectName || p.projectId}
                  </option>
                ))}
              </select>
            </div>
            <div className="edit-section">
              <div className="edit-section-label">Load (0-10)</div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={draft.baseLoadScore}
                  aria-label="Load score"
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, baseLoadScore: Number(e.target.value) }))
                  }
                  onMouseUp={(e) =>
                    applyAndSave({ baseLoadScore: Number((e.target as HTMLInputElement).value) })
                  }
                  onTouchEnd={(e) =>
                    applyAndSave({ baseLoadScore: Number((e.target as HTMLInputElement).value) })
                  }
                  style={{ flex: 1 }}
                />
                <span
                  className="load-badge"
                  style={{
                    color: loadScoreColor(draft.baseLoadScore),
                    borderColor: loadScoreColor(draft.baseLoadScore),
                    flexShrink: 0
                  }}
                >
                  {draft.baseLoadScore}
                </span>
              </div>
            </div>
          </div>

          <div className="edit-section">
            <div className="edit-section-label">Recurrence</div>
            <select
              className="edit-input"
              value={draft.recurrence}
              aria-label="Recurrence"
              onChange={(e) =>
                applyAndSave({ recurrence: e.target.value as typeof draft.recurrence })
              }
            >
              {RECURRENCE_TYPES.map((r) => (
                <option key={r} value={r}>
                  {RECURRENCE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>

          {draft.recurrence === "WEEKLY" && (
            <div className="edit-section">
              <div className="edit-section-label">Days</div>
              <div className="weekday-picker">
                {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    className={draft[d] ? "weekday-btn active" : "weekday-btn"}
                    onClick={() => applyAndSave({ [d]: !draft[d] })}
                    aria-label={`Toggle ${weekdays[i]}`}
                  >
                    {weekdays[i]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {draft.recurrence === "EVERY_N_DAYS" && (
            <>
              <div className="edit-section">
                <div className="edit-section-label">Every N Days</div>
                <input
                  type="number"
                  min={1}
                  className="edit-input"
                  value={draft.intervalDays}
                  aria-label="Every N days interval"
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, intervalDays: Number(e.target.value) }))
                  }
                  onBlur={(e) => applyAndSave({ intervalDays: Number(e.target.value) })}
                />
              </div>
              <div className="edit-section">
                <div className="edit-section-label">Anchor Date</div>
                <input
                  type="date"
                  className="edit-input"
                  value={draft.anchorDate}
                  aria-label="Anchor date"
                  onChange={(e) => applyAndSave({ anchorDate: e.target.value })}
                />
              </div>
            </>
          )}
          {draft.recurrence === "MONTHLY_DAY" && (
            <div className="edit-section">
              <div className="edit-section-label">Day of Month</div>
              <input
                type="number"
                min={1}
                max={31}
                className="edit-input"
                value={draft.monthDay}
                aria-label="Day of month"
                onChange={(e) => setDraft((p) => ({ ...p, monthDay: Number(e.target.value) }))}
                onBlur={(e) => applyAndSave({ monthDay: Number(e.target.value) })}
              />
            </div>
          )}
          {draft.recurrence === "MONTHLY_NTH_WEEKDAY" && (
            <div className="edit-two-col">
              <div className="edit-section">
                <div className="edit-section-label">Nth Week</div>
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="edit-input"
                  value={draft.nthInMonth}
                  aria-label="Nth week of month"
                  onChange={(e) => setDraft((p) => ({ ...p, nthInMonth: Number(e.target.value) }))}
                  onBlur={(e) => applyAndSave({ nthInMonth: Number(e.target.value) })}
                />
              </div>
              <div className="edit-section">
                <div className="edit-section-label">Weekday</div>
                <select
                  className="edit-input"
                  value={draft.weekdayMon1}
                  aria-label="Weekday for monthly nth recurrence"
                  onChange={(e) => applyAndSave({ weekdayMon1: Number(e.target.value) })}
                >
                  {weekdays.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="detail-card">
            <div className="detail-card-label">Due Date</div>
            {draft.recurrence === "ONCE" ? (
              <input
                type="date"
                className="edit-input detail-card-date"
                value={draft.dueDate}
                aria-label="Due date"
                onChange={(e) => applyAndSave({ dueDate: e.target.value })}
              />
            ) : (
              <p className="detail-card-recurring-note">Recurring - controlled by recurrence</p>
            )}
            <div className="edit-two-col" style={{ marginTop: "0.45rem" }}>
              <div className="edit-section">
                <div className="edit-section-label">Start Time</div>
                <input
                  type="time"
                  className="edit-input"
                  value={draft.startTime}
                  aria-label="Start time"
                  onChange={(e) => applyAndSave({ startTime: e.target.value })}
                />
              </div>
              <div className="edit-section">
                <div className="edit-section-label">End Time</div>
                <input
                  type="time"
                  className="edit-input"
                  value={draft.endTime}
                  aria-label="End time"
                  onChange={(e) => applyAndSave({ endTime: e.target.value })}
                />
              </div>
            </div>
            <div className="edit-section" style={{ marginTop: "0.45rem" }}>
              <div className="edit-section-label">Timezone</div>
              <input
                className="edit-input"
                value={draft.timezone}
                aria-label="Timezone"
                onChange={(e) => setDraft((p) => ({ ...p, timezone: e.target.value }))}
                onBlur={(e) => applyAndSave({ timezone: e.target.value })}
                placeholder="e.g. Asia/Tokyo"
              />
            </div>
          </div>

          <div className="detail-card">
            <div className="detail-card-label-row">
              <span className="detail-card-label">
                {draft.recurrence === "ONCE" ? "Scheduled Date" : "Schedule"}
              </span>
              {scheduleItemId != null && (
                <button
                  type="button"
                  className="detail-card-remove-btn"
                  onClick={() => {
                    void handleRemoveScheduleItem();
                  }}
                  aria-label="Remove scheduled date"
                  title="Remove scheduled date"
                >
                  <IcoX />
                </button>
              )}
            </div>
            {scheduleItemLoading ? (
              <p className="detail-card-loading">Loading...</p>
            ) : scheduleDraft && draft.recurrence !== "ONCE" && scheduleItemId == null ? (
              <>
                <div className="schedule-recurrence-summary">
                  <span>{RECURRENCE_LABELS[draft.recurrence]}</span>
                  <strong>{describeRecurringSchedule(draft)}</strong>
                  <small>Time: {formatScheduleTime(draft)}</small>
                  {(draft.activeFrom || draft.activeUntil) && (
                    <small>
                      Active: {draft.activeFrom || "start"} - {draft.activeUntil || "open"}
                    </small>
                  )}
                </div>
                <p className="detail-card-recurring-note">
                  Repeating schedule is generated from Recurrence and the Start/End/Timezone above.
                </p>
                <button
                  type="button"
                  className="schedule-override-btn"
                  onClick={() => {
                    void handleSaveScheduleItem();
                  }}
                >
                  Customize this occurrence
                </button>
              </>
            ) : scheduleDraft ? (
              <>
                {draft.recurrence !== "ONCE" && (
                  <p className="detail-card-recurring-note schedule-override-note">
                    Manual override for this occurrence.
                  </p>
                )}
                <input
                  type="date"
                  className={`edit-input detail-card-date${scheduleItemId != null ? " has-value" : ""}`}
                  value={scheduleDraft.scheduledDate}
                  aria-label="Scheduled date"
                  onChange={(e) =>
                    setScheduleDraft((p) =>
                      p ? { ...p, scheduledDate: e.target.value } : p
                    )
                  }
                  onBlur={() => {
                    void handleSaveScheduleItem();
                  }}
                />
                <div className="edit-two-col" style={{ marginTop: "0.45rem" }}>
                  <div className="edit-section">
                    <div className="edit-section-label">Start Time</div>
                    <input
                      type="time"
                      className="edit-input"
                      value={scheduleDraft.startTime}
                      aria-label="Scheduled start time"
                      onChange={(e) =>
                        setScheduleDraft((p) => (p ? { ...p, startTime: e.target.value } : p))
                      }
                      onBlur={() => {
                        void handleSaveScheduleItem();
                      }}
                    />
                  </div>
                  <div className="edit-section">
                    <div className="edit-section-label">End Time</div>
                    <input
                      type="time"
                      className="edit-input"
                      value={scheduleDraft.endTime}
                      aria-label="Scheduled end time"
                      onChange={(e) =>
                        setScheduleDraft((p) => (p ? { ...p, endTime: e.target.value } : p))
                      }
                      onBlur={() => {
                        void handleSaveScheduleItem();
                      }}
                    />
                  </div>
                </div>
                <div className="edit-section" style={{ marginTop: "0.45rem" }}>
                  <div className="edit-section-label">Timezone</div>
                  <input
                    className="edit-input"
                    value={scheduleDraft.timezone}
                    aria-label="Scheduled timezone"
                    onChange={(e) =>
                      setScheduleDraft((p) => (p ? { ...p, timezone: e.target.value } : p))
                    }
                    onBlur={() => {
                      void handleSaveScheduleItem();
                    }}
                    placeholder="e.g. Asia/Tokyo"
                  />
                </div>
              </>
            ) : null}
          </div>

          <div className="edit-section">
            <div className="edit-section-label">Notes</div>
            <textarea
              className="edit-input"
              rows={4}
              value={draft.notes}
              aria-label="Notes"
              onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
              onBlur={(e) => applyAndSave({ notes: e.target.value })}
              placeholder="Notes..."
            />
          </div>

          <div className="edit-section">
            <button
              type="button"
              className="history-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              <IcoHistory />
              <span>Advanced Setting</span>
              <span
                style={{
                  marginLeft: "auto",
                  transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.15s"
                }}
              >
                <IcoChevronDown />
              </span>
            </button>
            {advancedOpen && (
              <div className="history-body advanced-body">
                {draft.recurrence !== "ONCE" && (
                  <div className="edit-two-col" style={{ padding: "0 0.2rem 0.45rem" }}>
                    <div className="edit-section">
                      <div className="edit-section-label">Active From</div>
                      <input
                        type="date"
                        className="edit-input"
                        value={draft.activeFrom}
                        onChange={(e) => applyAndSave({ activeFrom: e.target.value })}
                      />
                    </div>
                    <div className="edit-section">
                      <div className="edit-section-label">Active Until</div>
                      <input
                        type="date"
                        className="edit-input"
                        value={draft.activeUntil}
                        onChange={(e) => applyAndSave({ activeUntil: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="edit-section">
            <div
              className="edit-section-label"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
            >
              <span>Files</span>
              <button
                type="button"
                className="ghost-button"
                style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem" }}
                onClick={() => attachmentInputRef.current?.click()}
                aria-label="Add attachment"
              >
                + Add
              </button>
            </div>
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              aria-label="Attachment files"
              onChange={(e) => {
                if (!e.target.files) return;
                void handleAttachFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div
              className={`attachment-drop-zone${isDraggingOver ? " dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingOver(true);
              }}
              onDragLeave={() => setIsDraggingOver(false)}
              onDrop={handleAttachmentDrop}
            >
              {attachmentsLoading ? (
                <p style={{ color: "#6b7280", fontSize: "0.75rem", margin: "0.4rem 0" }}>
                  Loading...
                </p>
              ) : attachments.length === 0 ? (
                <p style={{ color: "#4b5563", fontSize: "0.75rem", margin: "0.4rem 0" }}>
                  Drop files here or use Add
                </p>
              ) : (
                <div className="attachment-list">
                  {attachments.map((att) => (
                    <div key={att.id} className="attachment-row">
                      <IcoFile />
                      <button
                        type="button"
                        className="attachment-name"
                        onClick={() => {
                          void handleOpenFileViewer(att);
                        }}
                        aria-label={`Open attachment: ${att.filename}`}
                      >
                        {att.filename}
                      </button>
                      {att.sizeBytes != null && (
                        <span className="attachment-size">
                          {att.sizeBytes < 1024 * 1024
                            ? `${Math.round(att.sizeBytes / 1024)} KB`
                            : `${(att.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                        </span>
                      )}
                      <button
                        type="button"
                        className="attachment-delete"
                        onClick={() => {
                          void handleDeleteAttachment(att.id);
                        }}
                        aria-label={`Delete attachment: ${att.filename}`}
                        title="Delete attachment"
                      >
                        <IcoX />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="edit-timestamps">
            <small>Created: {formatDateTime(selectedTask.createdAt)}</small>
            <small>Updated: {formatDateTime(selectedTask.updatedAt)}</small>
          </div>

          <div className="edit-section">
            <button type="button" className="history-toggle" onClick={handleHistoryToggle}>
              <IcoHistory />
              <span>Execution History</span>
              <span style={{ marginLeft: "auto" }}>
                <IcoChevronDown />
              </span>
            </button>
            {historyOpen && (
              <div className="history-body">
                {historyLoading ? (
                  <p style={{ color: "#6b7280", fontSize: "0.75rem", margin: "0.5rem 0" }}>
                    Loading...
                  </p>
                ) : history.length === 0 ? (
                  <p style={{ color: "#4b5563", fontSize: "0.75rem", margin: "0.5rem 0" }}>
                    No history found.
                  </p>
                ) : (
                  history.map((h, i) => (
                    <div key={i} className="history-entry">
                      <span className="history-date">{h.targetDate}</span>
                      <span className={`history-status ${h.status}`}>{h.status}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <div className="edit-footer">
          <button
            type="button"
            className="edit-delete-btn"
            onClick={() => {
              void handleDeleteDetail();
            }}
            disabled={isSaving}
            title="Delete task"
            aria-label="Delete task"
          >
            <IcoTrash />
          </button>
        </div>
      </aside>
    </>
  );
}
