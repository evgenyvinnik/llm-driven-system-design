import React, { useState, useEffect } from 'react';
import { PluginHostProvider, usePluginHost } from './core/PluginHost';
import { Slot } from './core/SlotRenderer';
import type { PluginManifest, PluginModule } from './core/types';
import { MarketplaceModal } from './components/MarketplaceModal';
import { AuthModal } from './components/AuthModal';
import { useAuthStore } from './stores/auth';

// Import all plugins
import * as paperBackground from './plugins/paper-background';
import * as fontSelector from './plugins/font-selector';
import * as textEditor from './plugins/text-editor';
import * as wordCount from './plugins/word-count';
import * as theme from './plugins/theme';

// Configure which plugins to load
const PLUGINS: Array<{ manifest: PluginManifest; module: PluginModule }> = [
  { manifest: paperBackground.manifest, module: paperBackground },
  { manifest: fontSelector.manifest, module: fontSelector },
  { manifest: textEditor.manifest, module: textEditor },
  { manifest: wordCount.manifest, module: wordCount },
  { manifest: theme.manifest, module: theme },
];

function EditorLayout(): React.ReactElement {
  const { isLoading: pluginsLoading } = usePluginHost();
  const { user, isAuthenticated, isLoading: authLoading, checkAuth, logout } = useAuthStore();
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [showAuth, setShowAuth] = useState(false);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (pluginsLoading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-100 dark:bg-gray-900 transition-colors">
      {/* Header with toolbar */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold text-gray-800 dark:text-white">
              Pluggable Editor
            </h1>
            <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
            <Slot id="toolbar" />
          </div>
          <div className="flex items-center gap-3">
            {/* Marketplace button */}
            <button
              onClick={() => setShowMarketplace(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
            >
              <PluginIcon />
              <span>Plugins</span>
            </button>

            {/* Auth */}
            {isAuthenticated && user ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 dark:text-gray-400">{user.username}</span>
                <button
                  onClick={logout}
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAuth(true)}
                className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main content area with canvas */}
      <main className="flex-1 flex overflow-hidden">
        {/* Editor canvas */}
        <div className="flex-1 relative m-4 rounded-lg shadow-lg overflow-hidden border border-gray-200 dark:border-gray-700">
          <Slot id="canvas" />
        </div>

        {/* Sidebar (if any plugins contribute to it) */}
        <aside className="hidden lg:block w-64 p-4">
          <Slot id="sidebar" />
        </aside>
      </main>

      {/* Status bar */}
      <footer className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-4 py-2">
        <Slot id="statusbar" />
      </footer>

      {/* Modal slot for dialogs */}
      <Slot id="modal" />

      {/* Marketplace modal */}
      <MarketplaceModal isOpen={showMarketplace} onClose={() => setShowMarketplace(false)} />

      {/* Auth modal */}
      <AuthModal isOpen={showAuth} onClose={() => setShowAuth(false)} />
    </div>
  );
}

function PluginIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"
      />
    </svg>
  );
}

export default function App(): React.ReactElement {
  return (
    <PluginHostProvider plugins={PLUGINS}>
      <EditorLayout />
    </PluginHostProvider>
  );
}
