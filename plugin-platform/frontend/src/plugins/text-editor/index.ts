// Text Editor Plugin
// Provides the core text editing functionality

import type { PluginContext } from '../../core/types';
import { STATE_KEYS } from '../../core/types';
import { manifest } from './manifest';
import { TextEditor } from './TextEditor';

export { manifest, TextEditor };

export function activate(context: PluginContext): void {
  // Initialize content state
  const savedContent = context.storage.get<string>('content');
  context.state.set(STATE_KEYS.CONTENT, savedContent || '');

  // Register commands
  context.commands.register('clear', () => {
    context.state.set(STATE_KEYS.CONTENT, '');
    context.storage.set('content', '');
  });

  context.commands.register('selectAll', () => {
    const content = context.state.get<string>(STATE_KEYS.CONTENT) || '';
    context.state.set(STATE_KEYS.SELECTION, { start: 0, end: content.length });
  });

  console.log('[text-editor] Plugin activated');
}
