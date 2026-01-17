import React, { useState, useRef, useEffect } from 'react';
import { useStateValue } from '../../core/PluginHost';
import type { PluginProps } from '../../core/types';
import { STATE_KEYS, EVENTS } from '../../core/types';

/**
 * The main text editor component.
 * This is the actual textarea where users type their content.
 */
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

    // Auto-save to storage (debounced would be better in production)
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
