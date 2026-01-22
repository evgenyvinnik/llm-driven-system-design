# Robinhood - Stock Trading Platform - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

"Design a stock trading platform like Robinhood that enables users to view real-time stock quotes, place orders, and track their portfolio. I'll focus on the end-to-end architecture: how frontend and backend integrate for real-time quote streaming, how order placement flows through the system, API contract design, session management, and error handling strategies."

---

## 1. Requirements Clarification (3 minutes)

### Functional Requirements (Fullstack Scope)
1. **Quote Subscription Flow** - WebSocket handshake, symbol subscription, quote delivery
2. **Order Placement Flow** - Form submission, validation, execution, confirmation
3. **Portfolio Synchronization** - Real-time P&L updates as quotes change
4. **Session Management** - Login, token handling, session expiry
5. **Error Handling** - Network failures, validation errors, order rejections

### Non-Functional Requirements
| Requirement | Frontend | Backend | Integration |
|-------------|----------|---------|-------------|
| Latency | < 200ms render | < 100ms quote, < 500ms order | WebSocket batching |
| Reliability | Reconnection, offline state | Circuit breakers, retries | Idempotency keys |
| Consistency | Optimistic updates | ACID transactions | Eventual consistency for quotes |
| Security | Token storage, HTTPS | Input validation, rate limiting | Session management |

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (React)                                │
│                                                                              │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│   │   Portfolio  │    │    Order     │    │   Watchlist  │                  │
│   │   Dashboard  │    │    Entry     │    │     View     │                  │
│   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                  │
│          │                   │                   │                          │
│   ┌──────┴───────────────────┴───────────────────┴───────┐                  │
│   │                    Zustand Stores                     │                  │
│   │   ┌─────────┐  ┌───────────┐  ┌─────────────────┐   │                  │
│   │   │ quotes  │  │  orders   │  │   portfolio     │   │                  │
│   │   └────┬────┘  └─────┬─────┘  └────────┬────────┘   │                  │
│   └────────┼─────────────┼─────────────────┼────────────┘                  │
│            │             │                 │                                │
│   ┌────────┴─────────────┴─────────────────┴────────────┐                  │
│   │                  Service Layer                       │                  │
│   │   ┌─────────────────┐    ┌─────────────────┐        │                  │
│   │   │ WebSocketService│    │   ApiClient     │        │                  │
│   │   └────────┬────────┘    └────────┬────────┘        │                  │
│   └────────────┼──────────────────────┼─────────────────┘                  │
└────────────────┼──────────────────────┼─────────────────────────────────────┘
                 │                      │
           WebSocket                 HTTPS
                 │                      │
┌────────────────┼──────────────────────┼─────────────────────────────────────┐
│                │      BACKEND (Node.js + Express)       │                   │
│   ┌────────────▼──────────┐    ┌──────▼──────────────┐  │                   │
│   │   WebSocket Handler   │    │   REST API Routes   │  │                   │
│   │  - Token validation   │    │  - Auth middleware  │  │                   │
│   │  - Subscription mgmt  │    │  - Order validation │  │                   │
│   │  - Quote broadcasting │    │  - Portfolio queries│  │                   │
│   └───────────┬───────────┘    └──────────┬──────────┘  │                   │
│               │                           │              │                   │
│   ┌───────────┴───────────────────────────┴───────────┐ │                   │
│   │                   Services Layer                   │ │                   │
│   │   ┌─────────┐  ┌─────────┐  ┌───────────────────┐ │ │                   │
│   │   │ Quote   │  │ Order   │  │    Portfolio      │ │ │                   │
│   │   │ Service │  │ Service │  │    Service        │ │ │                   │
│   │   └────┬────┘  └────┬────┘  └─────────┬─────────┘ │ │                   │
│   └────────┼────────────┼─────────────────┼───────────┘ │                   │
│            │            │                 │              │                   │
│   ┌────────┴────────────┴─────────────────┴───────────┐ │                   │
│   │          PostgreSQL              Redis            │ │                   │
│   │   ┌────────────────────┐  ┌───────────────────┐  │ │                   │
│   │   │ users, orders,     │  │ quotes, sessions, │  │ │                   │
│   │   │ positions, sessions│  │ idempotency keys  │  │ │                   │
│   │   └────────────────────┘  └───────────────────┘  │ │                   │
│   └──────────────────────────────────────────────────┘ │                   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Deep Dive: Quote Subscription Flow (10 minutes)

