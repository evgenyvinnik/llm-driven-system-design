// Theme Plugin
// Provides light/dark mode switching

import type { PluginContext } from '../../core/types';
import { STATE_KEYS } from '../../core/types';
import { manifest } from './manifest';
import { ThemeToggle } from './ThemeToggle';

export { manifest, ThemeToggle };

export function activate(context: PluginContext): void {
  // Set default theme from storage or system preference
  const savedTheme = context.storage.get<string>('theme');
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const defaultTheme = savedTheme || (systemPrefersDark ? 'dark' : 'light');

  context.state.set(STATE_KEYS.THEME_MODE, defaultTheme);

  // Apply theme class to document
  updateDocumentTheme(defaultTheme);

  // Save theme and update document when it changes
  context.state.subscribe(STATE_KEYS.THEME_MODE, (mode) => {
    context.storage.set('theme', mode);
    updateDocumentTheme(mode as string);
  });

  // Register toggle command
  context.commands.register('toggle', () => {
    const current = context.state.get<string>(STATE_KEYS.THEME_MODE);
    context.state.set(STATE_KEYS.THEME_MODE, current === 'dark' ? 'light' : 'dark');
  });

  console.log('[theme] Plugin activated');
}

function updateDocumentTheme(mode: string): void {
  if (mode === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}
