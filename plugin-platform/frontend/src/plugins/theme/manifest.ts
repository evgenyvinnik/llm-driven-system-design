import type { PluginManifest } from '../../core/types';

export const manifest: PluginManifest = {
  id: 'theme',
  name: 'Theme Switcher',
  version: '1.0.0',
  description: 'Toggle between light and dark mode',
  contributes: {
    slots: [
      { slot: 'toolbar', component: 'ThemeToggle', order: 200 },
    ],
    commands: [
      { id: 'toggle', handler: 'toggleTheme' },
    ],
    settings: [
      { id: 'defaultTheme', type: 'select', default: 'light' },
    ],
  },
};
