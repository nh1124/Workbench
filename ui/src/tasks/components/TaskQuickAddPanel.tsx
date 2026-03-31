import type { Dispatch, SetStateAction } from "react";
import type { ProjectOption } from "../../lib/taskDisplayUtils";
import {
  RECURRENCE_LABELS,
  RECURRENCE_TYPES,
  weekdays,
  type TaskDraft
} from "../types";
import { IcoCalSmall, IcoChevron, IcoFolder } from "./icons";

export interface TaskQuickAddPanelProps {
  addDraft: TaskDraft;
  setAddDraft: Dispatch<SetStateAction<TaskDraft>>;
  addContextInput: string;
  setAddContextInput: Dispatch<SetStateAction<string>>;
  addAdvancedOpen: boolean;
  setAddAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  projectOptions: ProjectOption[];
  resolveExistingContextOption: (rawValue: string) => ProjectOption | undefined;
  isSaving: boolean;
  onCancel: () => void;
  onAddTask: () => void;
}

export function TaskQuickAddPanel({
  addDraft,
  setAddDraft,
  addContextInput,
  setAddContextInput,
  addAdvancedOpen,
  setAddAdvancedOpen,
  projectOptions,
  resolveExistingContextOption,
  isSaving,
  onCancel,
  onAddTask
}: TaskQuickAddPanelProps) {
  return (
    <div className="task-add-panel">
      <p className="task-add-panel-kicker">New Task</p>
      <div className="task-add-panel-body">
        <div className="task-add-row">
          <input
            className="task-add-title-input"
            placeholder="Task name..."
            value={addDraft.title}
            onChange={(e) => setAddDraft((p) => ({ ...p, title: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAddTask();
            }}
          />
        </div>
        <div
          className={
            addDraft.recurrence === "ONCE"
              ? "task-add-compact-row"
              : "task-add-compact-row without-date"
          }
        >
          <label className="task-add-select task-add-select-context">
            <span className="task-add-select-icon">
              <IcoFolder />
            </span>
            <input
              list="task-context-options"
              className="task-add-context-input"
              placeholder="Type or select context"
              value={addContextInput}
              onChange={(e) => {
                const value = e.target.value;
                setAddContextInput(value);
                const matched = resolveExistingContextOption(value);
                setAddDraft((p) => ({ ...p, context: matched?.projectId || "" }));
              }}
            />
            <datalist id="task-context-options">
              {projectOptions.map((p) => (
                <option key={p.projectId} value={p.projectName || p.projectId} />
              ))}
            </datalist>
          </label>
          <label className="task-add-select task-add-select-load">
            <span className="task-add-select-icon">#</span>
            <input
              type="number"
              min={0}
              max={10}
              value={addDraft.baseLoadScore}
              onChange={(e) =>
                setAddDraft((p) => ({ ...p, baseLoadScore: Number(e.target.value) }))
              }
            />
          </label>
          {addDraft.recurrence === "ONCE" && (
            <label className="task-add-select task-add-select-date">
              <span className="task-add-select-icon">
                <IcoCalSmall />
              </span>
              <input
                type="date"
                value={addDraft.dueDate}
                onChange={(e) => setAddDraft((p) => ({ ...p, dueDate: e.target.value }))}
              />
            </label>
          )}
        </div>
        <button
          type="button"
          className="task-add-more-btn"
          onClick={() => setAddAdvancedOpen((prev) => !prev)}
        >
          <span className={addAdvancedOpen ? "task-add-more-chevron open" : "task-add-more-chevron"}>
            <IcoChevron />
          </span>
          More options
        </button>
        {addAdvancedOpen && (
          <div className="task-add-advanced-grid">
            <div className="edit-section task-add-advanced-span">
              <div className="edit-section-label">Recurrence</div>
              <select
                className="edit-input"
                value={addDraft.recurrence}
                onChange={(e) => {
                  const recurrence = e.target.value as typeof addDraft.recurrence;
                  setAddDraft((p) => ({
                    ...p,
                    recurrence,
                    dueDate: recurrence === "ONCE" ? p.dueDate : "",
                    activeFrom: recurrence === "ONCE" ? "" : p.activeFrom,
                    activeUntil: recurrence === "ONCE" ? "" : p.activeUntil
                  }));
                }}
              >
                {RECURRENCE_TYPES.map((r) => (
                  <option key={r} value={r}>
                    {RECURRENCE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            {addDraft.recurrence === "WEEKLY" && (
              <div className="edit-section task-add-advanced-span">
                <div className="weekday-picker">
                  {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      className={addDraft[d] ? "weekday-btn active" : "weekday-btn"}
                      onClick={() => setAddDraft((p) => ({ ...p, [d]: !p[d] }))}
                    >
                      {weekdays[i]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {addDraft.recurrence === "EVERY_N_DAYS" && (
              <>
                <div className="edit-section task-add-advanced-span">
                  <div className="edit-section-label">Every N Days</div>
                  <input
                    type="number"
                    min={1}
                    className="edit-input"
                    value={addDraft.intervalDays}
                    onChange={(e) =>
                      setAddDraft((p) => ({ ...p, intervalDays: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="edit-section task-add-advanced-span">
                  <div className="edit-section-label">Anchor Date</div>
                  <input
                    type="date"
                    className="edit-input"
                    value={addDraft.anchorDate}
                    onChange={(e) => setAddDraft((p) => ({ ...p, anchorDate: e.target.value }))}
                  />
                </div>
              </>
            )}
            {addDraft.recurrence === "MONTHLY_DAY" && (
              <div className="edit-section">
                <div className="edit-section-label">Day of Month</div>
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="edit-input"
                  value={addDraft.monthDay}
                  onChange={(e) => setAddDraft((p) => ({ ...p, monthDay: Number(e.target.value) }))}
                />
              </div>
            )}
            {addDraft.recurrence === "MONTHLY_NTH_WEEKDAY" && (
              <>
                <div className="edit-section">
                  <div className="edit-section-label">Nth Week</div>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    className="edit-input"
                    value={addDraft.nthInMonth}
                    onChange={(e) =>
                      setAddDraft((p) => ({ ...p, nthInMonth: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="edit-section">
                  <div className="edit-section-label">Weekday</div>
                  <select
                    className="edit-input"
                    value={addDraft.weekdayMon1}
                    onChange={(e) =>
                      setAddDraft((p) => ({ ...p, weekdayMon1: Number(e.target.value) }))
                    }
                  >
                    {weekdays.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            {addDraft.recurrence !== "ONCE" && (
              <>
                <div className="edit-section">
                  <div className="edit-section-label">Active From</div>
                  <input
                    type="date"
                    className="edit-input"
                    value={addDraft.activeFrom}
                    onChange={(e) => setAddDraft((p) => ({ ...p, activeFrom: e.target.value }))}
                  />
                </div>
                <div className="edit-section">
                  <div className="edit-section-label">Active Until</div>
                  <input
                    type="date"
                    className="edit-input"
                    value={addDraft.activeUntil}
                    onChange={(e) => setAddDraft((p) => ({ ...p, activeUntil: e.target.value }))}
                  />
                </div>
              </>
            )}
            <div className="edit-two-col task-add-advanced-span">
              <div className="edit-section">
                <div className="edit-section-label">Start Time</div>
                <input
                  type="time"
                  className="edit-input"
                  value={addDraft.startTime}
                  onChange={(e) => setAddDraft((p) => ({ ...p, startTime: e.target.value }))}
                />
              </div>
              <div className="edit-section">
                <div className="edit-section-label">End Time</div>
                <input
                  type="time"
                  className="edit-input"
                  value={addDraft.endTime}
                  onChange={(e) => setAddDraft((p) => ({ ...p, endTime: e.target.value }))}
                />
              </div>
            </div>
            <div className="edit-section">
              <div className="edit-section-label">Timezone</div>
              <input
                className="edit-input"
                value={addDraft.timezone}
                onChange={(e) => setAddDraft((p) => ({ ...p, timezone: e.target.value }))}
              />
            </div>
            <div className="edit-section task-add-advanced-notes">
              <div className="edit-section-label">Notes</div>
              <textarea
                className="edit-input"
                value={addDraft.notes}
                onChange={(e) => setAddDraft((p) => ({ ...p, notes: e.target.value }))}
              />
            </div>
          </div>
        )}
        <div className="task-add-actions">
          <button type="button" className="task-add-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="task-add-submit" onClick={onAddTask} disabled={isSaving}>
            {isSaving ? "Creating..." : "Add Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
