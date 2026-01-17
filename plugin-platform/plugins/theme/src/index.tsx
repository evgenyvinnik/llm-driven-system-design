import React from 'react';
import {
  definePlugin,
  useStateValue,
  STATE_KEYS,
  EVENTS,
  type PluginProps,
  type PluginManifest,
  type PluginContext,
} from '@plugin-platform/sdk';

// ============================================================================
// Manifest
// ============================================================================

export const manifest: PluginManifest = {
  id: 'theme',
  name: 'Theme Toggle',
  version: '1.0.0',
  description: 'Light and dark theme toggle with system preference detection',
  category: 'appearance',
  contributes: {
    slots: [
      { slot: 'toolbar', component: 'ThemeToggle', order: 100 },
    ],
    settings: [
      { id: 'useSystemTheme', type: 'boolean', default: true, label: 'Use system theme preference' },
    ],
  },
};

// ============================================================================
// Icons
// ============================================================================

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

// ============================================================================
// Component
// ============================================================================

export function ThemeToggle({ context }: PluginProps): React.ReactElement {
  const themeMode = useStateValue<string>(context, STATE_KEYS.THEME_MODE) || 'light';
  const isDark = themeMode === 'dark';

  const handleToggle = () => {
    const newMode = isDark ? 'light' : 'dark';
    context.state.set(STATE_KEYS.THEME_MODE, newMode);
    context.storage.set('themeMode', newMode);
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

// ============================================================================
// Plugin Lifecycle
// ============================================================================

export function activate(context: PluginContext): void {
  // Check for saved preference
  const savedTheme = context.storage.get<string>('themeMode');

  if (savedTheme) {
    context.state.set(STATE_KEYS.THEME_MODE, savedTheme);
  } else {
    // Detect system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    context.state.set(STATE_KEYS.THEME_MODE, prefersDark ? 'dark' : 'light');
  }

  // Listen for system theme changes
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemChange = (e: MediaQueryListEvent) => {
    // Only update if user hasn't set a preference
    if (!context.storage.get<string>('themeMode')) {
      const newMode = e.matches ? 'dark' : 'light';
      context.state.set(STATE_KEYS.THEME_MODE, newMode);
      context.events.emit(EVENTS.THEME_CHANGED, { mode: newMode });
    }
  };

  mediaQuery.addEventListener('change', handleSystemChange);

  console.log('[theme] Plugin activated');
}

// ============================================================================
// Export Plugin Module
// ============================================================================

export default definePlugin({
  manifest,
  activate,
  ThemeToggle,
});
