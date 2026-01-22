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
│                              Browser / Mobile App                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         React Application                           │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │    │
│  │  │  Portfolio  │  │   Trading   │  │  Watchlist  │  │   Stock     │ │    │
│  │  │  Dashboard  │  │    View     │  │    View     │  │   Detail    │ │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │    │
│  │         └────────────────┴────────────────┴────────────────┘        │    │
│  │  ┌──────────────────────────────────────────────────────────────┐   │    │
│  │  │                    Shared Components                         │   │    │
│  │  │  QuoteTicker  │  OrderForm  │  PriceChart  │  PositionCard   │   │    │
│  │  └──────────────────────────────────────────────────────────────┘   │    │
│  │  ┌──────────────────────────────────────────────────────────────┐   │    │
│  │  │                      State Management                        │   │    │
│  │  │  quoteStore (Zustand) │ orderStore │ portfolioStore          │   │    │
│  │  └──────────────────────────────────────────────────────────────┘   │    │
│  │  ┌──────────────────────────────────────────────────────────────┐   │    │
│  │  │                     Service Layer                            │   │    │
│  │  │       WebSocketService (Quote Stream) │ API Client (REST)    │   │    │
│  │  └──────────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                  │                                  │
                  ▼                                  ▼
         ┌────────────────┐                 ┌────────────────┐
         │   WebSocket    │                 │   REST API     │
         │    Server      │                 │    Server      │
         └────────────────┘                 └────────────────┘
```

---

## 3. Deep Dive: Real-Time Quote Streaming (10 minutes)

### WebSocket Service Architecture

"I designed a robust WebSocket service with auto-reconnection. When the connection drops, it uses exponential backoff to avoid overwhelming the server during outages. The service maintains a subscription set so it can resubscribe to previously watched symbols after reconnecting."

```
┌─────────────────────────────────────────────────────────────────┐
│                    WebSocketService                             │
├─────────────────────────────────────────────────────────────────┤
│  State:                                                         │
│  ├── ws: WebSocket | null                                       │
│  ├── subscriptions: Set<string>                                 │
│  ├── reconnectAttempts: number                                  │
│  └── handlers: Set<QuoteHandler>                                │
├─────────────────────────────────────────────────────────────────┤
│  Connection Flow:                                               │
│                                                                  │
│  connect(token) ──▶ WebSocket.OPEN ──▶ resubscribe symbols     │
│        │                                                         │
│        ▼                                                         │
│  onclose ──▶ scheduleReconnect ──▶ exponential backoff          │
│              (delay * 2^attempts, max 30s)                      │
├─────────────────────────────────────────────────────────────────┤
│  Message Types:                                                  │
│  ├── quotes/quote_batch ──▶ notify quoteHandlers                │
│  ├── alert ──▶ handlePriceAlert                                 │
│  └── pong ──▶ heartbeat confirmation                            │
└─────────────────────────────────────────────────────────────────┘
```

### Quote Store Design

"The quote store uses Zustand with subscribeWithSelector middleware. This allows components to subscribe to specific symbols without re-rendering when unrelated quotes update. I preserve the previous close price to calculate daily change."

```
┌─────────────────────────────────────────────────────────────────┐
│                     Quote Store (Zustand)                       │
├─────────────────────────────────────────────────────────────────┤
│  State:                                                         │
│  ├── quotes: Map<symbol, Quote>                                 │
│  ├── connectionStatus: 'connected' | 'disconnected' | 'error'  │
│  └── lastUpdate: timestamp                                      │
├─────────────────────────────────────────────────────────────────┤
│  Quote Shape:                                                    │
│  { symbol, bid, ask, last, prevClose, volume, timestamp }       │
├─────────────────────────────────────────────────────────────────┤
│  Actions:                                                        │
│  ├── updateQuotes(quotes[]) ──▶ merge with prevClose preserved  │
│  ├── subscribe(symbols[]) ──▶ wsService.subscribe               │
│  └── unsubscribe(symbols[])                                     │
├─────────────────────────────────────────────────────────────────┤
│  Selector Hooks:                                                 │
│  ├── useQuote(symbol) ──▶ single quote subscription             │
│  ├── useQuotes(symbols[]) ──▶ batch subscription                │
│  └── useConnectionStatus() ──▶ connection state only            │
└─────────────────────────────────────────────────────────────────┘
```

### Quote Ticker Component

"The QuoteTicker component uses a ref to track the previous price and applies CSS flash animations for price changes. Green flash for upticks, red for downticks. The animation is CSS-based for GPU acceleration."

```
┌─────────────────────────────────────────────────────────────────┐
│                     QuoteTicker Component                       │
├─────────────────────────────────────────────────────────────────┤
│  Props: symbol, showChange?, size?                              │
├─────────────────────────────────────────────────────────────────┤
│  Rendering Logic:                                               │
│                                                                  │
│  quote.last > prevPrice ──▶ animate-flash-green (0.3s)          │
│  quote.last < prevPrice ──▶ animate-flash-red (0.3s)            │
│                                                                  │
│  Display: $123.45 +2.50 (+2.07%)                                │
│           └─price  └─change └─percent                           │
├─────────────────────────────────────────────────────────────────┤
│  Loading State: Skeleton with animate-pulse                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dive: Order Entry System (10 minutes)

