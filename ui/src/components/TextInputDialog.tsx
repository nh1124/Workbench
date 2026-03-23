import { useEffect, useRef, useState, type ReactNode } from "react";
import "./TextInputDialog.css";

interface TextInputDialogProps {
  open: boolean;
  title?: string;
  message?: ReactNode;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function TextInputDialog({
  open,
  title = "Input",
  message,
  label,
  placeholder,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel
}: TextInputDialogProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setValue("");
      return;
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key === "Enter") {
        const normalized = value.trim();
        if (normalized) {
          onConfirm(normalized);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel, onConfirm, open, value]);

  if (!open) {
    return null;
  }

  const normalized = value.trim();

  return (
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <section
        className="text-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="text-input-dialog-head">
          <h3>{title}</h3>
        </header>

        <div className="text-input-dialog-body">
          {message ? <p>{message}</p> : null}
          <label>
            <span>{label}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              disabled={busy}
            />
          </label>
        </div>

        <footer className="text-input-dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" onClick={() => onConfirm(normalized)} disabled={busy || normalized.length === 0}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
