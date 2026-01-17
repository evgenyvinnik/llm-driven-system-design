import React, { useState, useEffect } from 'react';
import { useEditorStore } from '../stores/editorStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../services/api';
import { Toolbar } from './Toolbar';
import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { Canvas } from './Canvas';
import { VersionHistory } from './VersionHistory';

interface EditorProps {
  fileId: string;
  onBack: () => void;
}

export function Editor({ fileId, onBack }: EditorProps) {
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const { setFileId, setFileName, setCanvasData } = useEditorStore();
  const { sendPresence } = useWebSocket(fileId);

  useEffect(() => {
    loadFile();
    setFileId(fileId);

    return () => {
      setFileId(null);
    };
  }, [fileId]);

  const loadFile = async () => {
    try {
      setLoading(true);
      const file = await api.getFile(fileId);
      setFileName(file.name);
      setCanvasData(file.canvas_data);
    } catch (error) {
      console.error('Failed to load file:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen bg-figma-bg flex items-center justify-center">
        <div className="text-figma-text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-figma-bg flex flex-col overflow-hidden">
      {/* Toolbar with back button */}
      <div className="relative">
        <button
          onClick={onBack}
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 flex items-center gap-2 text-figma-text-secondary hover:text-figma-text"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Files
        </button>

        {/* Version history button */}
        <button
          onClick={() => setShowVersionHistory(true)}
          className="absolute right-32 top-1/2 -translate-y-1/2 z-10 flex items-center gap-1 px-3 py-1.5 text-figma-text-secondary hover:text-figma-text hover:bg-figma-hover rounded"
          title="Version History"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10" strokeWidth="2" />
            <polyline points="12,6 12,12 16,14" strokeWidth="2" strokeLinecap="round" />
          </svg>
          History
        </button>

        <Toolbar />
      </div>

      {/* Main editor area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Layers panel */}
        <LayersPanel />

        {/* Canvas */}
        <Canvas sendPresence={sendPresence} />

        {/* Properties panel */}
        <PropertiesPanel />
      </div>

      {/* Version history modal */}
      {showVersionHistory && (
        <VersionHistory
          fileId={fileId}
          onClose={() => setShowVersionHistory(false)}
        />
      )}
    </div>
  );
}
