/**
 * Modal dialog for viewing and restoring file version history.
 * Lists all previous versions with size and date, allowing restore.
 * @module components/VersionHistoryModal
 */

import { useState, useEffect } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { FileItem, FileVersion } from '../types';
import { filesApi } from '../services/api';
import { formatBytes, formatDate } from '../utils/format';

/** Props for the VersionHistoryModal component */
interface VersionHistoryModalProps {
  /** Whether the modal is currently visible */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** The file to show version history for (null if none selected) */
  file: FileItem | null;
  /** Callback after a version is successfully restored */
  onRestore: () => void;
}

/**
 * Renders a modal showing all versions of a file.
 * Displays current version and allows restoring previous versions.
 */
export function VersionHistoryModal({ isOpen, onClose, file, onRestore }: VersionHistoryModalProps) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && file) {
      loadVersions();
    }
  }, [isOpen, file]);

  const loadVersions = async () => {
    if (!file) return;

    setIsLoading(true);
    setError('');

    try {
      const data = await filesApi.getVersions(file.id);
      setVersions(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestore = async (versionId: string) => {
    if (!file) return;

    setRestoringId(versionId);

    try {
      await filesApi.restoreVersion(file.id, versionId);
      onRestore();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestoringId(null);
    }
  };

  if (!isOpen || !file) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Version history - {file.name}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-100 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-6 text-center text-gray-500">Loading versions...</div>
          ) : error ? (
            <div className="p-6 text-center text-red-500">{error}</div>
          ) : versions.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              No previous versions available
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {/* Current version */}
              <div className="px-6 py-4 bg-blue-50">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">Version {file.version}</span>
                    <span className="ml-2 text-xs bg-dropbox-blue text-white px-2 py-0.5 rounded">
                      Current
                    </span>
                  </div>
                  <span className="text-sm text-gray-500">{formatBytes(file.size)}</span>
                </div>
                <p className="text-sm text-gray-500 mt-1">{formatDate(file.updatedAt)}</p>
              </div>

              {/* Previous versions */}
              {versions.map((version) => (
                <div key={version.id} className="px-6 py-4 hover:bg-gray-50">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">Version {version.version}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-500">{formatBytes(version.size)}</span>
                      <button
                        onClick={() => handleRestore(version.id)}
                        disabled={restoringId === version.id}
                        className="flex items-center gap-1 px-3 py-1 text-sm text-dropbox-blue hover:bg-blue-50 rounded transition-colors disabled:opacity-50"
                      >
                        <RotateCcw size={14} />
                        {restoringId === version.id ? 'Restoring...' : 'Restore'}
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{formatDate(version.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
