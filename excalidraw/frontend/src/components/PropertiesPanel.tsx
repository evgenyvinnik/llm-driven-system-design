import { useCanvasStore } from '../stores/canvasStore';
import { wsClient } from '../services/websocket';
import type { ExcalidrawElement } from '../types';

const STROKE_COLORS = [
  '#1e1e1e', '#e03131', '#c2255c', '#9c36b5', '#6741d9',
  '#3b5bdb', '#1971c2', '#0c8599', '#099268', '#2f9e44',
  '#e8590c', '#868e96',
];

const FILL_COLORS = [
  'transparent', '#ffc9c9', '#fcc2d7', '#eebefa', '#d0bfff',
  '#bac8ff', '#a5d8ff', '#99e9f2', '#96f2d7', '#b2f2bb',
  '#ffe8cc', '#e9ecef',
];

const STROKE_WIDTHS = [1, 2, 3, 4, 6];

/** Renders the properties panel for editing selected element styles. */
export function PropertiesPanel() {
  const {
    strokeColor,
    fillColor,
    strokeWidth,
    opacity,
    fontSize,
    selectedElementId,
    elements,
    setStrokeColor,
    setFillColor,
    setStrokeWidth,
    setOpacity,
    setFontSize,
    updateElement,
  } = useCanvasStore();

  const selectedElement = selectedElementId
    ? elements.find((el) => el.id === selectedElementId && !el.isDeleted)
    : null;

  // With a shape selected the controls show and edit that shape; otherwise
  // they set the defaults for the next shape drawn.
  const shown = {
    strokeColor: selectedElement?.strokeColor ?? strokeColor,
    fillColor: selectedElement?.fillColor ?? fillColor,
    strokeWidth: selectedElement?.strokeWidth ?? strokeWidth,
    opacity: selectedElement?.opacity ?? opacity,
    fontSize: selectedElement?.fontSize ?? fontSize,
  };

  /** Applies a style change to the selected shape and sends it to collaborators. */
  const applyToSelection = (updates: Partial<ExcalidrawElement>) => {
    if (!selectedElementId) return;
    updateElement(selectedElementId, updates);
    const updated = useCanvasStore.getState().elements.find((el) => el.id === selectedElementId);
    if (updated) wsClient.sendShapeUpdate(updated);
  };

  const handleStrokeColorChange = (color: string) => {
    setStrokeColor(color);
    applyToSelection({ strokeColor: color });
  };

  const handleFillColorChange = (color: string) => {
    setFillColor(color);
    applyToSelection({ fillColor: color });
  };

  const handleStrokeWidthChange = (width: number) => {
    setStrokeWidth(width);
    applyToSelection({ strokeWidth: width });
  };

  const handleOpacityChange = (value: number) => {
    setOpacity(value);
    applyToSelection({ opacity: value });
  };

  const handleFontSizeChange = (size: number) => {
    setFontSize(size);
    if (selectedElement?.type === 'text') applyToSelection({ fontSize: size });
  };

  return (
    <div className="fixed left-4 top-20 z-40">
      <div className="bg-white rounded-xl shadow-lg p-4 w-52 space-y-4">
        {/* Stroke Color */}
        <div>
          <label className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2 block">
            Stroke
          </label>
          <div className="grid grid-cols-6 gap-1.5">
            {STROKE_COLORS.map((color) => (
              <button
                key={color}
                className={`color-swatch ${shown.strokeColor === color ? 'selected' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => handleStrokeColorChange(color)}
              />
            ))}
          </div>
        </div>

        {/* Fill Color */}
        <div>
          <label className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2 block">
            Fill
          </label>
          <div className="grid grid-cols-6 gap-1.5">
            {FILL_COLORS.map((color, i) => (
              <button
                key={i}
                className={`color-swatch ${shown.fillColor === color ? 'selected' : ''} ${
                  color === 'transparent' ? 'bg-white border-dashed' : ''
                }`}
                style={color !== 'transparent' ? { backgroundColor: color } : undefined}
                onClick={() => handleFillColorChange(color)}
                title={color === 'transparent' ? 'No fill' : color}
              />
            ))}
          </div>
        </div>

        {/* Stroke Width */}
        <div>
          <label className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2 block">
            Stroke Width
          </label>
          <div className="flex gap-1">
            {STROKE_WIDTHS.map((width) => (
              <button
                key={width}
                className={`flex-1 h-8 rounded border transition-colors flex items-center justify-center ${
                  shown.strokeWidth === width
                    ? 'border-selection-blue bg-selection-light'
                    : 'border-panel-border hover:bg-panel-bg'
                }`}
                onClick={() => handleStrokeWidthChange(width)}
              >
                <div
                  className="bg-text-primary rounded-full"
                  style={{ width: `${width * 3}px`, height: `${width * 3}px` }}
                />
              </button>
            ))}
          </div>
        </div>

        {/* Opacity */}
        <div>
          <label className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2 block">
            Opacity: {Math.round(shown.opacity * 100)}%
          </label>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={shown.opacity}
            onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
            className="w-full accent-selection-blue"
          />
        </div>

        {/* Font Size (when text is selected) */}
        {(!selectedElement || selectedElement.type === 'text') && (
          <div>
            <label className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2 block">
              Font Size
            </label>
            <select
              value={shown.fontSize}
              onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
              className="w-full border border-panel-border rounded px-2 py-1 text-sm"
            >
              <option value={12}>12</option>
              <option value={14}>14</option>
              <option value={16}>16</option>
              <option value={20}>20</option>
              <option value={24}>24</option>
              <option value={32}>32</option>
              <option value={48}>48</option>
            </select>
          </div>
        )}
      </div>
    </div>
  );
}
