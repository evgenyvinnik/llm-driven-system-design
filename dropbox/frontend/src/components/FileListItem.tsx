import { useState, useRef } from 'react';
import { MoreVertical, Download, Trash2, Edit2, Share2, History, FolderInput } from 'lucide-react';
import { FileItem } from '../types';
import { FileIcon } from './FileIcon';
import { formatBytes, formatRelativeDate } from '../utils/format';
import { filesApi } from '../services/api';

interface FileListItemProps {
  item: FileItem;
  isSelected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onShare: () => void;
  onShowVersions: () => void;
  onMove: () => void;
}

export function FileListItem({
  item,
  isSelected,
  onSelect,
  onOpen,
  onDelete,
  onRename,
  onShare,
  onShowVersions,
  onMove,
}: FileListItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(item.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleRename = () => {
    if (newName && newName !== item.name) {
      onRename(newName);
    }
    setIsRenaming(false);
  };

  const handleDownload = async () => {
    setShowMenu(false);
    const response = await filesApi.downloadFile(item.id);
    if (response.ok) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div
      className={`group flex items-center px-4 py-3 border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${
        isSelected ? 'bg-blue-50' : ''
      }`}
      onClick={(e) => {
        if (!isRenaming && !showMenu) {
          if (e.ctrlKey || e.metaKey) {
            onSelect();
          } else {
            onOpen();
          }
        }
      }}
    >
      {/* Checkbox */}
      <div className="mr-4" onClick={(e) => { e.stopPropagation(); onSelect(); }}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => {}}
          className="w-4 h-4 text-dropbox-blue rounded border-gray-300 focus:ring-dropbox-blue"
        />
      </div>

      {/* Icon */}
      <div className="mr-4">
        <FileIcon mimeType={item.mimeType} isFolder={item.isFolder} size={32} />
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') {
                setNewName(item.name);
                setIsRenaming(false);
              }
            }}
            className="w-full px-2 py-1 border border-dropbox-blue rounded focus:outline-none"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <p className="font-medium text-gray-900 truncate">{item.name}</p>
        )}
        <p className="text-sm text-gray-500">
          {formatRelativeDate(item.updatedAt)}
          {!item.isFolder && ` - ${formatBytes(item.size)}`}
        </p>
      </div>

      {/* Sync status */}
      {item.syncStatus !== 'synced' && (
        <span
          className={`mr-4 px-2 py-1 text-xs rounded ${
            item.syncStatus === 'syncing'
              ? 'bg-blue-100 text-blue-700'
              : item.syncStatus === 'pending'
              ? 'bg-yellow-100 text-yellow-700'
              : 'bg-red-100 text-red-700'
          }`}
        >
          {item.syncStatus}
        </span>
      )}

      {/* Version */}
      {!item.isFolder && item.version > 1 && (
        <span className="mr-4 text-xs text-gray-500">v{item.version}</span>
      )}

      {/* Menu */}
      <div className="relative">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
          className="p-2 rounded-full hover:bg-gray-200 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <MoreVertical size={20} />
        </button>

        {showMenu && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowMenu(false)}
            />
            <div className="absolute right-0 top-10 z-20 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1">
              {!item.isFolder && (
                <button
                  onClick={handleDownload}
                  className="w-full flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                >
                  <Download size={16} className="mr-3" />
                  Download
                </button>
              )}
              <button
                onClick={() => {
                  setShowMenu(false);
                  setIsRenaming(true);
                  setTimeout(() => inputRef.current?.select(), 0);
                }}
                className="w-full flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                <Edit2 size={16} className="mr-3" />
                Rename
              </button>
              <button
                onClick={() => {
                  setShowMenu(false);
                  onMove();
                }}
                className="w-full flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                <FolderInput size={16} className="mr-3" />
                Move
              </button>
              <button
                onClick={() => {
                  setShowMenu(false);
                  onShare();
                }}
                className="w-full flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                <Share2 size={16} className="mr-3" />
                Share
              </button>
              {!item.isFolder && (
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onShowVersions();
                  }}
                  className="w-full flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                >
                  <History size={16} className="mr-3" />
                  Version history
                </button>
              )}
              <hr className="my-1" />
              <button
                onClick={() => {
                  setShowMenu(false);
                  onDelete();
                }}
                className="w-full flex items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                <Trash2 size={16} className="mr-3" />
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
