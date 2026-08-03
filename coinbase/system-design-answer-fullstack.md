# Coinbase Full-Stack — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Requirements | Trading and trust promises | 4 min |
| Architecture | Browser, API, matcher, ledger, streams | 8 min |
| Data model | Shared domain and client state | 6 min |
| Interfaces | REST, WebSocket, command lifecycle | 8 min |
| Deep dives | Precision, orders, rendering, recovery | 20 min |
| Trade-offs and close | Scaling path and rollout | 4 min |

## Opening — 2 minutes

I am designing a full-stack spot exchange experience. A user chooses a market, observes price and depth, submits an order, and sees the resulting order and balance state. The frontend must feel real time, while the backend must remain authoritative for matching, permissions, and money.

The central full-stack decision is to keep three truths distinct. The matching engine owns pair order. The ledger owns balances. The frontend owns transient interaction state and render scheduling. A websocket connects these worlds but does not replace the durable APIs.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether this is spot trading, whether limit and market orders are required, whether users need historical candles, and what freshness the product promises. I assume spot trading with limit, market, cancel, partial fills, portfolio, and order history.

I would ask whether the client can place orders from multiple tabs and whether the product needs offline submission. I will support multi-tab viewing but never offline order submission; an ambiguous financial command must be resolved against the server.

### Functional requirements

- Browse enabled assets and trading pairs.
- View ticker, candles, trades, and an order-book snapshot plus deltas.
- Submit and cancel authenticated orders.
- Show open, partial, filled, cancelled, and unknown command states.
- Show balances, reservations, fills, fees, and order history.
- Recover after websocket disconnects and sequence gaps.
- Preserve decimal precision across database, API, and browser.
- Prevent duplicate orders across retries and multiple tabs.

### Non-functional requirements

- Input and chart interaction remain responsive under market-data bursts.
- A committed order and settlement are durable after process failure.
- Public data can be eventually consistent across regions; private balances cannot be fabricated.
- The client labels stale market or account data.
- One broken chart or stream subscription does not crash the route.
- All private API and stream access is capability checked.

### Out of scope

I will not design custody, KYC, blockchain settlement, derivatives, or the exact matching algorithm. I will define the frontend and backend boundaries needed to integrate them safely.

## A — Architecture — 8 minutes

