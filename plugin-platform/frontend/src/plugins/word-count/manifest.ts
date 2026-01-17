import type { PluginManifest } from '../../core/types';

export const manifest: PluginManifest = {
  id: 'word-count',
  name: 'Word Count',
  version: '1.0.0',
  description: 'Display word and character counts in the status bar',
  contributes: {
    slots: [
      { slot: 'statusbar', component: 'WordCount', order: 100 },
    ],
  },
  requires: {
    events: ['editor:content-changed'],
    state: ['editor.content'],
  },
};
