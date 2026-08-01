import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Lets a feature page put its own controls into the dedicated app's title bar.
 *
 * A dedicated app has no topbar, so controls that belong to the whole app — the view
 * switcher, a project picker, a search box — have nowhere to live except the window frame.
 * Rather than teach the title bar about every feature, it exposes a slot and pages portal
 * into it. Pages stay usable in the main app, where the slot simply does not exist.
 */

interface VariantChromeValue {
  slot: HTMLElement | null;
  registerSlot: (element: HTMLElement | null) => void;
}

const VariantChromeContext = createContext<VariantChromeValue>({
  slot: null,
  registerSlot: () => {}
});

export function VariantChromeProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo<VariantChromeValue>(() => ({ slot, registerSlot: setSlot }), [slot]);
  return <VariantChromeContext.Provider value={value}>{children}</VariantChromeContext.Provider>;
}

export function useVariantChrome(): VariantChromeValue {
  return useContext(VariantChromeContext);
}

/** True when rendering inside a dedicated app whose title bar is ready to receive controls. */
export function useHasTitleBarSlot(): boolean {
  return useContext(VariantChromeContext).slot !== null;
}

/** Renders `children` into the title bar, or nothing when there is no title bar. */
export function TitleBarPortal({ children }: { children: ReactNode }) {
  const { slot } = useContext(VariantChromeContext);
  return slot ? createPortal(children, slot) : null;
}
