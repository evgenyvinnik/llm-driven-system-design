# Coinbase Frontend — System Design Answer

## 45–50 minute interview walkthrough

## Opening — 2 minutes

“I’ll design the frontend for a crypto exchange: market overview, trading view, order book, order form, portfolio, and order history. The hard part is not displaying a price. It is deciding which updates may be dropped for performance, which financial events must be lossless, and how the UI makes stale data impossible to mistake for live data.”

| Stage | Exchange frontend focus | Approximate time |
|---|---|---:|
| Requirements | Latency, precision, users, and risk | 4 min |
| Architecture | REST, WebSocket, stores, rendering, workers | 8 min |
| Data model | Decimal values, snapshots, sequences, order states | 6 min |
| Interfaces | HTTP, WebSocket, subscriptions, component contracts | 8 min |
| Optimizations/deep dives | Frame budgets, reconnection, security, accessibility | 18–22 min |
| Wrap-up | Trade-offs and scaling limits | 3 min |

## R — Requirements — 4 minutes

### Clarifying questions

I would ask:

- Is this a retail exchange for occasional users or a professional trading terminal?
- What latency target applies to market display and to order acknowledgement?
- Which streams are public, and which require authentication?
- Must the order book be exact at every level, or can depth visualization be approximate?
- What precision and rounding rules apply to each trading pair?
- What happens if the browser disconnects after an order is submitted but before the response arrives?
- Do we need multiple tabs, mobile browsers, accessibility, and reduced-motion support?

For this answer I’ll assume a retail-to-active-trader product, public market data, private portfolio and order channels, sub-100ms visible market updates for the active pair, exact decimal order calculations, and a browser that can sleep or change networks.

### Functional requirements

1. Show a market overview with pairs, prices, changes, and sparklines.
2. Show a trading view with candles, order book, recent trades, and buy/sell form.
3. Let authenticated users place, cancel, and observe orders.
4. Show portfolio balances and order history.
5. Recover from connection loss without silently presenting stale prices.
6. Preserve order correctness when a POST response is lost or delayed.
7. Provide keyboard, screen-reader, and non-color status alternatives.

### Non-functional requirements

- Tick-to-visible-price latency below 100ms for the active trading pair.
- Sustained 60fps during normal order-book updates.
- No floating-point arithmetic for user-actionable money.
- Bounded memory and DOM work when watching many pairs.
- Explicit freshness and sequence health for book, candles, and private orders.
- Reconnect and resync without requiring a full page reload.

### Out of scope

I will treat matching, custody, risk engines, ledger storage, and market-data fanout as server black boxes. I will define their frontend-facing protocols. I will not design the exchange’s pricing algorithm or blockchain settlement.

## A — Architecture — 8 minutes

### High-level diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                       React SPA (Vite + TypeScript)                         │
│ Routes: / market overview · /trade/$symbol chart/book/form                 │
│         /portfolio holdings/allocation · /orders history                   │
│                                                                            │
│ ┌──────────────┐ ┌───────────────┐ ┌──────────────────┐ ┌───────────────┐ │
│ │ authStore    │ │ marketStore   │ │ portfolioStore   │ │ orderStore    │ │
│ │ session and  │ │ prices, book, │ │ wallets, orders, │ │ drafts and    │ │
│ │ capabilities │ │ candles       │ │ holdings         │ │ lifecycle     │ │
│ └──────────────┘ └───────▲───────┘ └────────▲─────────┘ └──────▲────────┘ │
│                          │ push             │ fetch             │ commands │
│ ┌────────────────────────┴───────┐ ┌───────┴─────────┐ ┌──────┴────────┐ │
│ │ WebSocket service               │ │ REST data layer │ │ Render        │ │
│ │ channels · sequence · backoff   │ │ snapshots ·     │ │ adapters      │ │
│ │ reconnect · resync              │ │ cache · retries │ │ chart · book  │ │
│ └─────────────────────────────────┘ └─────────────────┘ └───────────────┘ │
│ Workers where justified: book aggregation, decimal helpers, shared tabs    │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ HTTPS / WSS
                        ┌────────────▼─────────────┐
                        │ Exchange API boundary    │
                        │ snapshots · commands     │
                        │ public/private streams   │
                        └──────────────────────────┘
