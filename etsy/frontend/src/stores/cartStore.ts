import { create } from 'zustand';
import api from '../services/api';
import type { Cart } from '../types';

interface CartState {
  cart: Cart | null;
  isLoading: boolean;
  fetchCart: () => Promise<void>;
  addToCart: (productId: number, quantity?: number) => Promise<void>;
  updateQuantity: (itemId: number, quantity: number) => Promise<void>;
  removeItem: (itemId: number) => Promise<void>;
  clearCart: () => Promise<void>;
}

export const useCartStore = create<CartState>((set, get) => ({
  cart: null,
  isLoading: false,

  fetchCart: async () => {
    set({ isLoading: true });
    try {
      const cart = await api.get<Cart>('/cart');
      set({ cart, isLoading: false });
    } catch {
      set({ cart: null, isLoading: false });
    }
  },

  addToCart: async (productId, quantity = 1) => {
    await api.post('/cart/items', { productId, quantity });
    await get().fetchCart();
  },

  updateQuantity: async (itemId, quantity) => {
    await api.put(`/cart/items/${itemId}`, { quantity });
    await get().fetchCart();
  },

  removeItem: async (itemId) => {
    await api.delete(`/cart/items/${itemId}`);
    await get().fetchCart();
  },

  clearCart: async () => {
    await api.delete('/cart');
    set({ cart: null });
  },
}));
