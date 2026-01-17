import { create } from 'zustand';
import type { Portfolio, Order, Watchlist, PriceAlert } from '../types';
import { portfolioApi, ordersApi, watchlistsApi } from '../services/api';

interface PortfolioState {
  portfolio: Portfolio | null;
  orders: Order[];
  watchlists: Watchlist[];
  alerts: PriceAlert[];
  isLoading: boolean;
  error: string | null;

  // Portfolio actions
  fetchPortfolio: () => Promise<void>;

  // Order actions
  fetchOrders: (status?: string) => Promise<void>;
  placeOrder: (data: {
    symbol: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
    quantity: number;
    limitPrice?: number;
    stopPrice?: number;
  }) => Promise<Order>;
  cancelOrder: (orderId: string) => Promise<void>;

  // Watchlist actions
  fetchWatchlists: () => Promise<void>;
  createWatchlist: (name: string) => Promise<Watchlist>;
  deleteWatchlist: (watchlistId: string) => Promise<void>;
  addToWatchlist: (watchlistId: string, symbol: string) => Promise<void>;
  removeFromWatchlist: (watchlistId: string, symbol: string) => Promise<void>;

  // Alert actions
  fetchAlerts: () => Promise<void>;
  createAlert: (symbol: string, targetPrice: number, condition: 'above' | 'below') => Promise<PriceAlert>;
  deleteAlert: (alertId: string) => Promise<void>;

  clearError: () => void;
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  portfolio: null,
  orders: [],
  watchlists: [],
  alerts: [],
  isLoading: false,
  error: null,

  fetchPortfolio: async () => {
    set({ isLoading: true, error: null });
    try {
      const portfolio = await portfolioApi.getPortfolio();
      set({ portfolio, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  fetchOrders: async (status?: string) => {
    try {
      const orders = await ordersApi.getOrders(status);
      set({ orders });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  placeOrder: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const result = await ordersApi.placeOrder(data);
      // Refresh portfolio and orders after placing order
      await Promise.all([
        get().fetchPortfolio(),
        get().fetchOrders(),
      ]);
      set({ isLoading: false });
      return result.order;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  cancelOrder: async (orderId: string) => {
    try {
      await ordersApi.cancelOrder(orderId);
      await Promise.all([
        get().fetchPortfolio(),
        get().fetchOrders(),
      ]);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  fetchWatchlists: async () => {
    try {
      const watchlists = await watchlistsApi.getWatchlists();
      set({ watchlists });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  createWatchlist: async (name: string) => {
    const watchlist = await watchlistsApi.createWatchlist(name);
    set((state) => ({ watchlists: [...state.watchlists, { ...watchlist, items: [] }] }));
    return watchlist;
  },

  deleteWatchlist: async (watchlistId: string) => {
    await watchlistsApi.deleteWatchlist(watchlistId);
    set((state) => ({
      watchlists: state.watchlists.filter((w) => w.id !== watchlistId),
    }));
  },

  addToWatchlist: async (watchlistId: string, symbol: string) => {
    const item = await watchlistsApi.addToWatchlist(watchlistId, symbol);
    set((state) => ({
      watchlists: state.watchlists.map((w) =>
        w.id === watchlistId
          ? { ...w, items: [...w.items, item] }
          : w
      ),
    }));
  },

  removeFromWatchlist: async (watchlistId: string, symbol: string) => {
    await watchlistsApi.removeFromWatchlist(watchlistId, symbol);
    set((state) => ({
      watchlists: state.watchlists.map((w) =>
        w.id === watchlistId
          ? { ...w, items: w.items.filter((i) => i.symbol !== symbol.toUpperCase()) }
          : w
      ),
    }));
  },

  fetchAlerts: async () => {
    try {
      const alerts = await watchlistsApi.getAlerts();
      set({ alerts });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  createAlert: async (symbol: string, targetPrice: number, condition: 'above' | 'below') => {
    const alert = await watchlistsApi.createAlert(symbol, targetPrice, condition);
    set((state) => ({ alerts: [...state.alerts, alert] }));
    return alert;
  },

  deleteAlert: async (alertId: string) => {
    await watchlistsApi.deleteAlert(alertId);
    set((state) => ({
      alerts: state.alerts.filter((a) => a.id !== alertId),
    }));
  },

  clearError: () => set({ error: null }),
}));
