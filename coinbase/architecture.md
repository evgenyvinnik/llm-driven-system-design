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
┌────────────────┐       ┌────────────────┐
│ Browser        │──────▶│ API / gateway  │
│ CDN assets     │◀──────│ Auth + queries │
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Pair command   │
                         │ owner / book   │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Durable store  │
                         │ Orders/ledger  │
                         │ Receipt/outbox │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Event relay    │──────▶ Market views
                         │ Stream workers │──────▶ Account views
                         └────────────────┘
```

Logical ownership does not require a different database for every box. The first production design keeps orders, reservations, fills, journal entries, receipts, and outbox records in a common transactional store. Pair owners keep committed active books in memory to avoid repeated database comparisons, but do not publish speculative fills as durable facts.

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
  idempotency_key VARCHAR(64) UNIQUE,
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
  buyer_fee DECIMAL(28,18) DEFAULT 0,
  seller_fee DECIMAL(28,18) DEFAULT 0,
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
```

The wallet checks constrain individual stored rows. They do not prove that order holds reconcile, fees use the correct asset, or transfers conserve assets across accounts. Balance and reserve columns are nullable; order quantity/price/fill columns lack positive, finite, scale, and fill-not-above-quantity constraints. Transaction references are UUIDs without a foreign key or unique effect identity.

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
| Process failure | Replay committed book mutations before trading | Open database orders are not rehydrated |
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

[Configuration](./backend/src/config/index.ts) loads dotenv for API/workers and reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE plus REDIS_HOST/REDIS_PORT. DATABASE_URL and REDIS_URL are unused. [The migration runner](./backend/src/db/migrate.ts) reads PG* directly without dotenv and reexecutes non-idempotent initialization SQL. Compose already applies that SQL on a fresh volume.

The default API port and npm dev port are 3001. The server2/server3 scripts invoke dev, whose inner PORT assignment overrides their 3002/3003 values. Even a correctly overridden direct tsx invocation creates independent books and prices. There is no load balancer or shared matching owner.

The full seed has valid UUIDs and a password123 hash verified with bcrypt. It creates Alice/Bob and fifteen wallets, one-minute candles for three USD markets, and five deposit records. Repeated imports append deposit records and may add newer candle timestamps. Existing usernames with other IDs can break fixed wallet references. There are no seeded orders, trade rows, liquidity, or administrator role.

### Order and reservation boundaries

[placeOrder](./backend/src/services/orderService.ts) first reads a Redis result when given a key, fetches the trading pair, parses quantity/price to numbers, and calls [reserveBalance](./backend/src/services/walletService.ts). The conditional wallet update is atomic for that row:

```sql
UPDATE wallets
SET reserved_balance = reserved_balance + $3, updated_at = NOW()
WHERE user_id = $1 AND currency_id = $2
  AND (balance - reserved_balance) >= $3
RETURNING id;
```

Order insertion is a separate pool query. A duplicate key, malformed quantity, or later failure can therefore leave a reserve without a corresponding successful order. Validation checks a parsed quantity against min/max, but does not enforce finite positive prices, full-string numeric syntax, configured price/quantity precision, or a common per-currency rounding policy. A value such as a numeric prefix followed by junk can pass parseFloat before SQL rejects the original string.

[OrderBook](./backend/src/services/orderBook.ts) uses number-valued sorted arrays. matchOrders mutates quantities and removes entries before any database settlement is attempted. processMatches then inserts a trade, updates each order in separate queries, and only afterward opens the wallet-transfer transaction. That transaction cannot roll back the already committed trade/order records or restore memory.

There is no pair command queue, owner epoch, transaction spanning these stages, per-order fill revision guard, or book rehydration. JavaScript's synchronous matching loop does not prevent asynchronous settlement and cancellation from interleaving. Multiple process-local books cannot coordinate shared wallet/order records.

Price-time ties use Date.now milliseconds. An isolated check inserted an ask at 99 and then a bid at 101 with the same timestamp; the match chose 101 because the tie branch favors the bid, despite the ask arriving first. Another check matched 0.3 against 0.1 plus 0.2 and left an ask residue of about 2.78e-17. There is no exact quantity grid or dust reconciliation.

### Fees, synthetic fills, and cancellation

Matched fees are computed as quantity × price × rate, so both are quote-denominated. executeTradeTransfer subtracts buyerFee directly from baseAmount. At the code's illustrative 65,000 price, a one-unit buy computes a 130 quote-unit fee and a negative 129 base-unit credit. This isolated arithmetic demonstrates a unit error; the resulting database outcome depends on existing balances and constraints. The buyer is always charged the taker rate and seller the maker rate, regardless of which order rested first.

Wallet settlement has no exchange fee account or balanced journal. It logs two positive incoming trade records rather than all asset movements. Buyer limit reserves are reduced by actual execution cost instead of releasing the accepted limit allowance for the filled quantity, leaving price-improvement residue. Aggregate holds have no order attribution.

A market order is added to the book at 110% of the current price for buys or 90% for sells, while a buy reserves only quantity × current price. A higher eligible fill can exceed that reservation. If matching returns no results, simulateMarketFill marks the order filled and updates that user's wallets, with no counterparty or trades row. It leaves the original market entry in the book, permitting later matches against an already filled database order.

