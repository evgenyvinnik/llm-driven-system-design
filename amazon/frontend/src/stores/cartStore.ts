import { create } from 'zustand';
import type { Cart, CartItem } from '../types';
import { api } from '../services/api';

interface CartState {
  items: CartItem[];
  subtotal: string;
  itemCount: number;
  isLoading: boolean;
  error: string | null;
  fetchCart: () => Promise<void>;
  addToCart: (productId: number, quantity?: number) => Promise<void>;
  updateQuantity: (productId: number, quantity: number) => Promise<void>;
  removeItem: (productId: number) => Promise<void>;
  clearCart: () => Promise<void>;
}

export const useCartStore = create<CartState>((set) => ({
  items: [],
  subtotal: '0.00',
  itemCount: 0,
  isLoading: false,
  error: null,

  fetchCart: async () => {
    set({ isLoading: true, error: null });
    try {
      const cart = await api.getCart();
      set({
        items: cart.items,
        subtotal: cart.subtotal,
        itemCount: cart.itemCount,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  addToCart: async (productId: number, quantity = 1) => {
    set({ isLoading: true, error: null });
    try {
      const cart = await api.addToCart(productId, quantity);
      set({
        items: cart.items,
        subtotal: cart.subtotal,
        itemCount: cart.itemCount,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
      throw error;
    }
  },

  updateQuantity: async (productId: number, quantity: number) => {
    set({ isLoading: true, error: null });
    try {
      const cart = await api.updateCartItem(productId, quantity);
      set({
        items: cart.items,
        subtotal: cart.subtotal,
        itemCount: cart.itemCount,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
      throw error;
    }
  },

  removeItem: async (productId: number) => {
    set({ isLoading: true, error: null });
    try {
      const cart = await api.removeFromCart(productId);
      set({
        items: cart.items,
        subtotal: cart.subtotal,
        itemCount: cart.itemCount,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
      throw error;
    }
  },

  clearCart: async () => {
    set({ isLoading: true, error: null });
    try {
      const cart = await api.clearCart();
      set({
        items: cart.items,
        subtotal: cart.subtotal,
        itemCount: cart.itemCount,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
      throw error;
    }
  },
}));
