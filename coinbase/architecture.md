# Coinbase architecture

## System Overview

A spot exchange accepts orders, reserves spendable assets, matches compatible interest, records transfers and fees, and publishes market and account views. The central challenge is keeping order priority, accounting, and recovery consistent while delivering a responsive trading interface.

This is an independent learning design. The production proposal below uses one durable accounting authority and a serialized command stream per trading pair. The final Implementation Notes describe the actual local project, including simulated prices, incomplete matching/settlement boundaries, and client limitations. It is not a description of Coinbase's private infrastructure.

## Requirements

### Functional requirements

Support enabled spot pairs, public market browsing, market and limit orders, cancellation, partial fills, balance reservations, transaction history, and private account views. Guests can inspect markets; authenticated accounts place orders. Define tick size, quantity step, fee currency, rounding, market-price protection, and time-in-force as instrument policy.

For this proposal, limit orders can rest; market orders use an explicit price/spend boundary and cancel any unfilled remainder. No synthetic counterparty is introduced when liquidity is absent. Stop triggers, derivatives, margin, banking rails, blockchain custody, and identity-verification workflows are separate extensions.

### Non-functional requirements

Planning targets are order acknowledgement p99 below 250 ms, market queries p95 below 150 ms, and 99.95% command availability within the primary region. Acknowledgement means the result and reservation are durable under the configured failover policy; it does not mean the entire order filled. These are design targets, not local benchmarks.

Every committed fill must have matching order transitions and balanced per-asset accounting entries, including fee and rounding accounts. Spendable balance cannot be promised to two orders. A cancelled remainder cannot be filled after the cancellation wins the pair sequence. Retrying one command must recover the same outcome without reserving again.

The browser may sample ticker presentation, but it must not build depth from an unknown delta baseline or confuse a lost order response with rejection. Public data freshness, private account revision, and connection state are separate signals.

## Capacity Estimation

| Assumption | Estimate | Design consequence |
|------------|----------|--------------------|
| Ten million accounts, ten million commands/day | About 116 commands/s average; 2,000/s assumed peak | Measure journal, wallet contention, and hot pairs |
| Four million fills/day, 1 KB/fill before indexes | About 4 GB/day of fill records | Ledger entries, commands, and replicas add substantially more |
| 500 pairs with six candle intervals | About 927,500 candles/day | At 250 bytes each, roughly 232 MB/day raw |
| 100,000 connected clients, five symbols/client, two ticker updates/s | About one million delivered updates/s | At 200 bytes each, about 200 MB/s before protocol overhead |
| One minute of command replay at peak | 120,000 commands | Checkpoint frequency and measured replay speed determine recovery time |

The candle estimate uses 1,440 one-minute, 288 five-minute, 96 fifteen-minute, 24 hourly, six four-hourly, and one daily candle per pair. It does not multiply every interval by 1,440. Market data bursts and one popular pair require separate load cases; averages do not establish a universal database or matching-engine throughput limit.

### Local Development Scale

The schema creates thirteen currencies and twelve pairs. The optional fixture adds two users, fifteen wallets, 180 one-minute candles, and five deposit-history rows on a fresh import. No orders or liquidity are seeded. One API process is the only coherent scope for its in-memory book; additional processes have independent books and price maps.

## High-Level Architecture

```text
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Trading clients        │       │ Command + receipt API  │       │ Active pair owner      │
│ Order / cancel intent  │◀─────▶│ Auth, limits, routing  │◀─────▶│ Epoch + pair sequence  │
└────────────────────────┘       │ Scoped retry identity  │       │ Committed memory book  │
                                 └────────────────────────┘       └────────────────────────┘
                                              ▲                                ▲
                                              │                                │
               receipt lookup                 │  commit / recovery read        │
                                              │                                │
                                              ▼                                ▼
┌────────────────────────┐       ┌─────────────────────────────────────────────────────────┐
│ Recovery / checkpoints │       │ Transactional order and accounting authority            │
│ Committed sequence     │◀─────▶│ Orders, holds, fills and balanced per-asset entries     │
│ Replay + verify holds  │       │ Command decisions, receipts, fencing epoch and outbox   │
└────────────────────────┘       └─────────────────────────────────────────────────────────┘
                                              │
committed events only                         │
                                              │
                                              ▼
                                 ┌────────────────────────┐       ┌────────────────────────┐
                                 │ Outbox relay           │       │ Projection workers     │
                                 │ Retry publication      │──────▶│ Committed fills/events │
                                 │ Stable event identity  │       │ Versioned state        │
                                 └────────────────────────┘       └────────────────────────┘
                                                                               ▲
                                                                               │
                                                 apply / checkpoint            │
                                                                               │
                                                                               ▼
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Read clients           │       │ Read/stream gateways   │       │ Market/account views   │
│ Public / account views │◀─────▶│ Snapshots + streams    │◀─────▶│ Sequences + revisions  │
└────────────────────────┘       │ Auth + replay limits   │       │ Snapshot/replay data   │
                                 └────────────────────────┘       └────────────────────────┘

Pair memory advances after commit. Unknown commit pauses matching until resolved.
```

