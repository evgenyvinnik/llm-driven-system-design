import React, { useCallback, useState } from 'react';
import type { FileItem } from '../types';
import { FileIcon, SyncStatusIcon } from './Icons';
import { formatBytes, formatRelativeTime, getFileIcon } from '../utils/helpers';
import { useFileStore } from '../stores/fileStore';

interface FileItemComponentProps {
  file: FileItem;
  isSelected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}

export const FileItemComponent: React.FC<FileItemComponentProps> = ({
  file,
  isSelected,
  onSelect,
  onOpen,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const { deleteFile, downloadFile, renameFile } = useFileStore();
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(file.name);

  const handleDoubleClick = useCallback(() => {
    if (file.isFolder) {
      onOpen();
    } else {
      // Download file
      downloadFile(file.id, file.name);
    }
  }, [file, onOpen, downloadFile]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
  }, []);

  const handleDelete = async () => {
    if (confirm(`Delete "${file.name}"?`)) {
      await deleteFile(file.id);
    }
    setShowMenu(false);
  };

  const handleRename = async () => {
    if (newName && newName !== file.name) {
      await renameFile(file.id, newName);
    }
    setIsRenaming(false);
    setShowMenu(false);
  };

  const handleDownload = async () => {
    await downloadFile(file.id, file.name);
    setShowMenu(false);
  };

  const iconType = getFileIcon(file.mimeType, file.isFolder);

  return (
    <div
      className={`file-item ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <div className={`file-icon ${file.isFolder ? 'folder' : iconType === 'image' ? 'image' : 'file'}`}>
        <FileIcon type={iconType as 'folder' | 'file' | 'image'} />
      </div>

      <div className="flex-1 min-w-0">
        {isRenaming ? (
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setIsRenaming(false);
            }}
            className="w-full px-2 py-1 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
        ) : (
          <>
            <div className="font-medium truncate">{file.name}</div>
            <div className="text-sm text-gray-500">
              {file.isFolder ? 'Folder' : formatBytes(file.size)} - {formatRelativeTime(file.modifiedAt)}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {file.syncStatus && <SyncStatusIcon status={file.syncStatus} />}
      </div>

      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setShowMenu(false)}
          />
          <div className="dropdown-menu">
            {!file.isFolder && (
              <button className="dropdown-item w-full text-left" onClick={handleDownload}>
                Download
              </button>
            )}
            <button
              className="dropdown-item w-full text-left"
              onClick={() => {
                setIsRenaming(true);
                setShowMenu(false);
              }}
            >
              Rename
            </button>
            <button
              className="dropdown-item w-full text-left text-red-600"
              onClick={handleDelete}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
};

interface FileBrowserProps {
  onNavigate: (path: string) => void;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({ onNavigate }) => {
  const {
    files,
    currentPath,
    selectedFiles,
    isLoading,
    error,
    conflicts,
    uploadProgress,
    toggleSelection,
    clearSelection,
    uploadFiles,
    createFolder,
    clearError,
  } = useFileStore();

  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0) {
        uploadFiles(droppedFiles);
      }
    },
    [uploadFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files || []);
      if (selectedFiles.length > 0) {
        uploadFiles(selectedFiles);
      }
    },
    [uploadFiles]
  );

  const handleCreateFolder = async () => {
    if (newFolderName.trim()) {
      await createFolder(newFolderName.trim());
      setNewFolderName('');
      setShowNewFolderModal(false);
    }
  };

  const handleFileOpen = (file: FileItem) => {
    if (file.isFolder) {
      onNavigate(file.path);
    }
  };

  // Breadcrumb navigation
  const pathParts = currentPath.split('/').filter(Boolean);
  const breadcrumbs = [
    { name: 'iCloud Drive', path: '/' },
    ...pathParts.map((part, index) => ({
      name: part,
      path: '/' + pathParts.slice(0, index + 1).join('/'),
    })),
  ];

  return (
    <div
      className={`flex flex-col h-full ${isDragOver ? 'bg-blue-50' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between p-4 border-b">
        {/* Breadcrumb */}
        <nav className="breadcrumb">
          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={crumb.path}>
              {index > 0 && <span className="breadcrumb-separator">/</span>}
              <button
                className="breadcrumb-item hover:underline"
                onClick={() => onNavigate(crumb.path)}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-sm bg-gray-100 rounded hover:bg-gray-200"
            onClick={() => setShowNewFolderModal(true)}
          >
            New Folder
          </button>
          <label className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer">
            Upload
            <input
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
          </label>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-100 text-red-700 rounded flex justify-between items-center">
          <span>{error}</span>
          <button onClick={clearError} className="text-red-500 hover:text-red-700">
            Dismiss
          </button>
        </div>
      )}

      {/* Conflicts warning */}
      {conflicts.length > 0 && (
        <div className="mx-4 mt-4 p-3 bg-yellow-100 text-yellow-800 rounded">
          You have {conflicts.length} file conflict(s) that need resolution.
        </div>
      )}

      {/* Upload progress */}
      {uploadProgress.size > 0 && (
        <div className="mx-4 mt-4 space-y-2">
          {Array.from(uploadProgress.entries()).map(([name, progress]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="text-sm truncate flex-1">{name}</span>
              <div className="w-24 progress-bar">
                <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500">
            <p>This folder is empty</p>
            <p className="text-sm">Drag files here or click Upload</p>
          </div>
        ) : (
          <div className="space-y-1">
            {files.map((file) => (
              <FileItemComponent
                key={file.id}
                file={file}
                isSelected={selectedFiles.has(file.id)}
                onSelect={() => toggleSelection(file.id)}
                onOpen={() => handleFileOpen(file)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Selection actions */}
      {selectedFiles.size > 0 && (
        <div className="p-4 border-t bg-gray-50 flex items-center justify-between">
          <span className="text-sm text-gray-600">
            {selectedFiles.size} item(s) selected
          </span>
          <button
            className="text-sm text-gray-500 hover:text-gray-700"
            onClick={clearSelection}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* New folder modal */}
      {showNewFolderModal && (
        <div className="modal-overlay" onClick={() => setShowNewFolderModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">New Folder</h3>
            <input
              type="text"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
              className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
                onClick={() => setShowNewFolderModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                onClick={handleCreateFolder}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-500 bg-opacity-20 flex items-center justify-center pointer-events-none">
          <div className="text-blue-600 text-lg font-medium">Drop files to upload</div>
        </div>
      )}
    </div>
  );
};
