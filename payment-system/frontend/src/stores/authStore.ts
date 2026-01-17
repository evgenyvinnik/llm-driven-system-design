import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  apiKey: string | null;
  merchantId: string | null;
  merchantName: string | null;
  isAuthenticated: boolean;
  setApiKey: (apiKey: string) => void;
  setMerchant: (id: string, name: string) => void;
  logout: () => void;
}

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
