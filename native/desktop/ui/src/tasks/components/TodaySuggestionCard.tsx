import { IcoSun } from "./icons";

interface TodaySuggestionCardProps {
  count: number;
  onAddToToday: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

export function TodaySuggestionCard({
  count,
  onAddToToday,
  onCancel,
  disabled = false,
}: TodaySuggestionCardProps) {
  return (
    <section className="task-suggestion-card" role="status" aria-live="polite">
      <div className="task-suggestion-head">
        <span className="task-suggestion-icon"><IcoSun /></span>
        <strong>Today Suggestion</strong>
      </div>
      <p>
        {count} task{count === 1 ? "" : "s"} due today are not in Today. Add them now?
      </p>
      <div className="task-suggestion-actions">
        <button
          type="button"
          className="task-suggestion-cancel"
          onClick={onCancel}
          disabled={disabled}
        >
          Cancel
        </button>
        <button
          type="button"
          className="task-suggestion-apply"
          onClick={onAddToToday}
          disabled={disabled}
        >
          Add to Today
        </button>
      </div>
    </section>
  );
}