Logical ownership does not require a different database for every box. The first production design keeps orders, reservations, fills, journal entries, receipts, and outbox records in a common transactional store. Pair owners keep committed active books in memory to avoid repeated database comparisons, but do not publish speculative fills as durable facts.

The command response returns only the authority's durable decision. If that decision
is uncertain to the owner, matching pauses while receipt lookup and committed replay
resolve the sequence. Outbox publication and read-model checkpoints have separate
progress: they may lag without changing the validity of an already committed order.
Clients recover a command by its scoped identity and recover missing market/account
updates by the corresponding snapshot and sequence contract.

## Core Components / Request Flows

### Instrument and amount policy

Represent actionable amounts with validated decimal strings or explicit integer units. Instrument policy defines price ticks, quantity steps, allowed scale, fee denomination, and rounding direction. Integer arithmetic is a credible alternative to decimal arithmetic; both require scale metadata and overflow checks.

The local numeric(28,18) column permits ten integral digits and eighteen fractional digits. PostgreSQL rounds excess fractional precision on storage and rejects integral overflow; exact storage does not repair an earlier floating-point calculation. [PostgreSQL 16 numeric types](https://www.postgresql.org/docs/16/datatype-numeric.html).

Use exact arithmetic throughout validation, reservation, matching, fees, and settlement. Convert only derived chart coordinates or approximate display geometry to browser numbers. A BTC-USD price is denominated in USD; an ETH-BTC price is denominated in BTC. Fee records carry their own asset instead of relying on a field name to imply units.

### Order acceptance, matching, and settlement

The API authenticates the account, normalizes input, and routes an identified command to the active owner of the pair. Ownership has a fencing epoch checked by the durable store. A lease without stale-owner rejection is not sufficient to prevent two owners from committing after a pause or partition.

The owner handles one command at a time and plans matches against its committed book. Admission reserves a bounded amount before that order can become matchable. In the initial design, one database transaction validates current instrument policy, locks affected wallet/order rows in a consistent order, reserves funds, writes the new order, applies any fills, and records the receipt, pair sequence, journal, and outbox entries.

Each fill consumes order-specific reservations, transfers base and quote assets, accounts for fees, updates cumulative fills, and releases unused price-improvement amounts. A remaining buy reservation reflects the still-open quantity at its accepted limit or budget. A fully filled/cancelled order has no remaining hold. All participating assets balance separately; USD cannot offset an unexplained BTC difference.

The in-memory book applies the committed plan before the owner handles the next command. If commit outcome is unknown, pause the pair and recover the command from the store. If the process dies after commit but before applying the plan, replay restores the committed sequence. Do not continue matching from a potentially stale memory state.

This design puts a durable transaction on command acceptance. It makes correctness easier to demonstrate at the proposed initial scale, at the cost of write latency and wallet contention. A more demanding low-latency design would need durable admission grants, replicated sequencing, and settlement recovery specified together; simply moving fills to an asynchronous consumer does not prevent unfunded orders.

### Priority and cancellation

Assign a monotonic accepted sequence within each pair; wall-clock milliseconds are not a complete ordering. Maintain price levels with FIFO order queues. Match at the resting order's price according to the exchange's stated rule, recording actual maker/taker identities rather than equating buyer with taker.

Cancellation enters the same sequence as new orders and fills. If a fill wins first, cancellation can remove only the remaining quantity. Its committed result includes the resulting filled and cancelled amounts. Repeating a cancellation command recovers that result instead of releasing unrelated wallet reserves again.

### Recovery and derived data

Checkpoint the committed book with a sequence and integrity marker. Replay every subsequent committed book mutation, including placements, fills, cancellations, and policy-driven expiry. A trade-only log cannot reconstruct unfilled orders or cancellations. Compare reconstructed open quantity and holds with durable order/reservation records before admitting new commands.

Publish market and account events from an outbox committed with their source changes. Consumers deduplicate stable event identities. Broker acceptance, consumer processing, and browser delivery are different milestones; a producer call without a connected consumer does not implement fan-out.

Candles aggregate committed trade events in event-time buckets with duplicate handling and a defined late-event policy. A ticker may be sampled, but sample values must not replace the trade stream used for OHLCV. Portfolio valuation combines a coherent account snapshot with identified price marks, timestamps, and explicit unavailable prices.

### Browser data flow

Use separate identities for instrument/range queries, order commands, authenticated account data, and stream generations. Keep order drafts as strings and freeze the submitted attempt. A confirmed receipt updates the appropriate order; a timeout triggers authorized operation recovery with the same command identity.

For order-book streaming, establish a snapshot sequence and buffer deltas that arrived during acquisition. Discard deltas covered by the snapshot, apply only the contiguous suffix, and restart acquisition if the buffer overflows or a gap remains. Skipping intermediate renders is safe after the underlying state is correct; dropping arbitrary raw depth deltas is not.

Maintain chart instances across data updates, preserve intentional viewport changes, and bound visible depth. Public market state can survive logout; private queries, subscriptions, pending operations, and late responses remain tied to the account that created them. A socket being open does not establish data freshness or account authorization.

## Database Schema

### Current local schema

The following is the actual table/index structure from [init.sql](./backend/src/db/init.sql). Its currency/pair seed statements are omitted here and described in the README. This schema has no immutable balanced journal, order-specific reservation table, command log, fencing epoch, or transactional outbox.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  is_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE currencies (
  id VARCHAR(10) PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  icon_url TEXT,
  decimals INT DEFAULT 8,
  is_fiat BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE trading_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(20) UNIQUE NOT NULL,
  base_currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  quote_currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  min_order_size DECIMAL(28,18) DEFAULT 0.00000001,
  max_order_size DECIMAL(28,18) DEFAULT 1000000,
  price_precision INT DEFAULT 2,
  quantity_precision INT DEFAULT 8,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  balance DECIMAL(28,18) DEFAULT 0,
  reserved_balance DECIMAL(28,18) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, currency_id),
  CHECK (balance >= 0),
  CHECK (reserved_balance >= 0),
  CHECK (balance >= reserved_balance)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  trading_pair_id UUID NOT NULL REFERENCES trading_pairs(id),
  side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type VARCHAR(10) NOT NULL CHECK (order_type IN ('market', 'limit', 'stop')),
  quantity DECIMAL(28,18) NOT NULL,
  price DECIMAL(28,18),
  stop_price DECIMAL(28,18),
  filled_quantity DECIMAL(28,18) DEFAULT 0,
  avg_fill_price DECIMAL(28,18),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  idempotency_key VARCHAR(64),             -- unique per user, see index below
  hold_remaining DECIMAL(28,18) NOT NULL DEFAULT 0 CHECK (hold_remaining >= 0),
  arrival_seq BIGSERIAL,                   -- time priority; the book is rebuilt in this order
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trading_pair_id UUID NOT NULL REFERENCES trading_pairs(id),
  buy_order_id UUID NOT NULL REFERENCES orders(id),
  sell_order_id UUID NOT NULL REFERENCES orders(id),
  price DECIMAL(28,18) NOT NULL,
  quantity DECIMAL(28,18) NOT NULL,
  buyer_fee DECIMAL(28,18) DEFAULT 0,      -- quote currency
  seller_fee DECIMAL(28,18) DEFAULT 0,     -- quote currency
  taker_side VARCHAR(4) CHECK (taker_side IN ('buy', 'sell')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE price_candles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(20) NOT NULL,
  interval VARCHAR(5) NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  open_time TIMESTAMPTZ NOT NULL,
  open DECIMAL(28,18) NOT NULL,
  high DECIMAL(28,18) NOT NULL,
  low DECIMAL(28,18) NOT NULL,
  close DECIMAL(28,18) NOT NULL,
  volume DECIMAL(28,18) DEFAULT 0,
  UNIQUE(symbol, interval, open_time)
);

CREATE TABLE portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  total_value_usd DECIMAL(28,18) NOT NULL,
  breakdown JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'trade', 'fee')),
  currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  amount DECIMAL(28,18) NOT NULL,
  fee DECIMAL(28,18) DEFAULT 0,
  reference_id UUID,
  status VARCHAR(20) DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_pair_status ON orders(trading_pair_id, status);
