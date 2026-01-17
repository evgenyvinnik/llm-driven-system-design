import { redis } from '../redis.js';
import type { Quote } from '../types/index.js';

// Mock stock data for simulation
const STOCKS: Record<string, { name: string; basePrice: number; volatility: number }> = {
  AAPL: { name: 'Apple Inc.', basePrice: 178.50, volatility: 0.015 },
  GOOGL: { name: 'Alphabet Inc.', basePrice: 141.80, volatility: 0.018 },
  MSFT: { name: 'Microsoft Corporation', basePrice: 378.90, volatility: 0.012 },
  AMZN: { name: 'Amazon.com Inc.', basePrice: 178.25, volatility: 0.020 },
  TSLA: { name: 'Tesla Inc.', basePrice: 248.50, volatility: 0.035 },
  META: { name: 'Meta Platforms Inc.', basePrice: 505.75, volatility: 0.022 },
  NVDA: { name: 'NVIDIA Corporation', basePrice: 495.22, volatility: 0.030 },
  JPM: { name: 'JPMorgan Chase & Co.', basePrice: 195.40, volatility: 0.010 },
  V: { name: 'Visa Inc.', basePrice: 275.30, volatility: 0.008 },
  JNJ: { name: 'Johnson & Johnson', basePrice: 156.80, volatility: 0.006 },
  WMT: { name: 'Walmart Inc.', basePrice: 165.45, volatility: 0.007 },
  PG: { name: 'Procter & Gamble Co.', basePrice: 158.90, volatility: 0.005 },
  UNH: { name: 'UnitedHealth Group Inc.', basePrice: 528.15, volatility: 0.012 },
  HD: { name: 'The Home Depot Inc.', basePrice: 345.60, volatility: 0.011 },
  BAC: { name: 'Bank of America Corp.', basePrice: 33.75, volatility: 0.014 },
  XOM: { name: 'Exxon Mobil Corporation', basePrice: 104.20, volatility: 0.016 },
  DIS: { name: 'The Walt Disney Company', basePrice: 112.45, volatility: 0.018 },
  NFLX: { name: 'Netflix Inc.', basePrice: 485.30, volatility: 0.025 },
  INTC: { name: 'Intel Corporation', basePrice: 43.80, volatility: 0.020 },
  AMD: { name: 'Advanced Micro Devices', basePrice: 147.65, volatility: 0.028 },
};

// Store current simulated prices
const currentPrices: Map<string, Quote> = new Map();

// Initialize prices
function initializePrices(): void {
  const now = Date.now();
  for (const [symbol, data] of Object.entries(STOCKS)) {
    const spread = data.basePrice * 0.001;
    const quote: Quote = {
      symbol,
      bid: data.basePrice - spread / 2,
      ask: data.basePrice + spread / 2,
      last: data.basePrice,
      open: data.basePrice * (1 + (Math.random() - 0.5) * 0.02),
      high: data.basePrice * (1 + Math.random() * 0.03),
      low: data.basePrice * (1 - Math.random() * 0.03),
      volume: Math.floor(Math.random() * 10000000) + 1000000,
      change: 0,
      changePercent: 0,
      timestamp: now,
    };
    quote.change = quote.last - quote.open;
    quote.changePercent = (quote.change / quote.open) * 100;
    currentPrices.set(symbol, quote);
  }
}

// Simulate price movement
function simulatePriceMovement(quote: Quote, volatility: number): Quote {
  const now = Date.now();
  const change = (Math.random() - 0.5) * 2 * volatility * quote.last;
  const newLast = Math.max(0.01, quote.last + change);
  const spread = newLast * 0.001;

  return {
    ...quote,
    bid: newLast - spread / 2,
    ask: newLast + spread / 2,
    last: newLast,
    high: Math.max(quote.high, newLast),
    low: Math.min(quote.low, newLast),
    volume: quote.volume + Math.floor(Math.random() * 10000),
    change: newLast - quote.open,
    changePercent: ((newLast - quote.open) / quote.open) * 100,
    timestamp: now,
  };
}

export class QuoteService {
  private updateInterval: NodeJS.Timeout | null = null;
  private subscribers: Map<string, Set<(quotes: Quote[]) => void>> = new Map();

  constructor() {
    initializePrices();
  }

  start(intervalMs: number = 1000): void {
    if (this.updateInterval) return;

    this.updateInterval = setInterval(async () => {
      const updatedQuotes: Quote[] = [];

      for (const [symbol, quote] of currentPrices.entries()) {
        const stock = STOCKS[symbol];
        if (stock) {
          const newQuote = simulatePriceMovement(quote, stock.volatility);
          currentPrices.set(symbol, newQuote);
          updatedQuotes.push(newQuote);

          // Store in Redis
          await redis.hset(
            `quote:${symbol}`,
            'data',
            JSON.stringify(newQuote)
          );
        }
      }

      // Notify all subscribers
      this.notifySubscribers(updatedQuotes);

      // Publish to Redis pub/sub for other processes
      await redis.publish('quote_updates', JSON.stringify(updatedQuotes));
    }, intervalMs);

    console.log(`Quote service started with ${intervalMs}ms interval`);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  getQuote(symbol: string): Quote | null {
    return currentPrices.get(symbol.toUpperCase()) || null;
  }

  getQuotes(symbols: string[]): Quote[] {
    return symbols
      .map((s) => currentPrices.get(s.toUpperCase()))
      .filter((q): q is Quote => q !== null);
  }

  getAllQuotes(): Quote[] {
    return Array.from(currentPrices.values());
  }

  getAllSymbols(): string[] {
    return Object.keys(STOCKS);
  }

  getStockInfo(symbol: string): { name: string; symbol: string } | null {
    const stock = STOCKS[symbol.toUpperCase()];
    if (!stock) return null;
    return { name: stock.name, symbol: symbol.toUpperCase() };
  }

  getAllStocks(): Array<{ name: string; symbol: string }> {
    return Object.entries(STOCKS).map(([symbol, data]) => ({
      symbol,
      name: data.name,
    }));
  }

  subscribe(id: string, callback: (quotes: Quote[]) => void): void {
    if (!this.subscribers.has(id)) {
      this.subscribers.set(id, new Set());
    }
    this.subscribers.get(id)!.add(callback);
  }

  unsubscribe(id: string, callback?: (quotes: Quote[]) => void): void {
    if (callback) {
      this.subscribers.get(id)?.delete(callback);
    } else {
      this.subscribers.delete(id);
    }
  }

  private notifySubscribers(quotes: Quote[]): void {
    for (const callbacks of this.subscribers.values()) {
      for (const callback of callbacks) {
        try {
          callback(quotes);
        } catch (error) {
          console.error('Error notifying subscriber:', error);
        }
      }
    }
  }
}

export const quoteService = new QuoteService();
