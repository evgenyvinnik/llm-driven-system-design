# Coinbase (Crypto Exchange) - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 📋 Problem Statement

Design the web frontend for a cryptocurrency exchange: a live market overview, a trading view with a candlestick chart, an order book, and an order form, plus portfolio and order-history pages. What makes this frontend hard is that it is a **real-time rendering problem wearing a web app costume**: dozens of prices ticking multiple times per second, an order book that changes on every trade, and monetary values where JavaScript's native number type is not safe to use.

## 🎯 Requirements Clarification

Questions I'd ask before drawing anything:

- **Update latency?** Users watch prices to time trades — staleness is a product failure. Target: tick to pixel in under 100ms.
- **How much of the app is real-time?** Market overview and trading view are; portfolio and history can be fetch-on-navigation.
- **Precision guarantees?** Backend sends DECIMAL(28,18) values. The frontend must never lose that precision.

### Functional Requirements

- **Market overview**: All trading pairs with live price, 24h change, sparkline
- **Trading view** (per pair): OHLCV candlestick chart, order book depth, buy/sell form with market/limit modes
- **Portfolio**: Holdings with USD valuation and allocation breakdown
- **Orders**: Open/filled/cancelled list with cancellation
- **Auth**: Market data public; trading and portfolio behind login

### Non-Functional Requirements

- **Render latency**: price update visible < 100ms after server emit
- **Frame budget**: order book and tickers must not jank the chart — sustained 60fps on the trading view
- **Correctness**: zero floating-point arithmetic on monetary values
- **Resilience**: WebSocket drops (laptop sleep, network switch) must self-heal without user action

## 🏗️ High-Level Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       React SPA (Vite + TS)                    │
│                                                                │
│  Routes (TanStack Router)                                      │
│  ├─ /                → Market overview (asset list)            │
│  ├─ /trade/$symbol   → Chart + order book + trade form         │
│  ├─ /portfolio       → Holdings, allocation                    │
│  └─ /orders          → Order history                           │
│                                                                │
│  ┌──────────────┐   ┌───────────────┐   ┌──────────────────┐  │
│  │  authStore   │   │  marketStore  │   │  portfolioStore  │  │
│  │  (Zustand)   │   │ prices, book, │   │ wallets, orders, │  │
│  │              │   │ candles       │   │ holdings         │  │
│  └──────────────┘   └───────▲───────┘   └────────▲─────────┘  │
│                             │ push                │ fetch      │
│  ┌──────────────────────────┴────────┐   ┌────────┴─────────┐ │
│  │  WebSocket client (singleton)     │   │  REST client     │ │
│  │  channel subs, backoff reconnect  │   │  (credentials:   │ │
│  └──────────────────────────▲────────┘   │   include)       │ │
└─────────────────────────────┼────────────┴───────▲───────────┘
                              │ WSS                │ HTTPS
                     ┌────────┴────────────────────┴────────┐
                     │            Exchange API              │
                     └──────────────────────────────────────┘
