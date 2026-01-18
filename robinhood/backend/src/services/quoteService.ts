import { redis } from '../redis.js';
import type { Quote } from '../types/index.js';
import { logger } from '../shared/logger.js';
import { createCircuitBreaker, CircuitBreakerState, getCircuitBreakerState } from '../shared/circuitBreaker.js';
import { publishQuotes, isProducerConnected } from '../shared/kafka.js';
import CircuitBreaker from 'opossum';

/**
 * Mock stock data for price simulation.
 * Contains base prices and volatility factors for realistic market behavior.
 * In production, this would be replaced by real market data feeds.
 */
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

/** In-memory cache for current simulated stock prices */
const currentPrices: Map<string, Quote> = new Map();

/** Last known good quotes for fallback when circuit breaker is open */
let lastKnownQuotes: Map<string, Quote> = new Map();

/**
 * Initializes stock prices with realistic market data.
 * Sets up bid/ask spreads, open/high/low values, and volume.
 * Called once when the QuoteService is instantiated.
 */
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
  // Initialize last known quotes
  lastKnownQuotes = new Map(currentPrices);
}

/**
 * Simulates realistic price movement using random walk with volatility.
 * Updates bid/ask spread, tracks high/low, and accumulates volume.
 * @param quote - Current quote to update
 * @param volatility - Stock-specific volatility factor (0-1)
 * @returns New quote with updated prices
 */
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

/**
 * Simulated external market data fetch.
 * In production, this would call an external API like IEX Cloud, Alpha Vantage, etc.
 * Wrapped with circuit breaker for resilience.
 */
async function fetchMarketData(_symbol: string): Promise<Quote | null> {
  // Simulate external API call
  // In production, this would be:
  // const response = await axios.get(`https://api.marketdata.com/v1/quote/${symbol}`);
  // return response.data;

  // Simulate occasional failures for testing circuit breaker
  if (Math.random() < 0.001) {
    throw new Error('Market data provider timeout');
  }

  return null; // Using simulated data instead
}

/**
 * Publishes quotes to Redis.
 * Wrapped with circuit breaker to handle Redis outages.
 */
async function publishQuotesToRedis(quotes: Quote[]): Promise<void> {
  for (const quote of quotes) {
    await redis.hset(`quote:${quote.symbol}`, 'data', JSON.stringify(quote));
  }
  await redis.publish('quote_updates', JSON.stringify(quotes));
}

/**
 * Service for managing real-time stock quotes.
 * Simulates market data with configurable update intervals and
 * supports pub/sub for distributing quotes to WebSocket clients.
 *
 * Enhanced with:
 * - Circuit breaker for external market data calls
 * - Circuit breaker for Redis publishing
 * - Kafka publishing for distributed quote streaming
 * - Fallback to last known good quotes
 * - Structured logging
 *
 * In a production system, this would integrate with real market data providers.
 */
export class QuoteService {
  private updateInterval: NodeJS.Timeout | null = null;
  private subscribers: Map<string, Set<(quotes: Quote[]) => void>> = new Map();

  /** Circuit breaker for external market data API */
  private marketDataBreaker: CircuitBreaker<[string], Quote | null>;

  /** Circuit breaker for Redis operations */
  private redisBreaker: CircuitBreaker<[Quote[]], void>;

  /**
   * Creates a new QuoteService instance and initializes stock prices.
   */
  constructor() {
    initializePrices();

    // Create circuit breaker for market data fetching
    this.marketDataBreaker = createCircuitBreaker(fetchMarketData, {
      name: 'market-data',
      timeout: 5000, // 5 second timeout
      errorThresholdPercentage: 50,
      volumeThreshold: 10,
      resetTimeout: 30000, // 30 seconds before trying again
    });

    // Fallback: return last known quote when circuit is open
    this.marketDataBreaker.fallback((symbol: string) => {
      logger.warn({ symbol }, 'Using fallback quote data - market data circuit open');
      return lastKnownQuotes.get(symbol.toUpperCase()) || null;
    });

    // Create circuit breaker for Redis publishing
    this.redisBreaker = createCircuitBreaker(publishQuotesToRedis, {
      name: 'redis-publish',
      timeout: 3000, // 3 second timeout
      errorThresholdPercentage: 50,
      volumeThreshold: 5,
      resetTimeout: 10000, // 10 seconds
    });

    // Fallback: log warning when Redis is unavailable
    this.redisBreaker.fallback(() => {
      logger.warn('Redis publish circuit open - quotes not persisted');
    });
  }

  /**
   * Gets the current state of the market data circuit breaker.
   */
  getMarketDataCircuitState(): CircuitBreakerState {
    return getCircuitBreakerState(this.marketDataBreaker);
  }

  /**
   * Gets the current state of the Redis circuit breaker.
   */
  getRedisCircuitState(): CircuitBreakerState {
    return getCircuitBreakerState(this.redisBreaker);
  }

