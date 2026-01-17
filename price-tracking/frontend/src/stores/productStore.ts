/**
 * Zustand store for product tracking state management.
 * Handles CRUD operations for tracked products.
 * @module stores/productStore
 */
import { create } from 'zustand';
import { Product } from '../types';
import * as productService from '../services/products';

/**
 * Product state shape.
 */
interface ProductState {
  /** List of tracked products */
  products: Product[];
  /** True while loading products */
  isLoading: boolean;
  /** Error message if operation failed */
  error: string | null;
  /** Fetches all tracked products from API */
  fetchProducts: () => Promise<void>;
  /** Adds a new product to track */
  addProduct: (url: string, targetPrice?: number, notifyAnyDrop?: boolean) => Promise<Product>;
  /** Updates product tracking settings */
  updateProduct: (productId: string, updates: { target_price?: number | null; notify_any_drop?: boolean }) => Promise<void>;
  /** Removes a product from tracking */
  deleteProduct: (productId: string) => Promise<void>;
}

/**
 * Global product store.
 * Use with: const { products, fetchProducts, addProduct } = useProductStore();
 */
export const useProductStore = create<ProductState>((set, get) => ({
  products: [],
  isLoading: false,
  error: null,

  fetchProducts: async () => {
    set({ isLoading: true, error: null });
    try {
      const products = await productService.getProducts();
      set({ products, isLoading: false });
    } catch (err) {
      set({ error: 'Failed to fetch products', isLoading: false });
    }
  },

  addProduct: async (url: string, targetPrice?: number, notifyAnyDrop?: boolean) => {
    const product = await productService.addProduct(url, targetPrice, notifyAnyDrop);
    set((state) => ({ products: [product, ...state.products] }));
    return product;
  },

  updateProduct: async (productId: string, updates) => {
    await productService.updateProduct(productId, updates);
    set((state) => ({
      products: state.products.map((p) =>
        p.id === productId ? { ...p, ...updates } : p
      ),
    }));
  },

  deleteProduct: async (productId: string) => {
    await productService.deleteProduct(productId);
    set((state) => ({
      products: state.products.filter((p) => p.id !== productId),
    }));
  },
}));