CREATE INDEX idx_trades_pair ON trades(trading_pair_id, created_at DESC);
CREATE INDEX idx_price_candles_lookup ON price_candles(symbol, interval, open_time DESC);
CREATE INDEX idx_portfolio_snapshots_user ON portfolio_snapshots(user_id, created_at DESC);
CREATE INDEX idx_transactions_user ON transactions(user_id, created_at DESC);
CREATE UNIQUE INDEX idx_orders_user_idempotency ON orders(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_orders_live ON orders(trading_pair_id, arrival_seq)
  WHERE status IN ('open', 'partially_filled');
```

The actual `init.sql` uses `IF NOT EXISTS`/`ON CONFLICT` throughout and ends with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` upgrades, because Compose applies it on a fresh volume and `npm run db:migrate` re-runs it against an existing one.

The checks constrain individual stored rows, and `hold_remaining >= 0` makes overspending an order's hold a failed transaction rather than a stored state. Cross-row properties (each wallet's `reserved_balance` equals the holds of its live orders; trades conserve every currency) are maintained by the settlement code and verified by the end-to-end checks described in Implementation Notes, not enforced by the schema. Order quantity/price columns still lack positive and scale constraints at the database level; the service validates them before insert.

### Proposed extensions

| Record | Key information | Purpose |
|--------|-----------------|---------|
| Instrument revision | Tick/step, status, fee assets, rounding, price protection | One accepted policy across validation and settlement |
| Pair command log | Pair, sequence, owner epoch, normalized command, decision | Durable ordering and complete book replay |
| Command receipt | Account, operation identity, input digest, outcome | Recover lost responses and reject key misuse |
| Order reservation | Order, asset, held amount, consumed/released amounts | Attribute every hold and release |
| Fill | Stable identity, pair sequence, maker/taker, quantity, price | Link the matching decision to accounting |
| Journal transaction/entries | Reference, account, asset, exact signed amount | Balance effects per asset, including fee accounts |
| Outbox and consumer receipt | Event identity, source revision, delivery progress | Recover publication and duplicate processing |
| Book checkpoint | Pair, committed sequence, integrity marker | Bound recovery work |

