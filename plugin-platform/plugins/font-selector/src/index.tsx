import React from 'react';
import {
  definePlugin,
  useStateValue,
  STATE_KEYS,
  type PluginProps,
  type PluginManifest,
  type PluginContext,
} from '@plugin-platform/sdk';

// ============================================================================
// Manifest
// ============================================================================

export const manifest: PluginManifest = {
  id: 'font-selector',
  name: 'Font Selector',
  version: '1.0.0',
  description: 'Choose fonts and sizes for your text',
  category: 'formatting',
  contributes: {
    slots: [
      { slot: 'toolbar', component: 'FontSelector', order: 10 },
    ],
    settings: [
      { id: 'defaultFont', type: 'string', default: 'system-ui', label: 'Default Font' },
      { id: 'defaultSize', type: 'number', default: 16, label: 'Default Size' },
    ],
  },
};

// ============================================================================
// Font Definitions
// ============================================================================

export interface Font {
  id: string;
  name: string;
  value: string;
}

export const FONTS: Font[] = [
  { id: 'system', name: 'System', value: 'system-ui, -apple-system, sans-serif' },
  { id: 'serif', name: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { id: 'sans', name: 'Sans Serif', value: 'Arial, Helvetica, sans-serif' },
  { id: 'mono', name: 'Monospace', value: 'Monaco, "Courier New", monospace' },
  { id: 'comic', name: 'Comic', value: '"Comic Sans MS", cursive' },
  { id: 'handwriting', name: 'Handwriting', value: '"Brush Script MT", "Segoe Script", cursive' },
  { id: 'typewriter', name: 'Typewriter', value: '"American Typewriter", "Courier New", monospace' },
];

export const SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64];

// ============================================================================
// Components
// ============================================================================

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

// ============================================================================
// Plugin Lifecycle
// ============================================================================

export function activate(context: PluginContext): void {
  // Set defaults from storage or use system font
  const savedFont = context.storage.get<string>('selectedFont');
  const savedSize = context.storage.get<number>('selectedSize');

  context.state.set(STATE_KEYS.FONT_FAMILY, savedFont || FONTS[0].value);
  context.state.set(STATE_KEYS.FONT_SIZE, savedSize || 16);

  // Save selections to storage when they change
  context.state.subscribe(STATE_KEYS.FONT_FAMILY, (font) => {
    context.storage.set('selectedFont', font);
  });

  context.state.subscribe(STATE_KEYS.FONT_SIZE, (size) => {
    context.storage.set('selectedSize', size);
  });

  console.log('[font-selector] Plugin activated');
}

// ============================================================================
// Export Plugin Module
// ============================================================================

export default definePlugin({
  manifest,
  activate,
  FontSelector,
});
