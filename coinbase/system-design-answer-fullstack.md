# 💱 Design a spot exchange: fullstack interview

> “I would follow one order from an exact input in the browser to a durable
> reservation and fill, then back to the account view. The design should make a
> delayed price, a pending order, and a settled balance distinguishable instead of
> hiding them behind one success message.”

This is a proposed production design for a 45-minute whiteboard discussion. The local
React/Express exchange supplies the product example; [Implementation
Notes](./architecture.md#implementation-notes) describe its actual simulations,
partial implementations, and correctness gaps.

| Time | Discussion |
|------|------------|
| 5 minutes | Scope, user promises, and capacity |
| 5 minutes | Architecture and shared contracts |
| 9 minutes | Deep dive: one recoverable order |
| 8 minutes | Deep dive: precise amounts and account meaning |
| 8 minutes | Deep dive: coherent market data and rendering |
| 6 minutes | Failure handling, security, and growth |
| 4 minutes | Verification and implementation boundary |

## 🎯 Scope, user promises, and capacity — 5 minutes

I would build a spot exchange with public market browsing, one active trading screen,
market/limit orders, cancellation, partial fills, balances, and order history. The
guest can inspect prices; trading requires an authenticated account.

The market page shows ticker, depth, and candles. The account page shows holdings,
available and reserved amounts, and approximate valuation with its price source and
age. A portfolio total is not the same thing as the quantity of assets the account
owns.

I would exclude margin, derivatives, stop triggers, custody, and funding-provider
integration from this first discussion. Those systems have important contracts, but
they should not obscure whether an ordinary order can reserve funds and settle
correctly.

The first promise is that accepted orders cannot spend the same funds twice. The
second is that order fills, reservations, and accounting agree durably. The third is
that a lost response can be resolved without submitting another order.

The UI also needs honest execution semantics. A limit order may be accepted and remain
open. A market order has an explicit protection boundary and a policy for unfilled
quantity; I would cancel that remainder in this design. The displayed last price does
not guarantee a full fill at that price.

For sizing, assume ten million commands per day: roughly 116 per second on average and
2,000 at peak. Four million fills per day contribute about four GB of raw fill records
at one KB each, with additional journal, command, index, and replica storage.

Read fan-out can be larger. With 100,000 clients following five markets at two updates
per second, we deliver around one million updates per second. At 200 bytes each, that
is about 200 MB/s before protocol overhead.

I would target durable command acknowledgement p99 below 250 ms and 99.95% command
availability in the primary region. Client input responsiveness and update-to-paint
delay are separate targets to measure under bursts. These are planning assumptions,
not measured results from the repository.

## 🏗️ Architecture and shared contracts — 5 minutes

I would use a compact diagram and keep the order path visible:

```
┌────────────────┐       ┌────────────────┐
│ Browser        │──────▶│ Command API    │
│ Draft / views  │◀──────│ Query gateway  │
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Pair owner     │
                         │ Committed book │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Orders + holds │
                         │ Ledger/receipt │
                         │ Outbox         │
                         └───────┬────────┘
                                 ▼
                         Market/account views
```

The browser owns local drafts, navigation, focus, and rendering. The pair owner orders
commands and compares compatible interest. The initial transactional store owns
durable orders, holds, fills, accounting, command receipts, and publication intent.

A memory book accelerates comparisons but represents committed state. Public market
projections and private account views can update asynchronously after that commit.
Their delay does not change the accepted order, and the UI exposes the relevant
freshness.

| Shared concept | Browser needs | Backend provides |
|----------------|---------------|------------------|
| Instrument | Base/quote labels, tick/step, active status | Versioned accepted policy |
| Command | Frozen draft and stable identity | Account-bound receipt and canonical outcome |
| Order | Remaining/filled quantities and revision | Durable lifecycle and cancellation result |
| Balance | Owned, available, reserved, valuation age | Account snapshot with attributed obligations |
| Market data | Snapshot coverage and sequence | Coherent projection and recovery path |
| Connection | Current, stale, resynchronizing | Authorized subscriptions and bounded replay |

I would use HTTP for commands and snapshots, with a WebSocket for market subscriptions
where the freshness requirement warrants it. SSE or bounded polling remain credible
choices for simpler views. None of these transports determines whether the accounting
is correct.

Private query keys include account identity. Market query keys include pair and
interval or range. A shared loading boolean or one global candle array without context
makes unrelated requests interfere with each other.

The initial design keeps orders and accounting in one database transaction. Splitting
every diagram box into a separate database would introduce distributed coordination
before we have shown that the workload needs it.

## 🔧 Deep dive: one recoverable order — 9 minutes

I would walk through a limit buy. The user edits a quantity and limit price as exact
strings. The form displays the base and quote assets, the estimated cost, and the fee
policy, then freezes those values when submitted.

The client assigns one operation identity to that intention and retains it across
transport retries. It does not generate a fresh identity whenever the request times
out. A changed price or quantity after a known rejection is a new intention.

The API authenticates the account, validates the command, and routes it to the active
pair owner. The owner processes commands in a monotonic sequence; wall-clock
timestamps alone cannot break all arrival ties.

The owner plans any matches against its committed book. Before accepting the order,
the transaction secures its funds and rechecks the relevant instrument policy,
affected order revisions, and wallet state. Orders from different pairs still
coordinate if they spend the same wallet.

In this initial design, order creation, reservations, fills, remaining quantities,
journal entries, receipt, and outbox records commit together. If a planned settlement
fails, those records do not remain partly accepted while memory reports a completed
match.

After commit, the owner applies the same plan to its in-memory book before processing
another command. If commit outcome is uncertain, it pauses and recovers the command
from the durable store instead of continuing from possibly stale memory.

This boundary puts durable storage on the acknowledgement path. I would accept that
latency at the stated initial scale because it keeps the financial result explainable.
A faster independent matcher needs a durable funded-admission and recovery protocol,
not just a consumer that eventually updates balances.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ One committed order/hold/accounting result | Clear acknowledgement and failure semantics | Database latency and contention on shared wallets |
| ❌ Memory match followed by independent table writes | Simple fast matching loop | Failures can leave fills without settlement |
| Alternative: replicated matcher and later settlement | Can support a more demanding latency target | Requires durable funding grants and coordinated recovery |

Suppose the transaction commits but the HTTP response is lost. The browser shows that
it is checking the existing order and queries the same command identity. The server
recovers the receipt without reserving more funds.

The receipt is scoped to the authenticated account and bound to normalized input. A
caller cannot retrieve another user's result by guessing a global key, and a reused
key with different input is an explicit conflict.

The client then renders the canonical order reference, status, filled quantity, and
remaining quantity. It does not use the currently edited draft to describe an earlier
result. If the person began another draft while waiting, that new draft is preserved.

| Outcome | Browser behavior | Durable meaning |
|---------|------------------|-----------------|
| Accepted open | Show reference and remaining quantity | Reservation and order exist |
| Partial execution | Show fills and remaining disposition | Executed quantity and holds agree |
| Filled | Show canonical execution details | Entire accepted quantity has settled |
| Rejected | Explain the specific attempt's reason | No accepted obligation for that attempt |
| Unknown response | Recover the same command | Transport did not establish the result |

Cancellation joins the same pair sequence as fills. A cancellation request can lose to
an earlier fill or cancel only the remaining quantity. The UI keeps a pending action
until the result is known instead of optimistically erasing the order.

A cancelled order may still have a filled quantity. That is legitimate history, not an
impossible status combination. The order detail should make the completed execution
and cancelled remainder visible together.

Recovery after process failure restores every committed book mutation, including
unfilled placements and cancellations. A trade-only log cannot recreate the full book.
The service should not reopen trading until restored quantities and holds agree with
durable records.

> “The browser's stable command identity and the server's commit boundary solve the
> same user problem from opposite sides: the person needs to know whether this order
> happened, even when the connection cannot tell them.”

## 🔧 Deep dive: precise amounts and account meaning — 8 minutes

I would make units explicit before discussing decimal libraries. Price is quote asset
per base asset; quantity is base asset; their product is quote asset. A fee is charged
in a specified asset and cannot be subtracted from a quantity in another asset without
conversion.

For an illustrative policy, charge fees in quote currency. A buy reserves its maximum
permitted quote cost plus the applicable maximum fee. A sell reserves base quantity
and pays the fee from received quote proceeds.

The policy includes rounding and is fixed for the accepted order. If a maker fee is
lower than the maximum reserved allowance, the unused amount is released. A later
instrument change does not silently increase an old order's funding obligation.

A price improvement also releases unused reserve for the filled quantity. If the order
remains partially open, only the remaining obligation stays held. A completed or fully
cancelled order should have no leftover reservation.

I would store holds by order and asset, with an aggregate balance projection for
efficient reads. Cancellation releases that specific hold. Subtracting a guessed
quantity from a global reserved total and clamping at zero can consume another order's
reserve without revealing the mistake.

For accounting, each asset balances separately. A one-unit base transfer produces a
buyer credit and seller debit in that asset. Quote debits equal seller proceeds plus
fees, with explicit fee and rounding accounts. An approximate USD portfolio value does
not prove those original movements conserve assets.

Exact decimal arithmetic and scaled integers are both reasonable choices. Each
requires clear scale, rounding, and overflow behavior. The browser keeps draft strings
and uses exact helpers for actionable validation; the server repeats authoritative
checks.

A decimal database column is only one boundary. PostgreSQL rounds values beyond a
column's declared scale, and cannot recover precision already lost in application
calculations. [PostgreSQL numeric
types](https://www.postgresql.org/docs/16/datatype-numeric.html).

The chart may convert prices into approximate numeric coordinates for pixels. The
order form must preserve the original exact value when the user selects a depth level.
Feeding a rounded chart coordinate back into an order changes the submitted meaning.

For crypto-to-crypto pairs, the quote label is especially important. An ETH-BTC price
should not display a dollar sign. Fees and estimated total need their own asset
labels, and quantity controls must honor that pair's step rather than a universal set
of decimal shortcuts.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Exact amounts, explicit assets, and attributed holds | Preserves intent and explains every release | More policy metadata and arithmetic discipline |
| ❌ All fields are ordinary numbers | Convenient formatting and products | Precision and denomination errors become easy |
| ❌ Aggregate balances without a journal | Fewer records | Cannot reconstruct or reconcile every effect |

The account view separates ownership from valuation. The backend returns balances and
holds at a known account revision. Valuation uses identified price marks and their
age; missing marks produce an unavailable value rather than pretending the holding is
worthless.

The browser should not recompute spendable balance by subtracting the latest visible
order. Other tabs, pairs, fees, and pending holds can affect it. A pending visual
annotation is useful, but the canonical account response remains authoritative.

If an order view has advanced while its balance projection is delayed, I would label
the account refresh state. Publishing versions makes that understandable. Guessing a
new balance to make the screen appear instantly consistent can create a false spending
signal.

## 🔧 Deep dive: coherent market data and rendering — 8 minutes

Public ticker, depth, recent trades, and candles should derive from a coherent
committed market source. Independent price generators in each process can animate a
demo, but they cannot explain one exchange history.

The command transaction records outbox events. A relay retries publication after a
crash, and consumers deduplicate by stable event identity. Publication may repeat; it
must not apply a second accounting or candle effect merely because the same message
arrived again.

Candle aggregation retains completed buckets until persisted, with a defined
late-event correction policy. Sampling only the latest ticker is insufficient to
reconstruct high, low, and volume. A timer reading one mutable current candle can miss
the previous bucket after rollover.

For the active depth view, the browser buffers stream updates while acquiring a
sequenced snapshot. It removes updates already included in that snapshot and applies
the contiguous suffix. Missing sequences or buffer overflow trigger a fresh baseline.

The order of acquisition matters. Taking a snapshot and then subscribing creates a
possible gap unless the server offers replay from that snapshot's sequence. I would
draw this timeline as the main protocol example in the interview.

Once the state is correct, rendering can be sampled. Apply all required depth
mutations, then publish one bounded visual snapshot per animation frame. Ticker values
that are superseded before paint may be dropped; arbitrary raw depth deltas may not.

Complete private order snapshots can also replace older revisions. The server retains
execution history durably; the browser does not have to keep every historical event
merely to render cumulative fills. Incremental private deltas need a continuity or
canonical-recovery contract.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Coherent source, sequenced snapshots, sampled rendering | Correct baseline with responsive input | Recovery buffers and separate rendering lifecycle |
| ❌ Independent API/worker price state | Easy local animation | Candles, ticker, and valuation disagree |
| ❌ Render or buffer every message indefinitely | Simple immediate implementation | Bursts create input lag and growing staleness |

A stream gateway uses bounded queues and subscriptions. It can retain only the latest
ticker for a slow client, while a depth client that cannot keep up must resynchronize.
A connected socket is not evidence that its data is current.

The client stream service owns reconnect, subscription counts, and connection
generation. Components express interest and clean it up symmetrically. Old-socket
callbacks and late REST responses cannot update the newly selected pair.

The chart instance persists across data changes so new candles do not reset zoom and
scroll. I would use bounded rows for depth and move computation into a worker only if
profiling shows that it blocks input. A worker cannot compensate for an invalid data
baseline.

Public market streams and private account streams have separate authorization. The
server determines account access from the session or a scoped credential, not a
supplied user ID. A guessed channel string never grants private data access.

## 🛠️ Failure handling, security, and growth — 6 minutes

Private route rendering waits for resolved authentication. Account changes clear
private query data and invalidate pending response generations. An unresolved command
remains associated with its original account; it is never silently retried as the next
user.

Logout must have a defined server result and private-stream revocation path. If the
network prevents confirmation, the UI can distinguish local sign-out from confirmed
server revocation. Public market browsing can remain available without private account
access.

A database outage pauses command acceptance because a cached balance or book cannot
establish a durable reservation. A broker outage delays projections while the outbox
retains work. Backlog age and storage limits determine when further admission needs to
be restricted.

A failed matching owner requires fenced takeover and replay. The old owner must be
rejected if it resumes later. Readiness includes restored book state and access to
spend authority, not just an HTTP response from a listening process.

API and stream gateways scale separately from command owners. Pair partitioning
distributes matching work but does not partition a wallet shared across markets. If
the ledger later needs sharding, coordinated transfers or funded allocations must
preserve conservation during failures.

I would optimize bounded requests, price-level structures, and wallet lock ordering
before adding distributed accounting. Separate idempotent updates to buyer and seller
shards do not magically become an atomic trade.

On the browser, route-split chart code, cap rendered depth, and paginate long order
histories. A twelve-market list does not need virtualization; a much larger list can
use it alongside visible-market subscriptions. Memory and input latency matter more
than a blanket target to render every tick.

Accessibility includes keyboard order entry, explicit asset labels, textual freshness,
non-color status cues, and readable order/fill details. Announce command outcomes and
validation errors without announcing every price change or moving focus away from an
edited field.

I would measure command acknowledgement, settlement failure, hold mismatch, owner
replay time, outbox age, stream recovery, and input/update-to-paint delay. A counter
of attempted or simulated trades is not proof of settled volume, and a healthy process
is not a healthy exchange.

## 🧪 Verification and implementation boundary — 4 minutes

The first end-to-end test submits an order, loses the response after commit, reloads,
and recovers exactly that command. It checks the order reference, quantities, holds,
journal effects, and the visible recovery state.

Concurrency tests place orders on different pairs using one wallet, cancel during
partial execution, and fail settlement after a match is planned. A successful design
leaves either the complete committed change or the prior consistent state, with an
explainable command outcome.

Recovery tests crash between commit and memory application, replay duplicate
publication, reject a stale owner, and rebuild unfilled orders from a checkpoint.
Stream tests buffer across snapshot acquisition, drop a delta, switch pairs during a
slow request, and resume after a long browser sleep.

Amount tests cover non-USD quotes, fee units, price improvement, tiny quantities,
large values, and tick/step boundaries. Browser tests verify that an old result does
not clear a new draft or enter another account's view, and that chart updates preserve
the chosen viewport.

The local implementation has conditional reserve updates and wallet transactions, but
order insertion, trade records, fill updates, and wallet settlement are separate
commits. It uses floating-point matching, incorrect matched buyer fee units, synthetic
fills, and no book rehydration.

Its API, price worker, and portfolio worker have independent price state. The UI lacks
command recovery, sequence-aware streams, and account-scoped request guards, while
some chart and subscription lifecycles are incomplete. The interview proposal makes
those missing contracts concrete without presenting them as already delivered.
