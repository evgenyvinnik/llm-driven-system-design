import { create } from 'zustand';
import { User, Store } from '../types';
import { authApi, storesApi } from '../services/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const { user } = await authApi.login(email, password);
      set({ user, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  register: async (email, password, name) => {
    set({ isLoading: true, error: null });
    try {
      const { user } = await authApi.register(email, password, name);
      set({ user, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    await authApi.logout();
    set({ user: null });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const { user } = await authApi.me();
      set({ user, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  },
}));

interface StoreState {
  stores: Store[];
  currentStore: Store | null;
  isLoading: boolean;
  error: string | null;
  fetchStores: () => Promise<void>;
  setCurrentStore: (store: Store | null) => void;
  createStore: (data: { name: string; subdomain: string; description?: string }) => Promise<Store>;
}

export const useStoreStore = create<StoreState>((set) => ({
  stores: [],
  currentStore: null,
  isLoading: false,
  error: null,

  fetchStores: async () => {
    set({ isLoading: true, error: null });
    try {
      const { stores } = await storesApi.list();
      set({ stores, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  setCurrentStore: (store) => {
    set({ currentStore: store });
  },

  createStore: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const { store } = await storesApi.create(data);
      set((state) => ({ stores: [...state.stores, store], isLoading: false }));
      return store;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },
}));
