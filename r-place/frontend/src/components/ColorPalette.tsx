/**
 * Color palette component for selecting the pixel color.
 *
 * Displays the 16-color palette matching the original r/place.
 * Highlights the currently selected color.
 */
import { useAppStore } from '../stores/appStore';

/**
 * Renders a grid of color buttons for color selection.
 * The selected color is highlighted with a ring indicator.
 */
export function ColorPalette() {
  const { config, selectedColor, setSelectedColor } = useAppStore();

  if (!config) return null;

  return (
    <div className="flex flex-wrap gap-1 p-2 bg-gray-800 rounded-lg max-w-xs">
      {config.colors.map((color, index) => (
        <button
          key={index}
          className={`w-8 h-8 rounded transition-transform hover:scale-110 ${
            selectedColor === index
              ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-800 scale-110'
              : ''
          }`}
          style={{ backgroundColor: color }}
          onClick={() => setSelectedColor(index)}
          title={`Color ${index}: ${color}`}
        />
      ))}
    </div>
  );
}
