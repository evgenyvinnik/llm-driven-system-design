import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api from '../services/api';
import type { User, Device, Card, Transaction } from '../types';

interface AuthState {
  user: User | null;
  sessionId: string | null;
  devices: Device[];
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string, deviceId?: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  loadUser: () => Promise<void>;
  loadDevices: () => Promise<void>;
  registerDevice: (name: string, type: string) => Promise<Device>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      sessionId: null,
      devices: [],
      isLoading: false,
      error: null,

      login: async (email, password, deviceId) => {
        set({ isLoading: true, error: null });
        try {
          const { sessionId, user } = await api.login(email, password, deviceId);
          localStorage.setItem('sessionId', sessionId);
          set({ user, sessionId, isLoading: false });
          await get().loadDevices();
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      register: async (email, password, name) => {
        set({ isLoading: true, error: null });
        try {
          await api.register(email, password, name);
          set({ isLoading: false });
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.logout();
        } catch {
          // Ignore logout errors
        }
        localStorage.removeItem('sessionId');
        sessionStorage.removeItem('biometricSession');
        set({ user: null, sessionId: null, devices: [] });
      },

      loadUser: async () => {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;

        set({ isLoading: true });
        try {
          const { user } = await api.getMe();
          set({ user, sessionId, isLoading: false });
          await get().loadDevices();
        } catch {
          localStorage.removeItem('sessionId');
          set({ user: null, sessionId: null, isLoading: false });
        }
      },

      loadDevices: async () => {
        try {
          const { devices } = await api.getDevices();
          set({ devices });
        } catch (error) {
          console.error('Failed to load devices:', error);
        }
      },

      registerDevice: async (name, type) => {
        const { device } = await api.registerDevice(name, type);
        set((state) => ({ devices: [...state.devices, device] }));
        return device;
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ sessionId: state.sessionId }),
    }
  )
);

interface WalletState {
  cards: Card[];
  selectedCard: Card | null;
  isLoading: boolean;
  error: string | null;
  loadCards: () => Promise<void>;
  addCard: (data: {
    pan: string;
    expiry_month: number;
    expiry_year: number;
    cvv: string;
    card_holder_name: string;
    device_id: string;
  }) => Promise<Card>;
  suspendCard: (cardId: string, reason?: string) => Promise<void>;
  reactivateCard: (cardId: string) => Promise<void>;
  removeCard: (cardId: string) => Promise<void>;
  setDefaultCard: (cardId: string) => Promise<void>;
  selectCard: (card: Card | null) => void;
}

export const useWalletStore = create<WalletState>((set, get) => ({
  cards: [],
  selectedCard: null,
  isLoading: false,
  error: null,

  loadCards: async () => {
    set({ isLoading: true, error: null });
    try {
      const { cards } = await api.getCards();
      set({ cards, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  addCard: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const { card } = await api.provisionCard(data);
      await get().loadCards();
      set({ isLoading: false });
      return card;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  suspendCard: async (cardId, reason) => {
    await api.suspendCard(cardId, reason);
    await get().loadCards();
  },

  reactivateCard: async (cardId) => {
    await api.reactivateCard(cardId);
    await get().loadCards();
  },

  removeCard: async (cardId) => {
    await api.removeCard(cardId);
    await get().loadCards();
  },

  setDefaultCard: async (cardId) => {
    await api.setDefaultCard(cardId);
    await get().loadCards();
  },

  selectCard: (card) => set({ selectedCard: card }),
}));

interface TransactionState {
  transactions: Transaction[];
  total: number;
  isLoading: boolean;
  error: string | null;
  loadTransactions: (options?: {
    limit?: number;
    offset?: number;
    card_id?: string;
    status?: string;
  }) => Promise<void>;
}

export const useTransactionStore = create<TransactionState>((set) => ({
  transactions: [],
  total: 0,
  isLoading: false,
  error: null,

  loadTransactions: async (options) => {
    set({ isLoading: true, error: null });
    try {
      const { transactions, total } = await api.getTransactions(options);
      set({ transactions, total, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },
}));

interface PaymentState {
  biometricSession: string | null;
  isAuthenticating: boolean;
  isProcessing: boolean;
  error: string | null;
  initiateBiometric: (deviceId: string, authType: string) => Promise<string>;
  simulateBiometric: (sessionId: string) => Promise<void>;
  processPayment: (data: {
    card_id: string;
    amount: number;
    currency: string;
    merchant_id: string;
    transaction_type: string;
  }) => Promise<{ success: boolean; transaction_id?: string; auth_code?: string; error?: string }>;
  clearBiometricSession: () => void;
}

export const usePaymentStore = create<PaymentState>((set) => ({
  biometricSession: null,
  isAuthenticating: false,
  isProcessing: false,
  error: null,

  initiateBiometric: async (deviceId, authType) => {
    set({ isAuthenticating: true, error: null });
    try {
      const { sessionId } = await api.initiateBiometric(deviceId, authType);
      set({ biometricSession: sessionId, isAuthenticating: false });
      return sessionId;
    } catch (error) {
      set({ error: (error as Error).message, isAuthenticating: false });
      throw error;
    }
  },

  simulateBiometric: async (sessionId) => {
    set({ isAuthenticating: true, error: null });
    try {
      await api.simulateBiometric(sessionId);
      sessionStorage.setItem('biometricSession', sessionId);
      set({ biometricSession: sessionId, isAuthenticating: false });
    } catch (error) {
      set({ error: (error as Error).message, isAuthenticating: false });
      throw error;
    }
  },

  processPayment: async (data) => {
    set({ isProcessing: true, error: null });
    try {
      const result = await api.processPayment(data);
      set({ isProcessing: false });
      return result;
    } catch (error) {
      set({ error: (error as Error).message, isProcessing: false });
      throw error;
    }
  },

  clearBiometricSession: () => {
    sessionStorage.removeItem('biometricSession');
    set({ biometricSession: null });
  },
}));
