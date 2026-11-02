import { create } from 'zustand';
import type { Space, Page, PageTreeNode } from '../types';
import * as api from '../services/api';

interface WikiState {
  spaces: Space[];
  currentSpace: Space | null;
  currentPage: Page | null;
  pageTree: PageTreeNode[];
  recentPages: Page[];
  loading: boolean;
  error: string | null;

  loadSpaces: () => Promise<void>;
  loadSpace: (key: string) => Promise<void>;
  loadPageTree: (spaceKey: string) => Promise<void>;
  loadPage: (spaceKey: string, slug: string) => Promise<void>;
  loadRecentPages: () => Promise<void>;
  setCurrentPage: (page: Page | null) => void;
  clearError: () => void;
}

// Each load gets a ticket; a response is applied only if no newer load of the
// same kind started meanwhile, so a slow answer for page A cannot replace page B.
let spaceTicket = 0;
let pageTicket = 0;
let treeTicket = 0;

/** Wiki state managing spaces, pages, page tree, and recent pages. */
export const useWikiStore = create<WikiState>((set) => ({
  spaces: [],
  currentSpace: null,
  currentPage: null,
  pageTree: [],
  recentPages: [],
  loading: false,
  error: null,

  loadSpaces: async () => {
    try {
      set({ loading: true, error: null });
      const { spaces } = await api.getSpaces();
      set({ spaces, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load spaces';
      set({ error: message, loading: false });
    }
  },

  loadSpace: async (key: string) => {
    const ticket = ++spaceTicket;
    try {
      set({ loading: true, error: null });
      const { space, access } = await api.getSpace(key);
      if (ticket !== spaceTicket) return;
      set({ currentSpace: { ...space, access }, loading: false });
    } catch (err) {
      if (ticket !== spaceTicket) return;
      const message = err instanceof Error ? err.message : 'Failed to load space';
      set({ error: message, loading: false, currentSpace: null });
    }
  },

  loadPageTree: async (spaceKey: string) => {
    const ticket = ++treeTicket;
    try {
      const { tree } = await api.getPageTree(spaceKey);
      if (ticket !== treeTicket) return;
      set({ pageTree: tree });
    } catch (err) {
      if (ticket !== treeTicket) return;
      const message = err instanceof Error ? err.message : 'Failed to load page tree';
      set({ error: message, pageTree: [] });
    }
  },

  loadPage: async (spaceKey: string, slug: string) => {
    const ticket = ++pageTicket;
    try {
      set({ loading: true, error: null });
      const { page } = await api.getPageBySlug(spaceKey, slug);
      if (ticket !== pageTicket) return;
      set({ currentPage: page, loading: false });
    } catch (err) {
      if (ticket !== pageTicket) return;
      const message = err instanceof Error ? err.message : 'Failed to load page';
      set({ error: message, loading: false, currentPage: null });
    }
  },

  loadRecentPages: async () => {
    try {
      const { pages } = await api.getRecentPages();
      set({ recentPages: pages });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load recent pages';
      set({ error: message });
    }
  },

  setCurrentPage: (page) => set({ currentPage: page }),
  clearError: () => set({ error: null }),
}));
