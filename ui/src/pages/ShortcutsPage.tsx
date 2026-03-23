type ShortcutSection = {
  title: string;
  items: Array<{
    label: string;
    keys: string[];
  }>;
};

const shortcutSections: ShortcutSection[] = [
  {
    title: "General",
    items: [{ label: "Close / Cancel", keys: ["Esc"] }]
  },
  {
    title: "Window",
    items: [
      { label: "New Window", keys: ["Ctrl", "N"] },
      { label: "New Window (Taskbar icon)", keys: ["Shift", "Click"] }
    ]
  },
  {
    title: "Notes",
    items: [
      { label: "Quick Note", keys: ["Win", "Alt", "N"] },
      { label: "Undo Delete", keys: ["Ctrl", "Z"] }
    ]
  },
  {
    title: "Chat",
    items: [
      { label: "Send Message", keys: ["Enter"] },
      { label: "New Line", keys: ["Shift", "Enter"] },
      { label: "Switch Chat Session", keys: ["Ctrl", "Up / Down"] }
    ]
  },
  {
    title: "Navigation",
    items: [
      { label: "Open Home", keys: ["G", "H"] },
      { label: "Open Project", keys: ["G", "P"] },
      { label: "Open Tasks", keys: ["G", "T"] },
      { label: "Open Notes", keys: ["G", "N"] },
      { label: "Open Artifacts", keys: ["G", "A"] },
      { label: "Open Settings", keys: ["G", "S"] }
    ]
  }
];

export function ShortcutsPage() {
  return (
    <section className="stack">
      <header className="page-header">
        <p className="eyebrow">Keyboard Shortcuts</p>
        <h2>Keyboard Shortcuts</h2>
      </header>

      <article className="panel">
        {shortcutSections.map((section) => (
          <section key={section.title} className="shortcut-section">
            <p>{section.title}</p>
            {section.items.map((item) => (
              <div key={item.label} className="shortcut-row">
                <span>{item.label}</span>
                <div className="shortcut-keys" aria-label={`${item.label} shortcut`}>
                  {item.keys.map((key, index) => (
                    <span key={`${item.label}-${key}`}>
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
