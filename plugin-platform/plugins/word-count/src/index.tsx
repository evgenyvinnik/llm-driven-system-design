import React, { useState, useEffect } from 'react';
import {
  definePlugin,
  STATE_KEYS,
  type PluginProps,
  type PluginManifest,
  type PluginContext,
} from '@plugin-platform/sdk';

// ============================================================================
// Manifest
// ============================================================================

export const manifest: PluginManifest = {
  id: 'word-count',
  name: 'Word Count',
  version: '1.0.0',
  description: 'Displays word, character, and line counts in the status bar',
  category: 'utilities',
  contributes: {
    slots: [
      { slot: 'statusbar', component: 'WordCount', order: 0 },
    ],
    settings: [
      { id: 'showWords', type: 'boolean', default: true, label: 'Show word count' },
      { id: 'showChars', type: 'boolean', default: true, label: 'Show character count' },
      { id: 'showLines', type: 'boolean', default: true, label: 'Show line count' },
    ],
  },
  requires: {
    state: ['editor.content'],
  },
};

// ============================================================================
// Types
// ============================================================================

interface ContentStats {
  words: number;
  chars: number;
  lines: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

function calculateStats(text: string): ContentStats {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const lines = text.split('\n').length;
  return { words, chars, lines };
}

// ============================================================================
// Component
// ============================================================================

export function WordCount({ context }: PluginProps): React.ReactElement {
  const [stats, setStats] = useState<ContentStats>({ words: 0, chars: 0, lines: 1 });

  useEffect(() => {
    // Calculate stats whenever content changes
    const unsubscribe = context.state.subscribe(STATE_KEYS.CONTENT, (content) => {
      const text = (content as string) || '';
      setStats(calculateStats(text));
    });

    // Initial calculation
    const currentContent = context.state.get<string>(STATE_KEYS.CONTENT) || '';
    setStats(calculateStats(currentContent));

    return unsubscribe;
  }, [context]);

  return (
    <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
      <span className="flex items-center gap-1">
        <span className="font-medium">{stats.words}</span>
        <span>words</span>
      </span>
      <span className="text-gray-300 dark:text-gray-600">|</span>
      <span className="flex items-center gap-1">
        <span className="font-medium">{stats.chars}</span>
        <span>characters</span>
      </span>
      <span className="text-gray-300 dark:text-gray-600">|</span>
      <span className="flex items-center gap-1">
        <span className="font-medium">{stats.lines}</span>
        <span>lines</span>
      </span>
    </div>
  );
}

// ============================================================================
// Plugin Lifecycle
// ============================================================================

export function activate(context: PluginContext): void {
  console.log('[word-count] Plugin activated');
}

// ============================================================================
// Export Plugin Module
// ============================================================================

export default definePlugin({
  manifest,
  activate,
  WordCount,
});
