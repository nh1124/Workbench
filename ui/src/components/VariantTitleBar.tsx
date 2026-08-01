import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { nativeWindowControls } from "../lib/api";
import { VariantAccountBar } from "./VariantAccountBar";

/**
 * Title bar for the dedicated apps, which run undecorated so the account control can sit
 * in the window frame the way Office does.
 *
 * Because the native frame is gone, dragging, double-click-to-maximize and the window
 * buttons are all reimplemented here on top of Rust commands.
 */

const variantAppNames: Record<string, string> = {
  tasks: "Workbench Tasks",
  notes: "Workbench Notes",
  artifacts: "Workbench Artifacts"
};

export function variantAppName(search: string): string {
  const variant = new URLSearchParams(search).get("app");
  return (variant && variantAppNames[variant]) || "Workbench";
}

export function VariantTitleBar({ appName }: { appName: string }) {
  const maximizeButtonRef = useRef<HTMLButtonElement>(null);

  // Windows decides whether to offer Snap Layouts from the hit-test result, so the native
  // side needs to know where this button ended up. Re-report whenever the layout can move.
  useEffect(() => {
    const report = () => {
      const element = maximizeButtonRef.current;
      if (!element) return;
      const { x, y, width, height } = element.getBoundingClientRect();
      void nativeWindowControls.reportMaximizeButtonRect({ x, y, width, height });
    };

    report();
    window.addEventListener("resize", report);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(report);
    if (observer && maximizeButtonRef.current) {
      observer.observe(maximizeButtonRef.current);
    }
    return () => {
      window.removeEventListener("resize", report);
      observer?.disconnect();
    };
  }, []);

  const [isMaximized, setIsMaximized] = useState(false);

  const refreshMaximized = useCallback(() => {
    void nativeWindowControls.isMaximized().then(setIsMaximized);
  }, []);

  useEffect(() => {
    refreshMaximized();
    // Maximizing, restoring and snapping all resize the window, so this covers the cases
    // where the state changes without going through our own button.
    window.addEventListener("resize", refreshMaximized);
    return () => window.removeEventListener("resize", refreshMaximized);
  }, [refreshMaximized]);

  const toggleMaximize = () => {
    void nativeWindowControls.toggleMaximize().then(refreshMaximized);
  };

  // Only a press on the bar's own background acts on the window; presses that originate on
  // a control must stay clicks.
  //
  // `startDragging` hands the pointer to the OS drag loop, which means a `dblclick` would
  // never arrive. The second press of a double click is therefore detected here, from the
  // click count, before any drag begins.
  const handleBackgroundMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target !== event.currentTarget) return;
    if (event.detail >= 2) {
      toggleMaximize();
      return;
    }
    void nativeWindowControls.startDrag();
  };

  return (
    <div className="variant-title-bar">
      <div className="variant-title-bar-drag" onMouseDown={handleBackgroundMouseDown}>
        <span className="variant-title-bar-name">{appName}</span>
      </div>

      <div className="variant-title-bar-actions">
        <VariantAccountBar />
        <button
          type="button"
          className="variant-window-button"
          aria-label="Minimize"
          onClick={() => void nativeWindowControls.minimize()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button
          type="button"
          ref={maximizeButtonRef}
          className="variant-window-button variant-maximize-button"
          aria-label={isMaximized ? "Restore" : "Maximize"}
          onClick={toggleMaximize}
        >
          {isMaximized ? (
            // Two offset squares, the way Windows draws "restore down".
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2" y="4" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M4 4V2h6v6H8" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="variant-window-button danger"
          aria-label="Close"
          onClick={() => void nativeWindowControls.close()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
