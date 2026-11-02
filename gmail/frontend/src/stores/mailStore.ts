import { create } from 'zustand';
import type { Thread, Label, ThreadDetail } from '../types';
import { threadApi, labelApi } from '../services/api';

interface MailState {
  threads: Thread[];
  totalThreads: number;
  currentThread: ThreadDetail | null;
  labels: Label[];
  unreadCounts: Record<string, number>;
  currentLabel: string;
  currentPage: number;
  isLoading: boolean;
  composeOpen: boolean;

  fetchThreads: (label?: string, page?: number) => Promise<void>;
  fetchThread: (threadId: string) => Promise<void>;
  fetchLabels: () => Promise<void>;
  fetchUnreadCounts: () => Promise<void>;
  setCurrentLabel: (label: string) => void;
  setCurrentPage: (page: number) => void;
  toggleStar: (threadId: string) => Promise<void>;
  markAsRead: (threadId: string) => Promise<void>;
  moveToTrash: (threadId: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  setComposeOpen: (open: boolean) => void;
  clearCurrentThread: () => void;
  /** Drops all mailbox data, e.g. on logout, so the next account never sees it. */
  reset: () => void;
}

/** Mail state managing threads, labels, unread counts, compose modal, and thread actions. */
const initialMailState = {
  threads: [],
  totalThreads: 0,
  currentThread: null,
  labels: [],
  unreadCounts: {},
  currentLabel: 'INBOX',
  currentPage: 1,
  isLoading: false,
  composeOpen: false,
};

export const useMailStore = create<MailState>((set, get) => ({
  reset: () => set({ ...initialMailState }),
  threads: [],
  totalThreads: 0,
  currentThread: null,
  labels: [],
  unreadCounts: {},
  currentLabel: 'INBOX',
  currentPage: 1,
  isLoading: false,
  composeOpen: false,

  fetchThreads: async (label?: string, page?: number) => {
    const l = label || get().currentLabel;
    const p = page || get().currentPage;
    set({ isLoading: true });
    try {
      const result = await threadApi.list(l, p);
      set({
        threads: result.threads,
        totalThreads: result.total,
        isLoading: false,
        currentLabel: l,
        currentPage: p,
      });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchThread: async (threadId: string) => {
    set({ isLoading: true });
    try {
      const result = await threadApi.get(threadId);
      set({ currentThread: result.thread, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchLabels: async () => {
    try {
      const result = await labelApi.list();
      set({ labels: result.labels });
    } catch {
      // Silently fail
    }
  },

  fetchUnreadCounts: async () => {
    try {
      const result = await threadApi.getUnreadCounts();
      set({ unreadCounts: result.counts });
    } catch {
      // Silently fail
    }
  },

  setCurrentLabel: (label: string) => {
    set({ currentLabel: label, currentPage: 1, currentThread: null });
  },

  setCurrentPage: (page: number) => {
    set({ currentPage: page });
  },

  toggleStar: async (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;

    const newStarred = !thread.isStarred;

    // Optimistic update
    set({
      threads: get().threads.map((t) =>
        t.id === threadId ? { ...t, isStarred: newStarred } : t
      ),
    });

    try {
      await threadApi.updateState(threadId, { isStarred: newStarred });
    } catch {
      // Revert on failure
      set({
        threads: get().threads.map((t) =>
          t.id === threadId ? { ...t, isStarred: !newStarred } : t
        ),
      });
    }
  },

  markAsRead: async (threadId: string) => {
    set({
      threads: get().threads.map((t) =>
        t.id === threadId ? { ...t, isRead: true } : t
      ),
    });
    try {
      await threadApi.updateState(threadId, { isRead: true });
      get().fetchUnreadCounts();
    } catch {
      // Ignore
    }
  },

  moveToTrash: async (threadId: string) => {
    set({
      threads: get().threads.filter((t) => t.id !== threadId),
    });
    try {
      await threadApi.updateState(threadId, { isTrashed: true });
      get().fetchUnreadCounts();
    } catch {
      get().fetchThreads();
    }
  },

  archiveThread: async (threadId: string) => {
    set({
      threads: get().threads.filter((t) => t.id !== threadId),
    });
    try {
      await threadApi.updateState(threadId, { isArchived: true });
      get().fetchUnreadCounts();
    } catch {
      get().fetchThreads();
    }
  },

  setComposeOpen: (open: boolean) => {
    set({ composeOpen: open });
  },

  clearCurrentThread: () => {
    set({ currentThread: null });
  },
}));
