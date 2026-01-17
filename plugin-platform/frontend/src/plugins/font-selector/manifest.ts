import type { PluginManifest } from '../../core/types';

export const manifest: PluginManifest = {
  id: 'font-selector',
  name: 'Font Selector',
  version: '1.0.0',
  description: 'Choose fonts and sizes for your text',
  contributes: {
    slots: [
      { slot: 'toolbar', component: 'FontSelector', order: 10 },
    ],
    settings: [
      { id: 'defaultFont', type: 'string', default: 'system-ui' },
      { id: 'defaultSize', type: 'number', default: 16 },
    ],
  },
};

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
