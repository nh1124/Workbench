import { useEffect, useMemo, useState } from "react";
import {
  SHORTCUT_DEFINITIONS,
  WORKBENCH_KEYBOARD_SHORTCUTS_CHANGED_EVENT,
  loadShortcutBindings,
  shortcutTokens
} from "../lib/keyboardShortcuts";

export function ShortcutsPage() {
  const [bindings, setBindings] = useState(() => loadShortcutBindings());
  const sections = useMemo(() => {
    const sectionMap = new Map<string, typeof SHORTCUT_DEFINITIONS>();
    for (const definition of SHORTCUT_DEFINITIONS) {
      sectionMap.set(definition.section, [...(sectionMap.get(definition.section) ?? []), definition]);
    }
    return Array.from(sectionMap.entries());
  }, []);

  useEffect(() => {
    const reloadShortcuts = () => setBindings(loadShortcutBindings());
    window.addEventListener(WORKBENCH_KEYBOARD_SHORTCUTS_CHANGED_EVENT, reloadShortcuts);
    window.addEventListener("storage", reloadShortcuts);
    return () => {
      window.removeEventListener(WORKBENCH_KEYBOARD_SHORTCUTS_CHANGED_EVENT, reloadShortcuts);
      window.removeEventListener("storage", reloadShortcuts);
    };
  }, []);

  return (
    <section className="stack">
      <header className="page-header">
        <h2>Keyboard Shortcuts</h2>
      </header>

      <article className="panel">
        {sections.map(([sectionTitle, items]) => (
          <section key={sectionTitle} className="shortcut-section">
            <p>{sectionTitle}</p>
            {items.map((item) => (
              <div key={item.id} className="shortcut-row">
                <span>{item.label}</span>
                <div className="shortcut-keys" aria-label={`${item.label} shortcut`}>
                  {shortcutTokens(bindings[item.id], item.fixedKeys).map((key, index) => (
                    <span key={`${item.id}-${key}`}>
                      {index > 0 ? <em>+</em> : null}
                      <kbd>{key}</kbd>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}
      </article>
    </section>
  );
}
