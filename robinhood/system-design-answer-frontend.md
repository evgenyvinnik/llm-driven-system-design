# Robinhood - Stock Trading Platform - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

"Design a stock trading platform like Robinhood that enables users to view real-time stock quotes, place orders, and track their portfolio. I'll focus on the frontend architecture: real-time data streaming, responsive trading UI, state management for financial data, and creating a smooth, trustworthy user experience."

---

## 1. Requirements Clarification (3 minutes)

### Functional Requirements (Frontend Scope)
1. **Real-Time Quote Display** - Live streaming prices with visual indicators for changes
2. **Order Entry Forms** - Market, limit, stop order placement with validation
3. **Portfolio Dashboard** - Holdings, P&L, buying power with real-time updates
4. **Watchlists** - User-curated symbol lists with price alerts
5. **Stock Detail View** - Charts, company info, order history

### Non-Functional Requirements
| Requirement | Target | Frontend Implication |
|-------------|--------|---------------------|
| Quote Update Latency | < 200ms visual | WebSocket + optimistic rendering |
| Order Confirmation | < 1s feedback | Loading states, success animations |
| Mobile Responsiveness | Full parity | Touch-optimized order entry |
| Accessibility | WCAG 2.1 AA | Keyboard navigation, screen reader support |
| Offline Resilience | Graceful degradation | Stale data indicators, reconnection |

### User Personas
1. **Day Trader** - Needs fastest updates, keyboard shortcuts, multi-symbol monitoring
2. **Casual Investor** - Simple buy/sell, portfolio overview, alerts
3. **Mobile User** - Touch-friendly interface, quick glance at holdings

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Browser / Mobile App                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         React Application                            │    │
│  │                                                                       │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │    │
│  │  │  Portfolio  │  │   Trading   │  │  Watchlist  │  │   Stock     │ │    │
│  │  │  Dashboard  │  │    View     │  │    View     │  │   Detail    │ │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │    │
│  │         │                │                │                │         │    │
│  │  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐ │    │
│  │  │                    Shared Components                           │ │    │
│  │  │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │ │    │
│  │  │  │QuoteTicker│  │OrderForm  │  │PriceChart│  │PositionCard  │  │ │    │
│  │  │  └──────────┘  └───────────┘  └──────────┘  └──────────────┘  │ │    │
│  │  └────────────────────────────────────────────────────────────────┘ │    │
│  │                                                                       │    │
│  │  ┌────────────────────────────────────────────────────────────────┐  │    │
│  │  │                      State Management                           │  │    │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐               │  │    │
│  │  │  │ quoteStore │  │ orderStore │  │portfolioStore│              │  │    │
│  │  │  │  (Zustand) │  │  (Zustand) │  │  (Zustand)  │              │  │    │
│  │  │  └──────┬─────┘  └──────┬─────┘  └──────┬─────┘               │  │    │
│  │  └─────────┼───────────────┼───────────────┼─────────────────────┘  │    │
│  │            │               │               │                         │    │
│  │  ┌─────────┴───────────────┴───────────────┴─────────────────────┐  │    │
│  │  │                     Service Layer                              │  │    │
│  │  │  ┌────────────────┐  ┌────────────────┐                       │  │    │
│  │  │  │ WebSocketService│  │   API Client   │                       │  │    │
│  │  │  │ (Quote Stream) │  │  (REST calls)  │                       │  │    │
│  │  │  └────────┬───────┘  └────────┬───────┘                       │  │    │
│  │  └───────────┼──────────────────┼────────────────────────────────┘  │    │
│  └──────────────┼──────────────────┼────────────────────────────────────┘    │
│                 │                  │                                         │
└─────────────────┼──────────────────┼─────────────────────────────────────────┘
                  │                  │
                  ▼                  ▼
         ┌────────────────┐  ┌────────────────┐
         │   WebSocket    │  │   REST API     │
         │    Server      │  │    Server      │
         └────────────────┘  └────────────────┘
