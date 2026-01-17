// Paper Background Plugin
// Provides different paper styles as editor backgrounds

import type { PluginContext } from '../../core/types';
import { STATE_KEYS } from '../../core/types';
import { manifest } from './manifest';
import { PaperBackground } from './PaperBackground';
import { PaperSelector } from './PaperSelector';

export { manifest, PaperBackground, PaperSelector };

export function activate(context: PluginContext): void {
  // Set default paper from storage or use plain
  const savedPaper = context.storage.get<string>('selectedPaper');
  context.state.set(STATE_KEYS.PAPER, savedPaper || 'plain');

  // Save paper selection to storage when it changes
  context.state.subscribe(STATE_KEYS.PAPER, (paper) => {
    context.storage.set('selectedPaper', paper);
  });

  console.log('[paper-background] Plugin activated');
}