### End-to-End WebSocket Flow

```
┌─────────┐                    ┌─────────┐                    ┌─────────┐
│ Browser │                    │  Server │                    │  Redis  │
└────┬────┘                    └────┬────┘                    └────┬────┘
     │                              │                              │
     │  1. ws://...?token=abc123    │                              │
     │─────────────────────────────▶│                              │
     │                              │  2. Validate token           │
     │                              │─────────────────────────────▶│
     │                              │◀─────────────────────────────│
     │  3. {"type":"connected"}     │                              │
     │◀─────────────────────────────│                              │
     │                              │                              │
     │  4. {"type":"subscribe",     │                              │
     │      "symbols":["AAPL"]}     │                              │
     │─────────────────────────────▶│                              │
     │                              │  5. HGET quote:AAPL          │
     │                              │─────────────────────────────▶│
     │                              │◀─────────────────────────────│
     │  6. {"type":"quotes",        │                              │
     │      "data":[{...}]}         │                              │
     │◀─────────────────────────────│                              │
     │                              │                              │
     │                              │  7. SUBSCRIBE quote_updates  │
     │                              │─────────────────────────────▶│
     │                              │                              │
     │                              │  8. Quote update published   │
     │                              │◀─────────────────────────────│
     │  9. {"type":"quote_batch",   │                              │
     │      "data":[{...}]}         │                              │
     │◀─────────────────────────────│                              │
     │                              │                              │
```

### Frontend: WebSocket Service

```typescript
// services/websocketService.ts
class WebSocketService {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private subscriptions = new Set<string>();
  private messageHandlers = new Map<string, Set<Function>>();
  private reconnectTimer: number | null = null;

  connect(token: string): Promise<void> {
    this.token = token;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_URL}?token=${token}`);

      this.ws.onopen = () => {
        this.clearReconnectTimer();
        // Resubscribe after reconnection
        if (this.subscriptions.size > 0) {
          this.send({ type: 'subscribe', symbols: Array.from(this.subscriptions) });
        }
        resolve();
      };

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        this.dispatch(message.type, message.data);
      };

      this.ws.onclose = (event) => {
        if (!event.wasClean) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));
    });
  }

  subscribe(symbols: string[]): void {
    symbols.forEach(s => this.subscriptions.add(s));
    if (this.isConnected()) {
      this.send({ type: 'subscribe', symbols });
    }
  }

  on(type: string, handler: Function): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
    return () => this.messageHandlers.get(type)?.delete(handler);
  }

  private dispatch(type: string, data: any): void {
    this.messageHandlers.get(type)?.forEach(handler => handler(data));
  }

  private send(message: object): void {
    if (this.isConnected()) {
      this.ws!.send(JSON.stringify(message));
    }
  }

  private isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.dispatch('connection', { status: 'reconnecting' });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.token) this.connect(this.token);
    }, 2000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const wsService = new WebSocketService();
```

### Backend: WebSocket Handler

```typescript
// routes/websocket.ts
import WebSocket from 'ws';
import { redis } from '../shared/cache.js';
import { validateSession } from '../shared/auth.js';

interface ClientState {
  userId: string;
  subscriptions: Set<string>;
  isAlive: boolean;
}

const clients = new Map<WebSocket, ClientState>();

