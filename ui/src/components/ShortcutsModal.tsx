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

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="shortcut-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shortcut-modal-head">
          <h2>Keyboard Shortcuts</h2>
          <button type="button" className="shortcut-close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="shortcut-modal-body">
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
        </div>
      </section>
    </div>
  );
}
