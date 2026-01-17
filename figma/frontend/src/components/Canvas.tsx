import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '../stores/editorStore';
import type { DesignObject, Viewport } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface CanvasProps {
  sendPresence: (cursor?: { x: number; y: number }, selection?: string[]) => void;
}

export function Canvas({ sendPresence }: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });

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

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback((screenX: number, screenY: number): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };

    return {
      x: (screenX - rect.left - viewport.x) / viewport.zoom,
      y: (screenY - rect.top - viewport.y) / viewport.zoom,
    };
  }, [viewport]);

  // Convert canvas coordinates to screen coordinates
  const canvasToScreen = useCallback((canvasX: number, canvasY: number): { x: number; y: number } => {
    return {
      x: canvasX * viewport.zoom + viewport.x,
      y: canvasY * viewport.zoom + viewport.y,
    };
  }, [viewport]);

  // Find object at position
  const findObjectAtPosition = useCallback((x: number, y: number): DesignObject | null => {
    // Search in reverse order (top-most first)
    for (let i = canvasData.objects.length - 1; i >= 0; i--) {
      const obj = canvasData.objects[i];
      if (!obj.visible || obj.locked) continue;

      if (
        x >= obj.x &&
        x <= obj.x + obj.width &&
        y >= obj.y &&
        y <= obj.y + obj.height
      ) {
        return obj;
      }
    }
    return null;
  }, [canvasData.objects]);

  // Render canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const container = containerRef.current;
    if (container) {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    }

    // Clear canvas
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Apply viewport transform
    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    // Draw grid
    drawGrid(ctx, canvas.width, canvas.height);

    // Draw objects
    canvasData.objects.forEach(obj => {
      if (!obj.visible) return;
      drawObject(ctx, obj, selectedIds.includes(obj.id));
    });

    ctx.restore();

    // Draw collaborator cursors (in screen space)
    collaborators.forEach(collab => {
      if (collab.cursor) {
        const screenPos = canvasToScreen(collab.cursor.x, collab.cursor.y);
        drawCursor(ctx, screenPos.x, screenPos.y, collab.userColor, collab.userName);
      }
    });
  }, [canvasData.objects, selectedIds, viewport, collaborators, canvasToScreen]);

  // Draw grid
  const drawGrid = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const gridSize = 20;
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 0.5 / viewport.zoom;

    const startX = Math.floor(-viewport.x / viewport.zoom / gridSize) * gridSize;
    const startY = Math.floor(-viewport.y / viewport.zoom / gridSize) * gridSize;
    const endX = startX + width / viewport.zoom + gridSize;
    const endY = startY + height / viewport.zoom + gridSize;

    for (let x = startX; x <= endX; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
      ctx.stroke();
    }

    for (let y = startY; y <= endY; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
      ctx.stroke();
    }
  };

  // Draw object
  const drawObject = (ctx: CanvasRenderingContext2D, obj: DesignObject, isSelected: boolean) => {
    ctx.save();
    ctx.globalAlpha = obj.opacity;

    // Apply rotation
    if (obj.rotation !== 0) {
      const centerX = obj.x + obj.width / 2;
      const centerY = obj.y + obj.height / 2;
      ctx.translate(centerX, centerY);
      ctx.rotate((obj.rotation * Math.PI) / 180);
      ctx.translate(-centerX, -centerY);
    }

    switch (obj.type) {
      case 'rectangle':
      case 'frame':
        ctx.fillStyle = obj.fill;
        ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
        if (obj.strokeWidth > 0) {
          ctx.strokeStyle = obj.stroke;
          ctx.lineWidth = obj.strokeWidth;
          ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
        }
        break;

      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse(
          obj.x + obj.width / 2,
          obj.y + obj.height / 2,
          obj.width / 2,
          obj.height / 2,
          0,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = obj.fill;
        ctx.fill();
        if (obj.strokeWidth > 0) {
          ctx.strokeStyle = obj.stroke;
          ctx.lineWidth = obj.strokeWidth;
          ctx.stroke();
        }
        break;

      case 'text':
        ctx.fillStyle = obj.fill;
        ctx.font = `${obj.fontWeight || 'normal'} ${obj.fontSize || 16}px ${obj.fontFamily || 'Inter, sans-serif'}`;
        ctx.textAlign = obj.textAlign || 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(obj.text || 'Text', obj.x, obj.y);
        break;
    }

    // Draw selection outline
    if (isSelected) {
      ctx.strokeStyle = '#0D99FF';
      ctx.lineWidth = 2 / viewport.zoom;
      ctx.setLineDash([]);

      if (obj.type === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(
          obj.x + obj.width / 2,
          obj.y + obj.height / 2,
          obj.width / 2 + 2 / viewport.zoom,
          obj.height / 2 + 2 / viewport.zoom,
          0,
          0,
          Math.PI * 2
        );
        ctx.stroke();
      } else {
        ctx.strokeRect(
          obj.x - 2 / viewport.zoom,
          obj.y - 2 / viewport.zoom,
          obj.width + 4 / viewport.zoom,
          obj.height + 4 / viewport.zoom
        );
      }

      // Draw resize handles
      const handleSize = 8 / viewport.zoom;
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#0D99FF';
      ctx.lineWidth = 1 / viewport.zoom;

      const handles = [
        { x: obj.x, y: obj.y },
        { x: obj.x + obj.width / 2, y: obj.y },
        { x: obj.x + obj.width, y: obj.y },
        { x: obj.x + obj.width, y: obj.y + obj.height / 2 },
        { x: obj.x + obj.width, y: obj.y + obj.height },
        { x: obj.x + obj.width / 2, y: obj.y + obj.height },
        { x: obj.x, y: obj.y + obj.height },
        { x: obj.x, y: obj.y + obj.height / 2 },
      ];

      handles.forEach(handle => {
        ctx.fillRect(
          handle.x - handleSize / 2,
          handle.y - handleSize / 2,
          handleSize,
          handleSize
        );
        ctx.strokeRect(
          handle.x - handleSize / 2,
          handle.y - handleSize / 2,
          handleSize,
          handleSize
        );
      });
    }

    ctx.restore();
  };

  // Draw cursor
  const drawCursor = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    name: string
  ) => {
    ctx.save();
    ctx.fillStyle = color;

    // Cursor shape
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 12, y + 10);
    ctx.lineTo(x + 6, y + 10);
    ctx.lineTo(x + 6, y + 16);
    ctx.lineTo(x, y + 16);
    ctx.closePath();
    ctx.fill();

    // Name label
    ctx.font = '12px Inter, sans-serif';
    const textWidth = ctx.measureText(name).width;
    ctx.fillStyle = color;
    ctx.fillRect(x + 10, y + 14, textWidth + 8, 18);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(name, x + 14, y + 27);

    ctx.restore();
  };

  // Handle mouse events
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
            setSelectedIds(selectedIds.filter(id => id !== obj.id));
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
        selectedIds.forEach(id => {
          const obj = canvasData.objects.find(o => o.id === id);
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
      const rect = canvasRef.current?.getBoundingClientRect();
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

  // Re-render on state changes
  useEffect(() => {
    render();
  }, [render]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => render();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [render]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        selectedIds.forEach(id => {
          const obj = canvasData.objects.find(o => o.id === id);
          if (obj && !obj.locked) {
            useEditorStore.getState().deleteObject(id);
          }
        });
      }
      if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        selectedIds.forEach(id => {
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
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        style={{
          cursor: activeTool === 'hand' ? 'grab' : activeTool === 'select' ? 'default' : 'crosshair',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />

      {/* Zoom indicator */}
      <div className="absolute bottom-4 right-4 bg-figma-panel px-3 py-1 rounded text-sm text-figma-text-secondary">
        {Math.round(viewport.zoom * 100)}%
      </div>
    </div>
  );
}