### Order Form Architecture

"The order form uses React Hook Form with Zod validation. This gives us type-safe validation with conditional requirements - limit price is only required for limit orders, stop price only for stop orders. The form generates an idempotency key to prevent duplicate orders on retry."

```
┌─────────────────────────────────────────────────────────────────┐
│                      OrderForm Component                        │
├─────────────────────────────────────────────────────────────────┤
│  Form State (react-hook-form + zod):                            │
│  ├── side: 'buy' | 'sell'                                       │
│  ├── orderType: 'market' | 'limit' | 'stop' | 'stop_limit'     │
│  ├── quantity: number (positive)                                │
│  ├── limitPrice?: number (required if limit/stop_limit)         │
│  └── stopPrice?: number (required if stop/stop_limit)           │
├─────────────────────────────────────────────────────────────────┤
│  Validation Flow:                                               │
│                                                                  │
│  Input ──▶ Zod Schema ──▶ Conditional Refinements ──▶ Errors   │
│                              │                                   │
│                              ├── limit order? ──▶ require limit │
│                              └── stop order? ──▶ require stop   │
├─────────────────────────────────────────────────────────────────┤
│  Pre-submit Validation:                                         │
│  ├── Buy: estimatedCost <= buyingPower                          │
│  └── Sell: quantity <= position.quantity                        │
├─────────────────────────────────────────────────────────────────┤
│  Submit Flow:                                                    │
│  1. Generate idempotencyKey (crypto.randomUUID)                 │
│  2. Call placeOrder API                                         │
│  3. Reset form on success                                       │
│  4. Show OrderConfirmationModal                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Order Form UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌──────────────────────┬──────────────────────┐                │
│  │     Buy (green)      │     Sell (red)       │  Side Toggle   │
│  └──────────────────────┴──────────────────────┘                │
│                                                                  │
│  Order Type: [ Market ▼ ]                                       │
│                                                                  │
│  Shares: [ 1 ]                                                  │
│                                                                  │
│  (if limit) Limit Price: [ $150.00 ]                            │
│  (if stop) Stop Price: [ $145.00 ]                              │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Order Summary                                              ││
│  │  Market Price:     $150.25                                  ││
│  │  Estimated Cost:   $1,502.50                                ││
│  │  Buying Power:     $5,000.00                                ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  (validation warning if insufficient funds/shares)              │
│                                                                  │
│  [ Buy AAPL ]  (or "Placing Order..." with spinner)             │
└─────────────────────────────────────────────────────────────────┘
```

### Order Confirmation Modal

"The confirmation modal uses entrance animation and auto-closes after 3 seconds. This gives users confidence their order was received without requiring manual dismissal."

