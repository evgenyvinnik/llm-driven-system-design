// Font Selector Plugin
// Provides font family and size selection for the editor

import type { PluginContext } from '../../core/types';
import { STATE_KEYS } from '../../core/types';
import { manifest, FONTS } from './manifest';
import { FontSelector } from './FontSelector';

export { manifest, FontSelector };

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
