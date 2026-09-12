# 💱 Design a spot exchange: backend interview

> “I would explain one order from reservation through matching and accounting, then
> show how it recovers after a crash. A fast in-memory book is useful, but it is not a
> complete exchange until accepted orders, holds, fills, and balances agree durably.”

This is a proposed production design for a 45-minute discussion. The local
Node/PostgreSQL project demonstrates some mechanisms and has significant correctness
gaps, documented in [Implementation Notes](./architecture.md#implementation-notes). It
is not Coinbase's private architecture.

| Time | Discussion |
|------|------------|
| 4 minutes | Scope, invariants, and capacity |
| 5 minutes | Architecture and data model |
| 10 minutes | Deep dive: matching authority, commit, and recovery |
| 9 minutes | Deep dive: amounts, reservations, and accounting |
| 8 minutes | Deep dive: publication and stream consistency |
| 6 minutes | Failure handling and growth |
| 3 minutes | Verification and implementation boundary |

## 🎯 Scope, invariants, and capacity — 4 minutes

I would design spot trading with market and limit orders, partial fills, cancellation,
account balances, and public market data. Orders use versioned instrument rules for
price ticks, quantity steps, fees, and execution limits.

For this discussion, limit orders may rest. A market order has a stated price or spend
boundary and cancels its unfilled remainder. An empty book is a liquidity condition;
it does not authorize the exchange to invent a counterparty.

Custody, banking rails, identity verification, derivatives, and stop-order triggering
are separate systems. I would define their interfaces if asked, but first prove the
internal order and accounting path.

The first invariant is that accepted orders cannot reserve the same spendable assets
twice. The second is that every committed fill agrees with order quantities and
balanced per-asset journal entries. The third is that a command has one recoverable
result across retries.

Cancellation must have a deterministic relationship with fills. If the fill wins the
pair sequence first, cancellation only affects the remaining quantity. An HTTP
cancellation request being received is not proof that its order stopped trading.

Assume ten million commands per day: about 116 per second on average and 2,000 per
second at a stated peak. Four million fills per day add about four GB of raw fill
records at one KB each, before journal entries, indexes, and replication.

For 100,000 connected clients, five subscribed markets each, and two ticker updates
per second, we deliver around one million updates per second. At 200 bytes per update,
that is roughly 200 MB/s before protocol overhead. Fan-out can be a larger
infrastructure cost than the command rate suggests.

I would target command acknowledgement p99 below 250 ms and 99.95% availability in the
primary region. Those targets justify a durable commit on the initial path; they do
not require claiming an unmeasured microsecond matching guarantee.

## 🏗️ Architecture and data model — 5 minutes

I would keep one logical command owner for each pair and one initial transactional
accounting authority:

```
┌────────────────┐       ┌────────────────┐
│ Command API    │──────▶│ Pair owner     │
│ Auth + routing │       │ Committed book │
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Orders + holds │
                         │ Ledger/receipt │
                         │ Outbox         │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Market/account │──────▶ Gateways
                         │ projections    │
                         └────────────────┘
```

Logical service boundaries do not force separate databases. Initially, orders, holds,
fills, journal entries, receipts, and outbox records share a database transaction. The
pair owner maintains a committed memory view for efficient comparison and serializes
commands for that pair.

| Record | Important fields | Invariant or purpose |
|--------|------------------|----------------------|
| Instrument policy | Pair, tick/step, fee assets, limits, revision | One accepted definition of valid amounts |
| Pair command | Pair, sequence, owner epoch, input, decision | Durable ordering and replay |
| Order | Account, quantity, remaining quantity, status, revision | No fills beyond accepted quantity |
| Reservation | Order, asset, held/consumed/released amounts | Attribute every hold to its obligation |
| Fill | Stable identity, orders, maker/taker, price, quantity | Link one matching decision to accounting |
| Journal entries | Transaction, account, asset, exact amount | Balance each asset independently |
| Command receipt | Account, identity, input digest, outcome | Recover accepted or rejected intent |
| Outbox/checkpoint | Event identity or committed sequence | Publication and bounded recovery |

The API needs instrument metadata, bounded market snapshots, account reads, identified
order/cancel commands, and command lookup. Every private route checks account
authorization. A command identity identifies an attempt; it does not grant access to
another account's result.

I would return explicit invalid-input, insufficient-funds, unavailable-pair, accepted,
and known-processing states. A client that loses the response can query the same
command rather than guessing from the current book or submitting a new order.

## 🔧 Deep dive: matching authority, commit, and recovery — 10 minutes

The pair owner processes one command at a time. Its book has price levels ordered by
price and FIFO queues within each level. Orders receive a monotonic pair sequence;
millisecond timestamps are useful metadata but cannot uniquely establish arrival
order.

For a limit order, the owner plans fills against the committed book at the resting
order's price. The plan records the affected order revisions, quantities, and expected
instrument policy. It does not mutate the accepted memory state and then hope
persistence succeeds.

The transaction validates the owner fencing epoch and current policy, locks affected
order and wallet rows in a consistent order, verifies available funds, and creates the
order-specific reservation. No order becomes matchable before its funding obligation
is secured.

It then applies the planned fills, updates remaining quantities and holds, creates
balanced journal entries, records the command result and pair sequence, and writes
outbox events. These changes commit together.

After commit, the owner applies the same plan to memory before handling its next
command. If the process dies between commit and memory application, the database still
contains the accepted decision and sequence needed for replay.

If commit outcome is unknown, the owner pauses the pair and resolves the command from
the durable store. Continuing to match from the old book would risk applying
subsequent commands against state that may already have changed.

This is a deliberate initial architecture. It pays database latency at the command
boundary and can hold several wallet locks for an order that crosses multiple
counterparties. I would bound order work and measure those costs before promising a
throughput target.

| Approach | Benefit | Cost for this workload |
|----------|---------|------------------------|
| ✅ Committed memory view plus one durable command transaction | Simple agreement among order, hold, fill, and ledger | Durable-write latency and wallet contention |
| ❌ Mutate memory, then write each table separately | Fast visible matching loop | A later failure leaves records and book disagreeing |
| Alternative: replicated matcher with asynchronous settlement | Can reduce command-path storage work | Requires funded admission, fencing, and recovery protocols |

A separate matcher is not inherently incorrect. Before it accepts an order, however,
it needs a durable reservation or an admission grant backed by funds. A fill stream
consumed later cannot retroactively prevent an unfunded order from matching.

If that advanced design uses a lease to choose the active owner, the durable write
boundary must reject stale epochs. A paused owner can resume after its lease expires;
merely declaring another process leader does not prevent the old one from writing.

Cancellation enters the same sequence as placements and matching. If it wins first,
the remaining order leaves the committed book and its attributed hold is released in
the same transaction. If a fill wins, cancellation reports the remaining cancellable
quantity or that execution already completed.

A cancelled order can therefore contain fills. The state describes the unfilled
remainder, while execution history records what traded. Treating cancellation as
deletion loses that distinction.

Idempotency is part of this commit boundary. The receipt is scoped to account and
operation identity, bound to normalized input, and stored durably. A duplicate command
recovers its prior result without reserving again; a reused key with different input
is rejected.

The receipt is not a cached copy of an order forever frozen at acceptance. It
identifies the original outcome and order reference. The current order may now be
partially filled, filled, or cancelled, and a separate canonical read reports that
revision.

For recovery, a checkpoint contains the committed book and its sequence. Replay
includes placements, fills, cancellations, and expiry after that sequence. Replaying
only trades cannot restore unfilled resting orders or orders removed by cancellation.

Before reopening the pair, I would compare open quantities, holds, and the replayed
book. A discrepancy pauses the affected scope and requires an explainable recovery
path. A process health endpoint saying “running” is not sufficient readiness for
trading.

> “The speed advantage comes from avoiding database comparisons inside the matching
> loop. It does not mean an acknowledged order can live only in a process's memory.”

## 🔧 Deep dive: amounts, reservations, and accounting — 9 minutes

I would make asset units explicit at every boundary. A price is quote asset per base
asset. Quantity is base asset. Their product is quote asset. A fee has its own
specified asset; subtracting a quote fee directly from base quantity is a unit error
even if both are exact decimals.

For an illustrative policy, suppose fees are charged in quote currency. A buy
reservation covers its maximum permitted execution cost plus the maximum applicable
fee, rounded according to policy. A sell reserves its base quantity, with fees
deducted from received quote proceeds.

The exact details can vary, but they must be fixed for the accepted order. A later
fee-policy edit cannot silently increase an existing obligation beyond what was
reserved without an explicit transition.

A fill consumes the relevant portion of the order's hold and transfers assets. Any
difference between a buy limit allowance and the actual execution cost is released. If
quantity remains open, its reservation reflects that remaining obligation; a completed
order leaves no residual hold.

Consider a one-unit trade at 100 quote units, with a 0.20 quote-unit buyer fee and
0.10 quote-unit seller fee. The accounting is illustrative and independent of current
market prices:

| Asset | Buyer change | Seller change | Fee account change | Sum |
|-------|--------------|---------------|--------------------|-----|
| Base | +1 | -1 | 0 | 0 |
| Quote | -100.20 | +99.90 | +0.30 | 0 |

The fee account is essential to explaining conservation. Logging only the buyer's
incoming base and seller's incoming quote is not a complete journal of the trade.
Summing unlike assets into one USD estimate does not prove the original transfers
balance.

I would keep attributed reservations rather than only an aggregate reserved_balance
field. The aggregate remains a useful query projection, but cancellation must release
that order's remaining hold, not subtract a guessed amount and clamp the total to
zero.

The transaction locks or conditionally updates spend authority shared across pairs.
The same account may place BTC-USD and ETH-USD buys concurrently. Separate pair owners
do not make that USD balance independently spendable in both markets.

For arithmetic, exact decimal libraries or integer units are both reasonable. Integers
need explicit per-asset scaling and overflow handling; decimals need explicit accepted
precision and rounding. Both need validation of full input syntax and tick/step
compliance.

PostgreSQL numeric values can be rounded to the declared scale when stored. A numeric
column preserves the value it receives within that definition; it cannot undo prior
binary floating-point rounding. [PostgreSQL numeric
types](https://www.postgresql.org/docs/16/datatype-numeric.html).

I would reject nonfinite values, unsupported exponents or syntax, invalid scale, and
nonpositive order quantities/prices before reservation. The database supplies
appropriate constraints as a backstop. Parsing the numeric prefix of a malformed
string and later inserting the original string can otherwise fail after funds were
already held.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Exact units, attributed holds, balanced journal | Supports reconciliation and precise release | Additional records and explicit rounding policy |
| ❌ Mutable balance totals alone | Fewer writes and simple reads | Cannot explain every hold or reconstruct missing effects |
| ❌ Decimal storage after floating-point calculations | Convenient application arithmetic | Stores earlier rounding and unit mistakes faithfully |

For a market order, reservation must match its execution boundary. Reserving at the
last price while allowing execution ten percent higher is inconsistent unless another
protected budget covers the difference. I would include the accepted price/spend
protection in the command contract.

If liquidity is absent or exhausted, the declared remainder policy applies. Synthetic
demo fills are useful for exercising a UI, but they are not counterparty settlement
and must not enter an authoritative exchange ledger as though they were.

## 🔧 Deep dive: publication and stream consistency — 8 minutes

The command transaction writes outbox events with stable identities. A relay publishes
them and records progress. A crash after database commit but before publication leaves
durable pending work; a crash after publication but before marking progress can cause
a duplicate.

Consumers handle that duplicate inside their own state transaction. A fill identity
prevents applying the same derived effect twice. The relay's transport acknowledgement
and the consumer's committed effect are separate milestones.

I would not make a slow market-data consumer block a committed trade. The accounting
result remains authoritative while its public or private projection is delayed.
Backlog limits still matter: unlimited outbox growth is not an availability strategy.

Market projections derive ticker, depth, candles, and recent trades from the same
committed source. Independent random price generators in API and worker processes are
fine for isolated demonstrations, but they cannot produce a coherent exchange history.

Candle aggregation retains completed buckets until persistence succeeds and
deduplicates trade identities. It defines how late events revise a bucket and how
clients receive that revision. A timer reading only the current mutable candle can
miss the previous minute after rollover.

For depth, the projection publishes a snapshot sequence and ordered deltas. A joining
client buffers while acquiring a snapshot, removes covered deltas, and applies a
contiguous suffix. A gap or overflow forces a fresh baseline.

A ticker's intermediate display values may be coalesced. Raw book deltas cannot be
discarded arbitrarily. Complete account snapshots can replace older revisions, while
incremental account effects need ordering or recovery from canonical state.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Outbox plus versioned projections and bounded replay | Recovers publication and missing updates | More event/checkpoint state and operational lag handling |
| ❌ Best-effort publish after commit | Simple happy path | Loses the only publication intent on a crash |
| ❌ Unbounded per-client buffering | Avoids immediate disconnects | Delivers increasingly stale data and exhausts memory |

Kafka's consumer-group model distributes work among members of a group. If every
gateway must receive all relevant events, use independent groups or an explicit
routing layer; one shared group does not broadcast every event to every member. [Kafka
consumer
groups](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html).

Private streams validate server-side account permissions. A client-supplied user
identifier or guessed channel name is not authentication. Session revocation and
account changes require a defined private-stream shutdown or revalidation path.

I would start with HTTP snapshots for slower account/history views and streams where
freshness warrants them. Polling can be the right initial choice for a small book if
its delay is acceptable. The protocol's correctness matters more than choosing
WebSocket everywhere.

## 📈 Failure handling and growth — 6 minutes

API and public gateway processes can scale independently from pair owners. Pair
assignment balances work, but the hottest individual pair still has one logical order
sequence. Moving that pair requires checkpoint/replay and fencing, not two independent
active books.

The initial accounting authority remains shared across pairs because accounts spend
the same assets in several markets. If it later needs sharding, I would specify
coordinated transfers or funded market allocations before splitting balances by
account.

Two separately idempotent writes to buyer and seller shards are not automatically one
atomic trade. The transfer protocol must preserve conserved value and unavailable
funds through every intermediate and failure state. That is substantial new design
work, not a free consequence of adding a message queue.

I would first optimize bounded command batches, wallet lock ordering, book lookup
structures, and query indexes. The throughput of a particular database or array
depends on the workload and implementation; I would not claim that one is universally
unusable for exchanges.

Read capacity is often dominated by subscription fan-out and history queries. Limit
requested depth and date ranges, paginate orders/fills, and publish lower-frequency
overview summaries. Ticker samples are suitable for display, while candle calculation
still needs its complete source contract.

Metrics should include command latency, owner queue depth, wallet lock waits,
settlement failures, orphan holds, journal imbalance, replay time, outbox age, and
stream resynchronization. Ordinary order rejection is a different metric from a
committed accounting discrepancy.

Readiness means the owner has recovered to the durable sequence and can access spend
authority. A database outage pauses acceptance. Redis failure has an explicit
session/recovery policy. A broker outage retains outbox work until its backlog or age
exceeds the defined operating limit.

Retention preserves enough command history and checkpoints for recovery, and enough
journal/receipt information for the promised account and retry behavior. I would avoid
inventing a regulatory retention period in a system-design answer; the product and
jurisdiction supply that requirement.

## 🧪 Verification and implementation boundary — 3 minutes

I would test competing orders across two pairs sharing one wallet, a partial fill
followed by cancellation, equal-time arrivals, price improvement, fee denomination,
and exact quantity boundaries. Assertions compare order quantities, attributed holds,
and balanced journal entries.

Failure tests stop the owner after commit but before memory application, lose the
acknowledgement, replay the command, duplicate outbox publication, and reject a stale
owner epoch. A successful restart must restore unfilled orders as well as completed
trades.

The local code has an atomic conditional reserve update and a wallet-transfer
transaction, but these are separate from order insertion and trade/fill updates.
Matching mutates memory first, fees contain a base/quote unit error, and synthetic
market fills leave book entries behind.

There is no durable pair log, book rehydration, attributed hold table, balanced
journal, or transactional outbox. Redis replay is global and unbound, and Kafka has no
connected application consumer. Those source boundaries are why the proposed commit
and recovery design is the core of this answer.
