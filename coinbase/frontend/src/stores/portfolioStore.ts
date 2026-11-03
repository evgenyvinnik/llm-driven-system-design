import { create } from 'zustand';
import { portfolioApi, ordersApi, walletsApi } from '../services/api';
import type { Order, PortfolioHolding } from '../types';

/** Portfolio state with holdings, orders, wallet balances, and trading actions. */
interface PortfolioState {
  totalValueUsd: string;
  holdings: PortfolioHolding[];
  orders: Order[];
  wallets: { currencyId: string; balance: string; reservedBalance: string; available: string; valueUsd: string }[];
  isLoading: boolean;
  error: string | null;

  fetchPortfolio: () => Promise<void>;
  fetchOrders: (status?: string) => Promise<void>;
  fetchWallets: () => Promise<void>;
  placeOrder: (data: {
    tradingPairId: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit' | 'stop';
    quantity: string;
    price?: string;
    stopPrice?: string;
  }) => Promise<{ id: string; status: string; filledQuantity: string; avgFillPrice: string | null }>;
  cancelOrder: (orderId: string) => Promise<void>;
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  totalValueUsd: '0',
  holdings: [],
  orders: [],
  wallets: [],
  isLoading: false,
  error: null,

  fetchPortfolio: async () => {
    set({ isLoading: true });
    try {
      const data = await portfolioApi.getPortfolio();
      set({
        totalValueUsd: data.totalValueUsd,
        holdings: data.holdings,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch portfolio',
        isLoading: false,
      });
    }
  },

  fetchOrders: async (status) => {
    try {
      const { orders } = await ordersApi.getOrders(status);
      set({ orders: orders as Order[] });
    } catch (error) {
      console.error('Failed to fetch orders:', error);
    }
  },

  fetchWallets: async () => {
    try {
      const { wallets } = await walletsApi.getWallets();
      set({
        wallets: wallets.map((w) => ({
          currencyId: w.currencyId,
          balance: String(w.balance),
          reservedBalance: String(w.reservedBalance),
          available: String(w.available),
          valueUsd: String(w.valueUsd),
        })),
      });
    } catch (error) {
      console.error('Failed to fetch wallets:', error);
    }
  },

  placeOrder: async (data) => {
    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { order } = await ordersApi.placeOrder({ ...data, idempotencyKey });

    // Refresh orders
    get().fetchOrders();
    get().fetchWallets();

    return order;
  },

  cancelOrder: async (orderId) => {
    await ordersApi.cancelOrder(orderId);
    get().fetchOrders();
    get().fetchWallets();
  },
}));