```
┌─────────────────────────────────────────────────────────────────┐
│                   Order Confirmation Modal                      │
├─────────────────────────────────────────────────────────────────┤
│                    ┌──────────┐                                  │
│                    │    ✓     │  (green checkmark)              │
│                    └──────────┘                                  │
│                                                                  │
│                    Order Placed!                                │
│           Buying 10 shares of AAPL                              │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Order Type:    Market                                  │    │
│  │  Limit Price:   $150.00                                 │    │
│  │  Status:        Pending                                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Animation: scale-95 → scale-100, opacity-0 → opacity-100       │
│  Auto-close: 3 seconds                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Portfolio Dashboard (8 minutes)

### Portfolio Store Architecture

"The portfolio store is separate from quotes to avoid coupling. I use a computed selector that combines portfolio positions with live quotes to calculate real-time P&L without duplicating data."

```
┌─────────────────────────────────────────────────────────────────┐
│                   Portfolio Store (Zustand)                     │
├─────────────────────────────────────────────────────────────────┤
│  State:                                                         │
│  ├── positions: Position[]                                      │
│  │   └── { symbol, quantity, avgCostBasis }                     │
│  ├── buyingPower: number                                        │
│  └── isLoading: boolean                                         │
├─────────────────────────────────────────────────────────────────┤
│  Actions:                                                        │
│  ├── fetchPortfolio() ──▶ GET /api/portfolio                    │
│  └── updateBuyingPower(delta)                                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│               usePortfolioValue() Selector                      │
├─────────────────────────────────────────────────────────────────┤
│  Combines: positions (portfolioStore) + quotes (quoteStore)     │
│                                                                  │
│  For each position:                                              │
│    marketValue = quantity * quote.last                          │
│    costBasis = quantity * avgCostBasis                          │
│                                                                  │
│  Returns:                                                        │
│  ├── totalValue: sum of all marketValues                        │
│  ├── totalCost: sum of all costBases                            │
│  ├── totalGainLoss: totalValue - totalCost                      │
│  └── totalGainLossPercent: (gainLoss / cost) * 100              │
└─────────────────────────────────────────────────────────────────┘
```

### Portfolio Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                     Portfolio Dashboard                         │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Portfolio Value                                            ││
│  │  $125,432.50  +$2,150.00 (+1.74%)                          ││
│  │               └─green if positive, red if negative          ││
│  │                                                              ││
│  │  Buying Power: $5,000.00  │  Total Account: $130,432.50    ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [Portfolio Chart - historical value over time]             ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Holdings                                                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  AAPL                              $15,025.00               ││
│  │  100 shares @ $145.00              +$525.00 (+3.62%)        ││
│  │  Today: +$125.00 (+0.84%)                                   ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │  GOOGL                             $28,750.00               ││
│  │  20 shares @ $1,400.00             +$350.00 (+1.23%)        ││
│  │  Today: -$50.00 (-0.17%)                                    ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Position Card Component

"Each position card subscribes only to its own symbol's quote using the useQuote selector. This means an AAPL price update won't cause the GOOGL card to re-render."

```
┌─────────────────────────────────────────────────────────────────┐
│                      PositionCard                               │
├─────────────────────────────────────────────────────────────────┤
│  Inputs: position { symbol, quantity, avgCostBasis }            │
├─────────────────────────────────────────────────────────────────┤
│  Computed Metrics (from useQuote + position):                   │
│  ├── marketValue = quantity * quote.last                        │
│  ├── costBasis = quantity * avgCostBasis                        │
│  ├── gainLoss = marketValue - costBasis                         │
│  ├── gainLossPercent = (gainLoss / costBasis) * 100             │
│  ├── todayChange = quantity * (quote.last - quote.prevClose)    │
│  └── todayChangePercent = (last - prevClose) / prevClose * 100  │
├─────────────────────────────────────────────────────────────────┤
│  Behavior:                                                       │
│  └── onClick ──▶ navigate to /stocks/$symbol                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Connection Status and Offline Handling (5 minutes)

### Connection Status Banner

"The connection banner only renders when disconnected. It shows the current state and provides a visual indicator of stale data. For reconnecting state, I animate the icon to show activity."

```
┌─────────────────────────────────────────────────────────────────┐
│                Connection Status States                         │
├─────────────────────────────────────────────────────────────────┤
│  connected ──▶ (no banner shown)                                │
│                                                                  │
│  disconnected:                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ [WiFiOff icon] Connection lost. Prices may be stale.       ││
│  │ (bg-red-500)                                                 ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  reconnecting:                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ [RefreshCw icon, spinning] Reconnecting...                  ││
│  │ (bg-amber-500)                                               ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  error:                                                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ [WiFiOff icon] Connection error. Retrying...                ││
│  │ (bg-red-500)                                                 ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Stale Data Indicator

"For individual quotes, I check if the timestamp is older than a threshold (default 5 seconds). If stale, I show a small clock icon next to the price. This is especially important for limit orders where stale prices could lead to unexpected fills."

```
┌─────────────────────────────────────────────────────────────────┐
│                   Stale Data Detection                          │
├─────────────────────────────────────────────────────────────────┤
│  Check: Date.now() - quote.timestamp > maxAge (5000ms)          │
│                                                                  │
│  If stale:                                                       │
│  ┌───────────────────────┐                                       │
│  │ [Clock icon] Delayed  │  (text-amber-500, text-xs)           │
│  └───────────────────────┘                                       │
│                                                                  │
│  Update check: setInterval every 1 second                       │
└─────────────────────────────────────────────────────────────────┘
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
