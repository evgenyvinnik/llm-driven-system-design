/**
 * Real-time stock quote state management using Zustand.
 * Manages WebSocket connection for live quote updates and
 * provides quote data to components throughout the app.
 */

import { create } from 'zustand';
import type { Quote } from '../types';
import { wsService } from '../services/websocket';
import { quotesApi } from '../services/api';

/**
 * Quote store state and actions.
 */
interface QuoteState {
  /** Map of symbol to current quote data */
  quotes: Map<string, Quote>;
  /** Whether WebSocket is currently connected */
  isConnected: boolean;
  /** Whether a quote fetch is in progress */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;
  /** Gets cached quote for a symbol */
  getQuote: (symbol: string) => Quote | undefined;
  /** Subscribes to real-time updates for symbols */
  subscribe: (symbols: string[]) => void;
  /** Unsubscribes from real-time updates for symbols */
  unsubscribe: (symbols: string[]) => void;
  /** Fetches quote from API and caches it */
  fetchQuote: (symbol: string) => Promise<Quote | null>;
  /** Initializes WebSocket connection */
  initializeConnection: () => void;
  /** Disconnects WebSocket */
  disconnect: () => void;
}

/**
 * Zustand store for real-time quote data.
 * Connects to WebSocket on initialization and updates
 * quotes map as new data arrives.
 */
export const useQuoteStore = create<QuoteState>((set, get) => {
  let initialized = false;

  return {
    quotes: new Map(),
    isConnected: false,
    isLoading: false,
    error: null,

    getQuote: (symbol: string) => {
      return get().quotes.get(symbol.toUpperCase());
    },

    subscribe: (symbols: string[]) => {
      wsService.subscribe(symbols);
    },

    unsubscribe: (symbols: string[]) => {
      wsService.unsubscribe(symbols);
    },

    fetchQuote: async (symbol: string) => {
      try {
        const quote = await quotesApi.getQuote(symbol);
        set((state) => {
          const newQuotes = new Map(state.quotes);
          newQuotes.set(symbol.toUpperCase(), quote);
          return { quotes: newQuotes };
        });
        return quote;
      } catch (error) {
        console.error('Error fetching quote:', error);
        return null;
      }
    },

    initializeConnection: () => {
      if (initialized) return;
      initialized = true;

      // Handle incoming quotes
      wsService.onMessage((quotes: Quote[]) => {
        set((state) => {
          const newQuotes = new Map(state.quotes);
          quotes.forEach((quote) => {
            newQuotes.set(quote.symbol, quote);
          });
          return { quotes: newQuotes };
        });
      });

      // Handle connection state
      wsService.onConnectionChange((connected: boolean) => {
        set({ isConnected: connected });
      });

      // Connect
      wsService.connect();
    },

    disconnect: () => {
      wsService.disconnect();
      set({ isConnected: false });
    },
  };
});
