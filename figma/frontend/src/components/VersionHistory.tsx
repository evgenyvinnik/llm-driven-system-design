/**
 * Version history modal component for managing file versions.
 * Allows viewing, creating, and restoring version snapshots.
 */
import { useState, useEffect } from 'react';
import { useEditorStore } from '../stores/editorStore';
import { api } from '../services/api';
import type { FileVersion } from '../types';

/**
 * Props for the VersionHistory component.
 */
interface VersionHistoryProps {
  /** The file ID to show versions for */
  fileId: string;
  /** Callback when the modal should be closed */
  onClose: () => void;
}

/**
 * VersionHistory component displaying a modal with version management.
 * Shows a list of saved versions with timestamps and allows restore.
 * Supports creating new named versions.
 * @param props - Component props
 * @returns The rendered version history modal
 */
export function VersionHistory({ fileId, onClose }: VersionHistoryProps) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newVersionName, setNewVersionName] = useState('');
  const { setCanvasData } = useEditorStore();

  useEffect(() => {
    loadVersions();
  }, [fileId]);

  const loadVersions = async () => {
    try {
      setLoading(true);
      const data = await api.getVersions(fileId);
      setVersions(data);
    } catch (error) {
      console.error('Failed to load versions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateVersion = async () => {
    try {
      setCreating(true);
      await api.createVersion(fileId, newVersionName || undefined);
      setNewVersionName('');
      await loadVersions();
    } catch (error) {
      console.error('Failed to create version:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!confirm('Are you sure you want to restore this version? This will replace the current design.')) {
      return;
    }

    try {
      const file = await api.restoreVersion(fileId, versionId);
      setCanvasData(file.canvas_data);
      onClose();
    } catch (error) {
      console.error('Failed to restore version:', error);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-figma-panel rounded-lg w-[500px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-figma-border">
          <h2 className="text-figma-text font-medium">Version History</h2>
          <button
            onClick={onClose}
            className="text-figma-text-secondary hover:text-figma-text"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Create new version */}
        <div className="px-4 py-3 border-b border-figma-border">
          <div className="flex gap-2">
            <input
              type="text"
              value={newVersionName}
              onChange={(e) => setNewVersionName(e.target.value)}
              placeholder="Version name (optional)"
              className="flex-1 bg-figma-bg border border-figma-border rounded px-3 py-2 text-figma-text text-sm focus:border-figma-accent outline-none"
            />
            <button
              onClick={handleCreateVersion}
              disabled={creating}
              className="px-4 py-2 bg-figma-accent text-white rounded text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating...' : 'Save Version'}
            </button>
          </div>
        </div>

        {/* Version list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-figma-text-secondary">
              Loading versions...
            </div>
          ) : versions.length === 0 ? (
            <div className="p-4 text-center text-figma-text-secondary">
              No versions saved yet. Click "Save Version" to create one.
            </div>
          ) : (
            <div className="divide-y divide-figma-border">
              {versions.map((version) => (
                <div
                  key={version.id}
                  className="px-4 py-3 hover:bg-figma-hover flex items-center justify-between"
                >
                  <div>
                    <div className="text-figma-text text-sm">
                      {version.name || `Version ${version.version_number}`}
                    </div>
                    <div className="text-figma-text-secondary text-xs">
                      {formatDate(version.created_at)}
                      {version.is_auto_save && (
                        <span className="ml-2 px-1.5 py-0.5 bg-figma-bg rounded text-xs">
                          Auto-save
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestoreVersion(version.id)}
                    className="px-3 py-1.5 text-figma-text-secondary hover:text-figma-text text-sm hover:bg-figma-bg rounded"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
