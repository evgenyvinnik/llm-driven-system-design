/**
 * Portfolio, orders, watchlists, and alerts state management using Zustand.
 * Centralizes all trading-related data and provides actions
 * for placing orders, managing watchlists, and setting price alerts.
 */

import { create } from 'zustand';
import type { Portfolio, Order, Watchlist, PriceAlert } from '../types';
import { portfolioApi, ordersApi, watchlistsApi } from '../services/api';

/**
 * Portfolio store state and actions.
 */
interface PortfolioState {
  /** User's portfolio with holdings and P&L metrics */
  portfolio: Portfolio | null;
  /** User's order history */
  orders: Order[];
  /** User's watchlists with items */
  watchlists: Watchlist[];
  /** User's price alerts */
  alerts: PriceAlert[];
  /** Whether an operation is in progress */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;

  /** Fetches portfolio summary from API */
  fetchPortfolio: () => Promise<void>;

  /** Fetches orders, optionally filtered by status */
  fetchOrders: (status?: string) => Promise<void>;
  /** Places a new order and refreshes portfolio/orders */
  placeOrder: (data: {
    symbol: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
    quantity: number;
    limitPrice?: number;
    stopPrice?: number;
  }) => Promise<Order>;
  /** Cancels an order and refreshes portfolio/orders */
  cancelOrder: (orderId: string) => Promise<void>;

  /** Fetches all watchlists with items */
  fetchWatchlists: () => Promise<void>;
  /** Creates a new watchlist */
  createWatchlist: (name: string) => Promise<Watchlist>;
  /** Deletes a watchlist */
  deleteWatchlist: (watchlistId: string) => Promise<void>;
  /** Adds a symbol to a watchlist */
  addToWatchlist: (watchlistId: string, symbol: string) => Promise<void>;
  /** Removes a symbol from a watchlist */
  removeFromWatchlist: (watchlistId: string, symbol: string) => Promise<void>;

  /** Fetches all price alerts */
  fetchAlerts: () => Promise<void>;
  /** Creates a new price alert */
  createAlert: (symbol: string, targetPrice: number, condition: 'above' | 'below') => Promise<PriceAlert>;
  /** Deletes a price alert */
  deleteAlert: (alertId: string) => Promise<void>;

  /** Clears any stored error message */
  clearError: () => void;
}

/**
 * Zustand store for portfolio, orders, watchlists, and alerts.
 * Provides actions for trading operations and data fetching.
 */
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
