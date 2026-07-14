export type ShortcutActionId =
  | "close_cancel"
  | "new_window"
  | "new_window_taskbar"
  | "quick_note"
  | "quick_note_alt"
  | "open_calendar_window"
  | "undo_delete"
  | "send_message"
  | "new_line"
  | "switch_chat_session"
  | "open_home"
  | "open_project"
  | "open_tasks"
  | "open_notes"
  | "open_artifacts"
  | "open_settings";

export type ShortcutBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type ShortcutDefinition = {
  id: ShortcutActionId;
  section: string;
  label: string;
  defaultBinding?: ShortcutBinding;
  fixedKeys?: string[];
  editable: boolean;
  handledGlobally?: boolean;
  nativeGlobal?: boolean;
};

export type ShortcutBindings = Partial<Record<ShortcutActionId, ShortcutBinding | null>>;
export type NativeGlobalShortcutRegistration = {
  actionId: ShortcutActionId;
  accelerator: string;
};

const STORAGE_KEY = "workbench-keyboard-shortcuts";
export const WORKBENCH_KEYBOARD_SHORTCUTS_CHANGED_EVENT = "workbench-keyboard-shortcuts-changed";

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "close_cancel",
    section: "General",
    label: "Close / Cancel",
    defaultBinding: { key: "Esc" },
    editable: true,
    handledGlobally: true
  },
  {
    id: "new_window",
    section: "Window",
    label: "New Window",
    defaultBinding: { key: "N", ctrl: true, shift: true },
    editable: true,
    handledGlobally: true,
    nativeGlobal: true
  },
  {
    id: "new_window_taskbar",
    section: "Window",
    label: "New Window (Taskbar icon)",
    fixedKeys: ["Shift", "Click"],
    editable: false
  },
  {
    id: "quick_note",
    section: "Notes",
    label: "Quick Note",
    defaultBinding: { key: "N", meta: true, alt: true },
    editable: true,
    handledGlobally: true,
    nativeGlobal: true
  },
  {
    id: "quick_note_alt",
    section: "Notes",
    label: "Quick Note (Alt)",
    defaultBinding: { key: "N", ctrl: true, alt: true },
    editable: true,
    handledGlobally: true,
    nativeGlobal: true
  },
  {
    id: "open_calendar_window",
    section: "Tasks",
    label: "Open Calendar Window",
    defaultBinding: { key: "C", ctrl: true, alt: true },
    editable: true,
    handledGlobally: true,
    nativeGlobal: true
  },
  {
    id: "undo_delete",
    section: "Notes",
    label: "Undo Delete",
    defaultBinding: { key: "Z", ctrl: true },
    editable: false
  },
  {
    id: "send_message",
    section: "Chat",
    label: "Send Message",
    defaultBinding: { key: "Enter" },
    editable: false
  },
  {
    id: "new_line",
    section: "Chat",
    label: "New Line",
    defaultBinding: { key: "Enter", shift: true },
    editable: false
  },
  {
    id: "switch_chat_session",
    section: "Chat",
    label: "Switch Chat Session",
    fixedKeys: ["Ctrl", "Up / Down"],
    editable: false
  },
  {
    id: "open_home",
    section: "Navigation",
    label: "Open Home",
    defaultBinding: { key: "H", alt: true },
    editable: true,
    handledGlobally: true
  },
  {
    id: "open_project",
    section: "Navigation",
    label: "Open Project",
    defaultBinding: { key: "P", alt: true },
    editable: true,
    handledGlobally: true
  },
  {
    id: "open_tasks",
    section: "Navigation",
    label: "Open Tasks",
    defaultBinding: { key: "T", alt: true },
    editable: true,
    handledGlobally: true
  },
  {
    id: "open_notes",
    section: "Navigation",
    label: "Open Notes",
    defaultBinding: { key: "L", alt: true },
    editable: true,
    handledGlobally: true
  },
  {
    id: "open_artifacts",
    section: "Navigation",
    label: "Open Artifacts",
    defaultBinding: { key: "A", alt: true },
    editable: true,
    handledGlobally: true
  },
  {
    id: "open_settings",
    section: "Navigation",
    label: "Open Settings",
    defaultBinding: { key: ",", ctrl: true },
    editable: true,
    handledGlobally: true
  }
];

export function getDefaultShortcutBindings(): ShortcutBindings {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((definition) => [
      definition.id,
      definition.defaultBinding ? { ...definition.defaultBinding } : null
    ])
  ) as ShortcutBindings;
}

export function loadShortcutBindings(): ShortcutBindings {
  if (typeof window === "undefined") return getDefaultShortcutBindings();
  const defaults = getDefaultShortcutBindings();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as ShortcutBindings;
    return {
      ...defaults,
      ...Object.fromEntries(
        Object.entries(parsed).map(([id, binding]) => [
          id,
          isShortcutBinding(binding) || binding === null ? binding : defaults[id as ShortcutActionId]
        ])
      )
    };
  } catch {
    return defaults;
  }
}

