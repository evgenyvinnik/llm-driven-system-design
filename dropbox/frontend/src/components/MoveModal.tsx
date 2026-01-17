import { useState, useEffect } from 'react';
import { X, Folder, ChevronRight } from 'lucide-react';
import { FileItem, FolderContents } from '../types';
import { filesApi } from '../services/api';

interface MoveModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: FileItem | null;
  onMove: (parentId: string | null) => Promise<void>;
}

export function MoveModal({ isOpen, onClose, item, onMove }: MoveModalProps) {
  const [currentFolder, setCurrentFolder] = useState<FolderContents | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadFolder(null);
    }
  }, [isOpen]);

  const loadFolder = async (folderId: string | null) => {
    setIsLoading(true);
    setError('');

    try {
      const contents = await filesApi.getFolder(folderId || undefined);
      setCurrentFolder(contents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMove = async () => {
    if (!item) return;

    setIsMoving(true);
    setError('');

    try {
      await onMove(currentFolder?.folder?.id || null);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsMoving(false);
    }
  };

  const folders = currentFolder?.items.filter(
    (i) => i.isFolder && i.id !== item?.id
  ) || [];

  if (!isOpen || !item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Move "{item.name}"</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-100 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="px-6 py-2 border-b border-gray-100 flex items-center gap-1 text-sm">
          <button
            onClick={() => loadFolder(null)}
            className="text-dropbox-blue hover:underline"
          >
            My files
          </button>
          {currentFolder?.breadcrumbs.map((crumb) => (
            <div key={crumb.id} className="flex items-center">
              <ChevronRight size={14} className="text-gray-400 mx-1" />
              <button
                onClick={() => loadFolder(crumb.id)}
                className="text-dropbox-blue hover:underline"
              >
                {crumb.name}
              </button>
            </div>
          ))}
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-6 text-center text-gray-500">Loading...</div>
          ) : error ? (
            <div className="p-6 text-center text-red-500">{error}</div>
          ) : folders.length === 0 ? (
            <div className="p-6 text-center text-gray-500">No folders here</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  onClick={() => loadFolder(folder.id)}
                  className="w-full flex items-center px-6 py-3 hover:bg-gray-50 transition-colors"
                >
                  <Folder size={20} className="text-dropbox-blue mr-3" />
                  <span className="flex-1 text-left">{folder.name}</span>
                  <ChevronRight size={16} className="text-gray-400" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between items-center">
          <span className="text-sm text-gray-600">
            Move to: {currentFolder?.folder?.name || 'My files'}
          </span>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleMove}
              disabled={isMoving}
              className="px-4 py-2 bg-dropbox-blue text-white rounded-lg hover:bg-dropbox-blue-dark transition-colors disabled:opacity-50"
            >
              {isMoving ? 'Moving...' : 'Move here'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
