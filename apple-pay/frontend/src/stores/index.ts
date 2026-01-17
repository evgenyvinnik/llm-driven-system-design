/**
 * Zustand stores for the Apple Pay frontend application.
 * Provides state management for authentication, wallet, transactions, and payments.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api from '../services/api';
import type { User, Device, Card, Transaction } from '../types';

/**
 * Authentication store state interface.
 * Manages user session, devices, and authentication operations.
 */
interface AuthState {
  /** Currently authenticated user or null if not logged in */
  user: User | null;
  /** Session ID for API authentication */
  sessionId: string | null;
  /** List of user's registered devices */
  devices: Device[];
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message from last operation or null */
  error: string | null;
  /** Authenticates user with email and password */
  login: (email: string, password: string, deviceId?: string) => Promise<void>;
  /** Creates a new user account */
  register: (email: string, password: string, name: string) => Promise<void>;
  /** Logs out the current user */
  logout: () => Promise<void>;
  /** Loads user from stored session */
  loadUser: () => Promise<void>;
  /** Fetches user's registered devices */
  loadDevices: () => Promise<void>;
  /** Registers a new device for the user */
  registerDevice: (name: string, type: string) => Promise<Device>;
}

/**
 * Zustand store for authentication state.
 * Persists session ID to localStorage for session recovery.
 */
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

/**
 * Wallet store state interface.
 * Manages payment cards and card operations.
 */
interface WalletState {
  /** List of user's provisioned cards */
  cards: Card[];
  /** Currently selected card for payment */
  selectedCard: Card | null;
  /** Whether a wallet operation is in progress */
  isLoading: boolean;
  /** Error message from last operation or null */
  error: string | null;
  /** Fetches all cards for the user */
  loadCards: () => Promise<void>;
  /** Provisions a new card to a device */
  addCard: (data: {
    pan: string;
    expiry_month: number;
    expiry_year: number;
    cvv: string;
    card_holder_name: string;
    device_id: string;
  }) => Promise<Card>;
  /** Temporarily suspends a card */
  suspendCard: (cardId: string, reason?: string) => Promise<void>;
  /** Reactivates a suspended card */
  reactivateCard: (cardId: string) => Promise<void>;
  /** Permanently removes a card */
  removeCard: (cardId: string) => Promise<void>;
  /** Sets a card as the default payment method */
  setDefaultCard: (cardId: string) => Promise<void>;
  /** Selects a card for payment */
  selectCard: (card: Card | null) => void;
}

/**
 * Zustand store for wallet/card state.
 * Manages card provisioning, suspension, and selection.
 */
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

/**
 * Transaction store state interface.
 * Manages transaction history with pagination support.
 */
interface TransactionState {
  /** List of loaded transactions */
  transactions: Transaction[];
  /** Total count of transactions (for pagination) */
  total: number;
  /** Whether transactions are being fetched */
  isLoading: boolean;
  /** Error message from last operation or null */
  error: string | null;
  /** Fetches transactions with optional filtering */
  loadTransactions: (options?: {
    limit?: number;
    offset?: number;
    card_id?: string;
    status?: string;
  }) => Promise<void>;
}

/**
 * Zustand store for transaction history.
 * Supports pagination and filtering by card/status.
 */
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

/**
 * Payment store state interface.
 * Manages biometric authentication and payment processing.
 */
interface PaymentState {
  /** Current biometric session ID or null */
  biometricSession: string | null;
  /** Whether biometric auth is in progress */
  isAuthenticating: boolean;
  /** Whether payment is being processed */
  isProcessing: boolean;
  /** Error message from last operation or null */
  error: string | null;
  /** Initiates a biometric authentication session */
  initiateBiometric: (deviceId: string, authType: string) => Promise<string>;
  /** Simulates successful biometric auth (demo only) */
  simulateBiometric: (sessionId: string) => Promise<void>;
  /** Processes a payment transaction */
  processPayment: (data: {
    card_id: string;
    amount: number;
    currency: string;
    merchant_id: string;
    transaction_type: string;
  }) => Promise<{ success: boolean; transaction_id?: string; auth_code?: string; error?: string }>;
  /** Clears the current biometric session */
  clearBiometricSession: () => void;
}

/**
 * Zustand store for payment operations.
 * Handles biometric authentication flow and payment processing.
 */
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
