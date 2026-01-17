import React, { useCallback, useState } from 'react';
import type { FileItem } from '../types';
import { useFileStore } from '../stores/fileStore';
import {
  FileToolbar,
  FileList,
  FileStatusBanners,
  NewFolderModal,
  SelectionBar,
  DragOverlay,
} from './files';

/**
 * Props for the FileBrowser component.
 */
interface FileBrowserProps {
  /** Callback when user navigates to a different directory */
  onNavigate: (path: string) => void;
}

/**
 * Main file browser component for iCloud Drive.
 *
 * Provides a complete file browsing experience including:
 * - Breadcrumb navigation
 * - File/folder listing with icons and metadata
 * - Drag-and-drop file upload
 * - Toolbar with "New Folder" and "Upload" buttons
 * - Multi-select for batch operations
 * - Conflict warnings
 * - Upload progress indicators
 *
 * The component uses the file store for state management and
 * subscribes to WebSocket events for real-time sync updates.
 *
 * @example
 * ```tsx
 * <FileBrowser onNavigate={(path) => setCurrentPath(path)} />
 * ```
 *
 * @param props - Component props
 * @param props.onNavigate - Callback when navigating directories
 * @returns Complete file browser UI
 */
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

  /**
   * Handles file drop for drag-and-drop upload.
   */
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

  /**
   * Handles drag over event.
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  /**
   * Handles drag leave event.
   */
  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  /**
   * Handles file upload from the toolbar.
   */
  const handleUpload = useCallback(
    (files: File[]) => {
      uploadFiles(files);
    },
    [uploadFiles]
  );

  /**
   * Handles folder creation.
   */
  const handleCreateFolder = async () => {
    if (newFolderName.trim()) {
      await createFolder(newFolderName.trim());
      setNewFolderName('');
      setShowNewFolderModal(false);
    }
  };

  /**
   * Handles file/folder open action.
   * For folders, navigates to the folder path.
   */
  const handleFileOpen = (file: FileItem) => {
    if (file.isFolder) {
      onNavigate(file.path);
    }
  };

  /**
   * Builds breadcrumb navigation from current path.
   */
  const breadcrumbs = buildBreadcrumbs(currentPath);

  return (
    <div
      className={`flex flex-col h-full ${isDragOver ? 'bg-blue-50' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <FileToolbar
        breadcrumbs={breadcrumbs}
        onNavigate={onNavigate}
        onNewFolder={() => setShowNewFolderModal(true)}
        onUpload={handleUpload}
      />

      <FileStatusBanners
        error={error}
        onClearError={clearError}
        conflicts={conflicts}
        uploadProgress={uploadProgress}
      />

      <div className="flex-1 overflow-auto p-4">
        <FileList
          files={files}
          selectedFiles={selectedFiles}
          isLoading={isLoading}
          onToggleSelection={toggleSelection}
          onFileOpen={handleFileOpen}
        />
      </div>

      <SelectionBar
        selectedCount={selectedFiles.size}
        onClearSelection={clearSelection}
      />

      <NewFolderModal
        isOpen={showNewFolderModal}
        onClose={() => setShowNewFolderModal(false)}
        folderName={newFolderName}
        onFolderNameChange={setNewFolderName}
        onCreateFolder={handleCreateFolder}
      />

      <DragOverlay isVisible={isDragOver} />
    </div>
  );
};

/**
 * Builds breadcrumb navigation items from a path string.
 *
 * @param currentPath - The current file browser path
 * @returns Array of breadcrumb items with name and path
 *
 * @example
 * ```ts
 * buildBreadcrumbs('/Documents/Work')
 * // Returns:
 * // [
 * //   { name: 'iCloud Drive', path: '/' },
 * //   { name: 'Documents', path: '/Documents' },
 * //   { name: 'Work', path: '/Documents/Work' },
 * // ]
 * ```
 */
function buildBreadcrumbs(currentPath: string): Array<{ name: string; path: string }> {
  const pathParts = currentPath.split('/').filter(Boolean);
  return [
    { name: 'iCloud Drive', path: '/' },
    ...pathParts.map((part, index) => ({
      name: part,
      path: '/' + pathParts.slice(0, index + 1).join('/'),
    })),
  ];
}

// Re-export FileItemComponent for backward compatibility
export { FileItemComponent } from './files';
