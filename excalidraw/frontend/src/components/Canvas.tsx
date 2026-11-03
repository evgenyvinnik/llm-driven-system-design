import { useRef, useEffect, useCallback, useState } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useAuthStore } from '../stores/authStore';
import { renderCanvas } from '../renderer/CanvasRenderer';
import { hitTest, generateId } from '../utils/geometry';
import { simplifyPath } from '../utils/pathSimplification';
import { wsClient } from '../services/websocket';
import type { ExcalidrawElement, Point } from '../types';

/** Renders the main drawing canvas with mouse/touch event handling for shapes. */
export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // CSS size of the canvas; the backing store is this times the pixel ratio.
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1);
  // Pointer position (world space) while a shape is being drawn, for the live preview.
  const [draftPoint, setDraftPoint] = useState<Point | null>(null);
  const dragMoved = useRef(false);
  const isPanning = useRef(false);
  const panStart = useRef<Point>({ x: 0, y: 0 });
  const spacePressed = useRef(false);

  const {
    elements,
    selectedElementId,
    activeTool,
    viewState,
    isDrawing,
    drawingStartPoint,
    currentPoints,
    strokeColor,
    fillColor,
    strokeWidth,
    opacity,
    fontSize,
    addElement,
    updateElement,
    setSelectedElementId,
    setActiveTool,
    setViewState,
    setIsDrawing,
    setDrawingStartPoint,
    setCurrentPoints,
    addCurrentPoint,
    canEdit,
  } = useCanvasStore();

  const { user } = useAuthStore();

  // Resize canvas to fill container
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
        setPixelRatio(window.devicePixelRatio || 1);
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, []);

  // The shape under construction, rendered live instead of only on mouseup.
  const draft: ExcalidrawElement | null = (() => {
    if (!isDrawing || !drawingStartPoint || !draftPoint || activeTool === 'select' || activeTool === 'text') {
      return null;
    }
    const base = {
      id: 'draft',
      type: activeTool,
      strokeColor,
      fillColor,
      strokeWidth,
      opacity,
      version: 0,
      isDeleted: false,
      createdBy: user?.id || 'anonymous',
      updatedAt: 0,
    } as const;
    if (activeTool === 'freehand') {
      return { ...base, x: drawingStartPoint.x, y: drawingStartPoint.y, width: 0, height: 0, points: currentPoints };
    }
    const dx = draftPoint.x - drawingStartPoint.x;
    const dy = draftPoint.y - drawingStartPoint.y;
    if (activeTool === 'line' || activeTool === 'arrow') {
      return { ...base, x: drawingStartPoint.x, y: drawingStartPoint.y, width: dx, height: dy, points: [{ x: 0, y: 0 }, { x: dx, y: dy }] };
    }
    return {
      ...base,
      x: Math.min(drawingStartPoint.x, draftPoint.x),
      y: Math.min(drawingStartPoint.y, draftPoint.y),
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  })();

  // Re-render canvas on state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const visibleElements = elements.filter((el) => !el.isDeleted);
    renderCanvas(ctx, visibleElements, viewState, selectedElementId, canvasSize.width, canvasSize.height, pixelRatio, draft);
  });

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback(
    (screenX: number, screenY: number): Point => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: screenX, y: screenY };

      const rect = canvas.getBoundingClientRect();
      const x = (screenX - rect.left - viewState.scrollX) / viewState.zoom;
      const y = (screenY - rect.top - viewState.scrollY) / viewState.zoom;
      return { x, y };
    },
    [viewState]
  );

  // Create a new element from current tool
  const createElement = useCallback(
    (startX: number, startY: number): ExcalidrawElement => {
      return {
        id: generateId(),
        type: activeTool === 'select' ? 'rectangle' : activeTool,
        x: startX,
        y: startY,
        width: 0,
        height: 0,
        points: activeTool === 'freehand' || activeTool === 'line' || activeTool === 'arrow' ? [{ x: 0, y: 0 }] : undefined,
        text: activeTool === 'text' ? '' : undefined,
        strokeColor,
        fillColor,
        strokeWidth,
        opacity,
        fontSize: activeTool === 'text' ? fontSize : undefined,
        version: 1,
        isDeleted: false,
        createdBy: user?.id || 'anonymous',
        updatedAt: Date.now(),
      };
    },
    [activeTool, strokeColor, fillColor, strokeWidth, opacity, fontSize, user]
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!canEdit && e.key !== ' ') return;

      if (e.key === ' ') {
        e.preventDefault();
        spacePressed.current = true;
      }

      switch (e.key) {
        case 'v':
        case 'V':
          setActiveTool('select');
          break;
        case 'r':
        case 'R':
          setActiveTool('rectangle');
          break;
        case 'o':
        case 'O':
          setActiveTool('ellipse');
          break;
        case 'd':
        case 'D':
          setActiveTool('diamond');
          break;
        case 'a':
        case 'A':
          if (!e.ctrlKey && !e.metaKey) setActiveTool('arrow');
          break;
        case 'l':
        case 'L':
          setActiveTool('line');
          break;
        case 'p':
        case 'P':
          setActiveTool('freehand');
          break;
        case 't':
        case 'T':
          setActiveTool('text');
          break;
        case 'Delete':
        case 'Backspace':
          if (selectedElementId) {
            updateElement(selectedElementId, { isDeleted: true });
            wsClient.sendShapeDelete(selectedElementId);
            setSelectedElementId(null);
          }
          break;
        case 'Escape':
          setSelectedElementId(null);
          setActiveTool('select');
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        spacePressed.current = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [selectedElementId, setActiveTool, setSelectedElementId, updateElement, canEdit]);

  // Mouse event handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const point = screenToCanvas(e.clientX, e.clientY);

      // Middle mouse button or space+left click for panning; view-only users pan with any drag
      if (e.button === 1 || (e.button === 0 && (spacePressed.current || !canEdit))) {
        isPanning.current = true;
        panStart.current = { x: e.clientX - viewState.scrollX, y: e.clientY - viewState.scrollY };
        return;
      }

      if (e.button !== 0) return;

      if (activeTool === 'select') {
        // Hit test
        const visibleElements = elements.filter((el) => !el.isDeleted);
        const hit = hitTest(point.x, point.y, visibleElements);
        setSelectedElementId(hit ? hit.id : null);

        if (hit) {
          // Start dragging
          dragMoved.current = false;
          setIsDrawing(true);
          setDrawingStartPoint({ x: point.x - hit.x, y: point.y - hit.y });
        }
      } else if (activeTool === 'text') {
        // Create text element
        const text = window.prompt('Enter text:');
        if (text) {
          const el = createElement(point.x, point.y);
          el.text = text;
          // Approximate width based on text length
          el.width = text.length * (fontSize * 0.6);
          el.height = fontSize * 1.4;
          addElement(el);
          wsClient.sendShapeAdd(el);
        }
        setActiveTool('select');
      } else {
        // Start drawing a shape
        setIsDrawing(true);
        setDrawingStartPoint(point);
        setDraftPoint(point);
        setCurrentPoints([{ x: 0, y: 0 }]);
      }
    },
    [activeTool, elements, viewState, canEdit, screenToCanvas, createElement, fontSize, addElement, setActiveTool, setIsDrawing, setDrawingStartPoint, setCurrentPoints, setSelectedElementId]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const point = screenToCanvas(e.clientX, e.clientY);

      // Send cursor position over WebSocket
      wsClient.sendCursorMove(point.x, point.y);

      // Handle panning
      if (isPanning.current) {
        setViewState({
          scrollX: e.clientX - panStart.current.x,
          scrollY: e.clientY - panStart.current.y,
        });
        return;
      }

      if (!isDrawing || !drawingStartPoint) return;

      if (activeTool === 'select' && selectedElementId) {
        // Dragging selected element
        const newX = point.x - drawingStartPoint.x;
        const newY = point.y - drawingStartPoint.y;
        dragMoved.current = true;
        updateElement(selectedElementId, { x: newX, y: newY });
      } else if (activeTool === 'freehand') {
        setDraftPoint(point);
        // Add point to freehand path
        addCurrentPoint({
          x: point.x - drawingStartPoint.x,
          y: point.y - drawingStartPoint.y,
        });
      } else if (activeTool !== 'select') {
        // Update shape dimensions
        const dx = point.x - drawingStartPoint.x;
        const dy = point.y - drawingStartPoint.y;

        if (activeTool === 'line' || activeTool === 'arrow') {
          setCurrentPoints([{ x: 0, y: 0 }, { x: dx, y: dy }]);
        }
        setDraftPoint(point);
      }
    },
    [isDrawing, drawingStartPoint, activeTool, selectedElementId, screenToCanvas, viewState, setViewState, updateElement, addCurrentPoint, setCurrentPoints]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Stop panning
      if (isPanning.current) {
        isPanning.current = false;
        return;
      }

      if (!isDrawing || !drawingStartPoint) return;

      const point = screenToCanvas(e.clientX, e.clientY);

      if (activeTool === 'select' && selectedElementId) {
        // Finish dragging: send the element as it is now. Each drag step already
        // bumped its version locally; the render-time `elements` closure is stale.
        const el = useCanvasStore.getState().elements.find((e) => e.id === selectedElementId);
        if (el && dragMoved.current) {
          wsClient.sendShapeMove(el);
        }
      } else if (activeTool !== 'select' && activeTool !== 'text') {
        // Finalize the shape
        const el = createElement(drawingStartPoint.x, drawingStartPoint.y);

        if (activeTool === 'freehand') {
          const simplified = simplifyPath(currentPoints, 2);
          // Calculate bounding box
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of simplified) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
          // Re-anchor so the element's (x, y) is the bounding box's corner;
          // otherwise selection bounds ignore strokes that went up or left.
          el.x += minX;
          el.y += minY;
          el.points = simplified.map((p) => ({ x: p.x - minX, y: p.y - minY }));
          el.width = maxX - minX;
          el.height = maxY - minY;
        } else if (activeTool === 'line' || activeTool === 'arrow') {
          const dx = point.x - drawingStartPoint.x;
          const dy = point.y - drawingStartPoint.y;
          el.points = [{ x: 0, y: 0 }, { x: dx, y: dy }];
          el.width = dx;
          el.height = dy;
        } else {
          // Store boxes with positive size whichever way the user dragged, so
          // hit testing never divides by a negative dimension.
          const width = point.x - drawingStartPoint.x;
          const height = point.y - drawingStartPoint.y;
          el.x = Math.min(drawingStartPoint.x, point.x);
          el.y = Math.min(drawingStartPoint.y, point.y);
          el.width = Math.abs(width);
          el.height = Math.abs(height);
        }

        // Only add if shape has meaningful size
        if (Math.abs(el.width) > 2 || Math.abs(el.height) > 2 || (el.points && el.points.length > 2)) {
          addElement(el);
          wsClient.sendShapeAdd(el);
        }
      }

      setIsDrawing(false);
      setDrawingStartPoint(null);
      setDraftPoint(null);
      setCurrentPoints([]);
    },
    [isDrawing, drawingStartPoint, activeTool, selectedElementId, elements, currentPoints, screenToCanvas, createElement, addElement, setIsDrawing, setDrawingStartPoint, setCurrentPoints]
  );

  // Handle zoom with scroll wheel
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.1, Math.min(5, viewState.zoom * zoomFactor));

      // Zoom centered on cursor position
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const newScrollX = mouseX - (mouseX - viewState.scrollX) * (newZoom / viewState.zoom);
      const newScrollY = mouseY - (mouseY - viewState.scrollY) * (newZoom / viewState.zoom);

      setViewState({
        zoom: newZoom,
        scrollX: newScrollX,
        scrollY: newScrollY,
      });
    },
    [viewState, setViewState]
  );

  // Determine cursor style
  const getCursorClass = (): string => {
    if (spacePressed.current || isPanning.current) return 'cursor-grab';
    if (activeTool === 'select') return 'cursor-default';
    if (activeTool === 'text') return 'cursor-text';
    return 'cursor-crosshair';
  };

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden bg-canvas-bg">
      <canvas
        ref={canvasRef}
        width={Math.round(canvasSize.width * pixelRatio)}
        height={Math.round(canvasSize.height * pixelRatio)}
        className={`w-full h-full ${getCursorClass()}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {/* Zoom indicator */}
      <div className="absolute bottom-4 right-4 bg-white rounded-lg shadow-md px-3 py-1 text-sm text-text-secondary">
        {Math.round(viewState.zoom * 100)}%
      </div>
    </div>
  );
}
