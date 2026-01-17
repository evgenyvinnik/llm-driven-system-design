import { create } from 'zustand';
import { FileItem, FolderContents } from '../types';
import { filesApi } from '../services/api';

interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

interface FileState {
  currentFolder: FolderContents | null;
  isLoading: boolean;
  error: string | null;
  uploadingFiles: UploadingFile[];
  selectedItems: Set<string>;

  loadFolder: (folderId?: string) => Promise<void>;
  createFolder: (name: string) => Promise<FileItem>;
  uploadFile: (file: File) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  renameItem: (itemId: string, name: string) => Promise<void>;
  moveItem: (itemId: string, parentId: string | null) => Promise<void>;
  toggleSelection: (itemId: string) => void;
  clearSelection: () => void;
  clearError: () => void;
  refresh: () => Promise<void>;
}

export const useFileStore = create<FileState>((set, get) => ({
  currentFolder: null,
  isLoading: false,
  error: null,
  uploadingFiles: [],
  selectedItems: new Set(),

  loadFolder: async (folderId?: string) => {
    set({ isLoading: true, error: null });
    try {
      const contents = await filesApi.getFolder(folderId);
      set({ currentFolder: contents, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  createFolder: async (name: string) => {
    const { currentFolder } = get();
    const parentId = currentFolder?.folder?.id;

    try {
      const folder = await filesApi.createFolder(name, parentId);
      await get().loadFolder(parentId);
      return folder;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  uploadFile: async (file: File) => {
    const { currentFolder } = get();
    const parentId = currentFolder?.folder?.id;
    const uploadId = `${Date.now()}-${file.name}`;

    const uploadingFile: UploadingFile = {
      id: uploadId,
      name: file.name,
      size: file.size,
      progress: 0,
      status: 'pending',
    };

    set((state) => ({
      uploadingFiles: [...state.uploadingFiles, uploadingFile],
    }));

    try {
      set((state) => ({
        uploadingFiles: state.uploadingFiles.map((f) =>
          f.id === uploadId ? { ...f, status: 'uploading' as const } : f
        ),
      }));

      await filesApi.uploadFile(file, parentId, (progress) => {
        set((state) => ({
          uploadingFiles: state.uploadingFiles.map((f) =>
            f.id === uploadId ? { ...f, progress } : f
          ),
        }));
      });

      set((state) => ({
        uploadingFiles: state.uploadingFiles.map((f) =>
          f.id === uploadId ? { ...f, status: 'completed' as const, progress: 100 } : f
        ),
      }));

      await get().loadFolder(parentId);

      // Remove from list after 3 seconds
      setTimeout(() => {
        set((state) => ({
          uploadingFiles: state.uploadingFiles.filter((f) => f.id !== uploadId),
        }));
      }, 3000);
    } catch (error) {
      set((state) => ({
        uploadingFiles: state.uploadingFiles.map((f) =>
          f.id === uploadId
            ? { ...f, status: 'error' as const, error: (error as Error).message }
            : f
        ),
      }));
    }
  },

  deleteItem: async (itemId: string) => {
    const { currentFolder } = get();

    try {
      await filesApi.deleteFile(itemId);
      await get().loadFolder(currentFolder?.folder?.id);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  renameItem: async (itemId: string, name: string) => {
    const { currentFolder } = get();

    try {
      await filesApi.renameFile(itemId, name);
      await get().loadFolder(currentFolder?.folder?.id);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  moveItem: async (itemId: string, parentId: string | null) => {
    const { currentFolder } = get();

    try {
      await filesApi.moveFile(itemId, parentId);
      await get().loadFolder(currentFolder?.folder?.id);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  toggleSelection: (itemId: string) => {
    set((state) => {
      const newSelection = new Set(state.selectedItems);
      if (newSelection.has(itemId)) {
        newSelection.delete(itemId);
      } else {
        newSelection.add(itemId);
      }
      return { selectedItems: newSelection };
    });
  },

  clearSelection: () => {
    set({ selectedItems: new Set() });
  },

  clearError: () => set({ error: null }),

  refresh: async () => {
    const { currentFolder } = get();
    await get().loadFolder(currentFolder?.folder?.id);
  },
}));
