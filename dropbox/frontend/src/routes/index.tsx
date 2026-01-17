import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useFileStore } from '../stores/fileStore';
import { Sidebar } from '../components/Sidebar';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { UploadZone } from '../components/UploadZone';
import { FileListItem } from '../components/FileListItem';
import { CreateFolderModal } from '../components/CreateFolderModal';
import { ShareModal } from '../components/ShareModal';
import { VersionHistoryModal } from '../components/VersionHistoryModal';
import { MoveModal } from '../components/MoveModal';
import { FileItem } from '../types';
import { Loader2 } from 'lucide-react';

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => {
    return {
      folder: search.folder as string | undefined,
    };
  },
  component: FileBrowser,
});

function FileBrowser() {
  const navigate = useNavigate();
  const { folder: folderId } = useSearch({ from: '/' });
  const { user, checkAuth, isLoading: authLoading } = useAuthStore();
  const {
    currentFolder,
    isLoading,
    error,
    selectedItems,
    loadFolder,
    createFolder,
    deleteItem,
    renameItem,
    moveItem,
    toggleSelection,
    clearSelection,
  } = useFileStore();

  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [shareItem, setShareItem] = useState<FileItem | null>(null);
  const [versionItem, setVersionItem] = useState<FileItem | null>(null);
  const [moveModalItem, setMoveModalItem] = useState<FileItem | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (user) {
      loadFolder(folderId);
    }
  }, [user, folderId]);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/login' });
    }
  }, [authLoading, user, navigate]);

  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-dropbox-blue" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const handleNavigate = (targetFolderId: string | null) => {
    clearSelection();
    if (targetFolderId) {
      navigate({ to: '/', search: { folder: targetFolderId } });
    } else {
      navigate({ to: '/' });
    }
  };

  const handleOpenItem = (item: FileItem) => {
    if (item.isFolder) {
      handleNavigate(item.id);
    } else {
      // For files, could open preview or download
    }
  };

  const handleDelete = async (itemId: string) => {
    if (confirm('Are you sure you want to delete this item?')) {
      await deleteItem(itemId);
    }
  };

  const handleRename = async (itemId: string, newName: string) => {
    await renameItem(itemId, newName);
  };

  const handleMove = async (parentId: string | null) => {
    if (moveModalItem) {
      await moveItem(moveModalItem.id, parentId);
    }
  };

  return (
    <div className="h-screen flex bg-gray-50">
      <Sidebar />

      <main className="flex-1 flex flex-col overflow-hidden">
        <Breadcrumbs
          breadcrumbs={currentFolder?.breadcrumbs || []}
          onNavigate={handleNavigate}
        />

        <div className="flex-1 overflow-hidden flex flex-col">
          <UploadZone onCreateFolder={() => setShowCreateFolder(true)} />

          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-dropbox-blue" />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center text-red-500">
              {error}
            </div>
          ) : currentFolder?.items.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
              <div className="text-6xl mb-4">📁</div>
              <p className="text-lg font-medium">This folder is empty</p>
              <p className="text-sm">Drop files here or click Upload to add files</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto bg-white">
              {currentFolder?.items.map((item) => (
                <FileListItem
                  key={item.id}
                  item={item}
                  isSelected={selectedItems.has(item.id)}
                  onSelect={() => toggleSelection(item.id)}
                  onOpen={() => handleOpenItem(item)}
                  onDelete={() => handleDelete(item.id)}
                  onRename={(name) => handleRename(item.id, name)}
                  onShare={() => setShareItem(item)}
                  onShowVersions={() => setVersionItem(item)}
                  onMove={() => setMoveModalItem(item)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <CreateFolderModal
        isOpen={showCreateFolder}
        onClose={() => setShowCreateFolder(false)}
        onCreate={async (name) => {
          await createFolder(name);
        }}
      />

      <ShareModal
        isOpen={!!shareItem}
        onClose={() => setShareItem(null)}
        item={shareItem}
      />

      <VersionHistoryModal
        isOpen={!!versionItem}
        onClose={() => setVersionItem(null)}
        file={versionItem}
        onRestore={() => loadFolder(folderId)}
      />

      <MoveModal
        isOpen={!!moveModalItem}
        onClose={() => setMoveModalItem(null)}
        item={moveModalItem}
        onMove={handleMove}
      />
    </div>
  );
}
