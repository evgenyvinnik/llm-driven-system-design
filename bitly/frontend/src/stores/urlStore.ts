/**
 * URL Store
 *
 * Manages URL-related state using Zustand.
 * Provides CRUD operations for the user's shortened URLs.
 */
import { create } from 'zustand';
import { Url, CreateUrlInput } from '../types';
import { api } from '../services/api';

/**
 * URL state interface.
 * Creation has its own loading/error state so a slow list reload or a failed delete
 * does not disable or mislabel the create form (and vice versa).
 */
interface UrlState {
  urls: Url[];
  total: number;
  isLoading: boolean;
  error: string | null;
  createdUrl: Url | null;
  isCreating: boolean;
  createError: string | null;

  createUrl: (data: CreateUrlInput, idempotencyKey?: string) => Promise<boolean>;
  loadUrls: (limit?: number, offset?: number) => Promise<void>;
  deleteUrl: (shortCode: string) => Promise<boolean>;
  clearCreatedUrl: () => void;
  clearCreateError: () => void;
  clearError: () => void;
  reset: () => void;
}

/**
 * Bumped by reset() (logout, session loss). Responses to requests started before that
 * are dropped instead of repopulating the store with the previous user's links.
 */
let generation = 0;

/** Only the most recent list load may write its result. */
let loadSequence = 0;

const initialState = {
  urls: [] as Url[],
  total: 0,
  isLoading: false,
  error: null as string | null,
  createdUrl: null as Url | null,
  isCreating: false,
  createError: null as string | null,
};

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/**
 * URL store hook.
 * Manages the list of user's URLs and provides actions for creating and deleting.
 */
export const useUrlStore = create<UrlState>()((set) => ({
  ...initialState,

  createUrl: async (data: CreateUrlInput, idempotencyKey?: string) => {
    const started = generation;
    set({ isCreating: true, createError: null });
    try {
      const url = await api.urls.create(data, { idempotencyKey });
      if (started !== generation) return false;
      set((state) => {
        // A retried draft can replay a link the list already shows.
        const known = state.urls.some((u) => u.short_code === url.short_code);
        return {
          urls: known ? state.urls : [url, ...state.urls],
          total: known ? state.total : state.total + 1,
          createdUrl: url,
          isCreating: false,
        };
      });
      return true;
    } catch (error) {
      if (started !== generation) return false;
      set({ createError: messageOf(error, 'Failed to create URL'), isCreating: false });
      return false;
    }
  },

  loadUrls: async (limit = 50, offset = 0) => {
    const started = generation;
    const sequence = ++loadSequence;
    set({ isLoading: true, error: null });
    try {
      const { urls, total } = await api.urls.list(limit, offset);
      if (started !== generation || sequence !== loadSequence) return;
      set({ urls, total, isLoading: false });
    } catch (error) {
      if (started !== generation || sequence !== loadSequence) return;
      set({ error: messageOf(error, 'Failed to load URLs'), isLoading: false });
    }
  },

  deleteUrl: async (shortCode: string) => {
    const started = generation;
    set({ error: null });
    try {
      await api.urls.delete(shortCode);
      if (started !== generation) return false;
      // Delete is a soft delete: the link comes back as inactive on the next reload, so
      // show it that way now instead of removing it.
      set((state) => ({
        urls: state.urls.map((u) => (u.short_code === shortCode ? { ...u, is_active: false } : u)),
      }));
      return true;
    } catch (error) {
      if (started !== generation) return false;
      set({ error: messageOf(error, 'Failed to delete URL') });
      return false;
    }
  },

  clearCreatedUrl: () => set({ createdUrl: null }),

  clearCreateError: () => set({ createError: null }),

  clearError: () => set({ error: null }),

  reset: () => {
    generation++;
    loadSequence++;
    set({ ...initialState });
  },
}));
