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

## 🧭 RADIO Map

| Stage | Exchange frontend focus |
|---|---|
| **R — Requirements** | Latency, precision, authenticated actions, and visible connection health |
| **A — Architecture** | REST snapshot path, WebSocket market path, stores, worker boundaries, and route-level code splitting |
| **D — Data model** | Decimal strings, market snapshots, order state machines, and client-only form state |
| **I — Interfaces** | REST endpoints, WebSocket messages, subscriptions, and order-command idempotency |
| **O — Optimizations** | Frame conflation, canvas rendering, workers, reconnection, and multi-tab sharing |

## 🗃️ Client Data Model

The client has two correctness classes: market data may be dropped or coalesced for rendering, while order events and balances must be processed in order. The model makes that distinction explicit.

| Source | Entity | Owner | Important fields |
|---|---|---|---|
| Server | `MarketSnapshot` | Market store | symbol, bid/ask, sequence, server time, freshness |
| Server | `CandleSeries` | Chart adapter | symbol, interval, ordered candles, last sequence |
| Server | `OrderBook` | Book store/worker | bids, asks, sequence, checksum, received time |
| Server | `Order` | Portfolio store | order ID, symbol, side, status, filled quantity, version |
| Server | `Balance` | Portfolio store | asset, available, held, decimal-string amounts |
| Client persisted | `SubscriptionSet` | Socket service | symbols, channels, desired connection state |
| Client ephemeral | `OrderDraft` | Order form | side, quantity string, price string, validation, submit state |
| Client derived | `ConnectionHealth` | Shell | connected, reconnecting, stale age, last sequence |

The WebSocket client owns transport state and sequence validation. Zustand or another store owns normalized domain state. React components subscribe to narrow selectors. The chart adapter owns its imperative canvas instance and consumes render-ready numbers only after the precision boundary has been crossed safely.

Order status is a state machine rather than a boolean loading flag: pending, accepted, partially filled, filled, cancelled, rejected, or unknown-after-disconnect. An order event with an older sequence is ignored; a gap triggers a REST resync before the UI presents the book or order as current.

## 🔌 Interface Contracts

### Server-facing API

```
GET  /api/markets?symbols=...              → initial tickers and market metadata
GET  /api/candles/:symbol?interval=...     → historical candles and sequence
GET  /api/order-book/:symbol               → authoritative book snapshot
GET  /api/orders?status=...                → authenticated order history
GET  /api/portfolio                        → authenticated balances and holdings
POST /api/orders                           → place order with idempotency key
POST /api/orders/:id/cancel                 → cancel an open order
WSS  /ws                                   → market, book, and private order channels
```

The WebSocket handshake authenticates private channels separately from public market channels. Every delta carries a channel, symbol, sequence, event time, and payload. The client acknowledges subscriptions but does not treat an acknowledgement as proof that the market snapshot is current; the first snapshot and sequence establish that baseline.

The order API returns a canonical order with server status and accepted quantities. A timeout after submission produces an `unknown` client state and triggers lookup by idempotency key or client command ID. The client never retries a financial mutation with a new key.

### Client-facing interfaces

| Interface | Inputs | Output/event | Main invariant |
|---|---|---|---|
| `useMarketSubscription` | symbols, channels | render-ready snapshot stream | reference-counted subscriptions |
| `OrderBookAdapter` | snapshot, ordered deltas | fixed rows for the view | sequence gaps force resync |
| `ChartAdapter` | candle snapshot/delta, dimensions | canvas rendering | React does not re-diff every tick |
| `OrderForm` | pair metadata, balances, draft strings | validated order command | no unsafe floating-point arithmetic |
| `ConnectionBanner` | connection health | reconnect/resync action | stale data is visible to the user |

This API boundary keeps the socket service independent of the chart and order book implementations. It also allows a SharedWorker to become the transport owner later without changing route components.

## 📈 Scaling and Failure Modes

At 500 symbols, subscribing every visible and hidden route to every channel wastes bandwidth. I would keep a desired subscription set at the application level, reference-count consumers, and subscribe only visible market rows plus the active trading pair. A SharedWorker can share one connection across tabs when browser support and security policy allow it.

