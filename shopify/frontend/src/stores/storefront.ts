import { create } from 'zustand';
import { Store, Product, Cart, CartLineItem } from '../types';
import { storefrontApi } from '../services/api';

interface StorefrontState {
  store: Store | null;
  products: Product[];
  cart: Cart | null;
  isLoading: boolean;
  error: string | null;
  subdomain: string;
  setSubdomain: (subdomain: string) => void;
  fetchStore: (subdomain: string) => Promise<void>;
  fetchProducts: (subdomain: string) => Promise<void>;
  fetchCart: (subdomain: string) => Promise<void>;
  addToCart: (variantId: number, quantity: number) => Promise<void>;
  updateCartItem: (variantId: number, quantity: number) => Promise<void>;
  getCartItemCount: () => number;
}

export const useStorefrontStore = create<StorefrontState>((set, get) => ({
  store: null,
  products: [],
  cart: null,
  isLoading: false,
  error: null,
  subdomain: '',

  setSubdomain: (subdomain) => set({ subdomain }),

  fetchStore: async (subdomain) => {
    set({ isLoading: true, error: null });
    try {
      const { store } = await storefrontApi.getStore(subdomain);
      set({ store, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  fetchProducts: async (subdomain) => {
    set({ isLoading: true, error: null });
    try {
      const { products } = await storefrontApi.getProducts(subdomain);
      set({ products, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  fetchCart: async (subdomain) => {
    try {
      const { cart } = await storefrontApi.getCart(subdomain);
      set({ cart });
    } catch {
      // Cart might not exist, that's okay
      set({ cart: null });
    }
  },

  addToCart: async (variantId, quantity) => {
    const { subdomain } = get();
    if (!subdomain) return;

    try {
      const { cart } = await storefrontApi.addToCart(subdomain, variantId, quantity);
      set({ cart });
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  updateCartItem: async (variantId, quantity) => {
    const { subdomain } = get();
    if (!subdomain) return;

    try {
      const { cart } = await storefrontApi.updateCart(subdomain, variantId, quantity);
      set({ cart });
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  getCartItemCount: () => {
    const { cart } = get();
    if (!cart || !cart.line_items) return 0;
    return cart.line_items.reduce((sum: number, item: CartLineItem) => sum + item.quantity, 0);
  },
}));