export function saveShortcutBindings(bindings: ShortcutBindings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  window.dispatchEvent(new Event(WORKBENCH_KEYBOARD_SHORTCUTS_CHANGED_EVENT));
}

export function resetShortcutBindings(): ShortcutBindings {
  const defaults = getDefaultShortcutBindings();
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(WORKBENCH_KEYBOARD_SHORTCUTS_CHANGED_EVENT));
  }
  return defaults;
}

export function bindingFromKeyboardEvent(event: KeyboardEvent): ShortcutBinding | undefined {
  const key = normalizeShortcutKey(event.key);
  if (!key || key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return undefined;
  }
  return {
    key,
    ctrl: event.ctrlKey || undefined,
    shift: event.shiftKey || undefined,
    alt: event.altKey || undefined,
    meta: event.metaKey || undefined
  };
}

export function shortcutMatchesEvent(binding: ShortcutBinding | null | undefined, event: KeyboardEvent): boolean {
  if (!binding) return false;
  return (
    Boolean(binding.ctrl) === event.ctrlKey &&
    Boolean(binding.shift) === event.shiftKey &&
    Boolean(binding.alt) === event.altKey &&
    Boolean(binding.meta) === event.metaKey &&
    binding.key === normalizeShortcutKey(event.key)
  );
}

export function shortcutBindingEquals(left: ShortcutBinding | null | undefined, right: ShortcutBinding | null | undefined): boolean {
  if (!left || !right) return false;
  return (
    left.key === right.key &&
    Boolean(left.ctrl) === Boolean(right.ctrl) &&
    Boolean(left.shift) === Boolean(right.shift) &&
    Boolean(left.alt) === Boolean(right.alt) &&
    Boolean(left.meta) === Boolean(right.meta)
  );
}

export function shortcutTokens(binding: ShortcutBinding | null | undefined, fixedKeys?: string[]): string[] {
  if (!binding) return fixedKeys ?? ["Unassigned"];
  return [
    binding.ctrl ? "Ctrl" : undefined,
    binding.meta ? "Win" : undefined,
    binding.alt ? "Alt" : undefined,
    binding.shift ? "Shift" : undefined,
    displayShortcutKey(binding.key)
  ].filter((token): token is string => Boolean(token));
}

export function shortcutNeedsModifier(binding: ShortcutBinding): boolean {
  return (
    !binding.ctrl &&
    !binding.shift &&
    !binding.alt &&
    !binding.meta &&
    binding.key !== "Esc" &&
    !/^F\d{1,2}$/.test(binding.key)
  );
}

export function getNativeGlobalShortcutRegistrations(bindings: ShortcutBindings): NativeGlobalShortcutRegistration[] {
  return SHORTCUT_DEFINITIONS.flatMap((definition) => {
    if (!definition.nativeGlobal) return [];
    const accelerator = shortcutAccelerator(bindings[definition.id]);
    return accelerator ? [{ actionId: definition.id, accelerator }] : [];
  });
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isShortcutBinding(value: unknown): value is ShortcutBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as ShortcutBinding;
  return typeof binding.key === "string" && binding.key.length > 0;
}

function normalizeShortcutKey(raw: string): string {
  if (!raw) return "";
  const key = raw.length === 1 ? raw.toUpperCase() : raw;
  const aliases: Record<string, string> = {
    " ": "Space",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right"
  };
  return aliases[key] ?? key;
}

function displayShortcutKey(key: string): string {
  const aliases: Record<string, string> = {
    Esc: "Esc",
    Up: "Up",
    Down: "Down",
    Left: "Left",
    Right: "Right"
  };
  return aliases[key] ?? key;
}

function shortcutAccelerator(binding: ShortcutBinding | null | undefined): string | undefined {
  if (!binding) return undefined;
  const code = nativeCodeForShortcutKey(binding.key);
  if (!code) return undefined;
  return [
    binding.ctrl ? "Ctrl" : undefined,
    binding.meta ? "Super" : undefined,
    binding.alt ? "Alt" : undefined,
    binding.shift ? "Shift" : undefined,
    code
  ].filter((token): token is string => Boolean(token)).join("+");
}

function nativeCodeForShortcutKey(key: string): string | undefined {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^\d$/.test(key)) return `Digit${key}`;

  const aliases: Record<string, string> = {
    ",": "Comma",
    ".": "Period",
    "-": "Minus",
    "=": "Equal",
    "/": "Slash",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    "`": "Backquote",
    Esc: "Escape",
    Enter: "Enter",
    Space: "Space",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight"
  };

  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  return aliases[key];
}