export function setupWebSocket(wss: WebSocket.Server): void {
  // Redis subscriber for quote updates
  const subscriber = redis.duplicate();
  subscriber.subscribe('quote_updates');

  subscriber.on('message', (channel, message) => {
    const quotes: Quote[] = JSON.parse(message);
    broadcastQuotes(quotes);
  });

  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url!, 'ws://localhost').searchParams.get('token');

    // Validate session token
    const user = await validateSession(token);
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    clients.set(ws, {
      userId: user.id,
      subscriptions: new Set(),
      isAlive: true
    });

    ws.send(JSON.stringify({ type: 'connected', data: { authenticated: true } }));

    ws.on('message', async (data) => {
      const message = JSON.parse(data.toString());
      await handleMessage(ws, message);
    });

    ws.on('pong', () => {
      const state = clients.get(ws);
      if (state) state.isAlive = true;
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  // Heartbeat every 30 seconds
  setInterval(() => {
    wss.clients.forEach((ws) => {
      const state = clients.get(ws);
      if (!state?.isAlive) {
        clients.delete(ws);
        return ws.terminate();
      }
      state.isAlive = false;
      ws.ping();
    });
  }, 30000);
}

async function handleMessage(ws: WebSocket, message: WSMessage): Promise<void> {
  const state = clients.get(ws);
  if (!state) return;

  switch (message.type) {
    case 'subscribe':
      message.symbols.forEach(s => state.subscriptions.add(s));
      // Send current quotes immediately
      const quotes = await getQuotesFromCache(message.symbols);
      ws.send(JSON.stringify({ type: 'quotes', data: quotes }));
      break;

    case 'unsubscribe':
      message.symbols.forEach(s => state.subscriptions.delete(s));
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}

function broadcastQuotes(quotes: Quote[]): void {
  const quotesBySymbol = new Map(quotes.map(q => [q.symbol, q]));

  for (const [ws, state] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    const relevantQuotes = quotes.filter(q => state.subscriptions.has(q.symbol));
    if (relevantQuotes.length > 0) {
      ws.send(JSON.stringify({ type: 'quote_batch', data: relevantQuotes }));
    }
  }
}

async function getQuotesFromCache(symbols: string[]): Promise<Quote[]> {
  const pipeline = redis.pipeline();
  symbols.forEach(s => pipeline.hgetall(`quote:${s}`));
  const results = await pipeline.exec();

  return results
    .map((r, i) => r[1] ? { symbol: symbols[i], ...r[1] } : null)
    .filter(Boolean) as Quote[];
}
```

---

## 4. Deep Dive: Order Placement Flow (10 minutes)

### End-to-End Order Flow

```
┌─────────┐              ┌─────────┐              ┌──────────┐              ┌─────────┐
│ Browser │              │   API   │              │PostgreSQL│              │  Redis  │
└────┬────┘              └────┬────┘              └────┬─────┘              └────┬────┘
     │                        │                        │                         │
     │  1. POST /api/orders   │                        │                         │
     │  X-Idempotency-Key:... │                        │                         │
     │───────────────────────▶│                        │                         │
     │                        │  2. Check idempotency  │                         │
     │                        │─────────────────────────────────────────────────▶│
     │                        │◀─────────────────────────────────────────────────│
     │                        │                        │                         │
     │                        │  3. BEGIN TRANSACTION  │                         │
     │                        │───────────────────────▶│                         │
     │                        │                        │                         │
     │                        │  4. Check buying power │                         │
     │                        │       FOR UPDATE       │                         │
     │                        │───────────────────────▶│                         │
     │                        │◀───────────────────────│                         │
     │                        │                        │                         │
     │                        │  5. Reserve funds      │                         │
     │                        │───────────────────────▶│                         │
     │                        │                        │                         │
     │                        │  6. INSERT order       │                         │
     │                        │───────────────────────▶│                         │
     │                        │                        │                         │
     │                        │  7. COMMIT             │                         │
     │                        │───────────────────────▶│                         │
     │                        │                        │                         │
     │                        │  8. Store idempotency  │                         │
     │                        │       result           │                         │
     │                        │─────────────────────────────────────────────────▶│
     │                        │                        │                         │
     │  9. 201 Created        │                        │                         │
     │     {order: {...}}     │                        │                         │
     │◀───────────────────────│                        │                         │
     │                        │                        │                         │
```

### Frontend: Order Service with Idempotency

```typescript
// services/orderService.ts
interface PlaceOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
}

export async function placeOrder(request: PlaceOrderRequest): Promise<Order> {
  // Generate idempotency key to prevent duplicate orders
  const idempotencyKey = crypto.randomUUID();

  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      'X-Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new OrderError(error.code, error.message);
  }

  return response.json();
}

