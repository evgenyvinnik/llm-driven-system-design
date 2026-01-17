import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Authentication state interface.
 * Stores API key and merchant identity for authenticated sessions.
 */
interface AuthState {
  /** Merchant's API key for authenticating with the backend */
  apiKey: string | null;
  /** Unique identifier of the authenticated merchant */
  merchantId: string | null;
  /** Display name of the authenticated merchant */
  merchantName: string | null;
  /** Whether the user is currently authenticated */
  isAuthenticated: boolean;
  /** Updates the API key and sets authenticated state */
  setApiKey: (apiKey: string) => void;
  /** Stores merchant identity after successful authentication */
  setMerchant: (id: string, name: string) => void;
  /** Clears all authentication state */
  logout: () => void;
}

/**
 * Zustand store for managing authentication state.
 * Persisted to localStorage under key 'payment-auth'.
 * Used throughout the app to access the current merchant's credentials.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      apiKey: null,
      merchantId: null,
      merchantName: null,
      isAuthenticated: false,
      setApiKey: (apiKey: string) =>
        set({ apiKey, isAuthenticated: true }),
      setMerchant: (id: string, name: string) =>
        set({ merchantId: id, merchantName: name }),
      logout: () =>
        set({
          apiKey: null,
          merchantId: null,
          merchantName: null,
          isAuthenticated: false,
        }),
    }),
    {
      name: 'payment-auth',
    }
  )
);
