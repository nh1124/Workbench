import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { clampWbsZoom, isDirectEditTarget, isInsideWbsItem, WBS_ZOOM_STEP } from "../utils/wbsTree";

/**
 * Owns the WBS grid viewport: shift-wheel zoom and drag-to-pan.
 *
 * None of this touches the plan or its items, so it is kept apart from the
 * table state. The page passes a callback used to dismiss any open menu when
 * the grid is interacted with.
 */

type WbsPanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  hasMoved: boolean;
};

export function useWbsGridPan(closeMenus: () => void) {
  const [isGridPanning, setIsGridPanning] = useState(false);
  const [wbsZoom, setWbsZoom] = useState(1);
  const gridPanRef = useRef<WbsPanState | null>(null);
  const suppressGridClickRef = useRef(false);

  function handleGridWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.shiftKey) return;
    event.preventDefault();
    const container = event.currentTarget;
    const rect = container.getBoundingClientRect();
    const pointerX = event.clientX - rect.left + container.scrollLeft;
    const pointerY = event.clientY - rect.top + container.scrollTop;
    const nextZoom = clampWbsZoom(wbsZoom + (event.deltaY > 0 ? -WBS_ZOOM_STEP : WBS_ZOOM_STEP));
    if (nextZoom === wbsZoom) return;
    setWbsZoom(nextZoom);
    window.requestAnimationFrame(() => {
      const ratio = nextZoom / wbsZoom;
      container.scrollLeft = pointerX * ratio - (event.clientX - rect.left);
      container.scrollTop = pointerY * ratio - (event.clientY - rect.top);
    });
  }

  function handleGridPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || isDirectEditTarget(event.target) || isInsideWbsItem(event.target)) return;
    closeMenus();
    gridPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      hasMoved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsGridPanning(true);
  }

  function handleGridPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = gridPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) pan.hasMoved = true;
    event.currentTarget.scrollLeft = pan.scrollLeft - deltaX;
    event.currentTarget.scrollTop = pan.scrollTop - deltaY;
  }

  function finishGridPan(container: HTMLDivElement, pointerId: number): void {
    const pan = gridPanRef.current;
    if (!pan || pan.pointerId !== pointerId) return;
    if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
    if (pan.hasMoved) {
      suppressGridClickRef.current = true;
      window.setTimeout(() => {
        suppressGridClickRef.current = false;
      }, 0);
    }
    gridPanRef.current = null;
    setIsGridPanning(false);
  }

  // A pan that moved swallows the click it would otherwise end with, so
  // dragging the grid does not also dismiss what the user was looking at.
  function handleGridClick(): void {
    if (suppressGridClickRef.current) {
      suppressGridClickRef.current = false;
      return;
    }
    closeMenus();
  }

  return {
    wbsZoom,
    isGridPanning,
    handleGridWheel,
    handleGridPointerDown,
    handleGridPointerMove,
    finishGridPan,
    handleGridClick
  };
}
