import { create } from 'zustand';
import type { FileItem, SyncStatus, Conflict } from '../types';
import { api } from '../services/api';
import { wsService, isFileEvent } from '../services/websocket';

interface FileStore {
  files: FileItem[];
  currentPath: string;
  selectedFiles: Set<string>;
  isLoading: boolean;
  error: string | null;
  conflicts: Conflict[];
  uploadProgress: Map<string, number>;

  setCurrentPath: (path: string) => void;
  loadFiles: (path?: string) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<void>;
  downloadFile: (fileId: string, fileName: string) => Promise<void>;
  deleteFile: (fileId: string) => Promise<void>;
  renameFile: (fileId: string, newName: string) => Promise<void>;
  selectFile: (fileId: string) => void;
  deselectFile: (fileId: string) => void;
  toggleSelection: (fileId: string) => void;
  clearSelection: () => void;
  loadConflicts: () => Promise<void>;
  resolveConflict: (fileId: string, resolution: 'use-local' | 'use-server', keepBoth?: boolean) => Promise<void>;
  clearError: () => void;
  subscribeToChanges: () => void;
}

export const useFileStore = create<FileStore>((set, get) => ({
  files: [],
  currentPath: '/',
  selectedFiles: new Set(),
  isLoading: false,
  error: null,
  conflicts: [],
  uploadProgress: new Map(),

  setCurrentPath: (path) => {
    set({ currentPath: path });
    get().loadFiles(path);
  },

  loadFiles: async (path) => {
    const targetPath = path || get().currentPath;
    set({ isLoading: true, error: null });
    try {
      const result = await api.listFiles(targetPath);
      set({ files: result.files, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load files',
      });
    }
  },

  createFolder: async (name) => {
    try {
      await api.createFolder(name, get().currentPath);
      await get().loadFiles();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to create folder' });
      throw error;
    }
  },

  uploadFile: async (file) => {
    const progressMap = new Map(get().uploadProgress);
    progressMap.set(file.name, 0);
    set({ uploadProgress: progressMap });

    try {
      await api.uploadFile(file, get().currentPath);
      progressMap.set(file.name, 100);
      set({ uploadProgress: new Map(progressMap) });
      await get().loadFiles();
    } catch (error) {
      progressMap.delete(file.name);
      set({
        uploadProgress: new Map(progressMap),
        error: error instanceof Error ? error.message : 'Failed to upload file',
      });
      throw error;
    } finally {
      // Remove from progress after a delay
      setTimeout(() => {
        const newMap = new Map(get().uploadProgress);
        newMap.delete(file.name);
        set({ uploadProgress: newMap });
      }, 2000);
    }
  },

  uploadFiles: async (files) => {
    for (const file of files) {
      await get().uploadFile(file);
    }
  },

  downloadFile: async (fileId, fileName) => {
    try {
      const blob = await api.downloadFile(fileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to download file' });
      throw error;
    }
  },

  deleteFile: async (fileId) => {
    try {
      await api.deleteFile(fileId);
      set({ files: get().files.filter((f) => f.id !== fileId) });
      get().deselectFile(fileId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete file' });
      throw error;
    }
  },

  renameFile: async (fileId, newName) => {
    try {
      const updated = await api.renameFile(fileId, newName);
      set({
        files: get().files.map((f) => (f.id === fileId ? { ...f, name: updated.name } : f)),
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to rename file' });
      throw error;
    }
  },

  selectFile: (fileId) => {
    const newSelection = new Set(get().selectedFiles);
    newSelection.add(fileId);
    set({ selectedFiles: newSelection });
  },

  deselectFile: (fileId) => {
    const newSelection = new Set(get().selectedFiles);
    newSelection.delete(fileId);
    set({ selectedFiles: newSelection });
  },

  toggleSelection: (fileId) => {
    const { selectedFiles } = get();
    if (selectedFiles.has(fileId)) {
      get().deselectFile(fileId);
    } else {
      get().selectFile(fileId);
    }
  },

  clearSelection: () => {
    set({ selectedFiles: new Set() });
  },

  loadConflicts: async () => {
    try {
      const result = await api.getConflicts();
      set({ conflicts: result.conflicts });
    } catch (error) {
      console.error('Failed to load conflicts:', error);
    }
  },

  resolveConflict: async (fileId, resolution, keepBoth = false) => {
    try {
      await api.resolveConflict(fileId, resolution, keepBoth);
      set({ conflicts: get().conflicts.filter((c) => c.fileId !== fileId) });
      await get().loadFiles();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to resolve conflict' });
      throw error;
    }
  },

  clearError: () => set({ error: null }),

  subscribeToChanges: () => {
    wsService.on('*', (message) => {
      if (isFileEvent(message)) {
        // Reload files when changes come from another device
        get().loadFiles();
      }
    });
  },
}));