Keep the initial ledger in one transactional authority. Sharding by account later splits a fill between buyer and seller; independently idempotent writes to those shards do not make that transfer atomic. A coordinated transfer or funded-allocation protocol would have to preserve conservation and unavailable funds through every intermediate state.

## API Design

### Current HTTP routes

Responses use domain objects such as user, order, pairs, wallets, or candles, and an error string on failure. There is no uniform success/data wrapper.

| Method | Path | Current behavior |
|--------|------|------------------|
| POST | /api/v1/auth/register | Creates user then zero USD wallet in separate writes; auto-login |
| POST | /api/v1/auth/login | Username/password session login |
| POST | /api/v1/auth/logout | Destroys session and clears cookie; no auth guard |
| GET | /api/v1/auth/me | Reads current user for a session |
| GET | /api/v1/markets/pairs, /currencies | Active configured records; pairs include process-local prices |
| GET | /api/v1/markets/:symbol/price | Process-local synthetic price statistics |
| GET | /api/v1/markets/:symbol/orderbook | Current process's book; unknown symbols create empty books |
| GET | /api/v1/markets/:symbol/candles | Stored interval rows converted to numeric chart values |
| GET | /api/v1/markets/:symbol/trades | Matched trade rows only; takerSide always comes from buy order |
| POST | /api/v1/orders | Session required; market/limit/stop accepted; optional body idempotencyKey |
| DELETE | /api/v1/orders/:id | Session owner cancels open/partially-filled order |
| GET | /api/v1/orders | Session owner's latest orders, optional status/limit |
| GET | /api/v1/portfolio, /portfolio/history | Current valuation or stored worker snapshots |
| GET | /api/v1/wallets | Session wallet strings plus approximate USD values |
| POST | /api/v1/wallets/deposit | Simulated per-request credit, maximum 1,000,000 |
| GET | /api/v1/transactions | Session transaction history with limit/offset/type |
| GET | /api/v1/health | Constant healthy response without dependency probes |
| GET | /metrics | Process metrics |

There is no order-by-ID or command-recovery endpoint, withdrawal route, administrator API, or actual funding integration. Limit/offset/depth parameters are parsed without safe upper bounds. Most order-service failures return 500; insufficient balance returns 400. Database insertion and replay failures are not classified as recoverable command outcomes.

Current order example:

```json
{
  "tradingPairId": "<pair UUID>",
  "side": "buy",
  "orderType": "limit",
  "quantity": "0.001",
  "price": "60000",
  "idempotencyKey": "<caller supplied string>"
}
```

The price is illustrative, not a current quotation. The proposed contract additionally requires validated instrument policy, explicit execution limits/time-in-force, account-scoped command identity, canonical outcomes, and operation lookup. Exact amount strings and per-field asset units replace the local mixture of strings and floating-point values.

### Current WebSocket path

The server accepts `/ws` on the API port. It handles subscribe/unsubscribe with channel arrays and `auth` with a userId. Every two seconds, the API sends ticker messages to matching subscribers and a full `prices` map to every socket. The browser normally listens to the full map.

No order-book, private order, or balance publisher is wired. There is no sequence, replay, heartbeat, bounded send buffer, subscription authorization, or session validation on upgrade. The existence of sendToUser does not mean private updates are implemented or protected.

## Key Design Decisions

### One committed command boundary versus independent matching and settlement writes

Keep initial command admission, fills, holds, journal, and receipt in one durable transaction. The in-memory book accelerates comparisons without being allowed to outrun committed state. This costs database latency and serializes contending wallets, but directly prevents recorded fills whose accounting rolled back.

A separate replicated matcher and asynchronous settlement can be valid at higher scale. It requires spend reservations or durable admission grants before matching, recoverable settlement identities, owner fencing, and a policy for settlement blockage. The event bus itself supplies none of those account invariants.

### Explicit units versus decimal columns alone

Exact decimal or integer arithmetic preserves actionable amounts when scale and rounding are explicit. Both are suitable; integers may simplify a tight loop while decimal libraries simplify varied asset scales. Neither eliminates fee-denomination checks or finite-value validation.

Keeping numeric columns while multiplying JavaScript numbers only preserves the rounded result. Converting approximate chart coordinates is acceptable for drawing; using those values to decide the debit is a different operation. The chosen separation adds typed conversion boundaries and tests.

### Sequence-aware streams versus broadcast-only freshness

A recent price is useful without rendering every intermediate ticker. Depth reconstruction needs a known snapshot and contiguous mutations. Use separate channels and recovery policies, with bounded buffers and resnapshot for slow consumers.

Kafka consumer groups distribute partition work within a group; independent delivery to every gateway needs separate groups or a deliberate redistribution layer. All gateway instances in one group do not automatically each receive every event. [Kafka consumer semantics](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html).

The cost is sequence/checkpoint management and reconnect work. Polling bounded snapshots is a legitimate simpler starting point when the product's freshness target allows it. A private account view can recover from a canonical versioned snapshot without replaying every historical event into browser memory.

## Consistency and Idempotency