At a sequence gap, the client should stop applying deltas, mark the affected view stale, fetch a fresh snapshot, verify its sequence, and resume. Replaying deltas without a verified baseline risks displaying an order book that looks plausible but is financially wrong.

The main-thread budget is protected by three choices: coalesce droppable market ticks per animation frame, move order-book aggregation to a worker when depth grows, and keep order events lossless. The alternative is to render every message immediately, which preserves an event trace but makes the chart and input jank under burst traffic.

## 🧪 Verification Strategy

- Decimal arithmetic tests cover multiplication, rounding policy, step size, and display precision.
- WebSocket contract tests cover subscription acknowledgements, sequence gaps, duplicate events, and reconnect resync.
- Order state-machine tests cover out-of-order fills, cancellation races, and unknown-after-timeout recovery.
- Performance tests measure tick-to-pixel latency, frame drops, heap growth, and worker transfer cost.
- Browser tests verify that stale prices are announced and that keyboard users can submit or cancel without relying on color.

## 🧭 End-to-End Market and Order Flow

The trading view has one read path and one command path, connected by explicit sequence and freshness rules:

```
REST snapshot ───────┐
                      ▼
                normalized store ──▶ chart / book / ticker views
                      ▲
WSS ordered deltas ───┘

Order form ──validated command + idempotency key──▶ REST order API
                                                       │
Private order events ◀──────── WSS authenticated channel
```

On route entry, the client fetches market metadata, a candle snapshot, an order-book snapshot, portfolio data, and open orders according to priority. It records the snapshot sequence before accepting deltas. The socket then applies only messages that extend that sequence. If a gap or checksum failure occurs, the affected stream pauses and resynchronizes.

An order submission is a separate lifecycle from market rendering. The form validates decimal strings and step sizes locally, sends one command ID, and enters an unknown state if the response is lost. A later private order event or idempotent lookup resolves the state. The market chart may continue updating while the order form waits.

## 📡 Transport and Interface Choices

| Data | Transport | Freshness/correctness rule | Why |
|---|---|---|---|
| Public ticker | WebSocket | newest value wins | high volume, droppable intermediates |
| Order book | WebSocket + REST snapshot | sequence and checksum required | deltas need a trusted baseline |
| Candles | REST snapshot + socket updates | interval boundary and sequence | chart can coalesce within a frame |
| Portfolio | REST | refetch after order events | authenticated, lower frequency |
| Order lifecycle | private WebSocket + REST lookup | lossless state transitions | every fill matters |

```
GET  /api/markets?symbols=...              → public market metadata and ticker snapshot
GET  /api/candles/:symbol?interval=...     → ordered candle snapshot
GET  /api/order-book/:symbol               → book snapshot with sequence/checksum
GET  /api/orders?status=...                → authenticated order history
GET  /api/portfolio                        → balances and holdings as decimal strings
POST /api/orders                           → place order with idempotency key
POST /api/orders/:id/cancel                → cancel an open order
WSS  /ws                                   → public and private channels
```

The socket client exposes subscription, snapshot, delta, stale, and resync events. Components do not parse wire messages directly. That interface lets the transport change from a browser WebSocket to a SharedWorker or a server-sent event stream for selected channels without changing the chart or book.

## ♿ Accessibility and Trust Signals

The trading view must communicate more than numbers. A stale banner states which streams are stale and when they were last updated. Order status changes are announced in a polite live region, while high-frequency price changes are not announced on every tick. Keyboard users can switch markets, focus the order form, change side, review validation errors, and reach cancel actions without using the chart canvas.

Color is never the only signal for price movement or order status. Positive/negative movement includes a sign or text label, and order states use status text plus icons. The order book has a tabular alternative for users who cannot interpret depth bars.

## ⚖️ Deep Trade-off: WebSocket, SSE, or Polling

WebSockets are the best default for this exchange because the client needs bidirectional subscriptions and private order events. Polling is simpler and easier to cache, but at sub-second market rates it creates latency and request overhead. SSE is a credible alternative for public server-to-client market streams, but it still needs a separate HTTP command path and is less natural for dynamic channel subscriptions.

