import type { PluginManifest } from '../../core/types';

export const manifest: PluginManifest = {
  id: 'paper-background',
  name: 'Paper Background',
  version: '1.0.0',
  description: 'Choose different paper styles for your editor background',
  contributes: {
    slots: [
      { slot: 'canvas', component: 'PaperBackground', order: 0 },
      { slot: 'toolbar', component: 'PaperSelector', order: 100 },
    ],
    settings: [
      { id: 'defaultPaper', type: 'select', default: 'plain' },
    ],
  },
};

export interface Paper {
  id: string;
  name: string;
  background: string;
  pattern: string;
  patternSize?: string;
}

export const PAPERS: Paper[] = [
  {
    id: 'plain',
    name: 'Plain',
    background: '#ffffff',
    pattern: 'none',
  },
  {
    id: 'ruled',
    name: 'Ruled',
    background: '#fffef8',
    pattern: 'repeating-linear-gradient(transparent, transparent 27px, #d4e4f7 28px)',
  },
  {
    id: 'checkered',
    name: 'Checkered',
    background: '#ffffff',
    pattern: 'linear-gradient(90deg, #e8e8e8 1px, transparent 1px), linear-gradient(#e8e8e8 1px, transparent 1px)',
    patternSize: '20px 20px',
  },
  {
    id: 'dotted',
    name: 'Dotted',
    background: '#ffffff',
    pattern: 'radial-gradient(circle, #ccc 1px, transparent 1px)',
    patternSize: '20px 20px',
  },
  {
    id: 'graph',
    name: 'Graph',
    background: '#f8fff8',
    pattern: 'linear-gradient(90deg, #c8e6c9 1px, transparent 1px), linear-gradient(#c8e6c9 1px, transparent 1px)',
    patternSize: '10px 10px',
  },
  {
    id: 'legal',
    name: 'Legal Pad',
    background: '#fffde7',
    pattern: 'repeating-linear-gradient(transparent, transparent 27px, #ffcc80 28px)',
  },
];
