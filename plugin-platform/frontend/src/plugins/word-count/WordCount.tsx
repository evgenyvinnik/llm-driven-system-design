import React, { useState, useEffect } from 'react';
import type { PluginProps } from '../../core/types';
import { STATE_KEYS } from '../../core/types';

/**
 * Status bar component showing word and character counts.
 */
export function WordCount({ context }: PluginProps): React.ReactElement {
  const [stats, setStats] = useState({ words: 0, chars: 0, lines: 1 });

  useEffect(() => {
    // Calculate stats whenever content changes
    const unsubscribe = context.state.subscribe(STATE_KEYS.CONTENT, (content) => {
      const text = (content as string) || '';
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const chars = text.length;
      const lines = text.split('\n').length;
      setStats({ words, chars, lines });
    });

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