```

### Two data paths

The pull path uses REST for initial snapshots, portfolio views, order history, and commands. It is cacheable, request/response oriented, and easy to retry when the operation is safe.

The push path uses a singleton WebSocket service for public market streams and authenticated private order events. Components declare channel interest; they do not open sockets themselves. The service reference-counts subscriptions and exposes connection health.

Keeping the paths separate prevents one abstraction from hiding important differences. A portfolio query can use a server-state cache. A price stream needs sequence handling and frame scheduling. An order command needs idempotency and an unknown state after timeout.

### Rendering architecture

React owns route composition, controls, semantics, and lifecycle. A canvas chart adapter owns the imperative chart instance. The order-book view receives fixed render-ready rows and uses memoized row components. A Web Worker can aggregate deep book data when the main thread cannot meet the frame budget.

The alternative is to pass every WebSocket message through React props and let the DOM represent every candle and depth level. That is easy to explain but fails under burst rates because component reconciliation and layout become part of the market-data hot path.

## D — Data Model — 6 minutes

### Server-originated entities

| Entity | Owner in the client | Important fields | Correctness rule |
|---|---|---|---|
| `MarketMetadata` | market store | symbol, tick size, step size, status | authoritative pair rules |
| `Ticker` | market store | bid, ask, last, change, sequence, server time | newest value may replace older display |
| `CandleSeries` | chart adapter | interval, ordered candles, sequence | baseline plus ordered updates |
| `OrderBookSnapshot` | book store/worker | bids, asks, sequence, checksum | gaps force resync |
| `Order` | order store | ID, side, price, quantity, status, fills, version | every lifecycle event matters |
| `Balance` | portfolio store | asset, available, held, decimal strings | server-authoritative |
| `ConnectionHealth` | shell | channel, state, stale age, last sequence | stale state must be visible |

### Client-owned entities

| Entity | Lifecycle | Purpose |
|---|---|---|
| `OrderDraft` | ephemeral | side, quantity string, price string, validation |
| `SubscriptionSet` | service lifetime | desired symbols and channels |
| `RenderSnapshot` | derived per frame | values safe for chart/book presentation |
| `PendingCommand` | until resolved | idempotency key, command, unknown state |
| `ViewPreferences` | persisted locally | selected symbol, interval, layout, depth |

### Lossy versus lossless data

Market ticker values are lossy for display. If three updates arrive before the next animation frame, the newest value supersedes the other two.

Order events are lossless. A partial fill followed by a fill cannot be collapsed because the state machine and audit trail depend on both events, even if the UI eventually paints only the final status.

Presence-like connection metadata is best effort. It can be refreshed or recomputed and should never block an order command.

### State machines

The market stream moves from disconnected to connecting, connected, stale, resyncing, and back to connected. The order command moves from draft to submitting, accepted, partially filled, filled/cancelled, rejected, or unknown after a lost response.

These states are intentionally separate from a generic `loading` boolean. The trading chart can be connected while a portfolio request is loading. An order can be unknown while public prices remain live.

## I — Interfaces — 8 minutes

### Server-facing API

``` 
GET  /api/markets?symbols=...              → market metadata and ticker snapshot
GET  /api/candles/:symbol?interval=...     → ordered candle snapshot
GET  /api/order-book/:symbol               → book snapshot with sequence/checksum
GET  /api/orders?status=...                → authenticated order history
GET  /api/portfolio                        → authenticated balances and holdings
POST /api/orders                           → place order with idempotency key
POST /api/orders/:id/cancel                → cancel an open order
GET  /api/orders/by-command/:key           → resolve an unknown command
WSS  /ws                                   → public and private channels
```

The order request carries symbol, side, order type, decimal-string quantity, optional decimal-string price, pair version, and idempotency key. The server returns a canonical order and status. If the response is lost, the client looks up the same command key; it never retries with a new identity.

Each stream message carries channel, symbol, sequence, event time, and payload. A book snapshot carries a checksum or equivalent integrity marker. The client applies deltas only after establishing the baseline sequence.

### Client interfaces

| Interface | Inputs | Output/event | Responsibility |
|---|---|---|---|
| `MarketSubscription` | symbols, channels | ticker/candle snapshots | reference-counted channel interest |
| `OrderBookAdapter` | snapshot and ordered deltas | fixed render rows | sequence validation and depth formatting |
| `ChartAdapter` | candles, dimensions, theme | canvas rendering | imperative high-frequency updates |
| `OrderForm` | pair rules, balances, draft strings | validated order command | exact decimal validation |
| `CommandResolver` | idempotency key, timeout | canonical order or unknown | safe recovery after lost response |
| `ConnectionBanner` | channel health | retry/resync intent | exposes freshness and recovery |

The socket service does not expose raw wire messages to components. That keeps protocol parsing, authentication renewal, sequence checks, and telemetry in one place.

### WebSocket lifecycle

1. Open the socket with public channel capability.
2. Authenticate private channels only after session validation.
3. Send desired subscriptions and record acknowledgements.
4. Establish snapshots and sequence baselines.
5. Apply ordered deltas and publish render snapshots.
6. On gap, checksum failure, or timeout, mark the channel stale.
7. Fetch a new snapshot, verify it, and resume.
8. On close, reconnect with exponential backoff and jitter.

## O — Optimizations and Deep Dives — 18–22 minutes

### Deep dive 1: WebSocket versus SSE versus polling

WebSockets are my default because the client needs dynamic channel subscriptions and private order events. They provide low-latency bidirectional communication but require reconnection, authentication renewal, resubscription, and sequence recovery.

Polling is simpler and cacheable, but polling market data at sub-second rates creates request overhead and uneven latency. It can remain the right choice for portfolio and history screens.

SSE is a credible option for public server-to-client market streams. It has simpler one-way semantics and works well with HTTP infrastructure, but private commands still need REST and dynamic subscription management is less natural. I would consider SSE for a read-only market overview, not the full trading surface.

### Deep dive 2: Frame budget and update policy

The naïve design updates a React store for every tick. That lets the system preserve every intermediate value but causes render storms. I would buffer droppable market updates and flush once per animation frame. A ticker display shows the newest value; the intermediate values had no chance to be observed.

The order book is different. A worker can aggregate raw levels and send a bounded set of render rows to the main thread. Rows are keyed by price and memoized. Depth bars use transforms or canvas to avoid repeated layout. The active chart uses canvas so a thousand candles do not become thousands of DOM nodes.

The trade-off is that debugging becomes harder and the UI no longer mirrors every wire event. That is acceptable because the order state machine retains lossless events and the market view is explicitly a sampled presentation.

### Deep dive 3: Decimal strings and fixed-point arithmetic

The backend serializes price and quantity as decimal strings. `Number` is suitable for geometry but unsafe for orderable money at 18 decimal places. The client uses a small fixed-point utility or BigInt-scaled representation for multiply, add, compare, step-size validation, and rounding policy.

Display formatting is separate from arithmetic. A chart can convert values to numbers after the precision boundary because a pixel coordinate does not need eighteen decimals. The order form never uses parseFloat as its source of truth.

The type contract should make monetary fields visibly different from ordinary numbers. Tests cover trailing zeros, maximum precision, rounding direction, minimum order size, and quantity times price.

### Deep dive 4: Snapshot, sequence, and resync

An order book delta without a trusted snapshot is not meaningful. On route entry, the client obtains a snapshot and records its sequence. It then applies only deltas that extend the sequence. If a message is missing, duplicated, or fails a checksum, the client stops updating the affected view, shows stale state, fetches a new snapshot, verifies it, and resumes.

Replaying a guessed set of deltas is faster in the happy path but risks showing a plausible, incorrect book. In a financial UI, correctness is worth the extra snapshot request.

### Deep dive 5: Unknown order after timeout

A disabled submit button prevents accidental double clicks but cannot solve a network timeout after the server accepted an order. The client generates one idempotency key per user command and stores it through retries. After a timeout, the UI says “checking order status,” not “order failed.” It resolves through a command lookup or private order event.

The alternative is to let the user retry with a new key. That makes the system responsive but can create two orders. The protocol-level identity is the real guarantee; button state is only a usability aid.

### Accessibility and trust signals

The UI states which channel is stale and when it was last updated. It does not announce every price tick to a screen reader. Order status changes are announced with text. Positive and negative movement use signs or labels in addition to color. The order book provides a table alternative for users who cannot interpret depth bars.

The chart canvas is not the only way to navigate. Keyboard users can choose symbols, change intervals, focus quantity and price fields, submit or cancel, and inspect validation errors without relying on pointer interaction.

### Security boundaries

Public market channels and private trading channels are separate capabilities. The browser stores no signing secret. An idempotency key identifies a command but does not authorize it. The server validates session, account permissions, pair status, balances, precision, risk limits, and order size.

Private portfolio and order data are isolated from public market caches. Logout closes private subscriptions and clears private stores. A SharedWorker may share public market data across tabs, but it must not accidentally share private account events between identities.

### Route lifecycle and loading policy

The market overview can render public cached prices before authentication finishes. The trade route needs three independent readiness signals: market data, account permissions, and instrument configuration. I would not block the whole route on a private portfolio request because a user should still inspect the order book when the account endpoint is slow.

Route loaders fetch the initial REST snapshot and pass it into the domain store. The WebSocket service subscribes after the symbol is known. On a symbol change, it removes old public channels before adding new ones, while the chart adapter resets its viewport and sequence marker.

Every snapshot and stream message carries symbol, channel, and sequence metadata before reaching a selector. This prevents a late response for the previous symbol from populating the new route.

### Market data fan-in

The chart, ticker, order book, and asset list may all want market data. They declare channel requirements to one service instead of opening duplicate sockets or REST requests. The service reference-counts channels and publishes normalized updates to the market store.

For a high-rate symbol, the store keeps the latest raw update while a render scheduler publishes a bounded render snapshot. The chart may receive one update per animation frame, while order-state transitions and sequence gaps are processed immediately. Visual coalescing must never drop correctness-sensitive events.

### Order submission lifecycle

The order form owns a draft with decimal strings, side, order type, price, quantity, and a client-generated idempotency key. Local validation checks obvious constraints; the server performs authoritative balance, risk, and tick-size validation.

After submit, the form enters submitting and prevents duplicate commands without disabling navigation. A successful command creates an acknowledged order state. A timeout creates unknown rather than failed: the client queries by idempotency key or order ID before offering another submit.

### Testing and observability

I would test reducers with deterministic snapshot-plus-delta sequences, including duplicates, gaps, reconnects, and out-of-order REST responses. Render adapters need performance tests with synthetic depth and candle counts, not only component snapshots.

Client telemetry records connection duration, reconnect count, resync count, dropped render frames, order latency, and unknown-command recovery. It must not record private quantities or balances by default. These measurements distinguish network freshness from worker cost and main-thread rendering.

### Capacity assumptions and extension decisions

I would size the first version around one active trading symbol, a few hundred visible market rows, and a book depth that can be rendered within one frame. Those numbers are test fixtures, not correctness limits; they help identify the browser bottleneck before a production feed does.

If the overview grows to thousands of assets, the route subscribes only to visible rows and uses a lower-frequency summary channel for off-screen assets. If users open several trade tabs, public channels can be shared through a worker, while private channels stay scoped to an authenticated identity.

If charting becomes a platform capability, I would expose a render adapter contract with normalized candles, viewport commands, and accessibility summaries. I would not turn every chart into an independent iframe by default. A module boundary or registry gives teams ownership without paying for a browser runtime per panel; an iframe is justified for untrusted extensions or a separate security domain.

The same principle applies to the order book. It is an independently testable feature boundary, but hard isolation complicates keyboard focus, resize, theme, and high-frequency data coordination. I would use error and worker boundaries first, then add a stronger process boundary only when trust or crash containment requires it.

### Failure matrix

| Failure | UI behavior | Recovery |
|---|---|---|
| Socket disconnects | stale banner and cautious controls | reconnect with jitter |
| Sequence gap | pause affected stream | snapshot and verify |
| Order POST timeout | unknown status | lookup by command key |
| Private auth expires | public market remains visible | renew and resubscribe |
| Worker fails | bounded fallback path | restart and resync |
| Hidden tab | reduce subscriptions | restore on focus |

### Alternative architecture review

The simplest alternative is a single React tree where every component owns its fetch and subscribes directly to a socket. It has low ceremony, but it couples transport lifecycle to route lifecycle and makes duplicate subscriptions likely.

The opposite extreme is an iframe per chart or order-book panel. It provides hard dependency and crash isolation, but every frame pays for its own runtime, authentication handoff, resize protocol, and accessibility integration. I would reserve it for untrusted code or a separate security domain.

Module Federation or a versioned local registry is a middle option. It supports team ownership and independently released render adapters while preserving a shared shell, store contract, and browser runtime. I would adopt it for a chart family after the data and accessibility contracts are stable, not as the first abstraction.

### Presentation checkpoints

At the end of requirements, I confirm that the browser is not the exchange and that market freshness, order correctness, and account privacy have different priorities.

At the end of architecture, I trace one route from initial REST snapshot through WebSocket updates, normalized store, render adapter, and freshness indicator.

At the end of data modeling, I explain which values may be coalesced and which events must be durable.

At the end of interfaces, I walk through a sequence gap and an order timeout because those cases reveal whether the design is actually safe.

At the end of optimization, I return to the frame budget and show which work is moved to a worker, which work is scheduled, and which work is never dropped.

These checkpoints keep the presentation architectural rather than turning into a tour of chart components.

### Implementation sequence

1. Build route composition, auth context, and a REST-only market overview.
2. Add normalized market state and one public WebSocket channel.
3. Add sequence validation, stale banners, reconnect, and resync.
4. Add chart and book render adapters with frame-budget measurements.
5. Add private portfolio queries and the idempotent order lifecycle.
6. Add worker aggregation and multi-tab sharing only after profiling.

This order makes the safe fallback usable before optimizing the hot path. It also prevents a worker or shared socket from hiding protocol bugs during the first implementation.

### What I would validate first

I would load-test the active book and chart together, because their combined frame cost matters more than either component in isolation. I would simulate packet loss and delayed messages, not only a clean socket.

I would test an order timeout after server acceptance and verify that recovery never creates a second command. I would also test logout during a reconnect so private data is cleared before a new subscription is attempted.

The success criteria are trustworthy freshness labels, bounded input latency, deterministic resync, and an order lifecycle that never guesses after an ambiguous network failure.

## Performance and scaling

The first browser bottleneck is the active trading view: order-book updates, canvas work, and form interaction compete for the main thread. Workers and bounded render snapshots protect input.

The second is a market overview with hundreds of pairs. Virtualize rows, subscribe only visible symbols plus the active pair, and conflate hidden-market ticks. A SharedWorker can own one public socket for several tabs if its lifecycle and security policy support it.

The third is bundle cost. Route-split the chart and trading view so a portfolio user does not load the full charting stack. Load heavy adapters only when the route requires them.

I would measure tick-to-pixel latency, dropped frames, worker transfer time, stale age, reconnect duration, order-command unknown rate, and heap growth after a long session.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Market transport | WebSocket | polling or SSE | dynamic subscriptions and private events |
| Public read-only transport | WebSocket-compatible abstraction | hard-code sockets in components | enables SSE or worker transport later |
| Tick rendering | frame-conflated newest value | render every tick | protects frame budget |
| Order events | lossless ordered state machine | generic last-write-wins store | fills cannot be dropped |
| Chart | canvas adapter | SVG/DOM chart | avoids layout cost at scale |
| Book aggregation | worker when depth grows | main thread forever | preserves input responsiveness |
| Money | strings and fixed-point utility | floating-point numbers | exact user-actionable values |
| Order retry | stable idempotency key | disabled button only | protects against lost responses |
| Snapshot recovery | pause and resync | apply uncertain deltas | financial correctness |
| State management | normalized stores with narrow selectors | one global context | limits re-render fan-out |

## Closing — 3 minutes

“The exchange frontend separates what may be dropped from what must be exact. Market ticks can be conflated per frame. Order events, balances, decimal calculations, and sequence integrity cannot. REST supplies snapshots and commands; WebSocket supplies live channels; stores normalize state; adapters protect rendering performance; freshness banners make failures visible.”

If time remains, I would discuss derivatives-specific risk displays, multi-tab synchronization, mobile battery behavior, and how to test the order state machine against out-of-order events.
