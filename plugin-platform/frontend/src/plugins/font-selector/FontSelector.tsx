import React from 'react';
import { useStateValue } from '../../core/PluginHost';
import type { PluginProps } from '../../core/types';
import { STATE_KEYS } from '../../core/types';
import { FONTS, SIZES } from './manifest';

/**
 * Toolbar component for selecting font family and size.
 */
export function FontSelector({ context }: PluginProps): React.ReactElement {
  const currentFont = useStateValue<string>(context, STATE_KEYS.FONT_FAMILY) || FONTS[0].value;
  const currentSize = useStateValue<number>(context, STATE_KEYS.FONT_SIZE) || 16;

  const handleFontChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const font = FONTS.find((f) => f.id === e.target.value);
    if (font) {
      context.state.set(STATE_KEYS.FONT_FAMILY, font.value);
      context.events.emit('format:font-changed', { fontFamily: font.value });
    }
  };

  const handleSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const size = parseInt(e.target.value, 10);
    context.state.set(STATE_KEYS.FONT_SIZE, size);
    context.events.emit('format:size-changed', { fontSize: size });
  };

  // Find current font ID from value
  const currentFontId = FONTS.find((f) => f.value === currentFont)?.id || 'system';

  return (
    <div className="flex items-center gap-3">
      {/* Font Family */}
      <div className="flex items-center gap-2">
        <label htmlFor="font-select" className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Font:
        </label>
        <select
          id="font-select"
          value={currentFontId}
          onChange={handleFontChange}
          className="px-2 py-1 text-sm border border-gray-300 rounded-md bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          style={{ fontFamily: currentFont }}
        >
          {FONTS.map((font) => (
            <option key={font.id} value={font.id} style={{ fontFamily: font.value }}>
              {font.name}
            </option>
          ))}
        </select>
      </div>

      {/* Font Size */}
      <div className="flex items-center gap-2">
        <label htmlFor="size-select" className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Size:
        </label>
        <select
          id="size-select"
          value={currentSize}
          onChange={handleSizeChange}
          className="px-2 py-1 text-sm border border-gray-300 rounded-md bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {SIZES.map((size) => (
            <option key={size} value={size}>
              {size}px
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