Bind each operation identity to its account and normalized input. Claim it atomically with the state change or a durable command-admission record. A repeated key with different content is a conflict; the same input recovers the same accepted or rejected outcome.

A receipt survives cache expiry and remains separate from mutable order status. An order accepted open may later fill or cancel; recovery identifies the original accepted order while a current-state read reports its latest revision. The retention window must be part of the retry contract.

Use stable fill identities and balanced journal transactions for settlement. Outbox consumers deduplicate inside their own state transaction before acknowledging progress. Reconciliation compares the pair log, open orders, attributed holds, fills, journal, and outbox; it does not silently edit financial history to hide discrepancies.

## Security / Auth

Use server-validated sessions for both HTTP and private stream subscriptions, with explicit current account permissions and session revocation behavior. Scope every private read, receipt lookup, and cancellation to the account. Apply quotas to commands, public queries, sockets, and subscriptions, with limits chosen from measured capacity.

Keep simulated funding explicitly separate from real funding. A production credit needs an authorized, deduplicated external event and reconciliation policy. Custody and regulatory workflows are outside this repository's implemented scope; a verified boolean does not implement them.

## Observability

Measure command-to-durable-result latency, pair queue depth, wallet lock wait, settlement failures, order/hold mismatch, journal imbalance, replay duration, outbox age, stream gap recovery, and account-view revision lag. A synthetic-fill counter should not be reported as an observed exchange trade without labeling it.

Separate liveness, command readiness, and market-data freshness. Readiness includes recovery through the durable pair sequence and access to the accounting authority. A listening HTTP socket or cached price does not prove that orders can settle.

## Failure Handling

| Failure | Proposed response | Current local limitation |
|---------|-------------------|--------------------------|
| Lost order response | Recover the same command receipt | Global Redis replay only; no lookup endpoint |
| Settlement rejection | Roll back the whole planned command | Trade/order records may already be committed |
| Process failure | Replay committed book mutations before trading | Live orders rebuilt from Postgres in `arrival_seq` order before the server listens; interrupted market orders cancelled |
| Competing cancel/fill | Resolve through one pair sequence | SQL and memory operations can race |
| Redis outage | Defined session failure; durable receipt recovery | Replay reads/writes throw; no fallback recovery |
| Kafka outage | Retain outbox work and limit backlog | Publish errors are logged/swallowed after writes |
| Slow socket or missing delta | Bound buffers and resnapshot | No backpressure or sequence protocol |
| Missing valuation mark | Report unavailable/stale value | Missing USD pair is valued at zero |

## Scalability Considerations

Scale public queries and stream delivery separately from pair command ownership. Coalesce replaceable ticker presentation, subscribe only interested clients, and size bandwidth before multiplying gateway processes. Avoid broadcasting every pair to every connection by default.

Improve hot-book structures from sorted arrays to price-level maps/FIFO queues when measurement warrants it. No particular order count makes arrays universally safe or unsafe; insertion work, cancellation lookup, and burst size determine cost. A monotonic sequence is needed regardless of data structure.

A single ledger initially coordinates wallets shared by multiple pairs. Sharding pairs does not shard spend authority: the same USD balance can fund several markets. At higher scale, use an explicitly funded allocation protocol or coordinated cross-partition transfers, retaining durable identities and conservation through failover.

Bound historical queries and retain enough command history to meet recovery objectives. Checkpoints shorten replay but must not omit active holds or open orders. Restore tests and fencing tests determine whether the design can safely resume trading after failure.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Initial commit authority | Shared order/hold/journal transaction | Independent post-match writes | Preserve accounting and order agreement |
| Book representation | Committed memory view with replay | Unlogged process-local arrays | Recover accepted open orders and priority |
| Amounts | Exact arithmetic with asset units | Decimal storage after float arithmetic | Preserve value and denomination end to end |
| Order retry | Durable account-scoped receipt | Global Redis response cache | Recover after eviction without a new reserve |
| Market remainder | Explicit cancel-rest policy | Synthetic unbounded liquidity | Define what absence of a counterparty means |
| Streams | Snapshot/sequence with bounded recovery | Unversioned broadcasts | Avoid plausible but incorrect depth |

## Implementation Notes

### Setup and persistence

[Configuration](./backend/src/config/index.ts) loads dotenv for API/workers and reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE plus REDIS_HOST/REDIS_PORT. DATABASE_URL and REDIS_URL are unused. [The migration runner](./backend/src/db/migrate.ts) reads PG* directly without dotenv and re-executes the initialization SQL, which is idempotent (and upgrades older volumes with the hold/sequence columns). Compose also applies it on a fresh volume.

The default API port and npm dev port are 3001; `dev:server2`/`dev:server3` bind 3002/3003. Each instance has its own books, prices, and pair queue, so several instances are not one exchange. There is no load balancer or shared matching owner.

The full seed has valid UUIDs and a password123 hash verified with bcrypt. It creates Alice/Bob and fifteen wallets, one-minute candles for three USD markets, and five deposit records. Repeated imports append deposit records and may add newer candle timestamps. Existing usernames with other IDs can break fixed wallet references. There are no seeded orders, trade rows, or administrator role. Liquidity comes from the exchange account the API creates at boot (below).