  /**
   * Starts the quote simulation with periodic price updates.
   * Updates are stored in Redis, published to Kafka, and sent to all subscribers.
   * @param intervalMs - Update interval in milliseconds (default: 1000)
   */
  start(intervalMs: number = 1000): void {
    if (this.updateInterval) return;

    this.updateInterval = setInterval(async () => {
      const updatedQuotes: Quote[] = [];

      for (const [symbol, quote] of currentPrices.entries()) {
        const stock = STOCKS[symbol];
        if (stock) {
          const newQuote = simulatePriceMovement(quote, stock.volatility);
          currentPrices.set(symbol, newQuote);
          lastKnownQuotes.set(symbol, newQuote); // Update fallback cache
          updatedQuotes.push(newQuote);
        }
      }

      // Notify all in-process subscribers (WebSocket handlers, etc.)
      this.notifySubscribers(updatedQuotes);

      // Publish to Redis with circuit breaker protection
      try {
        await this.redisBreaker.fire(updatedQuotes);
      } catch (error) {
        // Circuit breaker fallback handles this
      }

      // Publish to Kafka for distributed consumers
      if (isProducerConnected()) {
        try {
          await publishQuotes(updatedQuotes);
        } catch (error) {
          logger.error({ error }, 'Failed to publish quotes to Kafka');
        }
      }
    }, intervalMs);

    logger.info({ intervalMs }, 'Quote service started');
  }

  /**
   * Stops the quote simulation and clears the update interval.
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info('Quote service stopped');
    }
  }

  /**
   * Gets the current quote for a single stock symbol.
   * Uses circuit breaker when fetching from external source.
   * @param symbol - Stock ticker symbol (case-insensitive)
   * @returns Quote object or null if symbol not found
   */
  getQuote(symbol: string): Quote | null {
    return currentPrices.get(symbol.toUpperCase()) || null;
  }

  /**
   * Gets a quote with circuit breaker protection for external data.
   * Falls back to cached data if external source is unavailable.
   * @param symbol - Stock ticker symbol
   * @returns Quote object or null
   */
  async getQuoteWithFallback(symbol: string): Promise<Quote | null> {
    try {
      // Try external market data first (with circuit breaker)
      const externalQuote = await this.marketDataBreaker.fire(symbol);
      if (externalQuote) {
        currentPrices.set(symbol.toUpperCase(), externalQuote);
        return externalQuote;
      }
    } catch (error) {
      // Circuit breaker fallback handles this
    }

    // Fall back to simulated/cached data
    return this.getQuote(symbol);
  }

  /**
   * Gets quotes for multiple stock symbols.
   * @param symbols - Array of stock ticker symbols
   * @returns Array of Quote objects (excludes symbols not found)
   */
  getQuotes(symbols: string[]): Quote[] {
    return symbols
      .map((s) => currentPrices.get(s.toUpperCase()))
      .filter((q): q is Quote => q !== null);
  }

  /**
   * Gets all available stock quotes.
   * @returns Array of all Quote objects
   */
  getAllQuotes(): Quote[] {
    return Array.from(currentPrices.values());
  }

  /**
   * Gets all available stock ticker symbols.
   * @returns Array of symbol strings
   */
  getAllSymbols(): string[] {
    return Object.keys(STOCKS);
  }

  /**
   * Gets stock information (name and symbol) for a ticker.
   * @param symbol - Stock ticker symbol (case-insensitive)
   * @returns Stock info object or null if not found
   */
  getStockInfo(symbol: string): { name: string; symbol: string } | null {
    const stock = STOCKS[symbol.toUpperCase()];
    if (!stock) return null;
    return { name: stock.name, symbol: symbol.toUpperCase() };
  }

  /**
   * Gets information for all available stocks.
   * @returns Array of stock info objects with name and symbol
   */
  getAllStocks(): Array<{ name: string; symbol: string }> {
    return Object.entries(STOCKS).map(([symbol, data]) => ({
      symbol,
      name: data.name,
    }));
  }

  /**
   * Subscribes to quote updates with a callback function.
   * @param id - Unique identifier for the subscription (e.g., connection ID)
   * @param callback - Function called with updated quotes array
   */
  subscribe(id: string, callback: (quotes: Quote[]) => void): void {
    if (!this.subscribers.has(id)) {
      this.subscribers.set(id, new Set());
    }
    this.subscribers.get(id)!.add(callback);
  }

  /**
   * Unsubscribes from quote updates.
   * @param id - Subscription identifier
   * @param callback - Optional specific callback to remove; if omitted, removes all callbacks for id
   */
  unsubscribe(id: string, callback?: (quotes: Quote[]) => void): void {
    if (callback) {
      this.subscribers.get(id)?.delete(callback);
    } else {
      this.subscribers.delete(id);
    }
  }

  /**
   * Notifies all subscribers with updated quote data.
   * Called internally after each price simulation cycle.
   * @param quotes - Array of updated quotes to broadcast
   */
  private notifySubscribers(quotes: Quote[]): void {
    for (const callbacks of this.subscribers.values()) {
      for (const callback of callbacks) {
        try {
          callback(quotes);
        } catch (error) {
          logger.error({ error }, 'Error notifying subscriber');
        }
      }
    }
  }
}

/**
 * Singleton instance of the QuoteService.
 * Shared across the application for consistent quote data.
 */
export const quoteService = new QuoteService();
