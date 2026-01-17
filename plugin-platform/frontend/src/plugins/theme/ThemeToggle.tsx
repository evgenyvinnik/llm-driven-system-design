import React from 'react';
import { useStateValue } from '../../core/PluginHost';
import type { PluginProps } from '../../core/types';
import { STATE_KEYS, EVENTS } from '../../core/types';

/**
 * Theme toggle button for switching between light and dark mode.
 */
export function ThemeToggle({ context }: PluginProps): React.ReactElement {
  const themeMode = useStateValue<string>(context, STATE_KEYS.THEME_MODE) || 'light';
  const isDark = themeMode === 'dark';

  const handleToggle = () => {
    const newMode = isDark ? 'light' : 'dark';
    context.state.set(STATE_KEYS.THEME_MODE, newMode);
    context.events.emit(EVENTS.THEME_CHANGED, { mode: newMode });
  };

  return (
    <button
      onClick={handleToggle}
      className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? (
        <>
          <SunIcon />
          <span>Light</span>
        </>
      ) : (
        <>
          <MoonIcon />
          <span>Dark</span>
        </>
      )}
    </button>
  );
}

function SunIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
      />
    </svg>
  );
}

function MoonIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
      />
    </svg>
  );
}
