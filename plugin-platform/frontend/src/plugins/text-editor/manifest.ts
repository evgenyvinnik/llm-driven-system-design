import type { PluginManifest } from '../../core/types';

export const manifest: PluginManifest = {
  id: 'text-editor',
  name: 'Text Editor',
  version: '1.0.0',
  description: 'Core text editing functionality',
  contributes: {
    slots: [
      { slot: 'canvas', component: 'TextEditor', order: 50 },
    ],
  },
  requires: {
    state: ['format.fontFamily', 'format.fontSize', 'theme.paper'],
  },
};