The cost of WebSockets is connection lifecycle complexity: reconnect backoff, resubscription, sequence recovery, authentication renewal, and multi-tab coordination. I accept that cost for the trading view because stale prices and delayed fills are product correctness failures, not merely performance problems. For portfolio pages, REST remains simpler and preferable.

## 🚨 Failure Matrix

| Failure | User-visible state | Recovery |
|---|---|---|
| Socket disconnects | stale banner and disabled risky actions | reconnect with jitter and resubscribe |
| Sequence gap | book/chart marked stale | pause deltas, fetch snapshot, verify sequence |
| Order POST timeout | order status unknown | lookup by idempotency key or private event |
| Private channel auth expires | market stays public, private data marked stale | renew session and resubscribe |
| Worker crashes | fallback to bounded main-thread path | restart worker and resync derived state |
| Tab hidden | reduced subscriptions and refresh rate | restore visible channels on focus |

The key principle is to degrade the least dangerous thing first. A sparkline can freeze briefly; an order book must declare staleness; a financial command must never be replayed with a new identity.

## 🧩 Stream and Order State Machines

### Market stream

| State | Entry event | Allowed actions | Exit event |
|---|---|---|---|
| Disconnected | route entry or socket close | connect with backoff | connected or retrying |
| Connected | verified subscription | apply ordered deltas | stale or gap |
| Stale | heartbeat timeout or sequence gap | stop affected updates, request snapshot | resynced or disconnected |
| Resyncing | snapshot request | buffer or discard deltas according to sequence | connected or failed |

### Order command

| State | Meaning | Recovery |
|---|---|---|
| Draft | local decimal strings and validation | edit fields |
| Submitting | command sent with stable idempotency key | wait, cancel if supported |
| Unknown | response lost after send | lookup or private event |
| Accepted | server created the order | follow private lifecycle |
| Rejected | server refused the command | show canonical reason |
| Partially filled | some quantity executed | process every event |
| Filled/cancelled | terminal state | refresh balances and history |

Writing these states down keeps market freshness and order correctness from being accidentally handled by the same generic loading flag. A market tick can be replaced. An order fill cannot.

## 🔐 Security and Permission Boundaries

Public market channels and private trading channels should be separate capabilities. The client may hide the order form when unauthenticated, but the server authenticates the private socket channel and validates every order against account permissions, balances, pair rules, and risk limits.

The browser stores no signing secret. An idempotency key identifies a command; it does not authorize it. Decimal strings are validated at the UI boundary, then validated again by the server. The client cache must separate public market data from private balances and orders, and logout must tear down private subscriptions immediately.

The alternative is to let one authenticated WebSocket carry every public and private message. That is operationally convenient, but it increases blast radius during token renewal and makes accidental private-data fan-out easier. Separate channel capabilities give the shell more explicit failure and privacy behavior.

## 📏 Performance Budget

- Tick-to-visible-price latency: under 100ms for the active symbol.
- Trading view: sustained 60fps during normal book updates.
- Order-book update: bounded work per animation frame, with aggregation offloaded as depth grows.
- Initial route: render shell and last safe snapshot before loading non-critical history.
- Reconnect: show stale state within five seconds and resync without blocking navigation.

The budgets drive the architecture. Canvas, narrow selectors, frame conflation, workers, and route-level code splitting are not generic optimizations here; they directly protect the trading interaction and financial trust.

## 📈 Scaling the Frontend

What breaks first as the product grows:

1. **Asset list at 500+ pairs** → virtualize with `@tanstack/react-virtual`; only visible rows subscribe to their symbols, so scrolled-away rows cost zero renders *and* zero socket traffic
2. **Bundle size** → route-level code splitting; the chart library loads only on `/trade/$symbol`; login/portfolio never pay for it
3. **Order book at 100+ visible levels with L2 data** → move book aggregation into a Web Worker, post only render-ready rows to the main thread
4. **Multi-tab users** → SharedWorker owning the single WebSocket, broadcasting to tabs — traders famously open six tabs, and six sockets waste server capacity and battery

## 🚀 Closing

The through-line of this design: **decide, per data stream, what is allowed to be dropped, what must be exact, and what must be visible when it's broken.** Market ticks are droppable, money math is exact, connection loss is loudly visible. A trading UI earns trust with those three disciplines more than with any visual polish.
