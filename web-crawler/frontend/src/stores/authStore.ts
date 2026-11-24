/**
 * @fileoverview Auth store for the operator session.
 *
 * Reading the dashboard is public; changing crawler state (seeding, recovery,
 * clearing the frontier, domain settings) requires an admin session. The
 * session itself is an httpOnly cookie the browser manages - this store only
 * mirrors "who am I" so the UI can show or hide admin controls.
 *
 * Hiding a control is a UX courtesy, not access control: every mutating route
 * is protected by `requireAdmin` on the server regardless of what the UI shows.
 *
 * @module stores/authStore
 */

import { create } from 'zustand';
import type { AuthUser } from '../types';
import { api, setUnauthorizedHandler } from '../services/api';

interface AuthStore {
  user: AuthUser | null;
  /** True until the first /auth/me check completes */
  checking: boolean;
  isAdmin: () => boolean;
  checkSession: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  checking: true,

  isAdmin: () => get().user?.role === 'admin',

  checkSession: async () => {
    try {
      const res = await api.getCurrentUser();
      set({ user: res.authenticated ? res.user : null, checking: false });
    } catch {
      set({ user: null, checking: false });
    }
  },

  login: async (username, password) => {
    const res = await api.login(username, password);
    set({ user: res.user });
  },

  logout: async () => {
    try {
      await api.logout();
    } finally {
      set({ user: null });
    }
  },
}));

// Any 401 from the API means the session is gone (expired, server restarted
// with a new store, logged out in another tab): drop to signed-out state.
setUnauthorizedHandler(() => {
  if (useAuthStore.getState().user) {
    useAuthStore.setState({ user: null });
  }
});