```

---

## 3. Deep Dive: Real-Time Quote Streaming (10 minutes)

### WebSocket Service with Auto-Reconnection

```typescript
// services/websocketService.ts
type QuoteHandler = (quotes: Quote[]) => void;
type ConnectionHandler = (status: ConnectionStatus) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private subscriptions: Set<string> = new Set();
  private quoteHandlers: Set<QuoteHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();

  connect(token: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(`${WS_URL}?token=${token}`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.notifyConnection('connected');

      // Resubscribe to previously watched symbols
      if (this.subscriptions.size > 0) {
        this.send({
          type: 'subscribe',
          symbols: Array.from(this.subscriptions)
        });
      }
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = (event) => {
      this.notifyConnection('disconnected');

      if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect(token);
      }
    };

    this.ws.onerror = () => {
      this.notifyConnection('error');
    };
  }

  private scheduleReconnect(token: string): void {
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      30000
    );
    this.reconnectAttempts++;
    this.notifyConnection('reconnecting');

    setTimeout(() => this.connect(token), delay);
  }

  private handleMessage(message: WSMessage): void {
    switch (message.type) {
      case 'quotes':
      case 'quote_batch':
        this.quoteHandlers.forEach(handler => handler(message.data));
        break;
      case 'alert':
        this.handlePriceAlert(message.data);
        break;
      case 'pong':
        // Heartbeat response - connection healthy
        break;
    }
  }

  subscribe(symbols: string[]): void {
    symbols.forEach(s => this.subscriptions.add(s));
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', symbols });
    }
  }

  unsubscribe(symbols: string[]): void {
    symbols.forEach(s => this.subscriptions.delete(s));
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'unsubscribe', symbols });
    }
  }

  onQuotes(handler: QuoteHandler): () => void {
    this.quoteHandlers.add(handler);
    return () => this.quoteHandlers.delete(handler);
  }

  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  private send(message: object): void {
    this.ws?.send(JSON.stringify(message));
  }

  private notifyConnection(status: ConnectionStatus): void {
    this.connectionHandlers.forEach(h => h(status));
  }
}

export const wsService = new WebSocketService();
```

### Quote Store with Zustand

```typescript
// stores/quoteStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  prevClose: number;
  volume: number;
  timestamp: number;
}

interface QuoteState {
  quotes: Map<string, Quote>;
  connectionStatus: ConnectionStatus;
  lastUpdate: number;

  // Actions
  updateQuotes: (quotes: Quote[]) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  subscribe: (symbols: string[]) => void;
  unsubscribe: (symbols: string[]) => void;
}

export const useQuoteStore = create<QuoteState>()(
  subscribeWithSelector((set, get) => ({
    quotes: new Map(),
    connectionStatus: 'disconnected',
    lastUpdate: 0,

    updateQuotes: (incomingQuotes) => {
      set((state) => {
        const newQuotes = new Map(state.quotes);
        for (const quote of incomingQuotes) {
          const existing = newQuotes.get(quote.symbol);
          newQuotes.set(quote.symbol, {
            ...quote,
            prevClose: existing?.prevClose ?? quote.last
          });
        }
        return { quotes: newQuotes, lastUpdate: Date.now() };
      });
    },

    setConnectionStatus: (status) => set({ connectionStatus: status }),

    subscribe: (symbols) => wsService.subscribe(symbols),
    unsubscribe: (symbols) => wsService.unsubscribe(symbols),
  }))
);

// Selector hooks for optimized re-renders
export const useQuote = (symbol: string) =>
  useQuoteStore((state) => state.quotes.get(symbol));

export const useQuotes = (symbols: string[]) =>
  useQuoteStore((state) => {
    const result: Quote[] = [];
    for (const symbol of symbols) {
      const quote = state.quotes.get(symbol);
      if (quote) result.push(quote);
    }
    return result;
  });

export const useConnectionStatus = () =>
  useQuoteStore((state) => state.connectionStatus);
```

### Quote Ticker Component with Price Animation

```tsx
// components/QuoteTicker.tsx
import { useQuote } from '../stores/quoteStore';
import { useEffect, useRef, useState } from 'react';

interface QuoteTickerProps {
  symbol: string;
  showChange?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function QuoteTicker({ symbol, showChange = true, size = 'md' }: QuoteTickerProps) {
  const quote = useQuote(symbol);
  const prevPriceRef = useRef<number | null>(null);
  const [flashClass, setFlashClass] = useState('');

  // Flash animation on price change
  useEffect(() => {
    if (!quote || prevPriceRef.current === null) {
      prevPriceRef.current = quote?.last ?? null;
      return;
    }

    if (quote.last > prevPriceRef.current) {
      setFlashClass('animate-flash-green');
    } else if (quote.last < prevPriceRef.current) {
      setFlashClass('animate-flash-red');
    }

    prevPriceRef.current = quote.last;

    const timer = setTimeout(() => setFlashClass(''), 300);
    return () => clearTimeout(timer);
  }, [quote?.last]);

  if (!quote) {
    return <QuoteTickerSkeleton size={size} />;
  }

  const change = quote.last - quote.prevClose;
  const changePercent = (change / quote.prevClose) * 100;
  const isPositive = change >= 0;

  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-lg',
    lg: 'text-2xl font-bold'
  };