```

Two data paths with different disciplines: **push** (WebSocket → marketStore → subscribed components) for anything a user watches in real time, and **pull** (REST on navigation/action) for anything transactional. Keeping them separate means the transactional path stays simple and cacheable while the real-time path gets all the performance engineering.

## 🔧 Deep Dive 1: The Real-Time Pipeline Without Re-Render Storms

The naive design — WebSocket handler calls `setState`, React re-renders — melts down here. Twelve pairs ticking every 2 seconds is fine; 500 pairs at production tick rates re-rendering an asset list is not.

**My structure:**

1. **One WebSocket connection, app-wide, owned by a singleton service** outside React. Components never open sockets; they declare channel interest through a hook (`useTickerSubscription('BTC-USD')`) that subscribes on mount and unsubscribes on unmount. The service reference-counts channels so two components watching BTC-USD produce one subscription.

2. **Store-mediated updates with per-symbol selectors.** Ticks land in a Zustand store keyed by symbol. A `PriceTicker` for BTC-USD selects only `prices['BTC-USD']`, so an ETH tick re-renders nothing but the ETH row. This is the single most important decision: fan-out filtering happens in the store subscription layer, not in component tree diffing.

3. **Batch and conflate at the boundary.** The socket service buffers incoming ticks and flushes to the store once per animation frame. If three BTC ticks arrive within one frame, only the last one is written — the intermediate prices were never going to be visible anyway.

> "I conflate market data deliberately: for a price display, the newest value supersedes older ones, so dropping intermediate ticks is free performance. But I never conflate the user's own order events — a 'partially filled' followed by 'filled' must both be seen by the state machine, even if only the last renders. Knowing which stream tolerates loss is the difference between a fast UI and a wrong one."

**Why not TanStack Query for everything?** Query is excellent for the pull path (portfolio, order history — and I'd use it there for caching and refetch). But server-push data inverts its model; polling market data at real-time rates through Query is strictly worse than a socket. Right tool per path.

## 🔧 Deep Dive 2: Rendering the Trading View at 60fps

The trading view stacks the three most expensive components in the app.

**Candlestick chart**: I use TradingView's `lightweight-charts`, which renders to **canvas**, not DOM. A chart with 1,000 candles as SVG/DOM is 4,000+ nodes that reflow on every update; canvas redraws pixels with no layout cost. The library is imperative, so I bridge it with a thin wrapper component: React owns the container's lifecycle, the chart instance lives in a ref, and data updates flow through the imperative API (`series.update(candle)`) driven by store subscriptions — **not** through React props. Passing the candle array as a prop would re-diff the wrapper on every tick for nothing.

**Order book**: 20 levels per side, changing constantly. Three rules keep it cheap:
- Fixed row count and fixed height — the book never causes layout shift; only text and bar widths change
- Depth bars are a `transform: scaleX()` on an absolutely-positioned background div — transforms skip layout and paint on the compositor where possible, versus `width:` changes which reflow the row
- Rows are memoized on (price, size) so an update touching 3 levels re-renders 3 rows, not 40

**Sparklines** in the market overview are tiny canvases, one per row — hundreds of DOM-based mini-charts would dwarf the cost of everything else on the page.

**Flash-on-change**: price cells flash green/red on movement. I do this with a CSS animation triggered by a key change, not a JS timer per cell — at 50 visible tickers, per-cell timers accumulate into main-thread noise.

## 🔧 Deep Dive 3: Money Is Strings — Precision at the Edge

The backend serializes every monetary value as a string ("65000.123456789012345678"). The moment the frontend calls `parseFloat`, precision dies silently — IEEE 754 doubles hold ~15–17 significant digits, and crypto quantities legitimately use 18 decimals.

**Rules I enforce:**

- **Display**: format strings directly — split on the decimal point, group the integer part, truncate (never round) the fraction to the pair's display precision. `Intl.NumberFormat` only after verifying the value fits in a double, which display-precision values do.
- **Arithmetic** (order form total = quantity × price): a small fixed-point decimal utility operating on scaled BigInt. Not a heavy dependency — the exchange needs multiply, add, compare.
- **Sorting/charting**: chart libraries take numbers; that's fine because pixel positions don't need 18 digits. The rule is scope: `Number` for geometry, strings/BigInt for anything the user could act on financially.

> "The trade-off is real friction — every engineer's instinct is `parseFloat`. I'd encode the rule in the type system: API responses type monetary fields as a branded `DecimalString` type, so passing one to an arithmetic function without going through the decimal utility is a compile error. Lint rules are advisory; types are enforced."

**The order form** builds on this: quantity input validated against the pair's step size, total computed in fixed-point, and a client-generated **idempotency key (UUID)** attached to every submission. If the user double-clicks Buy or the network retries, the backend returns the original order instead of placing a second one. The submit button disables in-flight, but the idempotency key is the real guarantee — UI state is advisory, the key is contractual.

## 🛡️ Connection Resilience

WebSocket drops are routine — laptop lid closes, WiFi to cellular handoff, corporate proxies idling out connections.

- **Exponential backoff reconnect**: 1s, 2s, 4s … capped at 30s, with jitter so a server restart doesn't produce a synchronized reconnect stampede
- **Resubscribe on reconnect**: the socket service keeps the desired-channel set as state, so recovery replays every active subscription without component involvement
- **Staleness honesty**: while disconnected, prices freeze — that's dangerous on a trading UI. After 5s without ticks the UI shows a "reconnecting, prices may be stale" banner and dims tickers. Users must never trade against a frozen number they believe is live
- **Re-sync on recovery**: after reconnecting, one REST fetch refreshes the order book and open orders; the socket resumes deltas from there. Missed-while-offline data comes from pull, not from replaying push

## 📱 State Management Layout

| Store | Contents | Update source |
|-------|----------|---------------|
| authStore | user, session status | REST (login/logout/me) |
| marketStore | pairs, per-symbol prices, candles, order book | WebSocket push + initial REST |
| portfolioStore | wallets, holdings, open orders | REST, refetched after order actions |
| Local component state | form inputs, modals, toggles | User interaction |

Zustand over Redux for footprint and selector-based subscriptions; over Context because Context re-renders every consumer on any change — precisely wrong for per-symbol price fan-out.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time transport | ✅ Single WebSocket + channels | ❌ Polling / per-component sockets | Sub-100ms push; one connection to manage |
| Tick handling | ✅ Conflate market data per frame | ❌ Render every tick | Newest price supersedes; frame budget preserved |
| Chart rendering | ✅ Canvas (lightweight-charts) | ❌ SVG/DOM charting | No reflow cost at 1000+ candles |
| Chart↔React bridge | ✅ Imperative updates via ref | ❌ Data as props | Avoids re-diffing wrapper on every tick |
| Monetary values | ✅ Strings + fixed-point BigInt | ❌ parseFloat everywhere | 18-decimal precision survives the UI |
| Global state | ✅ Zustand with per-symbol selectors | ❌ Context / Redux | Surgical re-renders on tick fan-out |
| Order submission | ✅ Client idempotency key | ❌ Disabled-button-only | Guarantee lives in the protocol, not UI state |
| Stale connection | ✅ Visible staleness banner | ❌ Silent freeze | Never let users trade a dead number |

## 📈 Scaling the Frontend

What breaks first as the product grows:

1. **Asset list at 500+ pairs** → virtualize with `@tanstack/react-virtual`; only visible rows subscribe to their symbols, so scrolled-away rows cost zero renders *and* zero socket traffic
2. **Bundle size** → route-level code splitting; the chart library loads only on `/trade/$symbol`; login/portfolio never pay for it
3. **Order book at 100+ visible levels with L2 data** → move book aggregation into a Web Worker, post only render-ready rows to the main thread
4. **Multi-tab users** → SharedWorker owning the single WebSocket, broadcasting to tabs — traders famously open six tabs, and six sockets waste server capacity and battery

## 🚀 Closing

The through-line of this design: **decide, per data stream, what is allowed to be dropped, what must be exact, and what must be visible when it's broken.** Market ticks are droppable, money math is exact, connection loss is loudly visible. A trading UI earns trust with those three disciplines more than with any visual polish.
