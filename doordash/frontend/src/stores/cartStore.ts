import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CartItem, MenuItem, Restaurant, DeliveryAddress } from '../types';

interface CartState {
  restaurant: Restaurant | null;
  items: CartItem[];
  deliveryAddress: DeliveryAddress | null;
  tip: number;

  setRestaurant: (restaurant: Restaurant) => void;
  addItem: (menuItem: MenuItem, quantity?: number, specialInstructions?: string) => void;
  removeItem: (menuItemId: number) => void;
  updateQuantity: (menuItemId: number, quantity: number) => void;
  setDeliveryAddress: (address: DeliveryAddress) => void;
  setTip: (tip: number) => void;
  clearCart: () => void;

  // Computed
  subtotal: () => number;
  itemCount: () => number;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      restaurant: null,
      items: [],
      deliveryAddress: null,
      tip: 0,

      setRestaurant: (restaurant) => {
        const current = get().restaurant;
        // Clear cart if switching restaurants
        if (current && current.id !== restaurant.id) {
          set({ restaurant, items: [], tip: 0 });
        } else {
          set({ restaurant });
        }
      },

      addItem: (menuItem, quantity = 1, specialInstructions) => {
        const items = get().items;
        const existingIndex = items.findIndex((i) => i.menuItem.id === menuItem.id);

        if (existingIndex >= 0) {
          const newItems = [...items];
          newItems[existingIndex] = {
            ...newItems[existingIndex],
            quantity: newItems[existingIndex].quantity + quantity,
            specialInstructions: specialInstructions || newItems[existingIndex].specialInstructions,
          };
          set({ items: newItems });
        } else {
          set({
            items: [...items, { menuItem, quantity, specialInstructions }],
          });
        }
      },

      removeItem: (menuItemId) => {
        set({ items: get().items.filter((i) => i.menuItem.id !== menuItemId) });
      },

      updateQuantity: (menuItemId, quantity) => {
        if (quantity <= 0) {
          get().removeItem(menuItemId);
          return;
        }
        const items = get().items.map((i) =>
          i.menuItem.id === menuItemId ? { ...i, quantity } : i
        );
        set({ items });
      },

      setDeliveryAddress: (address) => set({ deliveryAddress: address }),

      setTip: (tip) => set({ tip }),

      clearCart: () =>
        set({
          restaurant: null,
          items: [],
          deliveryAddress: null,
          tip: 0,
        }),

      subtotal: () => {
        return get().items.reduce((sum, item) => sum + item.menuItem.price * item.quantity, 0);
      },

      itemCount: () => {
        return get().items.reduce((sum, item) => sum + item.quantity, 0);
      },
    }),
    {
      name: 'cart-storage',
    }
  )
);
