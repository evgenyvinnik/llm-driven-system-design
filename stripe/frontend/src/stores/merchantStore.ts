import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MerchantState {
  apiKey: string | null;
  merchantId: string | null;
  merchantName: string | null;
  setCredentials: (apiKey: string, merchantId: string, merchantName: string) => void;
  clearCredentials: () => void;
}

export const useMerchantStore = create<MerchantState>()(
  persist(
    (set) => ({
      apiKey: null,
      merchantId: null,
      merchantName: null,

      setCredentials: (apiKey, merchantId, merchantName) =>
        set({ apiKey, merchantId, merchantName }),

      clearCredentials: () =>
        set({ apiKey: null, merchantId: null, merchantName: null }),
    }),
    {
      name: 'stripe-merchant-storage',
    }
  )
);
