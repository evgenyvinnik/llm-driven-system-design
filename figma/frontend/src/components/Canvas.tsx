/**
 * Main canvas component for the design editor.
 * Provides an interactive drawing surface with pan, zoom, object selection,
 * and shape creation tools. Renders using PixiJS for hardware-accelerated graphics.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '../stores/editorStore';
import type { DesignObject } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { PixiRenderer } from '../renderer/PixiRenderer';

/**
 * Props for the Canvas component.
 */
interface CanvasProps {
  /** Function to send cursor and selection presence to other collaborators */
  sendPresence: (cursor?: { x: number; y: number }, selection?: string[]) => void;
}

/**
 * Canvas component for interactive design editing.
 * Handles mouse events for selection, dragging, and drawing new shapes.
 * Displays collaborator cursors and syncs viewport state with the store.
 * @param props - Component props including sendPresence callback
 * @returns The rendered canvas element
 */
export function Canvas({ sendPresence }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [rendererReady, setRendererReady] = useState(false);

  const {
    canvasData,
    selectedIds,
    activeTool,
    viewport,
    collaborators,
    setSelectedIds,
    setViewport,
    addObject,
    updateObject,
  } = useEditorStore();

  // Initialize PixiJS renderer
  useEffect(() => {
    if (!containerRef.current) return;

    const renderer = new PixiRenderer(containerRef.current);
    rendererRef.current = renderer;

    // Wait for initialization
    const checkInitialized = setInterval(() => {
      if (renderer.initialized) {
        clearInterval(checkInitialized);
        setRendererReady(true);
      }
    }, 10);

    return () => {
      clearInterval(checkInitialized);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback(
    (screenX: number, screenY: number): { x: number; y: number } => {
      if (rendererRef.current) {
        return rendererRef.current.screenToCanvas(screenX, screenY);
      }
      return { x: 0, y: 0 };
    },
    []
  );

  // Find object at position
  const findObjectAtPosition = useCallback(
    (x: number, y: number): DesignObject | null => {
      if (rendererRef.current) {
        return rendererRef.current.getObjectAtPoint(x, y, canvasData.objects);
      }
      return null;
    },
    [canvasData.objects]
  );

  // Render on state changes
  useEffect(() => {
    if (rendererRef.current && rendererReady) {
      rendererRef.current.setViewport(viewport);
      rendererRef.current.render(canvasData.objects, selectedIds, collaborators);
    }
  }, [canvasData.objects, selectedIds, viewport, collaborators, rendererReady]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (rendererRef.current) {
        rendererRef.current.resize();
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Mouse event handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    const canvasPos = screenToCanvas(e.clientX, e.clientY);

    if (activeTool === 'hand') {
      setIsDragging(true);
      setDragStart({ x: e.clientX - viewport.x, y: e.clientY - viewport.y });
      return;
    }

    if (activeTool === 'select') {
      const obj = findObjectAtPosition(canvasPos.x, canvasPos.y);
      if (obj) {
        if (e.shiftKey) {
          // Multi-select
          if (selectedIds.includes(obj.id)) {
            setSelectedIds(selectedIds.filter((id) => id !== obj.id));
          } else {
            setSelectedIds([...selectedIds, obj.id]);
          }
        } else {
          setSelectedIds([obj.id]);
        }
        setIsDragging(true);
        setDragStart(canvasPos);
      } else {
        setSelectedIds([]);
      }
      return;
    }

    // Drawing tools
    if (activeTool === 'rectangle' || activeTool === 'ellipse' || activeTool === 'text') {
      setIsDrawing(true);
      setDrawStart(canvasPos);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvasPos = screenToCanvas(e.clientX, e.clientY);

    // Send presence update
    sendPresence(canvasPos, selectedIds);

    if (isDragging) {
      if (activeTool === 'hand') {
        setViewport({
          x: e.clientX - dragStart.x,
          y: e.clientY - dragStart.y,
        });
      } else if (activeTool === 'select' && selectedIds.length > 0) {
        const dx = canvasPos.x - dragStart.x;
        const dy = canvasPos.y - dragStart.y;
        selectedIds.forEach((id) => {
          const obj = canvasData.objects.find((o) => o.id === id);
          if (obj && !obj.locked) {
            updateObject(id, {
              x: obj.x + dx,
              y: obj.y + dy,
            });
          }
        });
        setDragStart(canvasPos);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (isDrawing) {
      const canvasPos = screenToCanvas(e.clientX, e.clientY);
      const width = Math.abs(canvasPos.x - drawStart.x);
      const height = Math.abs(canvasPos.y - drawStart.y);
      const x = Math.min(canvasPos.x, drawStart.x);
      const y = Math.min(canvasPos.y, drawStart.y);

      if (width > 5 || height > 5 || activeTool === 'text') {
        const newObject: DesignObject = {
          id: uuidv4(),
          type: activeTool as 'rectangle' | 'ellipse' | 'text',
          name: `${activeTool.charAt(0).toUpperCase() + activeTool.slice(1)} ${canvasData.objects.length + 1}`,
          x,
          y,
          width: activeTool === 'text' ? 100 : Math.max(width, 10),
          height: activeTool === 'text' ? 24 : Math.max(height, 10),
          rotation: 0,
          fill: activeTool === 'text' ? '#FFFFFF' : '#3B82F6',
          stroke: '#1E40AF',
          strokeWidth: activeTool === 'text' ? 0 : 2,
          opacity: 1,
          visible: true,
          locked: false,
          text: activeTool === 'text' ? 'Text' : undefined,
          fontSize: activeTool === 'text' ? 16 : undefined,
          fontFamily: activeTool === 'text' ? 'Inter, sans-serif' : undefined,
        };
        addObject(newObject);
      }
      setIsDrawing(false);
    }
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.1, Math.min(5, viewport.zoom * zoomFactor));

      // Zoom toward cursor
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        setViewport({
          zoom: newZoom,
          x: mouseX - (mouseX - viewport.x) * (newZoom / viewport.zoom),
          y: mouseY - (mouseY - viewport.y) * (newZoom / viewport.zoom),
        });
      }
    } else {
      // Pan
      setViewport({
        x: viewport.x - e.deltaX,
        y: viewport.y - e.deltaY,
      });
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        selectedIds.forEach((id) => {
          const obj = canvasData.objects.find((o) => o.id === id);
          if (obj && !obj.locked) {
            useEditorStore.getState().deleteObject(id);
          }
        });
      }
      if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        selectedIds.forEach((id) => {
          useEditorStore.getState().duplicateObject(id);
        });
      }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) {
          useEditorStore.getState().redo();
        } else {
          useEditorStore.getState().undo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, canvasData.objects]);

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden relative">
      {/* PixiJS canvas is appended here by the renderer */}
      <div
        className="absolute inset-0"
        style={{
          cursor:
            activeTool === 'hand' ? 'grab' : activeTool === 'select' ? 'default' : 'crosshair',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />

      {/* Zoom indicator */}
      <div className="absolute bottom-4 right-4 bg-figma-panel px-3 py-1 rounded text-sm text-figma-text-secondary pointer-events-none">
        {Math.round(viewport.zoom * 100)}%
      </div>
    </div>
  );
}
