import React from 'react';
import { useStateValue } from '../../core/PluginHost';
import type { PluginProps } from '../../core/types';
import { STATE_KEYS } from '../../core/types';
import { PAPERS } from './manifest';

/**
 * Toolbar component for selecting paper style.
 */
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
