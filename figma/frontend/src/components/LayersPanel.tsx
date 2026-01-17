import React from 'react';
import { useEditorStore } from '../stores/editorStore';

export function LayersPanel() {
  const {
    canvasData,
    selectedIds,
    setSelectedIds,
    updateObject,
    deleteObject,
    moveObjectInLayer,
  } = useEditorStore();

  const handleSelect = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey) {
      if (selectedIds.includes(id)) {
        setSelectedIds(selectedIds.filter(sid => sid !== id));
      } else {
        setSelectedIds([...selectedIds, id]);
      }
    } else {
      setSelectedIds([id]);
    }
  };

  const toggleVisibility = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const obj = canvasData.objects.find(o => o.id === id);
    if (obj) {
      updateObject(id, { visible: !obj.visible });
    }
  };

  const toggleLock = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const obj = canvasData.objects.find(o => o.id === id);
    if (obj) {
      updateObject(id, { locked: !obj.locked });
    }
  };

  const getObjectIcon = (type: string) => {
    switch (type) {
      case 'rectangle':
      case 'frame':
        return (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="2" />
          </svg>
        );
      case 'ellipse':
        return (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <ellipse cx="12" cy="12" rx="9" ry="9" strokeWidth="2" />
          </svg>
        );
      case 'text':
        return (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 7V4h16v3M9 20h6M12 4v16" strokeWidth="2" strokeLinecap="round" />
          </svg>
        );
      default:
        return (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="2" />
          </svg>
        );
    }
  };

  return (
    <div className="w-60 bg-figma-panel border-r border-figma-border flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-figma-border flex items-center justify-between">
        <span className="text-figma-text font-medium text-sm">Layers</span>
        <span className="text-figma-text-secondary text-xs">
          {canvasData.objects.length} objects
        </span>
      </div>

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto">
        {/* Render in reverse order (top-most first in list) */}
        {[...canvasData.objects].reverse().map((obj) => (
          <div
            key={obj.id}
            onClick={(e) => handleSelect(obj.id, e)}
            className={`flex items-center gap-2 px-3 py-2 cursor-pointer border-l-2 transition-colors ${
              selectedIds.includes(obj.id)
                ? 'bg-figma-accent/20 border-figma-accent'
                : 'border-transparent hover:bg-figma-hover'
            }`}
          >
            {/* Type icon */}
            <span className={`text-figma-text-secondary ${!obj.visible ? 'opacity-40' : ''}`}>
              {getObjectIcon(obj.type)}
            </span>

            {/* Name */}
            <span
              className={`flex-1 text-sm truncate ${
                !obj.visible ? 'text-figma-text-secondary opacity-40' : 'text-figma-text'
              }`}
            >
              {obj.name}
            </span>

            {/* Visibility toggle */}
            <button
              onClick={(e) => toggleVisibility(obj.id, e)}
              className="p-1 text-figma-text-secondary hover:text-figma-text"
              title={obj.visible ? 'Hide' : 'Show'}
            >
              {obj.visible ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeWidth="2" />
                  <circle cx="12" cy="12" r="3" strokeWidth="2" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" strokeWidth="2" />
                  <line x1="1" y1="1" x2="23" y2="23" strokeWidth="2" />
                </svg>
              )}
            </button>

            {/* Lock toggle */}
            <button
              onClick={(e) => toggleLock(obj.id, e)}
              className="p-1 text-figma-text-secondary hover:text-figma-text"
              title={obj.locked ? 'Unlock' : 'Lock'}
            >
              {obj.locked ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" strokeWidth="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" strokeWidth="2" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" strokeWidth="2" />
                  <path d="M7 11V7a5 5 0 019.9-1" strokeWidth="2" />
                </svg>
              )}
            </button>
          </div>
        ))}

        {canvasData.objects.length === 0 && (
          <div className="p-4 text-center text-figma-text-secondary text-sm">
            No objects yet. Use the tools above to create shapes.
          </div>
        )}
      </div>

      {/* Selected object actions */}
      {selectedIds.length > 0 && (
        <div className="border-t border-figma-border p-2 flex gap-1">
          <button
            onClick={() => selectedIds.forEach(id => moveObjectInLayer(id, 'up'))}
            className="flex-1 p-2 text-figma-text-secondary hover:bg-figma-hover rounded text-xs"
            title="Move Up"
          >
            Up
          </button>
          <button
            onClick={() => selectedIds.forEach(id => moveObjectInLayer(id, 'down'))}
            className="flex-1 p-2 text-figma-text-secondary hover:bg-figma-hover rounded text-xs"
            title="Move Down"
          >
            Down
          </button>
          <button
            onClick={() => selectedIds.forEach(id => deleteObject(id))}
            className="flex-1 p-2 text-red-400 hover:bg-red-500/20 rounded text-xs"
            title="Delete"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
