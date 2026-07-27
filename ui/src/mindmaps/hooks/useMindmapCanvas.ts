import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_ZOOM_STEP,
  clampCanvasZoom,
  type PositionedMindmapNode
} from "../utils/mindmapTree";

/**
 * Owns the mindmap canvas viewport: zoom, drag-to-pan, and centring.
 *
 * None of this touches the document, so it is kept apart from the editing
 * state. The page passes the current layout and a callback used to close any
 * open menu whenever the canvas is interacted with.
 */

export type MindmapCanvasLayout = {
  nodes: PositionedMindmapNode[];
  width: number;
  height: number;
};

type CanvasPanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  hasMoved: boolean;
};

export type UseMindmapCanvasOptions = {
  layout: MindmapCanvasLayout | undefined;
  /** Panning and zooming are inert until a document is open. */
  enabled: boolean;
  /** Resets the viewport when the open document changes. */
  documentId: string | undefined;
  /** Called whenever an interaction should dismiss transient UI (the node menu). */
  onCanvasInteract: () => void;
};

export function useMindmapCanvas({ layout, enabled, documentId, onCanvasInteract }: UseMindmapCanvasOptions) {
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasPanRef = useRef<CanvasPanState | null>(null);
  const suppressCanvasClickRef = useRef(false);

  useEffect(() => {
    setCanvasZoom(1);
    setIsCanvasPanning(false);
    canvasPanRef.current = null;
    suppressCanvasClickRef.current = false;
  }, [documentId]);

  function handleCanvasWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.shiftKey || !enabled) return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (target?.closest("input, textarea, select")) return;

    event.preventDefault();
    event.stopPropagation();
    onCanvasInteract();

    const container = event.currentTarget;
    const rect = container.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const contentX = (container.scrollLeft + pointerX) / canvasZoom;
    const contentY = (container.scrollTop + pointerY) / canvasZoom;
    const wheelDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (wheelDelta === 0) return;
    const direction = wheelDelta < 0 ? 1 : -1;
    const nextZoom = clampCanvasZoom(canvasZoom + direction * CANVAS_ZOOM_STEP);
    if (nextZoom === canvasZoom) return;

    setCanvasZoom(nextZoom);
    window.requestAnimationFrame(() => {
      container.scrollLeft = Math.max(0, contentX * nextZoom - pointerX);
      container.scrollTop = Math.max(0, contentY * nextZoom - pointerY);
    });
  }

  function centerCanvasView(): void {
    const container = canvasRef.current;
    if (!container || !layout?.nodes.length) return;
    onCanvasInteract();

    const minX = Math.min(...layout.nodes.map((item) => item.x));
    const maxX = Math.max(...layout.nodes.map((item) => item.x + CANVAS_NODE_WIDTH));
    const minY = Math.min(...layout.nodes.map((item) => item.y));
    const maxY = Math.max(...layout.nodes.map((item) => item.y + CANVAS_NODE_HEIGHT));
    const centerX = ((minX + maxX) / 2) * canvasZoom;
    const centerY = ((minY + maxY) / 2) * canvasZoom;
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);

    container.scrollTo({
      left: Math.min(maxScrollLeft, Math.max(0, centerX - container.clientWidth / 2)),
      top: Math.min(maxScrollTop, Math.max(0, centerY - container.clientHeight / 2)),
      behavior: "smooth"
    });
  }

  function canStartCanvasPan(event: ReactPointerEvent<HTMLDivElement>): boolean {
    if (!enabled || event.button !== 0) return false;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    return !Boolean(target?.closest(".mindmaps-node, input, textarea, select, button, a"));
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!canStartCanvasPan(event)) return;
    event.preventDefault();
    onCanvasInteract();
    canvasPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      hasMoved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsCanvasPanning(true);
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      pan.hasMoved = true;
    }
    event.currentTarget.scrollLeft = pan.scrollLeft - deltaX;
    event.currentTarget.scrollTop = pan.scrollTop - deltaY;
  }

  function finishCanvasPan(container: HTMLDivElement, pointerId: number): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== pointerId) return;
    if (container.hasPointerCapture(pointerId)) {
      container.releasePointerCapture(pointerId);
    }
    if (pan.hasMoved) {
      suppressCanvasClickRef.current = true;
      window.setTimeout(() => {
        suppressCanvasClickRef.current = false;
      }, 0);
    }
    canvasPanRef.current = null;
    setIsCanvasPanning(false);
  }

  // A pan that moved swallows the click it would otherwise end with, so
  // dragging the canvas does not also dismiss what the user was looking at.
  function handleCanvasClick(): void {
    if (suppressCanvasClickRef.current) {
      suppressCanvasClickRef.current = false;
      return;
    }
    onCanvasInteract();
  }

  return {
    canvasRef,
    canvasZoom,
    isCanvasPanning,
    handleCanvasWheel,
    centerCanvasView,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    finishCanvasPan,
    handleCanvasClick
  };
}
