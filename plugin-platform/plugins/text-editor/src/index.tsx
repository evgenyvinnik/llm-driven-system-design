import React, { useState, useRef, useEffect } from 'react';
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
  id: 'text-editor',
  name: 'Text Editor',
  version: '1.0.0',
  description: 'The core text editing component for the pluggable text editor',
  category: 'core',
  contributes: {
    slots: [
      { slot: 'canvas', component: 'TextEditor', order: 10 },
    ],
    settings: [
      { id: 'autoSave', type: 'boolean', default: true, label: 'Auto-save content' },
      { id: 'spellCheck', type: 'boolean', default: true, label: 'Enable spell check' },
    ],
  },
  requires: {
    state: ['format.fontFamily', 'format.fontSize', 'theme.mode'],
  },
};

// ============================================================================
// Component
// ============================================================================

export function TextEditor({ context }: PluginProps): React.ReactElement {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to formatting state
  const fontFamily = useStateValue<string>(context, STATE_KEYS.FONT_FAMILY) || 'system-ui, sans-serif';
  const fontSize = useStateValue<number>(context, STATE_KEYS.FONT_SIZE) || 16;
  const themeMode = useStateValue<string>(context, STATE_KEYS.THEME_MODE) || 'light';

  // Load saved content on mount
  useEffect(() => {
    const savedContent = context.storage.get<string>('content');
    if (savedContent) {
      setContent(savedContent);
      context.state.set(STATE_KEYS.CONTENT, savedContent);
    }
  }, [context]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);
    context.state.set(STATE_KEYS.CONTENT, newContent);
    context.events.emit(EVENTS.CONTENT_CHANGED, { content: newContent });

    // Auto-save to storage
    context.storage.set('content', newContent);
  };

  const handleSelect = () => {
    if (textareaRef.current) {
      const { selectionStart, selectionEnd } = textareaRef.current;
      context.state.set(STATE_KEYS.SELECTION, { start: selectionStart, end: selectionEnd });
      context.events.emit(EVENTS.SELECTION_CHANGED, { start: selectionStart, end: selectionEnd });
    }
  };

  const isDark = themeMode === 'dark';

  return (
    <textarea
      ref={textareaRef}
      className="absolute inset-0 w-full h-full resize-none outline-none p-8 leading-relaxed transition-all duration-200"
      style={{
        fontFamily,
        fontSize: `${fontSize}px`,
        lineHeight: '1.75',
        backgroundColor: 'transparent',
        color: isDark ? '#e0e0e0' : '#1a1a1a',
        caretColor: isDark ? '#60a5fa' : '#2563eb',
      }}
      value={content}
      onChange={handleChange}
      onSelect={handleSelect}
      placeholder="Start typing your masterpiece..."
      spellCheck
    />
  );
}

// ============================================================================
// Plugin Lifecycle
// ============================================================================

export function activate(context: PluginContext): void {
  // Initialize content state
  const savedContent = context.storage.get<string>('content') || '';
  context.state.set(STATE_KEYS.CONTENT, savedContent);

  // Register clear command
  context.commands.register('editor.clear', () => {
    context.state.set(STATE_KEYS.CONTENT, '');
    context.storage.set('content', '');
    context.events.emit(EVENTS.CONTENT_CHANGED, { content: '' });
  });

  console.log('[text-editor] Plugin activated');
}

// ============================================================================
// Export Plugin Module
// ============================================================================

export default definePlugin({
  manifest,
  activate,
  TextEditor,
});
