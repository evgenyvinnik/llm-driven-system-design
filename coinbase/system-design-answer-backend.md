# Coinbase Backend — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Opening and requirements | Trading workflow and safety goals | 4 min |
| Architecture | API, matching, ledger, streams, storage | 8 min |
| Data model | Orders, trades, wallets, events, market data | 6 min |
| Interfaces | REST commands, WebSocket streams, internal events | 8 min |
| Deep dives | Matching, money correctness, fan-out, recovery | 20 min |
| Scaling and trade-offs | Bottlenecks, alternatives, rollout | 4 min |

## Opening — 2 minutes

I am designing the backend for a custodial crypto exchange. A user can inspect market data, submit an order, see it match, and observe balances and order status. The system must never lose a committed trade or create money through a retry.

The key distinction is between the matching path and the read path. Matching requires deterministic ordering and low latency for a trading pair. Portfolio reads require durable accounting and authorization. Market-data delivery can be lossy for intermediate prices but cannot invent a book state.

I will treat blockchain custody, external deposits, identity verification, and the exact matching algorithm as boundaries where appropriate. I will define the contracts that make those subsystems safe to integrate.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether this is a spot exchange or includes margin and derivatives. I will design spot trading first because leverage introduces liquidation, collateral, and risk-engine requirements.

I would ask whether users can trade globally, which currencies and pairs are supported, and whether the product promises a real-time order book. I will assume a multi-region read experience with one authoritative matching region per pair.

I would ask about order types. I will support limit and market orders, cancellation, partial fills, and time-in-force. Stop orders can be added through a trigger service without changing the core trade ledger.

### Functional requirements

- Accept authenticated orders for an enabled trading pair.
- Validate precision, balance, account permissions, and order limits.
- Match compatible orders with deterministic price-time priority.
- Persist trades, order transitions, and double-entry balance movements.
- Support cancellation with a clear race outcome if matching happens first.
- Stream public ticker, candles, trades, and order-book updates.
- Stream private order and account updates to the correct user.
- Provide order history, fills, balances, and audit history.
- Allow safe retries after client or network failures.

### Non-functional requirements

- A committed order must be recoverable after process failure.
- A pair’s matching sequence must be deterministic and single-writer.
- No balance may become negative or less than its reserved amount.
- Public market data should be low latency but may be eventually consistent across regions.
- Private events must not cross account boundaries.
- The API should expose explicit unknown status rather than guessing after a timeout.
- The service must support backpressure and degraded streaming without blocking settlement.

### Out of scope

I will not design blockchain node operation, KYC workflows, fiat banking rails, derivative liquidation, or the exact cryptographic custody policy. I will show where those services enter the deposit, withdrawal, and account boundaries.

## A — Architecture — 8 minutes

