import React from 'react';
import { useStateValue } from '../../core/PluginHost';
import type { PluginProps } from '../../core/types';
import { STATE_KEYS } from '../../core/types';
import { PAPERS } from './manifest';

/**
 * Paper background layer that sits behind the text editor.
 * Listens to state changes and updates the background pattern.
 */
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