// Custom error class for order failures
class OrderError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'OrderError';
  }
}
```

### Backend: Order Route with Validation

```typescript
// routes/orders.ts
import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../shared/auth.js';
import { orderService } from '../services/orderService.js';

const router = Router();

const orderSchema = z.object({
  symbol: z.string().min(1).max(10),
  side: z.enum(['buy', 'sell']),
  orderType: z.enum(['market', 'limit', 'stop', 'stop_limit']),
  quantity: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional()
}).refine(data => {
  if (data.orderType === 'limit' || data.orderType === 'stop_limit') {
    return data.limitPrice !== undefined;
  }
  return true;
}, { message: 'Limit price required for limit orders' });

router.post('/', authMiddleware, async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;

  if (!idempotencyKey) {
    return res.status(400).json({
      code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'X-Idempotency-Key header required'
    });
  }

  // Validate request body
  const parseResult = orderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: parseResult.error.errors[0].message,
      errors: parseResult.error.errors
    });
  }

  try {
    const order = await orderService.placeOrder(
      req.user!.id,
      parseResult.data,
      idempotencyKey
    );

    res.status(201).json({ order });

  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      return res.status(400).json({
        code: 'INSUFFICIENT_FUNDS',
        message: 'Insufficient buying power',
        available: error.available,
        required: error.required
      });
    }

    if (error instanceof InsufficientSharesError) {
      return res.status(400).json({
        code: 'INSUFFICIENT_SHARES',
        message: 'Insufficient shares to sell',
        available: error.available,
        required: error.required
      });
    }

    if (error instanceof ConflictError) {
      return res.status(409).json({
        code: 'DUPLICATE_REQUEST',
        message: 'Order already in progress or completed'
      });
    }

    throw error;
  }
});

router.get('/', authMiddleware, async (req, res) => {
  const orders = await orderService.getOrdersForUser(req.user!.id, {
    status: req.query.status as string,
    limit: parseInt(req.query.limit as string) || 50
  });

  res.json({ orders });
});

router.delete('/:id', authMiddleware, async (req, res) => {
  await orderService.cancelOrder(req.user!.id, req.params.id);
  res.status(204).send();
});

export default router;
```

### Frontend: Order Form with Error Handling

```tsx
// components/OrderForm.tsx
import { useState } from 'react';
import { placeOrder, OrderError } from '../services/orderService';
import { usePortfolioStore } from '../stores/portfolioStore';

