import { create } from 'zustand';
import type { CartItem, MenuItem, Merchant } from '@/types';

interface CartState {
  items: CartItem[];
  merchant: Merchant | null;

  addItem: (item: MenuItem, quantity?: number, specialInstructions?: string) => void;
  removeItem: (menuItemId: string) => void;
  updateQuantity: (menuItemId: string, quantity: number) => void;
  updateInstructions: (menuItemId: string, instructions: string) => void;
  setMerchant: (merchant: Merchant) => void;
  clearCart: () => void;
  getSubtotal: () => number;
  getItemCount: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  merchant: null,

  addItem: (menuItem, quantity = 1, specialInstructions) => {
    const { items, merchant } = get();

    // Check if adding from a different merchant
    if (merchant && merchant.id !== menuItem.merchant_id) {
      // Clear cart if switching merchants
      set({
        items: [{ menuItem, quantity, specialInstructions }],
        merchant: null, // Will be set separately
      });
      return;
    }

    const existingIndex = items.findIndex(
      (item) => item.menuItem.id === menuItem.id
    );

    if (existingIndex >= 0) {
      const newItems = [...items];
      newItems[existingIndex] = {
        ...newItems[existingIndex],
        quantity: newItems[existingIndex].quantity + quantity,
      };
      set({ items: newItems });
    } else {
      set({ items: [...items, { menuItem, quantity, specialInstructions }] });
    }
  },

  removeItem: (menuItemId) => {
    const { items } = get();
    const newItems = items.filter((item) => item.menuItem.id !== menuItemId);
    set({
      items: newItems,
      merchant: newItems.length === 0 ? null : get().merchant,
    });
  },

  updateQuantity: (menuItemId, quantity) => {
    if (quantity <= 0) {
      get().removeItem(menuItemId);
      return;
    }

    const { items } = get();
    const newItems = items.map((item) =>
      item.menuItem.id === menuItemId ? { ...item, quantity } : item
    );
    set({ items: newItems });
  },

  updateInstructions: (menuItemId, instructions) => {
    const { items } = get();
    const newItems = items.map((item) =>
      item.menuItem.id === menuItemId
        ? { ...item, specialInstructions: instructions }
        : item
    );
    set({ items: newItems });
  },

  setMerchant: (merchant) => set({ merchant }),

  clearCart: () => set({ items: [], merchant: null }),

  getSubtotal: () => {
    return get().items.reduce(
      (total, item) => total + item.menuItem.price * item.quantity,
      0
    );
  },

  getItemCount: () => {
    return get().items.reduce((count, item) => count + item.quantity, 0);
  },
}));