### Order lifecycle (implemented)

The order path in [orderService.ts](./backend/src/services/orderService.ts) is built around three rules: one command per pair at a time, every hold attributed to an order, and every fill two-sided.

**Exact arithmetic.** [decimal.ts](./backend/src/services/decimal.ts) holds every price and quantity as a BigInt scaled by 10^18, the same scale as the `DECIMAL(28,18)` columns. Parsing is strict (`^\d+(\.\d+)?$`, at most the pair's `quantity_precision`/`price_precision` significant decimals, at most ten integer digits), so `"12abc"`, `"1e3"`, `"-1"` and over-precise prices are 400s instead of reaching SQL. [OrderBook](./backend/src/services/orderBook.ts) compares and subtracts BigInts, so filling 0.7 out of seven 0.1 asks leaves exactly 0.3 (float64 left `2.78e-17` residue in the old engine). Fees are exact too: notional has at most `price_precision + quantity_precision` decimals, and multiplying by a three-decimal rate stays within 18.

**Per-pair serialization.** [pairQueue.ts](./backend/src/services/pairQueue.ts) chains commands per symbol. Place, cancel, stop trigger and book rebuild for one pair run one at a time in arrival order; different pairs run concurrently. This is what stops a cancel from slipping between "the book consumed this resting order" and "the fill committed". It is a per-process guarantee: several API instances still mean several unrelated books.

**Placement.** Validation runs first, outside the queue. Inside it, the hold is computed and the reservation plus the order insert commit in **one transaction**, so a failed insert can no longer strand a reserve:

```sql
UPDATE wallets SET reserved_balance = reserved_balance + $3
WHERE user_id = $1 AND currency_id = $2 AND (balance - reserved_balance) >= $3;
INSERT INTO orders (..., hold_remaining, ...) VALUES (..., $hold, ...) RETURNING id, arrival_seq;
```

A sell holds its base quantity. A buy holds `quantity × worst price × (1 + taker fee)` in quote, where the worst price is the limit price, or for market and stop orders a protection price 5% beyond the reference (current price, or stop price), rounded outward to the tick. Fills can only happen at that price or better and the taker rate is the larger fee, so the hold always covers what the order can spend.

**Matching and settlement.** `OrderBook.match` walks the opposite side for an incoming order without inserting it; executions happen at the resting order's price, the incoming order is the taker, the resting one the maker. Each match settles in its own transaction that inserts the trade (with `taker_side`), updates both orders, and moves value:

| Party | Effect |
|-------|--------|
| Buyer | spends `notional + buyer fee` quote out of its hold; receives base |
| Seller | spends base out of its hold; receives `notional − seller fee` quote |
| Exchange account | receives both fees |

Fees are always quote-denominated and follow maker/taker roles (0.1% maker, 0.2% taker). The fill update is guarded (`WHERE status IN ('open','partially_filled') AND filled_quantity + q <= quantity`) and decrements `hold_remaining`, whose `>= 0` CHECK refuses overspending. When an order finishes, whatever its worst-case hold did not spend (price improvement, maker-vs-taker difference, the protection band) is released in the same transaction. Ledger rows record each received currency as `trade` and each fee as a separate `fee` row in quote, so amounts never carry ambiguous units. If a settlement fails, the book has already consumed resting quantity in memory, so the pair's book is rebuilt from Postgres before the error is returned.

**Market orders and liquidity.** Market orders (and triggered stops) are immediate-or-cancel. They sweep the book down to the protection price; any remainder fills against the **exchange account** ([exchangeAccount.ts](./backend/src/services/exchangeAccount.ts)) at the simulated market price, as a real trade with a real counter-order, if that price is inside the protection band. Whatever is still unfilled is cancelled and its hold released. The exchange account is created at boot and topped up to 10^9 units per currency, each top-up recorded as a `deposit`, so the only place value enters the system is visible. It does not log in (random password hash) and is excluded from portfolio snapshots.

**Stops.** [stopOrders.ts](./backend/src/services/stopOrders.ts) keeps untriggered stops apart from the book. A buy stop must be above the current price and a sell stop below it, otherwise it is rejected as an order that would fire instantly. Stops are checked on every price tick and after every trade (a trade moves the price), fire nearest-first, and execute as protected market orders relative to their stop price. Cancellation removes them before they can fire; a trigger queued behind a cancel re-checks status and does nothing.

**Cancellation** runs in the pair queue: `SELECT ... FOR UPDATE` on the live order, set `cancelled`, zero `hold_remaining`, and release exactly that amount, all in one transaction; memory is updated only after commit. Releases are no longer clamped at zero: releasing more than is held is a bug, and the `reserved_balance >= 0` CHECK now surfaces it.

**Rehydration.** Before the server listens, [index.ts](./backend/src/index.ts) rebuilds every pair from `orders WHERE status IN ('open','partially_filled') ORDER BY arrival_seq`. `arrival_seq` is assigned by Postgres at insert and is also the in-memory tie-breaker, so replay reproduces exactly the priority the lost book had (it used to be `Date.now()` milliseconds, and an isolated check showed a same-millisecond bid winning over an earlier ask). Untriggered stops go back to the stop list; market orders and already-triggered stops still live were interrupted mid-execution and are cancelled with their holds released. Startup retries while Postgres is unavailable and refuses to serve if the book cannot be rebuilt.

**Idempotency.** Keys are scoped per user in Redis (`idempotency:<user>:<key>`) and in Postgres (`UNIQUE (user_id, idempotency_key)`). Two users choosing the same key get separate orders. A same-user race that slips past Redis hits the unique index, and the second request returns the first order instead of an error. The cached response is still a snapshot of the order at placement time.

**Verification.** Beyond the mocked route tests, [matching.test.ts](./backend/src/services/matching.test.ts) covers strict parsing, exact arithmetic, price-time priority with arrival sequences, limit stops, depth aggregation, stop ordering, and the pair queue. A scripted run against the live stack (Postgres + Valkey, Kafka down) placed, matched, cancelled and triggered orders between the two seeded users and checked after each phase that (a) every currency's total across all wallets is unchanged by trading, (b) every wallet's `reserved_balance` equals the sum of `hold_remaining` over its live orders, and (c) finished orders hold nothing; it then restarted the API and confirmed a resting order and an armed stop were rebuilt and still matched/cancellable.

### Price, candles, and Kafka

[MarketService](./backend/src/services/marketService.ts) initializes twelve random-offset prices and runs a GBM-style multiplicative simulation. The API ticks every two seconds. High/low, volume, and change are synthetic process-lifetime statistics, not rolling 24-hour trade aggregates. Sparklines use separately generated random points in the browser.

The [price worker](./backend/src/workers/price-broadcaster.ts) has an independent map and random path. The [portfolio worker](./backend/src/workers/portfolio-updater.ts) has a third initial price map and never ticks it or consumes external changes. API prices, stored candles, and snapshot marks consequently differ. Missing USD marks, including seeded USDT/USDC currencies without USD pairs, produce zero valuation rather than unavailable data.

The price service keeps only the current candle. Once a tick rolls to the next minute, getCompletedCandle cannot retrieve the previous candle. An isolated fake-clock check returned a completed candle before rollover tick and null afterward. The worker's once-per-minute timer can therefore miss completed candles; it does not retain a completed-candle queue. UPSERT adds full incoming volume again on duplicate writes, and no worker produces larger intervals.

[Kafka publication](./backend/src/services/kafka.ts) logs and swallows errors. Producer initialization exposes a producer before connect finishes and retains it after initial failure. There is no outbox or application retry receipt. KafkaJS's internal attempts do not make lost publication intent durable. getConsumer is never called; no consumer connects Kafka prices/trades to the API or portfolio worker.

Price broadcasting awaits publication per symbol, and recurring async timers can overlap under delay. The portfolio worker queries all users and their wallets sequentially, inserts snapshots separately, and can overlap its next run. Neither worker has coordinated ownership, bounded history, retention, or shutdown handling.

### Frontend behavior

[The root](./frontend/src/routes/__root.tsx) mounts a [WebSocket hook](./frontend/src/hooks/useWebSocket.ts) under React StrictMode. It registers its price and order-update handlers on every effect run and removes them on cleanup, so the development setup/cleanup/setup cycle ends with exactly one live handler. (An earlier "connected" ref skipped the second setup and left prices unapplied in development.)

[The client](./frontend/src/services/websocket.ts) retries up to ten consecutive failures with exponential delays capped at 30 seconds, resetting attempts on open. There is no jitter, heartbeat, sequence recovery, or stale-data indicator. connect is a no-op while a socket is OPEN or CONNECTING, and a socket replaced by `reconnect()` cannot schedule a second connection. The root hook reconnects when the signed-in user changes, because the server binds the private channel from the session cookie at upgrade time, and refreshes orders and wallets on each `order_update` push. Subscriptions use a set without reference counts; the ticker hook is unused.

The market overview polls pairs every ten seconds. The trade page fetches candles on entry/interval changes and polls depth every five seconds; it does not poll or stream live candles. Interval clicks can duplicate fetches. A global candle array and book object have no symbol/request-generation guard, and the unused setSelectedSymbol reset is never called. Late old responses can populate the current symbol's screen.

[PriceChart](./frontend/src/components/PriceChart.tsx) uses the Lightweight Charts 5 addSeries API. The chart is created once; new candles replace the series data, and the view is fitted only when the symbol changes, so zoom and scroll survive each refresh. Empty data always displays Loading chart data, including unsupported intervals or failed requests. The existing API usage agrees with the [v5 migration reference](https://tradingview.github.io/lightweight-charts/docs/5.0/migrations/from-v4-to-v5); a missing live update contract is not an obsolete-series-method bug.

[TradeForm](./frontend/src/components/TradeForm.tsx) offers market, limit, and stop orders. Its estimates are floats (display only), it labels every pair with dollar amounts, and it shows the maker-to-taker fee range for limits and the taker rate otherwise. For buys it shows the funds the server will hold (worst price plus taker fee) so the user can see why an order needs more than its estimated total. The result message distinguishes filled, resting, armed-stop, and cancelled-remainder outcomes. Only submit is disabled during the request; side/type/amount controls stay editable, and completion clears the newer draft. Changing route can preserve the old form draft because it is not keyed/reset by pair.

[Portfolio state](./frontend/src/stores/portfolioStore.ts) is shared without account identity. Logout does not clear wallets, holdings, or orders, and pending old-account queries can overwrite new state. Orders/wallets refresh after mutations without being awaited; portfolio totals do not. Private pages correctly wait for resolved authentication, but server errors often leave old data or an empty display. Logout clears local identity even if the HTTP operation failed.

The portfolio is a holdings list and stacked allocation bar, with no history chart, deposit control, or live valuation subscription. Orders show the latest fifty by default, with no filter or pagination controls and no automatic refresh while another user fills an order. Cancel clicks have no pending/error handling. Backend decimal strings conflict with several number-typed frontend fields and are parsed for display. Depth quantities use four decimals regardless of pair policy; crypto-to-crypto quote units are also mislabeled in tickers, asset rows, and order history.

### Authentication and operational patterns

[HTTP auth](./backend/src/routes/auth.ts) hashes new passwords at bcrypt cost 12 and strips password_hash correctly on login. Username/email matching is case-sensitive; validation is mostly truthiness and length, with no full server email/type schema. User creation and initial wallet creation are separate commits. Login/registration do not regenerate session IDs, and requireAuth trusts session userId without refreshing account state.

[Session setup](./backend/src/app.ts) uses coinbase:sess: Redis keys and a 24-hour HttpOnly/SameSite=Lax cookie, with secure false in every environment. CORS reflects arbitrary origins with credentials. SameSite behavior is not a complete authorization or CSRF policy. There is no administrator role or operational UI, and is_verified is not checked for trading.

[WebSocket handling](./backend/src/websocket.ts) resolves identity during the HTTP upgrade by running the same Express session middleware on the upgrade request. A socket with a session is subscribed to `user:<id>` by the server; `subscribe` refuses any `user:` channel by name, and the legacy `auth` message only reports the server-established identity (a client-supplied `userId` is ignored). Order state changes are pushed to the owner's channel as `order_update`. Anonymous sockets still receive public price broadcasts. Origin is not checked. Close and error share one idempotent cleanup, so the connection gauge is decremented once.

| Pattern | Actual wiring | Limitation |
|---------|---------------|------------|
| Conditional reservation | walletService.reserveBalance | Atomic one-row check, in the same transaction as the order insert |
| Deposit transaction | walletService.deposit | Wallet/log commit together; simulated and non-idempotent |
| Settlement transaction | orderService.applySettlement | Trade, both fills, wallets, fee credit and hold release commit together |
| Idempotency | services/idempotency.ts + unique (user, key) | Per-user Redis replay with database backstop; cached result is a placement-time snapshot |
| Rate limits | [services/rateLimiter.ts](./backend/src/services/rateLimiter.ts) | Per-process default IP stores, not Redis/account limits |
| Metrics | [services/metrics.ts](./backend/src/services/metrics.ts) | Order/depth/settlement meanings need separate interpretation |
| Logging | [services/logger.ts](./backend/src/services/logger.ts) | Pino used mainly in entry points/workers; no request context/redaction policy |
| Circuit breaker | [services/circuitBreaker.ts](./backend/src/services/circuitBreaker.ts) | Defined but never imported or used |

The active rate limits are 100 API requests/minute, ten placements/second, and twenty login/register attempts per fifteen minutes. They are shared by IP within one process, not calibrated proof that a caller uses at most ten percent of capacity. rate-limit-redis is installed but unused.

Prometheus exposes orders_total, trades_total, active_websocket_connections, and HTTP duration. Order depth is declared but never set. Every trades_total increment corresponds to a trades row (exchange-liquidity fills included); placed orders can later fail settlement without a failure counter. HTTP route labels omit mounted prefixes for matched routes and use raw paths otherwise. The health response is always healthy if reached and does not test dependencies or recovered book state.

The API calls server.close on SIGINT/SIGTERM, but does not explicitly drain/close WebSockets, stop its price timer, disconnect Kafka/Redis, or close the pool. There is no shutdown deadline or worker shutdown protocol. This is not demonstrated complete exchange recovery or connection draining.

### Simplifications, omissions, and verification

The local project intentionally uses simulated funding and prices, a single PostgreSQL instance, one Valkey, and optional Kafka. It omits real custody, funding rails, an immutable balanced journal (settlement is balanced per trade, but there is no signed double-entry table), a shared sequencer across instances (the pair queue is per process), a checkpointed command log (the book is rebuilt from the orders table instead), transactional outbox, replica/failover topology, and production deployment infrastructure. Private account streams exist only as `order_update` notifications that prompt the client to refetch.

The fifteen [mocked HTTP tests](./backend/src/app.test.ts) exercise route responses, validation, and unauthenticated access; [matching.test.ts](./backend/src/services/matching.test.ts) exercises the matching engine, decimal handling, stops, and the pair queue. The seven [smoke checks](./tests/smoke.spec.ts) mostly assert page containers. The order lifecycle was additionally verified against the live stack as described under Order lifecycle. Reconnect freshness, candle persistence, and production targets were not measured.
