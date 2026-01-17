import React from 'react';
import type { FileItem } from '../../types';
import { FileItemComponent } from './FileItemComponent';
import { LoadingSpinner } from '../common';

/**
 * Props for the FileList component.
 */
export interface FileListProps {
  /** Array of files and folders to display */
  files: FileItem[];
  /** Set of selected file IDs */
  selectedFiles: Set<string>;
  /** Whether files are currently loading */
  isLoading: boolean;
  /** Callback when a file is clicked (for selection toggle) */
  onToggleSelection: (fileId: string) => void;
  /** Callback when a file/folder is opened */
  onFileOpen: (file: FileItem) => void;
}

/**
 * File list component displaying files and folders.
 *
 * Handles:
 * - Loading state with centered spinner
 * - Empty state (folder is empty)
 * - File list with selection and open callbacks
 *
 * @example
 * ```tsx
 * <FileList
 *   files={files}
 *   selectedFiles={selectedFiles}
 *   isLoading={isLoading}
 *   onToggleSelection={toggleSelection}
 *   onFileOpen={handleFileOpen}
 * />
 * ```
 *
 * @param props - Component props
 * @returns File list or loading/empty state
 */
export const FileList: React.FC<FileListProps> = ({
  files,
  selectedFiles,
  isLoading,
  onToggleSelection,
  onFileOpen,
}) => {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <LoadingSpinner />
      </div>
    );
  }

  if (files.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-1">
      {files.map((file) => (
        <FileItemComponent
          key={file.id}
          file={file}
          isSelected={selectedFiles.has(file.id)}
          onSelect={() => onToggleSelection(file.id)}
          onOpen={() => onFileOpen(file)}
        />
      ))}
    </div>
  );
};

/**
 * Empty state displayed when a folder is empty.
 *
 * Shows helpful text encouraging the user to upload files.
 *
 * @returns Empty state message
 */
const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-32 text-gray-500">
    <p>This folder is empty</p>
    <p className="text-sm">Drag files here or click Upload</p>
  </div>
);
