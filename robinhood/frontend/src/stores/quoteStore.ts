import { create } from 'zustand';
import type { Quote } from '../types';
import { wsService } from '../services/websocket';
import { quotesApi } from '../services/api';

interface QuoteState {
  quotes: Map<string, Quote>;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  getQuote: (symbol: string) => Quote | undefined;
  subscribe: (symbols: string[]) => void;
  unsubscribe: (symbols: string[]) => void;
  fetchQuote: (symbol: string) => Promise<Quote | null>;
  initializeConnection: () => void;
  disconnect: () => void;
}

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