If a market order matches only partially, its remainder stays in the book; there is no immediate-or-cancel policy or synthetic fill of that remainder. Simulated fills record a transaction and Kafka event, but do not update the market-service price. Their buyer fee is converted to base before crediting, unlike the matched path, while transaction fee/amount units remain ambiguous.

Stop orders reserve funds and create an open row without entering the book or any trigger queue. Buy stops and remaining buy market orders have null price, so cancellation's price-dependent release branch does not release their quote hold.

Cancellation starts a transaction but selects without FOR UPDATE, updates status without an expected status/version predicate, removes memory state, and calls releaseReserve through a separate pool query. That release commits outside the cancellation transaction and clamps the aggregate reserve at zero. Concurrent cancellations can release twice; fill updates can overwrite cancelled status. No repeated-operation identity makes cancellation recoverable.

### Idempotency

[The helper](./backend/src/services/idempotency.ts) uses global idempotency:<key> entries for 24 hours. It has no account/body binding, atomic claim, lease, or database-result lookup. Two concurrent misses can both reserve; the database unique key may reject the second insert only after its reserve committed. A cache hit can return another account's order result for a reused key.

Redis errors propagate rather than invoking a database fallback. A post-processing setex failure returns an error after state changes. After cache expiry, the unique database key produces an error instead of recovering the original result. The cached result is an old order snapshot and can remain open after later fill/cancel.

The frontend generates Date.now plus Math.random on every placeOrder invocation, not UUID v4 and not one durable identity across retries. It supplies no command lookup or unknown-outcome state. Repeated submission after a timeout is a new attempt.

### Price, candles, and Kafka

[MarketService](./backend/src/services/marketService.ts) initializes twelve random-offset prices and runs a GBM-style multiplicative simulation. The API ticks every two seconds. High/low, volume, and change are synthetic process-lifetime statistics, not rolling 24-hour trade aggregates. Sparklines use separately generated random points in the browser.

The [price worker](./backend/src/workers/price-broadcaster.ts) has an independent map and random path. The [portfolio worker](./backend/src/workers/portfolio-updater.ts) has a third initial price map and never ticks it or consumes external changes. API prices, stored candles, and snapshot marks consequently differ. Missing USD marks, including seeded USDT/USDC currencies without USD pairs, produce zero valuation rather than unavailable data.

The price service keeps only the current candle. Once a tick rolls to the next minute, getCompletedCandle cannot retrieve the previous candle. An isolated fake-clock check returned a completed candle before rollover tick and null afterward. The worker's once-per-minute timer can therefore miss completed candles; it does not retain a completed-candle queue. UPSERT adds full incoming volume again on duplicate writes, and no worker produces larger intervals.

[Kafka publication](./backend/src/services/kafka.ts) logs and swallows errors. Producer initialization exposes a producer before connect finishes and retains it after initial failure. There is no outbox or application retry receipt. KafkaJS's internal attempts do not make lost publication intent durable. getConsumer is never called; no consumer connects Kafka prices/trades to the API or portfolio worker.

Price broadcasting awaits publication per symbol, and recurring async timers can overlap under delay. The portfolio worker queries all users and their wallets sequentially, inserts snapshots separately, and can overlap its next run. Neither worker has coordinated ownership, bounded history, retention, or shutdown handling.

### Frontend behavior

[The root](./frontend/src/routes/__root.tsx) mounts a [WebSocket hook](./frontend/src/hooks/useWebSocket.ts) under React StrictMode. Its connected ref remains true after effect cleanup removes the handler, so the development setup/cleanup/setup cycle skips re-registration. This defect is inferred from source and React's documented [development effect cycle](https://react.dev/reference/react/useEffect); no browser reproduction was run. The socket can remain connected without applying price messages.

[The client](./frontend/src/services/websocket.ts) retries up to ten consecutive failures with exponential delays capped at 30 seconds, resetting attempts on open. There is no jitter, heartbeat, sequence recovery, or stale-data indicator. connect guards OPEN but not CONNECTING; disconnect can trigger its own reconnect through onclose. Subscriptions use a set without reference counts. The ticker hook is unused, and no component authenticates a private socket.

The market overview polls pairs every ten seconds. The trade page fetches candles on entry/interval changes and polls depth every five seconds; it does not poll or stream live candles. Interval clicks can duplicate fetches. A global candle array and book object have no symbol/request-generation guard, and the unused setSelectedSymbol reset is never called. Late old responses can populate the current symbol's screen.