### High-level diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          Exchange API Layer                                 │
│ auth · rate limits · idempotency · order/query endpoints                    │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ Trading Command       │ Market Query Service   │ Stream Gateway             │
│ validation · routing  │ books · candles ·      │ public/private channels    │
│ order status          │ portfolio projections  │ replay · backpressure      │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ Pair-Owned Matching Engines                                                 │
│ deterministic sequence · price-time priority · fill events                  │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ Ledger and Settlement         │ Event Bus and Materialized Views            │
│ balances · reservations       │ trades · market data · account projections  │
│ double-entry journal          │ replay · fan-out · analytics                │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ Durable Storage: ledger DB · order store · event log · time-series store    │
└────────────────────────────────────────────────────────────────────────────┘
```

### Request flow

The API authenticates the user, checks coarse capabilities, validates the request shape, and assigns an idempotency key. It routes the command to the owner of the trading pair. The matching engine returns accepted, rejected, or already-seen command state.

The engine does not directly decide final wallet balances. It emits an ordered fill or cancellation event. Settlement consumes that event transactionally with the ledger and records the trade’s accounting result.

The API can respond with an accepted order and sequence metadata before every downstream projection is updated. The client then observes private order events and queries canonical state when it needs reconciliation.

### Pair ownership

Each trading pair has one active matching owner at a time. A partition map assigns pairs to engine instances. Ownership changes through a controlled lease or coordinator protocol, not by letting two instances process the same pair concurrently.

The engine keeps the active book in memory for latency. It persists command and fill sequence information to a durable log or journal so a replacement can rebuild state deterministically.

### Ledger boundary

The ledger is the source of truth for spendable, reserved, and settled amounts. A balance projection is convenient for reads, but the journal records immutable debit and credit entries with references to the trade and account.

Settlement must be idempotent. Replaying a fill event either finds the existing settlement or creates exactly one new settlement for that event ID. The event bus can deliver at least once without duplicating money.

### Market-data path

The matching engine publishes ordered book deltas and trades. A market-data service builds snapshots, validates sequence continuity, and fans out public channels. It can coalesce ticker updates, but book deltas require a recovery path when subscribers miss a sequence.

Private account events are filtered by account capability before delivery. The public and private fan-out paths may share infrastructure, but their authorization and retention policies are separate.

## D — Data Model — 6 minutes

| Entity | Key fields | Authority | Notes |
|---|---|---|---|
| `Account` | account ID, user ID, status, capabilities | account service | immutable identity boundary |
| `TradingPair` | symbol, base, quote, precision, status | instrument service | versioned rules |
| `Order` | order ID, client key, side, type, price, quantity, status | matching service | append-only transitions |
| `Fill` | fill ID, order IDs, price, quantity, fee, sequence | matching service | one event per match |
| `LedgerEntry` | entry ID, account, asset, signed amount, trade ID | ledger | immutable journal |
| `BalanceProjection` | account, asset, available, reserved, version | ledger | rebuildable read model |
| `MarketEvent` | pair, sequence, type, payload | market-data log | replayable public state |
| `AccountEvent` | account, sequence, type, order/fill reference | private stream log | capability-scoped |

### Order state machine

An order starts as accepted or rejected. An accepted order may become open, partially filled, filled, cancelled, or expired. A cancellation request can race with a fill, so the response describes the resulting state rather than promising that cancellation won.

The transition record includes the actor, command ID, pair sequence, and reason. Reconciliation can prove whether a transition was generated by matching, cancellation, risk policy, or administrative action.

### Money representation

Database amounts use fixed-precision decimal or integer minor units according to asset rules. API amounts are strings. A binary floating-point value is never used for balance or order arithmetic.

Precision is an end-to-end property: instrument configuration defines scale, validation enforces it, the ledger stores exact values, and serializers preserve it. A single floating-point conversion can corrupt a valid 18-decimal asset.

### Event model

Events carry an event ID, aggregate ID, aggregate sequence, schema version, occurred time, and correlation ID. The event ID is the idempotency key for consumers; the aggregate sequence supports ordered reconstruction.

Events are immutable facts. Derived order history, market streams, and account notifications can be rebuilt or backfilled without mutating the ledger.

## I — Interfaces — 8 minutes

### Public API

```
GET  /api/v1/markets                         → enabled pairs and metadata
GET  /api/v1/markets/:symbol/book            → snapshot plus sequence
GET  /api/v1/markets/:symbol/candles         → time-window candles
GET  /api/v1/orders/:orderId                 → canonical order state
GET  /api/v1/orders?cursor=                  → authenticated order history
GET  /api/v1/accounts/:id/balances            → authorized balance projection
POST /api/v1/orders                           → idempotent order command
POST /api/v1/orders/:orderId/cancel           → cancellation command
GET  /api/v1/commands/:commandKey             → unknown-command resolution
```

Order creation accepts a client command key, pair, side, order type, quantity, price where relevant, and time-in-force. The response includes command status and an order ID when one exists.

The API distinguishes invalid request, insufficient balance, disabled pair, unauthorized account, duplicate command, accepted command, and unknown command. These states map to different retry behavior.

### WebSocket interface

```
CONNECT /api/v1/stream
SUBSCRIBE public.ticker:<symbol>
SUBSCRIBE public.book:<symbol>
SUBSCRIBE private.orders
EVENT    snapshot { channel, sequence, payload }
EVENT    delta    { channel, sequence, payload }
EVENT    account  { accountSequence, payload }
```

The gateway authenticates private subscriptions, tracks the last acknowledged sequence when supported, and applies quotas per connection and account. A client that detects a gap requests a fresh snapshot rather than guessing missing deltas.

### Internal interfaces

| Boundary | Input | Output | Guarantee |
|---|---|---|---|
| Command router | authenticated order command | pair command | idempotent routing |
| Matching engine | ordered pair command | order/fill event | single-writer sequence |
| Settlement | fill event | ledger entries | exactly-once effect |
| Market fan-out | book/trade events | public stream | replayable sequence |
| Account fan-out | ledger/order events | private stream | capability isolation |
| Reconciliation | event ranges | discrepancy report | auditable repair |

### Retry semantics

Clients retry safe reads with bounded exponential backoff. They retry an order command only with the same command key. A timeout sends the client to status lookup rather than creating a new command.

Consumers acknowledge events after durable processing. A poison event moves to a quarantine path with an alert; it does not get silently skipped because skipped settlement corrupts projections.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: Matching engine versus database transactions

I choose an in-memory, pair-owned matching engine with a durable command and fill log. Price-time priority requires a total order for one pair. A database transaction around every order could provide strong durability, but lock contention and index work would put the database in the microsecond-to-millisecond matching hot path.

The engine receives commands in pair sequence order, updates the book, emits fills, and records the resulting sequence. A replacement rebuilds the book from a snapshot plus journal. The trade-off is operational complexity: memory state must be monitored, ownership must be coordinated, and replay must be deterministic.

A fully replicated active-active matcher would improve availability but creates a consensus problem for order ordering. I prefer one active owner with fast failover because a pair cannot safely have two independent matching sequences.

### Deep dive 2: Ledger correctness and reservations

Before accepting a buy order, the account’s available quote balance is reduced by the reserved amount. A sell reserves the base asset. A fill consumes the reservation, creates the trade settlement, charges fees, and releases any remainder.

The ledger records balanced entries. A projection can be rebuilt by summing entries, and a constraint or invariant check verifies available plus reserved equals the account’s uncommitted position.

The alternative is to update a mutable balance row without an immutable journal. That is simpler and faster initially, but a retry or partial failure can make reconciliation impossible. The journal costs storage and write amplification, but money correctness requires an audit trail.

### Deep dive 3: Event delivery and exactly-once effects

Exactly-once delivery is expensive and often unnecessary. I use at-least-once delivery with exactly-once effects at each consumer. Settlement deduplicates by fill ID. A market view deduplicates by sequence. A notification consumer deduplicates by account event ID.

The outbox pattern ensures a database transaction and its event publication are not split. The ledger transaction writes the accounting rows and an outbox record. A publisher retries the outbox until the event bus accepts it.

If the publisher is delayed, balances remain correct and private streams become stale. The UI shows freshness rather than inventing a new balance. This is a deliberate availability trade-off.

### Deep dive 4: Public fan-out at scale

The exchange may have many connected clients but far fewer active market channels. The stream gateway keeps connection state at the edge and consumes shared market topics. It sends snapshots on join, deltas in order, and throttled ticker updates.

Backpressure is explicit. A slow client cannot force the market-data producer to buffer indefinitely. The gateway drops intermediate ticker updates, disconnects a client that cannot keep up with book deltas, and lets it resync from a snapshot.

Private streams use account partitions and short replay windows. A reconnect can request missed private events; if the window expired, the client receives a canonical order and balance refresh instruction.

### Deep dive 5: Cancellation races

Cancellation is a command into the same pair sequence as order placement and matching. If matching consumes the order first, cancellation returns too late. If cancellation is sequenced first, the remaining quantity is cancelled.

The API should not claim that a cancellation succeeded until the pair owner acknowledges the sequence. The returned order state and sequence are the source of truth. This prevents a UI from displaying “cancelled” while a fill is still being settled.

### Deep dive 6: Recovery and reconciliation

On engine restart, the system loads the latest pair snapshot, replays commands or fills after the snapshot, and verifies sequence and book checksums. On ledger restart, projections rebuild from journal entries or a verified checkpoint.

A reconciliation job compares matching fills, ledger settlements, order projections, and published events. It reports missing or duplicated references without silently editing history. Repair creates compensating entries or rebuilds projections through controlled workflows.

### Failure matrix

| Failure | Correctness behavior | User-visible behavior |
|---|---|---|
| API timeout after order submit | command remains queryable | checking status |
| Matching owner fails | pair pauses and fails over | pair unavailable briefly |
| Ledger consumer delayed | trade remains durable | stale balance indicator |
| Event bus unavailable | outbox accumulates | streams degrade, writes continue |
| Book sequence gap | stream consumer resyncs | stale book banner |
| Private auth expires | stream closes | public data remains visible |
| Database replica stale | read routes to primary | freshness metadata |

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would begin with a small number of active pairs, high-frequency updates on the most popular pair, and a much larger number of read-only market clients. The important capacity dimension is not only requests per second; it is pair sequencing, fill rate, ledger writes, and stream bandwidth.

The test workload should include bursty order placement, partial fills, cancellation races, a reconnect storm, and a slow consumer. Average traffic hides the failure modes that matter for an exchange.

### What I would measure before scaling

- Command-to-acknowledgement latency by pair.
- Matching queue depth and replay time.
- Fill-to-ledger commit latency.
- Ledger invariant and reconciliation failures.
- Outbox age and event consumer lag.
- Public stream bytes, dropped tickers, and resync rate.
- Private stream authorization failures.
- API unknown-command resolution time.

These measurements separate a slow matching engine from a slow ledger, and a stale browser from a stale market projection. Without that separation, scaling decisions become guesswork.

### Rollout sequence

1. Launch one pair with a durable order and fill journal.
2. Prove replay, cancellation races, and ledger reconciliation.
3. Add public snapshots and sequence-checked deltas.
4. Add private account streams after capability tests pass.
5. Partition pairs across matching owners.
6. Introduce ledger partitioning only after measuring settlement pressure.

### Alternative architecture review

A database-only matcher is simpler to operate and easier to query, but transaction locks and index contention put the database on the latency-critical path. I would use it for a low-volume prototype, not as the long-term design for active pairs.

An active-active matcher improves apparent availability but requires consensus over pair ordering. A single logical owner with controlled failover is easier to reason about and keeps order sequence deterministic.

Exactly-once transport sounds attractive, but it is more expensive than at-least-once delivery with idempotent effects. The business invariant is exactly-once settlement, not exactly-once packet delivery.

### Backend interview checkpoints

At the architecture checkpoint, I trace one order from API validation to pair sequence, fill, ledger entry, outbox, and private event.

At the data checkpoint, I explain why a balance projection is rebuildable and why a fill ID is the consumer idempotency key.

At the interface checkpoint, I distinguish accepted, rejected, and unknown commands.

At the optimization checkpoint, I explain why market ticks can be coalesced while book sequence and settlement events cannot.

At the close, I return to the invariant: no duplicate money, no ambiguous order silently retried, and no private event crossing an account boundary.

## Scalability and capacity

The first bottleneck is settlement write throughput because every fill touches durable account state. The second is market fan-out, where bandwidth and slow consumers dominate. The third is event retention and replay storage.

Scale matching horizontally by pair ownership. Scale API and stream gateways statelessly behind load balancing. Partition ledger and account data by account ID only after the single-ledger design is proven, then use idempotent per-account settlement entries instead of a cross-shard transaction.

Keep hot market snapshots in memory or a cache, but never treat a cache as the trade authority. Use time-series storage for candles and analytics rather than querying the ledger for every chart.

## Security and observability

Authorization checks account, instrument, region, and trading capability. Rate limits apply per account, IP, API key, pair, and command type. Private event topics are scoped server-side; a guessed subscription name never grants access.

Metrics include order acceptance latency, matching queue depth, fill latency, settlement latency, ledger invariant failures, outbox age, stream lag, reconnect rate, and resync count. Logs carry correlation IDs and safe identifiers but never raw credentials or signing material.

## Testing and correctness review

I would test duplicate commands, pair restart during a fill, cancellation at the same sequence as a match, ledger retry, outbox replay, private-topic authorization, and book resync after a dropped delta.

The acceptance criteria are deterministic pair replay, balanced ledger entries, exactly-once settlement effects, explicit unknown-command recovery, and no cross-account event delivery.

## Implementation sequence

1. Define pair, order, fill, ledger, and event invariants.
2. Build one pair owner with durable replay.
3. Add reservations and idempotent settlement.
4. Add REST snapshots and command lookup.
5. Add public sequence-checked market streams.
6. Add private account streams and authorization tests.
7. Add pair partitioning and reconciliation automation.

This sequence proves financial correctness before optimizing fan-out. Each phase leaves a usable recovery path rather than introducing a cache or stream that becomes an accidental source of truth.

## Interview walkthrough: one order

I begin with a client command key and an authenticated account. The API validates the pair and routes the command to its owner. The pair sequence records the accepted order, and the engine matches or leaves it open.

The fill event is durable before downstream projections rely on it. Settlement consumes it once, updates reservations and ledger entries, and emits a private account event. The public stream receives a sequence-tagged trade and book update.

If the client times out after acceptance, it asks for command status. If the stream loses a delta, it requests a snapshot. If a worker retries a fill, the fill ID prevents duplicate accounting.

This single scenario demonstrates the authority boundaries, retry semantics, and recovery paths more clearly than a list of services.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Matching | pair-owned single writer | active-active consensus | deterministic ordering and lower latency |
| Accounting | journal plus projection | mutable balance only | auditability and replay |
| Delivery | at least once, idempotent effects | exactly-once transport | simpler recovery with same business result |
| Market updates | sequence plus resync | best-effort deltas only | prevents plausible but wrong books |
| Amounts | fixed precision/string APIs | binary floating point | no silent monetary corruption |
| Commands | idempotency key | client-generated retry IDs | safe timeout recovery |
| Fan-out | gateway with backpressure | unbounded per-client buffers | protects the system from slow consumers |

## Closing — 3 minutes

The design separates deterministic matching, durable accounting, query projections, and realtime delivery. The ledger is the source of truth for money. The pair owner is the source of truth for order sequence. The stream gateway is a delivery layer with snapshots and resync, not a second database.

The most important trade-off is accepting at-least-once events while making settlement effects idempotent. That avoids pretending distributed delivery is perfect while preserving exactly-once business outcomes.

I would build one pair end to end, prove replay and reconciliation, then add more pairs, fan-out capacity, and account partitioning. I would not scale the architecture by weakening the invariants that make a financial system trustworthy.
