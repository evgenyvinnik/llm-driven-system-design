import React, { useCallback, useState } from 'react';
import type { FileItem } from '../../types';
import { FileIcon, SyncStatusIcon } from '../Icons';
import { formatBytes, formatRelativeTime, getFileIcon } from '../../utils/helpers';
import { useFileStore } from '../../stores/fileStore';

/**
 * Props for the FileItemComponent.
 */
export interface FileItemComponentProps {
  /** File or folder to display */
  file: FileItem;
  /** Whether this item is currently selected */
  isSelected: boolean;
  /** Callback when item is clicked (for selection) */
  onSelect: () => void;
  /** Callback when item is double-clicked (for open/download) */
  onOpen: () => void;
}

/**
 * Renders a single file or folder item in the file browser.
 *
 * Displays the file icon, name, size/type, modification time, and sync status.
 * Supports selection (click), opening (double-click), and a context menu
 * for actions like rename, download, and delete.
 *
 * Uses the `file-item` CSS class for styling, which should be defined
 * in the application's global styles.
 *
 * @example
 * ```tsx
 * <FileItemComponent
 *   file={file}
 *   isSelected={selectedFiles.has(file.id)}
 *   onSelect={() => toggleSelection(file.id)}
 *   onOpen={() => handleFileOpen(file)}
 * />
 * ```
 *
 * @param props - Component props
 * @returns File item row element with icon and metadata
 */
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

  /**
   * Handles double-click to open folder or download file.
   */
  const handleDoubleClick = useCallback(() => {
    if (file.isFolder) {
      onOpen();
    } else {
      downloadFile(file.id, file.name);
    }
  }, [file, onOpen, downloadFile]);

  /**
   * Handles right-click to show context menu.
   */
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
  }, []);

  /**
   * Handles file deletion with confirmation.
   */
  const handleDelete = async () => {
    if (confirm(`Delete "${file.name}"?`)) {
      await deleteFile(file.id);
    }
    setShowMenu(false);
  };

  /**
   * Handles file rename.
   */
  const handleRename = async () => {
    if (newName && newName !== file.name) {
      await renameFile(file.id, newName);
    }
    setIsRenaming(false);
    setShowMenu(false);
  };

  /**
   * Handles file download.
   */
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
      <FileItemIcon file={file} iconType={iconType} />
      <FileItemContent
        file={file}
        isRenaming={isRenaming}
        newName={newName}
        onNewNameChange={setNewName}
        onRename={handleRename}
        onCancelRename={() => setIsRenaming(false)}
      />
      <FileItemStatus syncStatus={file.syncStatus} />
      {showMenu && (
        <FileContextMenu
          file={file}
          onClose={() => setShowMenu(false)}
          onDownload={handleDownload}
          onRename={() => {
            setIsRenaming(true);
            setShowMenu(false);
          }}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
};

/**
 * Props for the FileItemIcon component.
 */
interface FileItemIconProps {
  file: FileItem;
  iconType: string;
}

/**
 * Displays the file type icon.
 *
 * @param props - Component props
 * @returns File icon element
 */
const FileItemIcon: React.FC<FileItemIconProps> = ({ file, iconType }) => (
  <div className={`file-icon ${file.isFolder ? 'folder' : iconType === 'image' ? 'image' : 'file'}`}>
    <FileIcon type={iconType as 'folder' | 'file' | 'image'} />
  </div>
);

/**
 * Props for the FileItemContent component.
 */
interface FileItemContentProps {
  file: FileItem;
  isRenaming: boolean;
  newName: string;
  onNewNameChange: (name: string) => void;
  onRename: () => void;
  onCancelRename: () => void;
}

/**
 * Displays file name and metadata, or rename input.
 *
 * @param props - Component props
 * @returns File content with name and details
 */
const FileItemContent: React.FC<FileItemContentProps> = ({
  file,
  isRenaming,
  newName,
  onNewNameChange,
  onRename,
  onCancelRename,
}) => (
  <div className="flex-1 min-w-0">
    {isRenaming ? (
      <input
        type="text"
        value={newName}
        onChange={(e) => onNewNameChange(e.target.value)}
        onBlur={onRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onRename();
          if (e.key === 'Escape') onCancelRename();
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
);

/**
 * Props for the FileItemStatus component.
 */
interface FileItemStatusProps {
  syncStatus?: 'synced' | 'syncing' | 'pending' | 'conflict' | 'error';
}

/**
 * Displays the sync status icon for a file.
 *
 * @param props - Component props
 * @returns Sync status indicator
 */
const FileItemStatus: React.FC<FileItemStatusProps> = ({ syncStatus }) => (
  <div className="flex items-center gap-2">
    {syncStatus && <SyncStatusIcon status={syncStatus} />}
  </div>
);

/**
 * Props for the FileContextMenu component.
 */
interface FileContextMenuProps {
  file: FileItem;
  onClose: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * Context menu for file actions.
 *
 * Shows Download (for files only), Rename, and Delete options.
 *
 * @param props - Component props
 * @returns Context menu overlay with action buttons
 */
const FileContextMenu: React.FC<FileContextMenuProps> = ({
  file,
  onClose,
  onDownload,
  onRename,
  onDelete,
}) => (
  <>
    <div className="fixed inset-0 z-10" onClick={onClose} />
    <div className="dropdown-menu">
      {!file.isFolder && (
        <button className="dropdown-item w-full text-left" onClick={onDownload}>
          Download
        </button>
      )}
      <button className="dropdown-item w-full text-left" onClick={onRename}>
        Rename
      </button>
      <button className="dropdown-item w-full text-left text-red-600" onClick={onDelete}>
        Delete
      </button>
    </div>
  </>
);
