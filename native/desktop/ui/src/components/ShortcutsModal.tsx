import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  SHORTCUT_DEFINITIONS,
  bindingFromKeyboardEvent,
  loadShortcutBindings,
  resetShortcutBindings,
  saveShortcutBindings,
  shortcutNeedsModifier,
  shortcutBindingEquals,
  shortcutTokens,
  type ShortcutActionId,
  type ShortcutBindings
} from "../lib/keyboardShortcuts";
import { syncNativeGlobalShortcuts } from "../lib/api";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  const [bindings, setBindings] = useState<ShortcutBindings>(() => loadShortcutBindings());
  const [capturingActionId, setCapturingActionId] = useState<ShortcutActionId | null>(null);
  const [message, setMessage] = useState("");

  const sections = useMemo(() => {
    const sectionMap = new Map<string, typeof SHORTCUT_DEFINITIONS>();
    for (const definition of SHORTCUT_DEFINITIONS) {
      sectionMap.set(definition.section, [...(sectionMap.get(definition.section) ?? []), definition]);
    }
    return Array.from(sectionMap.entries());
  }, []);

  useEffect(() => {
    if (!open) return;
    setBindings(loadShortcutBindings());
    setCapturingActionId(null);
    setMessage("");
  }, [open]);

  if (!open) {
    return null;
  }

  const startCapture = (actionId: ShortcutActionId) => {
    setCapturingActionId(actionId);
    setMessage("Press the new shortcut.");
  };

  const persistBindings = (next: ShortcutBindings, successMessage: string) => {
    setBindings(next);
    saveShortcutBindings(next);
    void syncNativeGlobalShortcuts(next)
      .then(() => setMessage(successMessage))
      .catch(() => setMessage(`${successMessage} Desktop registration failed.`));
  };

  const clearShortcut = (actionId: ShortcutActionId) => {
    const next = { ...bindings, [actionId]: null };
    persistBindings(next, "Shortcut cleared.");
  };

  const resetAll = () => {
    const defaults = resetShortcutBindings();
    setCapturingActionId(null);
    setBindings(defaults);
    void syncNativeGlobalShortcuts(defaults)
      .then(() => setMessage("Shortcuts reset to defaults."))
      .catch(() => setMessage("Shortcuts reset to defaults. Desktop registration failed."));
  };

  const captureShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (!capturingActionId) return;
    event.preventDefault();
    event.stopPropagation();

    const binding = bindingFromKeyboardEvent(event.nativeEvent);
    if (!binding) {
      setMessage("Press a letter, number, or command key.");
      return;
    }

    const currentDefinition = SHORTCUT_DEFINITIONS.find((definition) => definition.id === capturingActionId);
    if (currentDefinition?.handledGlobally && shortcutNeedsModifier(binding)) {
      setMessage("Use a modifier such as Ctrl, Alt, Shift, or Win.");
      return;
    }

    const conflict = SHORTCUT_DEFINITIONS.find(
      (definition) =>
        definition.id !== capturingActionId &&
        shortcutBindingEquals(bindings[definition.id], binding)
    );
    if (conflict) {
      setMessage(`Already assigned to ${conflict.label}.`);
      return;
    }

    const next = { ...bindings, [capturingActionId]: binding };
    setCapturingActionId(null);
    persistBindings(next, "Shortcut updated.");
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="shortcut-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
        onKeyDownCapture={captureShortcut}
      >
        <header className="shortcut-modal-head">
          <div>
            <h2>Keyboard Shortcuts</h2>
            {message ? <p>{message}</p> : null}
          </div>
          <div className="shortcut-modal-actions">
            <button type="button" onClick={resetAll}>Reset Defaults</button>
            <button type="button" className="shortcut-close-button" onClick={onClose} aria-label="Close">
              X
            </button>
          </div>
        </header>

        <div className="shortcut-modal-body">
          {sections.map(([sectionTitle, items]) => (
            <section key={sectionTitle} className="shortcut-section">
              <p>{sectionTitle}</p>
              {items.map((item) => {
                const isCapturing = capturingActionId === item.id;
                const tokens = isCapturing
                  ? ["Press keys..."]
                  : shortcutTokens(bindings[item.id], item.fixedKeys);
                return (
                  <div key={item.id} className={isCapturing ? "shortcut-row recording" : "shortcut-row"}>
                    <span>{item.label}</span>
                    <div className="shortcut-keys" aria-label={`${item.label} shortcut`}>
                      {tokens.map((key, index) => (
                        <span key={`${item.id}-${key}`}>
                          {index > 0 ? <em>+</em> : null}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </div>
                    <div className="shortcut-row-actions">
                      {item.editable ? (
                        <>
                          <button type="button" onClick={() => startCapture(item.id)}>
                            {isCapturing ? "Listening" : "Change"}
                          </button>
                          <button type="button" onClick={() => clearShortcut(item.id)}>
                            Clear
                          </button>
                        </>
                      ) : (
                        <span>Fixed</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
