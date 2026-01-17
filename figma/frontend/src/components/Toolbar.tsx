/**
 * Toolbar component for the design editor.
 * Displays the application logo, file name, tool selection buttons,
 * undo/redo controls, and collaborator avatars.
 */
import React from 'react';
import { useEditorStore } from '../stores/editorStore';
import type { Tool } from '../types';

/**
 * Available tools with their keyboard shortcuts and icons.
 */
const tools: { id: Tool; label: string; icon: string }[] = [
  { id: 'select', label: 'Select (V)', icon: 'V' },
  { id: 'rectangle', label: 'Rectangle (R)', icon: 'R' },
  { id: 'ellipse', label: 'Ellipse (O)', icon: 'O' },
  { id: 'text', label: 'Text (T)', icon: 'T' },
  { id: 'hand', label: 'Hand (H)', icon: 'H' },
];

/**
 * Toolbar component providing access to design tools and actions.
 * Includes keyboard shortcuts for tool switching (V, R, O, T, H).
 * @returns The rendered toolbar element
 */
export function Toolbar() {
  const { activeTool, setActiveTool, fileName, collaborators, undo, redo } = useEditorStore();

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'v':
          setActiveTool('select');
          break;
        case 'r':
          setActiveTool('rectangle');
          break;
        case 'o':
          setActiveTool('ellipse');
          break;
        case 't':
          setActiveTool('text');
          break;
        case 'h':
          setActiveTool('hand');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTool]);

  return (
    <div className="h-12 bg-figma-panel border-b border-figma-border flex items-center justify-between px-4">
      {/* Left: Logo and file name */}
      <div className="flex items-center gap-4">
        <div className="w-8 h-8 flex items-center justify-center">
          <svg viewBox="0 0 38 57" className="w-5 h-7">
            <path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"/>
            <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"/>
            <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"/>
            <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"/>
            <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"/>
          </svg>
        </div>
        <span className="text-figma-text font-medium">{fileName}</span>
      </div>

      {/* Center: Tools */}
      <div className="flex items-center gap-1 bg-figma-bg rounded-lg p-1">
        {tools.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`w-8 h-8 flex items-center justify-center rounded text-sm font-medium transition-colors ${
              activeTool === tool.id
                ? 'bg-figma-accent text-white'
                : 'text-figma-text-secondary hover:bg-figma-hover hover:text-figma-text'
            }`}
            title={tool.label}
          >
            {tool.icon}
          </button>
        ))}

        <div className="w-px h-6 bg-figma-border mx-2" />

        {/* Undo/Redo */}
        <button
          onClick={undo}
          className="w-8 h-8 flex items-center justify-center rounded text-figma-text-secondary hover:bg-figma-hover hover:text-figma-text"
          title="Undo (Ctrl+Z)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
        </button>
        <button
          onClick={redo}
          className="w-8 h-8 flex items-center justify-center rounded text-figma-text-secondary hover:bg-figma-hover hover:text-figma-text"
          title="Redo (Ctrl+Shift+Z)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
          </svg>
        </button>
      </div>

      {/* Right: Collaborators */}
      <div className="flex items-center gap-2">
        {collaborators.map((collab) => (
          <div
            key={collab.userId}
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-medium"
            style={{ backgroundColor: collab.userColor }}
            title={collab.userName}
          >
            {collab.userName.charAt(0).toUpperCase()}
          </div>
        ))}

        <button className="px-4 py-1.5 bg-figma-accent text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors">
          Share
        </button>
      </div>
    </div>
  );
}