  return (
    <div className={`flex items-baseline gap-2 ${sizeClasses[size]}`}>
      <span className={`font-mono tabular-nums ${flashClass}`}>
        ${quote.last.toFixed(2)}
      </span>
      {showChange && (
        <span className={isPositive ? 'text-green-500' : 'text-red-500'}>
          {isPositive ? '+' : ''}{change.toFixed(2)} ({changePercent.toFixed(2)}%)
        </span>
      )}
    </div>
  );
}

function QuoteTickerSkeleton({ size }: { size: string }) {
  return (
    <div className="animate-pulse">
      <div className={`bg-gray-200 rounded h-6 w-24`} />
    </div>
  );
}
```

### CSS for Price Flash Animation

```css
/* styles/animations.css */
@keyframes flash-green {
  0% { background-color: rgba(34, 197, 94, 0.4); }
  100% { background-color: transparent; }
}

@keyframes flash-red {
  0% { background-color: rgba(239, 68, 68, 0.4); }
  100% { background-color: transparent; }
}

.animate-flash-green {
  animation: flash-green 0.3s ease-out;
}

.animate-flash-red {
  animation: flash-red 0.3s ease-out;
}
```

---

## 4. Deep Dive: Order Entry System (10 minutes)

### Order Form with Validation

```tsx
// components/OrderForm.tsx
import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuote } from '../stores/quoteStore';
import { usePortfolioStore } from '../stores/portfolioStore';
import { placeOrder } from '../services/orderService';

const orderSchema = z.object({
  side: z.enum(['buy', 'sell']),
  orderType: z.enum(['market', 'limit', 'stop', 'stop_limit']),
  quantity: z.number().positive('Quantity must be positive'),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
}).refine((data) => {
  if (data.orderType === 'limit' || data.orderType === 'stop_limit') {
    return data.limitPrice !== undefined;
  }
  return true;
}, { message: 'Limit price required', path: ['limitPrice'] })
.refine((data) => {
  if (data.orderType === 'stop' || data.orderType === 'stop_limit') {
    return data.stopPrice !== undefined;
  }
  return true;
}, { message: 'Stop price required', path: ['stopPrice'] });

type OrderFormData = z.infer<typeof orderSchema>;

interface OrderFormProps {
  symbol: string;
  onSuccess?: (order: Order) => void;
}