[PriceChart](./frontend/src/components/PriceChart.tsx) uses the actual Lightweight Charts 5 addSeries API, but destroys/recreates the whole chart whenever candles change and calls fitContent, losing the previous viewport. Its symbol argument is unused, and empty data always displays Loading chart data, including unsupported intervals or failed requests. The existing API usage agrees with the [v5 migration reference](https://tradingview.github.io/lightweight-charts/docs/5.0/migrations/from-v4-to-v5); a missing live update contract is not an obsolete-series-method bug.

[TradeForm](./frontend/src/components/TradeForm.tsx) performs float estimates, labels every pair with dollar amounts, and shows a fixed 0.2% estimate even for a sell or maker execution. Only submit is disabled during the request; side/type/amount controls stay editable, and completion clears the newer draft. No accepted order reference, fill detail, price protection, balance check, or recovery state is shown. Changing route can preserve the old form draft because it is not keyed/reset by pair.

[Portfolio state](./frontend/src/stores/portfolioStore.ts) is shared without account identity. Logout does not clear wallets, holdings, or orders, and pending old-account queries can overwrite new state. Orders/wallets refresh after mutations without being awaited; portfolio totals do not. Private pages correctly wait for resolved authentication, but server errors often leave old data or an empty display. Logout clears local identity even if the HTTP operation failed.

The portfolio is a holdings list and stacked allocation bar, with no history chart, deposit control, or live valuation subscription. Orders show the latest fifty by default, with no filter or pagination controls and no automatic refresh while another user fills an order. Cancel clicks have no pending/error handling. Backend decimal strings conflict with several number-typed frontend fields and are parsed for display. Depth quantities use four decimals regardless of pair policy; crypto-to-crypto quote units are also mislabeled in tickers, asset rows, and order history.

### Authentication and operational patterns

[HTTP auth](./backend/src/routes/auth.ts) hashes new passwords at bcrypt cost 12 and strips password_hash correctly on login. Username/email matching is case-sensitive; validation is mostly truthiness and length, with no full server email/type schema. User creation and initial wallet creation are separate commits. Login/registration do not regenerate session IDs, and requireAuth trusts session userId without refreshing account state.

[Session setup](./backend/src/app.ts) uses coinbase:sess: Redis keys and a 24-hour HttpOnly/SameSite=Lax cookie, with secure false in every environment. CORS reflects arbitrary origins with credentials. SameSite behavior is not a complete authorization or CSRF policy. There is no administrator role or operational UI, and is_verified is not checked for trading.

[WebSocket handling](./backend/src/websocket.ts) trusts auth.userId and accepts any subscription string, including user channels. It checks neither session nor origin. No private publisher currently exposes order data through that path, so this is an unprotected capability boundary rather than evidence of a working private feed. Error and close handlers both decrement the connection gauge, potentially counting one disconnection twice.

| Pattern | Actual wiring | Limitation |
|---------|---------------|------------|
| Conditional reservation | walletService.reserveBalance | Atomic one-row check; outside order/settlement transaction |
| Deposit transaction | walletService.deposit | Wallet/log commit together; simulated and non-idempotent |
| Wallet transfer transaction | executeTradeTransfer | Excludes trade/order writes and contains fee unit error |
| Idempotency cache | services/idempotency.ts | Global unbound replay; no claim or durable recovery |
| Rate limits | [services/rateLimiter.ts](./backend/src/services/rateLimiter.ts) | Per-process default IP stores, not Redis/account limits |
| Metrics | [services/metrics.ts](./backend/src/services/metrics.ts) | Order/depth/settlement meanings need separate interpretation |
| Logging | [services/logger.ts](./backend/src/services/logger.ts) | Pino used mainly in entry points/workers; no request context/redaction policy |
| Circuit breaker | [services/circuitBreaker.ts](./backend/src/services/circuitBreaker.ts) | Defined but never imported or used |

The active rate limits are 100 API requests/minute, ten placements/second, and twenty login/register attempts per fifteen minutes. They are shared by IP within one process, not calibrated proof that a caller uses at most ten percent of capacity. rate-limit-redis is installed but unused.

Prometheus exposes orders_total, trades_total, active_websocket_connections, and HTTP duration. Order depth is declared but never set. Trades_total includes synthetic fills with no trades row; placed orders can later fail processing without a failure counter. HTTP route labels omit mounted prefixes for matched routes and use raw paths otherwise. The health response is always healthy if reached and does not test dependencies or recovered book state.

The API calls server.close on SIGINT/SIGTERM, but does not explicitly drain/close WebSockets, stop its price timer, disconnect Kafka/Redis, or close the pool. There is no shutdown deadline or worker shutdown protocol. This is not demonstrated complete exchange recovery or connection draining.

### Simplifications, omissions, and verification

The local project intentionally uses simulated funding and prices, a single PostgreSQL instance, one Valkey, and optional Kafka. It omits real custody, funding rails, an immutable balanced journal, a shared sequencer, complete book replay, transactional outbox, private account streams, replica/failover topology, and production deployment infrastructure. Accounting and lifecycle defects are separate from these scope reductions.

The fifteen [mocked HTTP tests](./backend/src/app.test.ts) exercise route responses, validation, and unauthenticated access. The seven [smoke checks](./tests/smoke.spec.ts) mostly assert page containers. Neither suite proves successful matching, settlement, reconnect freshness, or reserve reconciliation. This review inspected source/configuration and ran isolated bcrypt, actual order-book, fee arithmetic, and fake-clock candle checks. It did not run the application stack, execute SQL, perform browser tests, or measure production targets.
