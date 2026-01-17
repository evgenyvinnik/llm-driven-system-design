import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { DesignFile } from '../types';

interface FileBrowserProps {
  onSelectFile: (fileId: string) => void;
}

export function FileBrowser({ onSelectFile }: FileBrowserProps) {
  const [files, setFiles] = useState<DesignFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      setLoading(true);
      const data = await api.getFiles();
      setFiles(data);
    } catch (error) {
      console.error('Failed to load files:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;

    try {
      setCreating(true);
      const file = await api.createFile(newFileName);
      setNewFileName('');
      setFiles([file, ...files]);
    } catch (error) {
      console.error('Failed to create file:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteFile = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this file?')) return;

    try {
      await api.deleteFile(id);
      setFiles(files.filter(f => f.id !== id));
    } catch (error) {
      console.error('Failed to delete file:', error);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString();
  };

  return (
    <div className="min-h-screen bg-figma-bg">
      {/* Header */}
      <header className="bg-figma-panel border-b border-figma-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 38 57" className="w-6 h-9">
              <path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"/>
              <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"/>
              <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"/>
              <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"/>
              <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"/>
            </svg>
            <h1 className="text-figma-text text-xl font-semibold">Figma Clone</h1>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Create new file */}
        <div className="mb-8">
          <h2 className="text-figma-text text-lg font-medium mb-4">Create New Design</h2>
          <div className="flex gap-3">
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
              placeholder="Enter file name..."
              className="flex-1 max-w-md bg-figma-panel border border-figma-border rounded-lg px-4 py-3 text-figma-text focus:border-figma-accent outline-none"
            />
            <button
              onClick={handleCreateFile}
              disabled={creating || !newFileName.trim()}
              className="px-6 py-3 bg-figma-accent text-white rounded-lg font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>

        {/* Recent files */}
        <div>
          <h2 className="text-figma-text text-lg font-medium mb-4">Recent Files</h2>

          {loading ? (
            <div className="text-figma-text-secondary">Loading files...</div>
          ) : files.length === 0 ? (
            <div className="text-figma-text-secondary">
              No files yet. Create your first design above.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {files.map((file) => (
                <div
                  key={file.id}
                  onClick={() => onSelectFile(file.id)}
                  className="bg-figma-panel rounded-lg overflow-hidden border border-figma-border hover:border-figma-accent cursor-pointer transition-colors group"
                >
                  {/* Thumbnail */}
                  <div className="aspect-[4/3] bg-figma-bg flex items-center justify-center relative">
                    {file.thumbnail_url ? (
                      <img
                        src={file.thumbnail_url}
                        alt={file.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <svg className="w-12 h-12 text-figma-border" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M3 3h18v18H3V3zm2 2v14h14V5H5z" />
                      </svg>
                    )}

                    {/* Active users indicator */}
                    {file.activeUsers && file.activeUsers > 0 && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-green-500 text-white text-xs rounded-full">
                        {file.activeUsers} editing
                      </div>
                    )}

                    {/* Delete button */}
                    <button
                      onClick={(e) => handleDeleteFile(file.id, e)}
                      className="absolute top-2 left-2 p-1.5 bg-figma-panel rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
                    >
                      <svg className="w-4 h-4 text-figma-text" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>

                  {/* File info */}
                  <div className="p-3">
                    <div className="text-figma-text font-medium truncate">
                      {file.name}
                    </div>
                    <div className="text-figma-text-secondary text-sm">
                      Edited {formatDate(file.updated_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
