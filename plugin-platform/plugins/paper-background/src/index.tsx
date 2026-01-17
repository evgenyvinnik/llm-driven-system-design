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
  id: 'paper-background',
  name: 'Paper Background',
  version: '1.0.0',
  description: 'Choose different paper styles for your editor background',
  category: 'appearance',
  contributes: {
    slots: [
      { slot: 'canvas', component: 'PaperBackground', order: 0 },
      { slot: 'toolbar', component: 'PaperSelector', order: 100 },
    ],
    settings: [
      { id: 'defaultPaper', type: 'select', default: 'plain', label: 'Default Paper Style' },
    ],
  },
};

// ============================================================================
// Paper Definitions
// ============================================================================

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

// ============================================================================
// Components
// ============================================================================

export function PaperBackground({ context }: PluginProps): React.ReactElement {
  const paperId = useStateValue<string>(context, STATE_KEYS.PAPER) || 'plain';
  const themeMode = useStateValue<string>(context, STATE_KEYS.THEME_MODE) || 'light';

  const paper = PAPERS.find((p) => p.id === paperId) || PAPERS[0];

  // Adjust colors for dark mode
  const isDark = themeMode === 'dark';
  const background = isDark ? '#1a1a2e' : paper.background;
  const pattern = isDark ? paper.pattern.replace(/#[a-fA-F0-9]{6}/g, '#333') : paper.pattern;

  return (
    <div
      className="absolute inset-0 pointer-events-none transition-all duration-300"
      style={{
        backgroundColor: background,
        backgroundImage: pattern,
        backgroundSize: paper.patternSize || 'auto',
      }}
    />
  );
}

export function PaperSelector({ context }: PluginProps): React.ReactElement {
  const currentPaper = useStateValue<string>(context, STATE_KEYS.PAPER) || 'plain';

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    context.state.set(STATE_KEYS.PAPER, e.target.value);
    context.events.emit('theme:paper-changed', { paperId: e.target.value });
  };

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="paper-select" className="text-sm font-medium text-gray-700 dark:text-gray-300">
        Paper:
      </label>
      <select
        id="paper-select"
        value={currentPaper}
        onChange={handleChange}
        className="px-2 py-1 text-sm border border-gray-300 rounded-md bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {PAPERS.map((paper) => (
          <option key={paper.id} value={paper.id}>
            {paper.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ============================================================================
// Plugin Lifecycle
// ============================================================================

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

// ============================================================================
// Export Plugin Module
// ============================================================================

export default definePlugin({
  manifest,
  activate,
  PaperBackground,
  PaperSelector,
});
