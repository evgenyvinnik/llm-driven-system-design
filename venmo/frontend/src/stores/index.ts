import { create } from 'zustand';
import type { User, Transfer, PaymentRequest, PaymentMethod, Friend } from '../types';
import { api } from '../services/api';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; password: string; name: string }) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateBalance: (balance: number) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (username, password) => {
    const { user, sessionId } = await api.login(username, password);
    localStorage.setItem('sessionId', sessionId);
    set({ user, isAuthenticated: true });
  },

  register: async (data) => {
    const { user, sessionId } = await api.register(data);
    localStorage.setItem('sessionId', sessionId);
    set({ user, isAuthenticated: true });
  },

  logout: async () => {
    try {
      await api.logout();
    } catch (e) {
      // Ignore logout errors
    }
    localStorage.removeItem('sessionId');
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      set({ isLoading: false });
      return;
    }

    try {
      const user = await api.getMe();
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem('sessionId');
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  updateBalance: (balance) => {
    const user = get().user;
    if (user) {
      set({
        user: {
          ...user,
          wallet: { ...user.wallet, balance, pendingBalance: user.wallet?.pendingBalance || 0 },
        },
      });
    }
  },
}));

interface FeedState {
  items: Transfer[];
  isLoading: boolean;
  loadFeed: () => Promise<void>;
  loadGlobalFeed: () => Promise<void>;
  addItem: (item: Transfer) => void;
  updateItem: (id: string, updates: Partial<Transfer>) => void;
}

export const useFeedStore = create<FeedState>((set) => ({
  items: [],
  isLoading: false,

  loadFeed: async () => {
    set({ isLoading: true });
    try {
      const items = await api.getFeed();
      set({ items, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  loadGlobalFeed: async () => {
    set({ isLoading: true });
    try {
      const items = await api.getGlobalFeed();
      set({ items, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  addItem: (item) => {
    set((state) => ({ items: [item, ...state.items] }));
  },

  updateItem: (id, updates) => {
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, ...updates } : item)),
    }));
  },
}));

interface RequestsState {
  sent: PaymentRequest[];
  received: PaymentRequest[];
  isLoading: boolean;
  loadRequests: () => Promise<void>;
}

export const useRequestsStore = create<RequestsState>((set) => ({
  sent: [],
  received: [],
  isLoading: false,

  loadRequests: async () => {
    set({ isLoading: true });
    try {
      const [sent, received] = await Promise.all([
        api.getSentRequests(),
        api.getReceivedRequests(),
      ]);
      set({ sent, received, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },
}));

interface WalletState {
  balance: number;
  pendingBalance: number;
  paymentMethods: PaymentMethod[];
  isLoading: boolean;
  loadWallet: () => Promise<void>;
}

export const useWalletStore = create<WalletState>((set) => ({
  balance: 0,
  pendingBalance: 0,
  paymentMethods: [],
  isLoading: false,

  loadWallet: async () => {
    set({ isLoading: true });
    try {
      const wallet = await api.getWallet();
      set({
        balance: wallet.balance,
        pendingBalance: wallet.pendingBalance,
        paymentMethods: wallet.paymentMethods,
        isLoading: false,
      });
    } catch {
      set({ isLoading: false });
    }
  },
}));

interface FriendsState {
  friends: Friend[];
  requests: Friend[];
  isLoading: boolean;
  loadFriends: () => Promise<void>;
  loadRequests: () => Promise<void>;
}

export const useFriendsStore = create<FriendsState>((set) => ({
  friends: [],
  requests: [],
  isLoading: false,

  loadFriends: async () => {
    set({ isLoading: true });
    try {
      const friends = await api.getFriends();
      set({ friends, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  loadRequests: async () => {
    try {
      const requests = await api.getFriendRequests();
      set({ requests });
    } catch {
      // Ignore errors
    }
  },
}));