### Combined architecture diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    React SPA (Vite + TypeScript)                            │
│ Routes: / markets · /trade/$symbol · /portfolio · /orders                  │
│                                                                            │
│ authStore · marketStore · portfolioStore · orderStore                     │
│ render adapters: chart · book rows · sparkline · accessible summaries     │
│ REST data layer: snapshots · commands · cache · retries                   │
│ WebSocket service: channels · sequence · reconnect · resync               │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ HTTPS / WSS
┌──────────────────────────────▼─────────────────────────────────────────────┐
│ Exchange API boundary                                                       │
│ auth · commands · snapshots · public streams · private account streams    │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ Trading API            │ Matching engines      │ Ledger and settlement     │
│ validation · routing  │ one owner per pair    │ journal · reservations    │
│ idempotency            │ deterministic fills   │ balance projections       │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ Event log · market projections · account projections · durable databases   │
└────────────────────────────────────────────────────────────────────────────┘
```

### Browser responsibilities

The shell owns routes, authentication context, theme, keyboard shortcuts, and freshness banners. Domain stores hold normalized market, order, portfolio, and connection state. Render adapters transform high-frequency state into bounded visual work.

The REST layer fetches initial snapshots and submits commands. The WebSocket service owns subscriptions and sequence checks. Components do not open sockets or perform monetary arithmetic directly.

### Backend responsibilities

The API authenticates and validates commands, then routes an order to the pair owner. Matching emits fills. Settlement applies double-entry accounting and produces account events. Market projections and stream gateways serve read and realtime workloads without becoming the financial authority.

### End-to-end order flow

1. The user edits a local order draft using decimal strings.
2. The client validates required fields and sends one command key.
3. The API validates capability, instrument rules, and request shape.
4. The pair owner sequences the order and emits accepted or rejected state.
5. Matching emits fills in pair order.
6. Settlement consumes fills idempotently and updates the ledger.
7. Private events update order state; a balance query confirms canonical holdings.

## D — Data Model — 6 minutes

### Server model

| Entity | Important fields | Authority |
|---|---|---|
| `TradingPair` | base, quote, scale, status | instrument service |
| `Order` | ID, command key, side, type, price, quantity, status | matching service |
| `Fill` | ID, order IDs, price, quantity, fee, pair sequence | matching service |
| `LedgerEntry` | account, asset, signed amount, reference | ledger |
| `BalanceProjection` | available, reserved, version | ledger projection |
| `MarketEvent` | channel, sequence, event type, payload | market log |

### Client model

| Entity | Important fields | Owner |
|---|---|---|
| `OrderDraft` | side, type, price string, quantity string | local form |
| `MarketSnapshot` | symbol, bids, asks, sequence, received time | market store |
| `OrderState` | status, fills, command key, stale flag | order store |
| `ConnectionState` | channel, connected, last sequence, error | websocket service |
| `RenderSnapshot` | visible candles, rows, dimensions | render adapter |

The browser never treats a computed portfolio total as authoritative if it can query a canonical balance response. It can display a pending order or provisional form preview, but it labels server freshness and unknown command state.

### Precision model

The database uses fixed-precision decimals or asset-specific integer units. JSON carries monetary values as strings. The frontend validates and formats strings without converting them through binary floating point.

### Consistency classes

Order transitions, fills, reservations, and ledger entries are durable and ordered. Ticker movement, remote cursors, and chart animation frames may be coalesced. This distinction determines which messages can be dropped and which require replay.

## I — Interfaces — 8 minutes

### REST API

```
GET  /api/v1/markets                         → pair metadata
GET  /api/v1/markets/:symbol/book            → snapshot and sequence
GET  /api/v1/markets/:symbol/candles         → bounded candle range
GET  /api/v1/accounts/me/balances             → authorized balances
GET  /api/v1/orders?cursor=                  → order history
POST /api/v1/orders                           → idempotent order command
POST /api/v1/orders/:id/cancel                → cancellation command
GET  /api/v1/commands/:key                    → resolve unknown command
```

The API returns explicit error classes: invalid precision, insufficient funds, disabled pair, authorization failure, duplicate command, accepted command, and unknown command. The client chooses retry behavior from the class.

### WebSocket API

```
CONNECT /api/v1/stream
SUBSCRIBE public.book:<symbol>
SUBSCRIBE public.ticker:<symbol>
SUBSCRIBE private.orders
EVENT snapshot { channel, sequence, payload }
EVENT delta    { channel, sequence, payload }
EVENT account  { accountSequence, payload }
```

The client validates channel and sequence. A gap pauses the affected view and fetches a snapshot. The server may close a slow client rather than buffering unbounded book deltas.

### Frontend interfaces

| Boundary | Input | Output |
|---|---|---|
| Route loader | symbol, account context | initial snapshots |
| REST client | typed request, command key | typed result or error |
| WebSocket service | channel interest | normalized events and health |
| Market store | snapshot/delta | selectors and render data |
| Order form | draft | command intent and validation |
| Render adapter | bounded snapshot | chart/book/accessibility output |

### Internal backend contracts

The command router guarantees pair ownership and idempotent command lookup. The matching engine guarantees one sequence per pair. Settlement guarantees idempotent financial effect per fill. The stream gateway guarantees sequence metadata and capability filtering, not universal delivery.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: Order correctness across the stack

The client creates one command key per user intent. It retains that key through retry and status lookup. The API stores the key with the accepted order or rejection result. A timeout therefore leads to lookup, not a new order.

The pair owner sequences the command. If matching happens before cancellation, the user sees a fill or partial fill. If cancellation wins, the remaining quantity is released. The API never tells the browser “cancelled” merely because a request was sent.

This approach gives up the illusion that every command has an immediate boolean result. It gains a recoverable state machine, which is essential when transport failure happens after server acceptance.

### Deep dive 2: Decimal strings and fixed-point arithmetic

A price and quantity are strings at the HTTP boundary because binary floating point cannot represent many asset values exactly. The server validates scale and tick size using decimal arithmetic. The matching engine uses fixed-point or integer units appropriate to the pair.

The browser can compare and format values using a decimal helper, but it should not calculate balances by multiplying JavaScript numbers. The same precision rule appears in form validation, JSON serialization, SQL storage, fees, and ledger entries.

The alternative is to trust client numbers and round on the server. That creates disagreements where the user sees one preview and the server accepts another quantity. Local validation is helpful, but the server’s canonical decimal result wins.

### Deep dive 3: WebSocket versus polling and SSE

Polling is easy to operate but cannot provide efficient order-book deltas at high frequency. SSE provides server-to-client streaming but does not naturally carry bidirectional subscription commands and private command acknowledgements. WebSockets fit dynamic public and private channels, provided the server implements authentication, heartbeat, backpressure, and resync.

The trade-off is connection lifecycle complexity. The client needs reconnect with jitter, subscription replay, stale indicators, and sequence validation. Those costs are justified for a trading UI where a one-second polling interval is perceptibly stale and a hundred-millisecond interval is wasteful.

### Deep dive 4: Rendering and stream scheduling

The browser may receive more book updates than it can paint. The store applies correctness-sensitive deltas immediately, while render adapters publish at most one visual snapshot per animation frame. Rows are memoized and virtualized when depth is large.

The chart does not need every intermediate tick to draw a useful frame. The order state and sequence gap path do. Separating transport processing from visual scheduling protects input latency without hiding stale data.

### Deep dive 5: Ledger, reservations, and reconciliation

An accepted order reserves funds before it can spend them. A fill consumes the reservation and creates balanced debit and credit entries. A cancelled remainder releases the reservation. The ledger transaction and outbox event commit together.

If a consumer retries a fill, the fill ID prevents a second settlement. If a projection is wrong, it rebuilds from journal entries. If matching and ledger disagree, reconciliation reports the mismatch and operators repair through compensating entries, never by editing immutable history.

### Deep dive 6: Public and private fan-out

Public streams can be partitioned by market channel and served from materialized snapshots plus ordered deltas. Private events are partitioned by account and filtered before delivery. A public market cache must never be reused as a private account cache.

Slow clients receive coalesced tickers or are disconnected for book channels. A reconnect fetches a snapshot and resumes from a known sequence. Private replay windows are shorter and can fall back to canonical REST queries when expired.

### Deep dive 7: Failure matrix

| Failure | Backend response | Frontend behavior |
|---|---|---|
| Order timeout | retain command state | checking status |
| Pair engine failure | pause pair, fail over | trading unavailable for pair |
| Ledger lag | preserve durable trade | stale balance label |
| Stream gap | require snapshot | pause affected view |
| Private auth expiry | close private channel | public data remains |
| Worker/render failure | serve bounded fallback | chart or book-local error |

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would test one active trading route under a burst of book deltas, a large portfolio history, multiple browser tabs, and an order timeout. The full-stack capacity budget includes API latency, stream bandwidth, browser frame time, ledger write throughput, and replay duration.

### What I would measure

- Input-to-command latency and command acknowledgement.
- Tick-to-render latency and dropped frames.
- WebSocket stale age, reconnects, and sequence resyncs.
- Fill-to-ledger and fill-to-private-event latency.
- Unknown-command recovery rate.
- Stream gateway lag and slow-client disconnects.
- Browser memory after a long trading session.

### Rollout sequence

1. Build REST market snapshots and a deterministic order form.
2. Add one public WebSocket channel with sequence recovery.
3. Add pair-owned matching and idempotent order commands.
4. Add ledger reservations, fills, and private order events.
5. Add chart/book render adapters and frame measurements.
6. Add pair partitioning, workers, and multi-tab public sharing only after profiling.

### Alternative architecture review

Polling is easier than WebSocket but cannot efficiently deliver order-book deltas or private transitions. SSE simplifies server push but needs a second command path and lacks natural channel multiplexing. WebSocket is justified by dynamic public and private streams, provided resync and backpressure are explicit.

An iframe per chart offers hard isolation but duplicates runtime, auth handoff, resize, focus, and stream coordination. A shared shell with render adapters and worker boundaries is better for trusted first-party features. A stronger frame boundary remains available for untrusted extensions.

### Full-stack interview checkpoints

I trace the order form through decimal validation, command key, API response, pair sequence, ledger settlement, and UI state.

I explain why the browser may show a pending order but must not invent a new balance.

I show how a sequence gap pauses one stream without taking down the whole route.

I finish with the three authorities: matcher for order sequence, ledger for money, and client for transient interaction.

## Scalability and operations

Scale API servers and stream gateways horizontally. Assign pairs to matching owners. Store market candles in time-series storage. Keep the ledger and account journal durable and partition only after measuring settlement writes.

The first bottleneck is settlement throughput. The second is stream bandwidth and slow consumers. The third is browser work on the active trade route. Backend metrics and browser metrics must be correlated by symbol and request or stream identifiers.

## Security and observability

The server enforces account, pair, region, and trading permissions. Rate limits apply to order commands and stream subscriptions. The browser receives no signing secret and cannot authorize itself by hiding a button.

Metrics include order command latency, unknown-command rate, matching queue depth, fill-to-ledger latency, outbox age, stream lag, resync count, client stale age, and dropped render frames. Logs avoid quantities and credentials unless access-controlled diagnostics explicitly require them.

## Testing and correctness review

I would test the complete order journey in a browser with delayed REST responses, dropped book deltas, a websocket reconnect, and a timeout after backend acceptance. The UI must preserve command identity and show the right stale or unknown state.

Backend tests cover pair replay, reservations, fill settlement, outbox retries, and private stream authorization. Browser tests cover decimal input, render scheduling, keyboard order entry, and local error boundaries.

The acceptance criteria are no duplicate orders, no invented balances, deterministic stream resync, bounded render work, and a safe logout path that clears private state.

## Implementation sequence

1. Build market routes with REST snapshots and decimal-safe forms.
2. Add normalized browser stores and render adapters.
3. Add one public WebSocket stream with snapshot recovery.
4. Add command keys, pair sequencing, and order status lookup.
5. Add ledger reservations, fills, and private events.
6. Add frame scheduling, worker aggregation, and multi-tab policy.

The sequence keeps the browser useful during backend or stream failures and proves the command protocol before introducing high-rate rendering optimizations.

## Interview walkthrough: one order

The browser creates a decimal-safe draft and command key. The API validates and routes it to the pair owner. The matcher returns accepted state, then a fill event reaches settlement and the private stream.

The browser may show a pending order, but it refreshes balances from the ledger projection. A timeout resolves through command lookup, and a book sequence gap resolves through snapshot and replay.

This scenario lets me explain frontend rendering, backend authority, transport failure, and money correctness in one coherent story.

## Further design decisions

The browser should not subscribe to every market symbol by default. The route requests the active pair and visible overview rows, while the server offers lower-frequency summaries for the rest.

The API should expose source versions and freshness so the client can distinguish a slow stream from an old cached portfolio. This is more useful than a generic “loading” spinner after the initial render.

Private data uses a separate cache namespace and stream capability. Logout closes the stream and clears private state before another identity can use the tab.

Chart, book, and portfolio features can be independently owned modules, but they share typed data and accessibility contracts. Module Federation is a deployment choice, not an authorization boundary.

The production review asks whether every retry preserves command identity, whether every derived view can be rebuilt, and whether every stream has a sequence or snapshot recovery path.

### Final questions

- What is authoritative for an order?
- What is authoritative for a balance?
- Which messages may be dropped?
- How is a timeout resolved?
- What does logout clear?

### Launch gate

The launch gate is command idempotency, exact decimal handling, sequence recovery, private-channel isolation, and browser responsiveness under burst traffic.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Pair ordering | single matching owner | active-active matcher | deterministic sequence |
| Accounting | journal plus projection | mutable balances | replay and audit |
| Client transport | WSS plus REST | polling only | deltas, commands, recovery |
| Retry | stable command key | new ID per retry | prevents duplicate orders |
| Browser updates | frame-bounded rendering | render every tick | protects interaction |
| Private state | capability-scoped channels | shared market cache | prevents data leakage |

## Closing — 3 minutes

The full-stack contract is clear: the browser renders and schedules, the API validates and routes, the matcher sequences, the ledger accounts, and the stream gateway delivers with sequence metadata. Each layer has a defined authority and a defined failure state.

I would ship the first version with one pair, one durable ledger, REST snapshots, and a WebSocket stream. I would prove command idempotency, replay, sequence recovery, and decimal correctness before scaling pair ownership or adding a distributed ledger.
