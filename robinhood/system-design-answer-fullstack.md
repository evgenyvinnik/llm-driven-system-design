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
│                │      BACKEND (Node.js + Express)                            │
│   ┌────────────▼──────────┐    ┌──────▼──────────────┐                      │
│   │   WebSocket Handler   │    │   REST API Routes   │                      │
│   │  - Token validation   │    │  - Auth middleware  │                      │
│   │  - Subscription mgmt  │    │  - Order validation │                      │
│   │  - Quote broadcasting │    │  - Portfolio queries│                      │
│   └───────────┬───────────┘    └──────────┬──────────┘                      │
│               │                           │                                  │
│   ┌───────────┴───────────────────────────┴───────────┐                     │
│   │                   Services Layer                   │                     │
│   │   ┌─────────┐  ┌─────────┐  ┌───────────────────┐ │                     │
│   │   │ Quote   │  │ Order   │  │    Portfolio      │ │                     │
│   │   │ Service │  │ Service │  │    Service        │ │                     │
│   │   └────┬────┘  └────┬────┘  └─────────┬─────────┘ │                     │
│   └────────┼────────────┼─────────────────┼───────────┘                     │
│            │            │                 │                                  │
│   ┌────────┴────────────┴─────────────────┴───────────┐                     │
│   │          PostgreSQL              Redis            │                     │
│   │   ┌────────────────────┐  ┌───────────────────┐  │                     │
│   │   │ users, orders,     │  │ quotes, sessions, │  │                     │
│   │   │ positions, sessions│  │ idempotency keys  │  │                     │
│   │   └────────────────────┘  └───────────────────┘  │                     │
│   └──────────────────────────────────────────────────┘                     │
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

### WebSocket Service Architecture

**Frontend WebSocketService responsibilities:**
- Connection management with token authentication
- Subscription tracking (Set of symbols)
- Message handlers by type (Map<string, Set<Function>>)
- Automatic reconnection with exponential backoff
- Resubscription on reconnect

**Backend WebSocket Handler responsibilities:**
- Token validation on connection
- Client state management (userId, subscriptions, heartbeat)
- Redis pub/sub subscription for quote updates
- Efficient broadcast (only send relevant quotes to subscribed clients)
- Heartbeat monitoring (30-second ping/pong)

### Quote Broadcasting Logic

```
┌─────────────────────────────────────────────────────────────────┐
│                    QUOTE UPDATE RECEIVED                         │
│                    (from Redis pub/sub)                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  FOR EACH CONNECTED CLIENT:                                      │
│    1. Check if WebSocket is OPEN                                 │
│    2. Filter quotes to only symbols client subscribed            │
│    3. If relevant quotes exist, send batch message               │
└─────────────────────────────────────────────────────────────────┘
```

"I batch quote updates every 50ms to reduce WebSocket message overhead. Individual quotes would create too much traffic, while longer batches would increase perceived latency."

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
```

### Idempotency Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    ORDER REQUEST RECEIVED                        │
│                  (with X-Idempotency-Key)                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  CHECK REDIS: idempotency:{key}                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│      KEY EXISTS      │        │    KEY NOT FOUND     │
│  Return cached       │        │  Process order       │
│  response            │        │  Store result        │
└──────────────────────┘        └──────────────────────┘
```

"Client-generated UUIDs for idempotency keys enable offline capability. Users can queue orders when disconnected, and duplicates are safely rejected when connectivity resumes."

### Order Validation Schema

Orders are validated using Zod with the following rules:
- **symbol**: 1-10 characters
- **side**: buy or sell
- **orderType**: market, limit, stop, stop_limit
- **quantity**: positive number
- **limitPrice**: required for limit and stop_limit orders
- **stopPrice**: required for stop and stop_limit orders

### Error Response Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| MISSING_IDEMPOTENCY_KEY | 400 | Header required |
| VALIDATION_ERROR | 400 | Invalid request body |
| INSUFFICIENT_FUNDS | 400 | Not enough buying power |
| INSUFFICIENT_SHARES | 400 | Not enough shares to sell |
| DUPLICATE_REQUEST | 409 | Order already processing |

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
```

### Session Validation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    REQUEST WITH BEARER TOKEN                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  CHECK REDIS: session:{token}                                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│    CACHE HIT         │        │    CACHE MISS        │
│  Validate expiry     │        │  Query PostgreSQL    │
│  Attach user to req  │        │  Re-cache if valid   │
└──────────────────────┘        └──────────────────────┘
```

### Dual Storage Strategy

| Storage | Purpose | TTL |
|---------|---------|-----|
| PostgreSQL | Source of truth, survives restarts | 24 hours |
| Redis | Fast validation, session caching | 1 hour (refreshed on use) |

"I store sessions in both PostgreSQL and Redis. PostgreSQL provides durability so sessions survive server restarts. Redis provides sub-millisecond validation for every authenticated request."

### Frontend Token Management

The frontend uses Zustand with persistence middleware:
- **Login**: Store token, user, connect WebSocket
- **Logout**: Clear token, disconnect WebSocket, call logout API
- **Session check**: Validate token on app load, clear if invalid

---

## 6. API Contract Design (5 minutes)

### REST API Contracts

**Authentication:**
- `POST /api/auth/login` - Returns token, user object, expiry
- `POST /api/auth/logout` - Invalidates session
- `GET /api/auth/me` - Returns current user

**Orders:**
- `POST /api/orders` - Place order (requires X-Idempotency-Key)
- `GET /api/orders` - List orders with optional status filter
- `DELETE /api/orders/:id` - Cancel pending order

**Portfolio:**
- `GET /api/portfolio` - Returns buying power and positions

### WebSocket Protocol

**Client to Server Messages:**

| Type | Payload | Description |
|------|---------|-------------|
| subscribe | symbols: string[] | Subscribe to quote updates |
| unsubscribe | symbols: string[] | Unsubscribe from symbols |
| subscribe_all | - | Subscribe to all available symbols |
| unsubscribe_all | - | Clear all subscriptions |
| ping | - | Heartbeat check |

**Server to Client Messages:**

| Type | Payload | Description |
|------|---------|-------------|
| connected | authenticated: boolean | Connection confirmed |
| quotes | Quote[] | Initial quotes for subscribed symbols |
| quote_batch | Quote[] | Batched quote updates |
| alert | PriceAlert | Triggered price alert |
| pong | - | Heartbeat response |
| error | code, message | Error notification |

### Quote Object Structure

| Field | Type | Description |
|-------|------|-------------|
| symbol | string | Stock ticker |
| bid | number | Best bid price |
| ask | number | Best ask price |
| last | number | Last trade price |
| volume | number | Trading volume |
| timestamp | number | Unix timestamp ms |

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