export function OrderForm({ symbol }: { symbol: string }) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const updateBuyingPower = usePortfolioStore(s => s.updateBuyingPower);

  const handleSubmit = async (data: OrderFormData) => {
    setIsSubmitting(true);
    setError(null);

    try {
      const order = await placeOrder({
        symbol,
        side: data.side,
        orderType: data.orderType,
        quantity: data.quantity,
        limitPrice: data.limitPrice,
        stopPrice: data.stopPrice
      });

      // Optimistic update - reduce buying power immediately
      if (data.side === 'buy') {
        updateBuyingPower(-order.estimatedCost);
      }

      // Show success confirmation
      showOrderConfirmation(order);

    } catch (err) {
      if (err instanceof OrderError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ code: 'UNKNOWN', message: 'Failed to place order. Please try again.' });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Form fields */}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-4">
          <p className="text-sm text-red-800 font-medium">{error.message}</p>
          {error.code === 'INSUFFICIENT_FUNDS' && (
            <p className="text-xs text-red-600 mt-1">
              Consider reducing the quantity or depositing more funds.
            </p>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full py-3 bg-green-500 text-white rounded-lg font-semibold"
      >
        {isSubmitting ? 'Placing Order...' : 'Place Order'}
      </button>
    </form>
  );
}
```

---

## 5. Deep Dive: Session Management (8 minutes)

### Login Flow

```
┌─────────┐              ┌─────────┐              ┌──────────┐              ┌─────────┐
│ Browser │              │   API   │              │PostgreSQL│              │  Redis  │
└────┬────┘              └────┬────┘              └────┬─────┘              └────┬────┘
     │                        │                        │                         │
     │  1. POST /api/auth/    │                        │                         │
     │     login              │                        │                         │
     │  {email, password}     │                        │                         │
     │───────────────────────▶│                        │                         │
     │                        │  2. Get user by email  │                         │
     │                        │───────────────────────▶│                         │
     │                        │◀───────────────────────│                         │
     │                        │                        │                         │
     │                        │  3. Verify bcrypt hash │                         │
     │                        │      (in-process)      │                         │
     │                        │                        │                         │
     │                        │  4. INSERT session     │                         │
     │                        │───────────────────────▶│                         │
     │                        │◀───────────────────────│                         │
     │                        │                        │                         │
     │                        │  5. Cache session      │                         │
     │                        │─────────────────────────────────────────────────▶│
     │                        │                        │                         │
     │  6. 200 OK             │                        │                         │
     │  {token, user}         │                        │                         │
     │◀───────────────────────│                        │                         │
     │                        │                        │                         │
     │  7. Store token in     │                        │                         │
     │     localStorage       │                        │                         │
     │                        │                        │                         │
```

### Backend: Auth Routes

```typescript
// routes/auth.ts
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';

const router = Router();
const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  // Fetch user
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, first_name, last_name, role FROM users WHERE email = $1',
    [email]
  );

  if (rows.length === 0) {
    return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  }

  const user = rows[0];

  // Verify password
  const passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) {
    return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  }

  // Create session
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [user.id, token, expiresAt]
  );

  // Cache session in Redis for fast validation
  await redis.setex(`session:${token}`, SESSION_TTL, JSON.stringify({
    userId: user.id,
    role: user.role,
    expiresAt: expiresAt.toISOString()
  }));

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role
    },
    expiresAt
  });
});

router.post('/logout', authMiddleware, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  // Remove from both PostgreSQL and Redis
  await Promise.all([
    pool.query('DELETE FROM sessions WHERE token = $1', [token]),
    redis.del(`session:${token}`)
  ]);

  res.status(204).send();
});

export default router;
```

### Backend: Auth Middleware with Redis Caching

```typescript
// shared/auth.ts
import { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';
import { redis } from './cache.js';

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ code: 'MISSING_TOKEN', message: 'Authorization required' });
  }

  const token = authHeader.replace('Bearer ', '');

  // Try Redis cache first
  const cached = await redis.get(`session:${token}`);
  if (cached) {
    const session = JSON.parse(cached);
    if (new Date(session.expiresAt) > new Date()) {
      req.user = { id: session.userId, role: session.role };
      return next();
    }
    // Expired - clean up
    await redis.del(`session:${token}`);
  }

  // Fall back to database
  const { rows } = await pool.query(`
    SELECT s.user_id, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = $1 AND s.expires_at > NOW()
  `, [token]);

  if (rows.length === 0) {
    return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Session expired or invalid' });
  }

  const session = rows[0];

  // Re-cache for next request
  const ttl = 3600; // 1 hour cache
  await redis.setex(`session:${token}`, ttl, JSON.stringify({
    userId: session.user_id,
    role: session.role,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString()
  }));

  req.user = { id: session.user_id, role: session.role };
  next();
}
```

### Frontend: Auth Store and Token Management

```typescript
// stores/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  user: User | null;
  isLoading: boolean;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isLoading: false,

      login: async (email, password) => {
        set({ isLoading: true });

        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        if (!response.ok) {
          set({ isLoading: false });
          const error = await response.json();
          throw new Error(error.message);
        }

        const { token, user } = await response.json();
        set({ token, user, isLoading: false });

        // Connect WebSocket with new token
        wsService.connect(token);
      },

      logout: async () => {
        const { token } = get();
        if (token) {
          await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
        }

        wsService.disconnect();
        set({ token: null, user: null });
      },

      checkSession: async () => {
        const { token } = get();
        if (!token) return false;

        const response = await fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          set({ token: null, user: null });
          return false;
        }

        const { user } = await response.json();
        set({ user });
        return true;
      }
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token })
    }
  )
);

