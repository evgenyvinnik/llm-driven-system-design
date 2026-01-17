import React from 'react';
import { PluginHostProvider, usePluginHost } from './core/PluginHost';
import { Slot } from './core/SlotRenderer';
import type { PluginManifest, PluginModule } from './core/types';

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
  const { isLoading } = usePluginHost();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">Loading plugins...</div>
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
    </div>
  );
}

export default function App(): React.ReactElement {
  return (
    <PluginHostProvider plugins={PLUGINS}>
      <EditorLayout />
    </PluginHostProvider>
  );
}
