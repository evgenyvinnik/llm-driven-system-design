import { create } from 'zustand';
import type { Photo, Album } from '../types';
import { api } from '../services/api';
import { wsService, isPhotoEvent } from '../services/websocket';

interface PhotoStore {
  photos: Photo[];
  albums: Album[];
  selectedPhotos: Set<string>;
  isLoading: boolean;
  hasMore: boolean;
  error: string | null;
  viewMode: 'grid' | 'list';
  filter: 'all' | 'favorites';

  loadPhotos: (options?: { reset?: boolean; albumId?: string }) => Promise<void>;
  loadMore: () => Promise<void>;
  uploadPhoto: (file: File) => Promise<void>;
  uploadPhotos: (files: File[]) => Promise<void>;
  toggleFavorite: (photoId: string) => Promise<void>;
  deletePhoto: (photoId: string) => Promise<void>;
  deleteSelectedPhotos: () => Promise<void>;
  selectPhoto: (photoId: string) => void;
  deselectPhoto: (photoId: string) => void;
  toggleSelection: (photoId: string) => void;
  clearSelection: () => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  setFilter: (filter: 'all' | 'favorites') => void;
  loadAlbums: () => Promise<void>;
  createAlbum: (name: string) => Promise<void>;
  addToAlbum: (albumId: string) => Promise<void>;
  clearError: () => void;
  subscribeToChanges: () => void;
}

const PAGE_SIZE = 50;

export const usePhotoStore = create<PhotoStore>((set, get) => ({
  photos: [],
  albums: [],
  selectedPhotos: new Set(),
  isLoading: false,
  hasMore: true,
  error: null,
  viewMode: 'grid',
  filter: 'all',

  loadPhotos: async (options = {}) => {
    const { reset = true, albumId } = options;
    const { filter } = get();

    set({ isLoading: true, error: null });

    if (reset) {
      set({ photos: [], hasMore: true });
    }

    try {
      const result = await api.listPhotos({
        limit: PAGE_SIZE,
        offset: reset ? 0 : get().photos.length,
        favorite: filter === 'favorites',
        albumId,
      });

      set({
        photos: reset ? result.photos : [...get().photos, ...result.photos],
        hasMore: result.hasMore,
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load photos',
      });
    }
  },

  loadMore: async () => {
    if (get().isLoading || !get().hasMore) return;
    await get().loadPhotos({ reset: false });
  },

  uploadPhoto: async (file) => {
    try {
      const newPhoto = await api.uploadPhoto(file);
      set({ photos: [newPhoto, ...get().photos] });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to upload photo' });
      throw error;
    }
  },

  uploadPhotos: async (files) => {
    for (const file of files) {
      await get().uploadPhoto(file);
    }
  },

  toggleFavorite: async (photoId) => {
    try {
      const result = await api.toggleFavorite(photoId);
      set({
        photos: get().photos.map((p) =>
          p.id === photoId ? { ...p, isFavorite: result.isFavorite } : p
        ),
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to update favorite' });
    }
  },

  deletePhoto: async (photoId) => {
    try {
      await api.deletePhoto(photoId);
      set({ photos: get().photos.filter((p) => p.id !== photoId) });
      get().deselectPhoto(photoId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete photo' });
      throw error;
    }
  },

  deleteSelectedPhotos: async () => {
    const { selectedPhotos } = get();
    for (const photoId of selectedPhotos) {
      await get().deletePhoto(photoId);
    }
  },

  selectPhoto: (photoId) => {
    const newSelection = new Set(get().selectedPhotos);
    newSelection.add(photoId);
    set({ selectedPhotos: newSelection });
  },

  deselectPhoto: (photoId) => {
    const newSelection = new Set(get().selectedPhotos);
    newSelection.delete(photoId);
    set({ selectedPhotos: newSelection });
  },

  toggleSelection: (photoId) => {
    const { selectedPhotos } = get();
    if (selectedPhotos.has(photoId)) {
      get().deselectPhoto(photoId);
    } else {
      get().selectPhoto(photoId);
    }
  },

  clearSelection: () => {
    set({ selectedPhotos: new Set() });
  },

  setViewMode: (mode) => {
    set({ viewMode: mode });
  },

  setFilter: (filter) => {
    set({ filter });
    get().loadPhotos({ reset: true });
  },

  loadAlbums: async () => {
    try {
      const result = await api.listAlbums();
      set({ albums: result.albums });
    } catch (error) {
      console.error('Failed to load albums:', error);
    }
  },

  createAlbum: async (name) => {
    try {
      const selectedIds = Array.from(get().selectedPhotos);
      const album = await api.createAlbum(name, selectedIds);
      set({ albums: [...get().albums, album] });
      get().clearSelection();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to create album' });
      throw error;
    }
  },

  addToAlbum: async (albumId) => {
    try {
      const selectedIds = Array.from(get().selectedPhotos);
      await api.addPhotosToAlbum(albumId, selectedIds);
      get().clearSelection();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to add to album' });
      throw error;
    }
  },

  clearError: () => set({ error: null }),

  subscribeToChanges: () => {
    wsService.on('*', (message) => {
      if (isPhotoEvent(message)) {
        get().loadPhotos({ reset: true });
      }
    });
  },
}));