// Helper hook
export function getToken(): string | null {
  return useAuthStore.getState().token;
}
```

---

## 6. API Contract Design (5 minutes)

### REST API Contracts

```typescript
// types/api.ts

// Authentication
interface LoginRequest {
  email: string;
  password: string;
}

interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'user' | 'admin';
  };
  expiresAt: string;
}

// Orders
interface PlaceOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
}

interface OrderResponse {
  order: {
    id: string;
    userId: string;
    symbol: string;
    side: 'buy' | 'sell';
    orderType: string;
    quantity: number;
    limitPrice: number | null;
    stopPrice: number | null;
    status: 'pending' | 'submitted' | 'filled' | 'partial' | 'cancelled' | 'rejected';
    filledQuantity: number;
    avgFillPrice: number | null;
    estimatedCost: number;
    createdAt: string;
    submittedAt: string | null;
    filledAt: string | null;
  };
}

// Portfolio
interface PortfolioResponse {
  buyingPower: number;
  positions: {
    symbol: string;
    quantity: number;
    avgCostBasis: number;
  }[];
}

// Error responses
interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
```

### WebSocket Protocol

```typescript
// types/websocket.ts

// Client to Server
type ClientMessage =
  | { type: 'subscribe'; symbols: string[] }
  | { type: 'unsubscribe'; symbols: string[] }
  | { type: 'subscribe_all' }
  | { type: 'unsubscribe_all' }
  | { type: 'ping' };

// Server to Client
type ServerMessage =
  | { type: 'connected'; data: { authenticated: boolean } }
  | { type: 'quotes'; data: Quote[] }
  | { type: 'quote_batch'; data: Quote[] }
  | { type: 'alert'; data: PriceAlert }
  | { type: 'pong' }
  | { type: 'error'; data: { code: string; message: string } };

interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: number;
}

interface PriceAlert {
  id: string;
  symbol: string;
  targetPrice: number;
  condition: 'above' | 'below';
  triggered: boolean;
}
```

---

## 7. Trade-offs Summary

| Decision | Chose | Alternative | Trade-off |
|----------|-------|-------------|-----------|
| Token Storage | localStorage | httpOnly cookie | WebSocket auth flexibility vs XSS protection |
| Session Caching | Redis + PostgreSQL | Redis only | Durability vs simplicity |
| Quote Delivery | Batched (50ms) | Individual | Efficiency vs latency |
| Idempotency | Client-generated UUID | Server-generated | Offline capability vs simplicity |
| Order Validation | Zod (both ends) | Backend only | Type safety vs duplication |
| State Management | Zustand | React Query | Simpler WebSocket integration vs caching |

---

## 8. Future Enhancements

1. **Optimistic Order Updates** - Show pending order in UI before server confirms
2. **Offline Order Queue** - Queue orders when disconnected, sync on reconnect
3. **GraphQL Subscriptions** - Alternative to custom WebSocket protocol
4. **Rate Limiting UI** - Show user when they're approaching rate limits
5. **Session Refresh** - Automatic token refresh before expiry
6. **Cross-Tab Sync** - Sync auth state across browser tabs with BroadcastChannel