export function OrderForm({ symbol, onSuccess }: OrderFormProps) {
  const quote = useQuote(symbol);
  const { buyingPower, positions } = usePortfolioStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const position = positions.find(p => p.symbol === symbol);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
    reset
  } = useForm<OrderFormData>({
    resolver: zodResolver(orderSchema),
    defaultValues: {
      side: 'buy',
      orderType: 'market',
      quantity: 1
    }
  });

  const side = watch('side');
  const orderType = watch('orderType');
  const quantity = watch('quantity');

  // Estimate order cost
  const estimatedCost = useMemo(() => {
    if (!quote || !quantity) return 0;
    const price = side === 'buy' ? quote.ask : quote.bid;
    return quantity * price;
  }, [quote, quantity, side]);

  // Validation messages
  const validationMessage = useMemo(() => {
    if (side === 'buy' && estimatedCost > buyingPower) {
      return `Insufficient buying power. Need $${estimatedCost.toFixed(2)}, have $${buyingPower.toFixed(2)}`;
    }
    if (side === 'sell' && quantity > (position?.quantity ?? 0)) {
      return `Insufficient shares. Have ${position?.quantity ?? 0} shares`;
    }
    return null;
  }, [side, estimatedCost, buyingPower, quantity, position]);

  const onSubmit = async (data: OrderFormData) => {
    setIsSubmitting(true);
    setError(null);

    // Generate idempotency key
    const idempotencyKey = crypto.randomUUID();

    try {
      const order = await placeOrder({
        symbol,
        ...data,
        idempotencyKey
      });
      reset();
      onSuccess?.(order);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Order failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Side Toggle */}
      <div className="flex rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => register('side').onChange({ target: { value: 'buy' } })}
          className={`flex-1 py-3 font-semibold transition-colors ${
            side === 'buy'
              ? 'bg-green-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => register('side').onChange({ target: { value: 'sell' } })}
          className={`flex-1 py-3 font-semibold transition-colors ${
            side === 'sell'
              ? 'bg-red-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Sell
        </button>
      </div>

      {/* Order Type */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Order Type
        </label>
        <select
          {...register('orderType')}
          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
        >
          <option value="market">Market</option>
          <option value="limit">Limit</option>
          <option value="stop">Stop</option>
          <option value="stop_limit">Stop Limit</option>
        </select>
      </div>

      {/* Quantity */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Shares
        </label>
        <input
          type="number"
          {...register('quantity', { valueAsNumber: true })}
          min="1"
          step="1"
          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
        />
        {errors.quantity && (
          <p className="mt-1 text-sm text-red-500">{errors.quantity.message}</p>
        )}
      </div>

      {/* Limit Price (conditional) */}
      {(orderType === 'limit' || orderType === 'stop_limit') && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Limit Price
          </label>
          <input
            type="number"
            {...register('limitPrice', { valueAsNumber: true })}
            step="0.01"
            placeholder={quote?.last.toFixed(2)}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
          />
          {errors.limitPrice && (
            <p className="mt-1 text-sm text-red-500">{errors.limitPrice.message}</p>
          )}
        </div>
      )}

      {/* Stop Price (conditional) */}
      {(orderType === 'stop' || orderType === 'stop_limit') && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Stop Price
          </label>
          <input
            type="number"
            {...register('stopPrice', { valueAsNumber: true })}
            step="0.01"
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
          />
          {errors.stopPrice && (
            <p className="mt-1 text-sm text-red-500">{errors.stopPrice.message}</p>
          )}
        </div>
      )}

      {/* Order Summary */}
      <div className="bg-gray-50 rounded-lg p-3 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Market Price</span>
          <QuoteTicker symbol={symbol} showChange={false} size="sm" />
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Estimated {side === 'buy' ? 'Cost' : 'Credit'}</span>
          <span className="font-medium">${estimatedCost.toFixed(2)}</span>
        </div>
        {side === 'buy' && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Buying Power</span>
            <span className={buyingPower < estimatedCost ? 'text-red-500' : ''}>
              ${buyingPower.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {/* Validation Warning */}
      {validationMessage && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-sm text-amber-800">{validationMessage}</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isSubmitting || !!validationMessage}
        className={`w-full py-3 rounded-lg font-semibold text-white transition-colors ${
          side === 'buy'
            ? 'bg-green-500 hover:bg-green-600 disabled:bg-green-300'
            : 'bg-red-500 hover:bg-red-600 disabled:bg-red-300'
        }`}
      >
        {isSubmitting ? (
          <span className="flex items-center justify-center gap-2">
            <Spinner size="sm" />
            Placing Order...
          </span>
        ) : (
          `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`
        )}
      </button>
    </form>
  );
}
```

### Order Confirmation Modal

```tsx
// components/OrderConfirmationModal.tsx
import { useEffect, useState } from 'react';
import { CheckCircle } from 'lucide-react';

interface OrderConfirmationModalProps {
  order: Order;
  onClose: () => void;
}

export function OrderConfirmationModal({ order, onClose }: OrderConfirmationModalProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Trigger entrance animation
    requestAnimationFrame(() => setShow(true));

    // Auto-close after 3 seconds
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div
        className={`bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 transform transition-all duration-300 ${
          show ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
      >
        <div className="text-center">
          <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <CheckCircle className="w-10 h-10 text-green-500" />
          </div>

          <h3 className="text-xl font-semibold mb-2">Order Placed!</h3>

          <div className="text-gray-600 mb-4">
            {order.side === 'buy' ? 'Buying' : 'Selling'} {order.quantity} shares of{' '}
            <span className="font-semibold">{order.symbol}</span>
          </div>

          <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span>Order Type</span>
              <span className="font-medium capitalize">{order.orderType}</span>
            </div>
            {order.limitPrice && (
              <div className="flex justify-between">
                <span>Limit Price</span>
                <span className="font-medium">${order.limitPrice.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Status</span>
              <span className="font-medium capitalize">{order.status}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## 5. Deep Dive: Portfolio Dashboard (8 minutes)

### Portfolio Store with P&L Calculations

```typescript
// stores/portfolioStore.ts
import { create } from 'zustand';

interface Position {
  symbol: string;
  quantity: number;
  avgCostBasis: number;
}

interface PortfolioState {
  positions: Position[];
  buyingPower: number;
  isLoading: boolean;

  // Computed in selectors
  fetchPortfolio: () => Promise<void>;
  updateBuyingPower: (delta: number) => void;
}

export const usePortfolioStore = create<PortfolioState>((set) => ({
  positions: [],
  buyingPower: 0,
  isLoading: false,

  fetchPortfolio: async () => {
    set({ isLoading: true });
    try {
      const response = await fetch('/api/portfolio');
      const data = await response.json();
      set({
        positions: data.positions,
        buyingPower: data.buyingPower,
        isLoading: false
      });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  updateBuyingPower: (delta) => set((state) => ({
    buyingPower: state.buyingPower + delta
  }))
}));

// Computed selectors that combine portfolio with live quotes
export function usePortfolioValue() {
  const positions = usePortfolioStore((s) => s.positions);
  const quotes = useQuoteStore((s) => s.quotes);

  return useMemo(() => {
    let totalValue = 0;
    let totalCost = 0;

    for (const position of positions) {
      const quote = quotes.get(position.symbol);
      if (quote) {
        totalValue += position.quantity * quote.last;
        totalCost += position.quantity * position.avgCostBasis;
      }
    }

    return {
      totalValue,
      totalCost,
      totalGainLoss: totalValue - totalCost,
      totalGainLossPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0
    };
  }, [positions, quotes]);
}
```

### Portfolio Dashboard Component

```tsx
// routes/portfolio.tsx
import { useEffect } from 'react';
import { usePortfolioStore, usePortfolioValue } from '../stores/portfolioStore';
import { useQuoteStore } from '../stores/quoteStore';
import { PositionCard } from '../components/PositionCard';
import { PortfolioChart } from '../components/PortfolioChart';

export function PortfolioPage() {
  const { positions, buyingPower, isLoading, fetchPortfolio } = usePortfolioStore();
  const { subscribe, unsubscribe } = useQuoteStore();
  const { totalValue, totalGainLoss, totalGainLossPercent } = usePortfolioValue();

  // Fetch portfolio and subscribe to position quotes
  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  useEffect(() => {
    const symbols = positions.map(p => p.symbol);
    if (symbols.length > 0) {
      subscribe(symbols);
      return () => unsubscribe(symbols);
    }
  }, [positions, subscribe, unsubscribe]);

  if (isLoading) {
    return <PortfolioSkeleton />;
  }

  const isPositive = totalGainLoss >= 0;

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      {/* Portfolio Summary */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h1 className="text-sm font-medium text-gray-500 mb-1">Portfolio Value</h1>
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold">
            ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
          <span className={`text-lg ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
            {isPositive ? '+' : ''}{totalGainLoss.toFixed(2)} ({totalGainLossPercent.toFixed(2)}%)
          </span>
        </div>

        <div className="mt-4 pt-4 border-t flex gap-8">
          <div>
            <div className="text-sm text-gray-500">Buying Power</div>
            <div className="text-lg font-semibold">${buyingPower.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">Total Account Value</div>
            <div className="text-lg font-semibold">
              ${(totalValue + buyingPower).toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Portfolio Chart */}
      <PortfolioChart />

      {/* Positions List */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Holdings</h2>
        {positions.length === 0 ? (
          <EmptyPositions />
        ) : (
          positions.map(position => (
            <PositionCard key={position.symbol} position={position} />
          ))
        )}
      </div>
    </div>
  );
}
```

### Position Card with Live Updates

```tsx
// components/PositionCard.tsx
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuote } from '../stores/quoteStore';

interface PositionCardProps {
  position: Position;
}

export function PositionCard({ position }: PositionCardProps) {
  const quote = useQuote(position.symbol);

  const metrics = useMemo(() => {
    if (!quote) return null;

    const marketValue = position.quantity * quote.last;
    const costBasis = position.quantity * position.avgCostBasis;
    const gainLoss = marketValue - costBasis;
    const gainLossPercent = (gainLoss / costBasis) * 100;

    // Today's change
    const todayChange = position.quantity * (quote.last - quote.prevClose);
    const todayChangePercent = ((quote.last - quote.prevClose) / quote.prevClose) * 100;

    return {
      marketValue,
      gainLoss,
      gainLossPercent,
      todayChange,
      todayChangePercent
    };
  }, [position, quote]);

  if (!metrics) {
    return <PositionCardSkeleton />;
  }

  return (
    <Link
      to="/stocks/$symbol"
      params={{ symbol: position.symbol }}
      className="block bg-white rounded-xl shadow-sm p-4 hover:shadow-md transition-shadow"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold text-lg">{position.symbol}</div>
          <div className="text-sm text-gray-500">
            {position.quantity} shares @ ${position.avgCostBasis.toFixed(2)}
          </div>
        </div>

        <div className="text-right">
          <div className="font-semibold">${metrics.marketValue.toFixed(2)}</div>
          <div className={metrics.gainLoss >= 0 ? 'text-green-500' : 'text-red-500'}>
            {metrics.gainLoss >= 0 ? '+' : ''}{metrics.gainLoss.toFixed(2)} ({metrics.gainLossPercent.toFixed(2)}%)
          </div>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t flex justify-between text-sm">
        <div className="text-gray-500">Today</div>
        <div className={metrics.todayChange >= 0 ? 'text-green-500' : 'text-red-500'}>
          {metrics.todayChange >= 0 ? '+' : ''}{metrics.todayChange.toFixed(2)} ({metrics.todayChangePercent.toFixed(2)}%)
        </div>
      </div>
    </Link>
  );
}
```

---

## 6. Deep Dive: Connection Status and Offline Handling (5 minutes)

### Connection Status Banner

```tsx
// components/ConnectionStatusBanner.tsx
import { useConnectionStatus } from '../stores/quoteStore';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';

export function ConnectionStatusBanner() {
  const status = useConnectionStatus();

  if (status === 'connected') return null;

  const config = {
    disconnected: {
      icon: WifiOff,
      message: 'Connection lost. Prices may be stale.',
      bg: 'bg-red-500'
    },
    reconnecting: {
      icon: RefreshCw,
      message: 'Reconnecting...',
      bg: 'bg-amber-500'
    },
    error: {
      icon: WifiOff,
      message: 'Connection error. Retrying...',
      bg: 'bg-red-500'
    }
  }[status];

  const Icon = config.icon;

  return (
    <div className={`${config.bg} text-white px-4 py-2 flex items-center justify-center gap-2`}>
      <Icon className={`w-4 h-4 ${status === 'reconnecting' ? 'animate-spin' : ''}`} />
      <span className="text-sm font-medium">{config.message}</span>
    </div>
  );
}
```

### Stale Data Indicator

```tsx
// components/StaleDataIndicator.tsx
import { useQuoteStore } from '../stores/quoteStore';
import { Clock } from 'lucide-react';

interface StaleDataIndicatorProps {
  symbol: string;
  maxAge?: number; // milliseconds
}

export function StaleDataIndicator({ symbol, maxAge = 5000 }: StaleDataIndicatorProps) {
  const quote = useQuote(symbol);
  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    const checkStaleness = () => {
      if (quote) {
        setIsStale(Date.now() - quote.timestamp > maxAge);
      }
    };

    checkStaleness();
    const interval = setInterval(checkStaleness, 1000);
    return () => clearInterval(interval);
  }, [quote, maxAge]);

  if (!isStale) return null;

  return (
    <div className="flex items-center gap-1 text-amber-500 text-xs">
      <Clock className="w-3 h-3" />
      <span>Delayed</span>
    </div>
  );
}
```

---

## 7. Trade-offs Summary

| Decision | Chose | Alternative | Trade-off |
|----------|-------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API vs mature ecosystem |
| Real-time Updates | WebSocket | SSE | Bidirectional vs simpler protocol |
| Form Validation | Zod + React Hook Form | Custom validation | Type safety vs bundle size |
| Animations | CSS transitions | Framer Motion | Performance vs flexibility |
| Quote Updates | Store-based | Props drilling | Shared state vs component isolation |
| Price Flash | CSS animation | React state | GPU-accelerated vs more control |

---

## 8. Future Enhancements

1. **Service Worker** - Cache static assets, queue orders offline
2. **Web Workers** - Move quote processing off main thread
3. **Virtualized Watchlists** - Handle 100+ symbols efficiently
4. **Advanced Charts** - TradingView integration, technical indicators
5. **Keyboard Shortcuts** - Power user order entry (Ctrl+B for buy, etc.)
6. **Push Notifications** - Price alerts via browser notifications
7. **Dark Mode** - Reduce eye strain for extended trading sessions
