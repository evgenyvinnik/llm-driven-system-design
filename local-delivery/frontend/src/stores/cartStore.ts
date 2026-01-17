/**
 * Shopping cart state management for the delivery platform.
 * Manages cart items, merchant association, and price calculations.
 * Enforces single-merchant cart (items from different merchants clear the cart).
 *
 * @module stores/cartStore
 */
import { create } from 'zustand';
import type { CartItem, MenuItem, Merchant } from '@/types';

/**
 * Cart store state and actions.
 */
interface CartState {
  /** Array of items in the cart */
  items: CartItem[];
  /** Merchant the cart items belong to, null if cart is empty */
  merchant: Merchant | null;

  /**
   * Adds an item to the cart or increments quantity if already present.
   * Clears cart if adding from a different merchant.
   *
   * @param item - Menu item to add
   * @param quantity - Number to add (default 1)
   * @param specialInstructions - Optional preparation notes
   */
  addItem: (item: MenuItem, quantity?: number, specialInstructions?: string) => void;

  /**
   * Removes an item from the cart entirely.
   *
   * @param menuItemId - ID of menu item to remove
   */
  removeItem: (menuItemId: string) => void;

  /**
   * Updates the quantity of an item in the cart.
   * Removes item if quantity is 0 or less.
   *
   * @param menuItemId - ID of menu item to update
   * @param quantity - New quantity value
   */
  updateQuantity: (menuItemId: string, quantity: number) => void;

  /**
   * Updates special instructions for an item.
   *
   * @param menuItemId - ID of menu item to update
   * @param instructions - New preparation instructions
   */
  updateInstructions: (menuItemId: string, instructions: string) => void;

  /**
   * Associates the cart with a merchant.
   *
   * @param merchant - Merchant to associate
   */
  setMerchant: (merchant: Merchant) => void;

  /**
   * Clears all items and merchant association from the cart.
   */
  clearCart: () => void;

  /**
   * Calculates the total price of all items (excluding delivery fee).
   *
   * @returns Subtotal in dollars
   */
  getSubtotal: () => number;

  /**
   * Gets the total number of items in the cart.
   *
   * @returns Sum of all item quantities
   */
  getItemCount: () => number;
}

/**
 * Zustand store for shopping cart state.
 * Cart is not persisted (resets on page reload).
 */
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
