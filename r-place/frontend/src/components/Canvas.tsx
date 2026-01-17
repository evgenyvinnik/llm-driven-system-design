/**
 * Interactive canvas component for viewing and editing the pixel canvas.
 *
 * Features:
 * - Renders the canvas from pixel data
 * - Supports zoom (mouse wheel) and pan (right/middle click drag)
 * - Shows hover indicator at high zoom levels
 * - Handles pixel placement on click
 * - Displays notifications and status indicators
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '../stores/appStore';

/**
 * Main canvas component providing the interactive pixel editing experience.
 * Uses HTML5 Canvas for efficient pixel rendering.
 */
export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [notification, setNotification] = useState<string | null>(null);

  const {
    config,
    canvas,
    selectedColor,
    zoom,
    panOffset,
    setZoom,
    setPanOffset,
    setHoveredPixel,
    hoveredPixel,
    placePixel,
    cooldown,
    isAuthenticated,
  } = useAppStore();

  /**
   * Renders the canvas from pixel data.
   * Iterates through all pixels and draws them with their corresponding colors.
   */
  const renderCanvas = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !config || !canvas) return;

    const { width, height, colors } = config;

    // Clear canvas
    ctx.imageSmoothingEnabled = false;

    // Draw each pixel
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const colorIndex = canvas[y * width + x];
        ctx.fillStyle = colors[colorIndex] || '#FFFFFF';
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }, [config, canvas]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  /**
   * Handles zoom with mouse wheel.
   * Prevents default scroll behavior and adjusts zoom level.
   */
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = zoom * delta;
      setZoom(newZoom);
    },
    [zoom, setZoom]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }
  }, [handleWheel]);

  /**
   * Converts mouse event coordinates to canvas pixel coordinates.
   * Returns null if the coordinates are outside the canvas bounds.
   */
  const getCanvasCoords = useCallback(
    (e: React.MouseEvent) => {
      if (!canvasRef.current || !config) return null;

      const rect = canvasRef.current.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) / zoom);
      const y = Math.floor((e.clientY - rect.top) / zoom);

      if (x >= 0 && x < config.width && y >= 0 && y < config.height) {
        return { x, y };
      }
      return null;
    },
    [zoom, config]
  );

  /**
   * Handles mouse movement for hover tracking and panning.
   * Updates hovered pixel or pan offset based on drag state.
   */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        setPanOffset({
          x: panOffset.x + dx,
          y: panOffset.y + dy,
        });
        setDragStart({ x: e.clientX, y: e.clientY });
      } else {
        const coords = getCanvasCoords(e);
        setHoveredPixel(coords);
      }
    },
    [isDragging, dragStart, panOffset, getCanvasCoords, setHoveredPixel, setPanOffset]
  );

  /**
   * Initiates panning on middle or right mouse button press.
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || e.button === 2) {
        // Middle or right click for panning
        e.preventDefault();
        setIsDragging(true);
        setDragStart({ x: e.clientX, y: e.clientY });
      }
    },
    []
  );

  /**
   * Ends panning on mouse button release.
   */
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  /**
   * Handles left-click to place a pixel.
   * Validates authentication and cooldown before placing.
   */
  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      if (e.button !== 0) return; // Only left click

      const coords = getCanvasCoords(e);
      if (!coords) return;

      if (!isAuthenticated) {
        setNotification('Please sign in to place pixels');
        setTimeout(() => setNotification(null), 3000);
        return;
      }

      if (cooldown && !cooldown.canPlace) {
        setNotification(`Wait ${cooldown.remainingSeconds}s`);
        setTimeout(() => setNotification(null), 2000);
        return;
      }

      try {
        await placePixel(coords.x, coords.y);
        setNotification('Pixel placed!');
        setTimeout(() => setNotification(null), 2000);
      } catch (err) {
        setNotification(err instanceof Error ? err.message : 'Failed to place pixel');
        setTimeout(() => setNotification(null), 3000);
      }
    },
    [getCanvasCoords, placePixel, isAuthenticated, cooldown]
  );

  /**
   * Prevents context menu on right-click (used for panning).
   */
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-white text-lg">Loading canvas...</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-gray-900 cursor-crosshair"
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div
        className="absolute"
        style={{
          transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
        }}
      >
        <canvas
          ref={canvasRef}
          width={config.width}
          height={config.height}
          style={{
            width: config.width * zoom,
            height: config.height * zoom,
            imageRendering: 'pixelated',
          }}
        />

        {/* Hover indicator */}
        {hoveredPixel && zoom >= 2 && (
          <div
            className="absolute border-2 border-white pointer-events-none"
            style={{
              left: hoveredPixel.x * zoom,
              top: hoveredPixel.y * zoom,
              width: zoom,
              height: zoom,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
            }}
          />
        )}
      </div>

      {/* Notification */}
      {notification && (
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg">
          {notification}
        </div>
      )}

      {/* Zoom indicator */}
      <div className="absolute bottom-4 right-4 bg-gray-800 text-white px-3 py-1 rounded text-sm">
        {Math.round(zoom * 100)}%
      </div>

      {/* Coordinates */}
      {hoveredPixel && (
        <div className="absolute bottom-4 left-4 bg-gray-800 text-white px-3 py-1 rounded text-sm">
          ({hoveredPixel.x}, {hoveredPixel.y})
        </div>
      )}
    </div>
  );
}
