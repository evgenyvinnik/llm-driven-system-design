/**
 * Toolbar component with zoom controls and connection status indicator.
 *
 * Features:
 * - Zoom in/out buttons
 * - Reset view button (centers canvas at 100% zoom)
 * - WebSocket connection status indicator
 */
import { useAppStore } from '../stores/appStore';

/**
 * Renders zoom controls and connection status in the header toolbar.
 */
export function Toolbar() {
  const { zoom, setZoom, setPanOffset, config, isConnected } = useAppStore();

  /** Increases zoom by 50%. */
  const handleZoomIn = () => setZoom(zoom * 1.5);

  /** Decreases zoom by 33%. */
  const handleZoomOut = () => setZoom(zoom / 1.5);

  /**
   * Resets view to 100% zoom and centers the canvas in the viewport.
   */
  const handleReset = () => {
    setZoom(1);
    if (config) {
      setPanOffset({
        x: (window.innerWidth - config.width) / 2,
        y: (window.innerHeight - config.height) / 2,
      });
    }
  };

  return (
    <div className="flex items-center gap-2 bg-gray-800 p-2 rounded-lg">
      <button
        onClick={handleZoomOut}
        className="w-8 h-8 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        title="Zoom Out"
      >
        -
      </button>
      <button
        onClick={handleReset}
        className="px-3 h-8 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
        title="Reset View"
      >
        Reset
      </button>
      <button
        onClick={handleZoomIn}
        className="w-8 h-8 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        title="Zoom In"
      >
        +
      </button>

      {/* Connection indicator */}
      <div
        className={`ml-2 w-2 h-2 rounded-full ${
          isConnected ? 'bg-green-500' : 'bg-red-500'
        }`}
        title={isConnected ? 'Connected' : 'Disconnected'}
      />
    </div>
  );
}
