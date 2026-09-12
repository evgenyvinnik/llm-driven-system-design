# 💱 Design a spot exchange: frontend interview

> “I would build a trading screen that makes three things clear: which market the
> person is viewing, what order they submitted, and how current the displayed result
> is. Fast price animation is useful, but it must not hide a stale book or an
> unresolved order.”

This is a proposed production design for a 45-minute interview. The local React
exchange is a starting example, not an implementation of every mechanism described
here. [Implementation Notes](./architecture.md#implementation-notes) record the source
behavior and simulations.

| Time | Discussion |
|------|------------|
| 4 minutes | Product scope and guarantees |
| 5 minutes | Browser architecture and API contracts |
| 9 minutes | Deep dive: market snapshots, streams, and rendering |
| 8 minutes | Deep dive: precise amounts and instrument context |
| 9 minutes | Deep dive: order recovery and account state |
| 6 minutes | Accessibility, performance, and delivery |
| 4 minutes | Verification and implementation boundary |

## 🎯 Product scope and guarantees — 4 minutes

I would scope the interface to a spot exchange: a market overview, one active trading
pair, candles, order depth, market/limit order entry, balances, and order history.
Public browsing does not require login. Placing or cancelling an order does.

The first version supports partial fills and a clearly stated policy for unfilled
market-order quantity. Margin, derivatives, stop triggers, custody, and
funding-provider flows are outside this discussion. A simulated deposit button is not
evidence of a real funding integration.

I would distinguish a displayed price from an executable quotation. The last trade
does not guarantee that the entire requested quantity can trade at that price. The
form should label its estimate and show any explicit spend or price-protection
boundary sent to the server.

Order acceptance and complete execution are also different. A limit order can be
accepted and remain open. A market order can fill partially before its remaining
quantity is cancelled under the selected policy. The interface should report quantity
and state rather than reduce every outcome to “success.”

The browser needs separate states for market loading, current data, stale data, and an
unavailable feed. It also needs submitting, accepted, rejected, and unknown-outcome
states for commands. One global loading flag cannot explain these independent
conditions.

I would target responsive input under market bursts and a measured delay below 100 ms
from an update reaching the browser to the active price being displayed. That is a
client processing target, not a claim that every worldwide network delivers a trade
within 100 ms.

> “A disconnected chart and an unknown order are different problems. I want the user
> to know whether they are waiting for new information or resolving an action that may
> already have happened.”

## 🏗️ Browser architecture and API contracts — 5 minutes

I would draw the public data path beside the private command path:

```
┌────────────────┐       ┌────────────────┐
│ Chart / depth  │◀──────│ Market API and │
│ Market list    │       │ stream gateway │
└────────────────┘       └────────────────┘
┌────────────────┐       ┌────────────────┐
│ Order form     │──────▶│ Command API    │
│ Orders/balance │◀──────│ Account state  │
└────────────────┘       └────────────────┘
```

React owns composition, controls, focus, and local drafts. A query layer owns
instrument metadata, account snapshots, history pages, and bounded candle ranges. A
stream service owns connections, subscriptions, sequence validation, and freshness.

The chart adapter holds an imperative chart instance rather than rebuilding the chart
whenever a price changes. The depth component receives a bounded set of formatted
rows. A worker is an optional place for heavy book processing after profiling shows
that it competes with input.

Query identity includes the instrument, interval or range, and relevant account. A
single global candles array without its symbol is vulnerable to a slow response from
the previous route. Private data must not share a query key across account changes.

| Contract | Data returned | Why the frontend needs it |
|----------|---------------|--------------------------|
| Instrument metadata | Base/quote assets, tick/step, status, revision | Validate and label one market correctly |
| Market snapshot | Covered range or depth, sequence, timestamp | Establish a baseline and freshness |
| Market stream | Channel, sequence, payload, source time | Detect gaps and update the correct view |
| Order command | Stable identity, accepted/rejected result | Recover the submitted intention |
| Order/account query | Canonical order quantities and account revision | Reconcile updates and stale projections |
| Private stream | Authorized account events or versioned snapshots | Refresh personal state without guessing |

I would keep commands over HTTP and use a WebSocket for dynamic market subscriptions.
SSE is a credible simpler choice for one-way market delivery; using HTTP for commands
is compatible with either transport. The decision depends on channel management and
infrastructure, not on a claim that SSE cannot support a trading page.

Public browsing can load while session resolution is pending. Private account panels
wait for a resolved identity and show their own loading state. The trading form
becomes available only when the account and instrument metadata required for
submission are known.

## 🔧 Deep dive: market snapshots, streams, and rendering — 9 minutes

I would first define what each update means. A ticker can be a replaceable latest
value. A depth delta modifies an existing book and is meaningless without the right
baseline. Candle updates describe aggregate state for a bucket rather than an
arbitrary point on a line.

For depth, I would start buffering the selected stream while requesting a snapshot.
The snapshot carries a sequence. I discard buffered deltas already covered by that
sequence and apply the contiguous suffix before marking the view current.

If the buffer overflows, a sequence is missing, or the stream belongs to a different
connection generation, I restart synchronization. Fetching a snapshot and only then
subscribing leaves a gap between those two actions unless the server explicitly
provides replay from the snapshot position.

A duplicate delta is ignored according to the protocol. A genuinely missing delta
changes the view to stale and triggers recovery. Guessing that the latest quantity
probably includes the missing event is unsafe unless the protocol specifically defines
complete replaceable snapshots.

Once the underlying book is correct, I can render at most once per animation frame.
Ten valid updates may change state before the next paint; the screen needs the
resulting rows, not ten separate React renders.

Ticker presentation can discard superseded intermediate values. Candle OHLCV cannot be
reconstructed from only those sampled tickers because the discarded values may contain
the high, low, or traded volume. I would receive authoritative candle aggregates or
derive them from a complete trade stream with the necessary recovery contract.

Private orders also deserve a precise distinction. The server retains fills and
history durably. The browser can replace an old order view with a complete newer
revision containing cumulative filled quantity; it does not need to replay every
historical fill just to paint the latest status.

If the private protocol sends incremental deltas instead, the client must apply them
in order or recover a canonical snapshot. The rule is about message semantics, not a
blanket statement that every private event must always remain in browser memory.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Apply valid state updates, then sample rendering | Preserves depth while protecting input responsiveness | Separate state processing from visual scheduling |
| ❌ Drop arbitrary raw book deltas | Reduces processing quickly | Can display a plausible but incorrect order book |
| ❌ Render every wire message | Simple direct mapping | Bursts make reconciliation and drawing compete with input |

I would cap depth rows and chart points before adding infrastructure. If processing
still dominates, a worker can maintain the book and send bounded render snapshots.
Moving work to a worker adds message transfer and lifecycle costs; it does not repair
a broken sequence contract.

A slow client needs bounded queues. For replaceable tickers, keep only the newest
value. For a depth stream that has fallen too far behind, discard the uncertain
baseline and resnapshot. Infinite buffering turns a temporary slowdown into stale data
and growing memory.

Subscription ownership belongs to the stream service. Components declare interest, and
reference counts prevent one component's cleanup from unsubscribing a channel another
still needs. Opening, closing, and reconnecting use a generation so callbacks from an
old socket cannot update a new connection's state.

Reconnect uses backoff with jitter and a visible recovery state. Reopening a socket
and resending channel names is only the start; the client still needs a fresh baseline
or a replayed contiguous suffix before claiming that the book is current.

> “I would draw one missing sequence number and walk through recovery. That
> demonstrates the important protocol more clearly than drawing twenty WebSocket
> servers.”

## 🔧 Deep dive: precise amounts and instrument context — 8 minutes

I would keep order draft amounts as decimal strings. The instrument metadata supplies
the price tick, quantity step, allowed scale, base asset, and quote asset. Validation
and formatting use those rules rather than a universal two-decimal price and
eight-decimal quantity.

A BTC-USD price is in USD per BTC. An ETH-BTC price is in BTC per ETH. Prefixing every
value with a dollar sign makes the second market misleading even if every arithmetic
operation is otherwise correct.

Fee estimates also need a denomination. A fee charged in the received asset is
different from a quote-currency fee. The form should show the fee asset and explain
whether the estimate depends on maker/taker execution, rather than displaying one
fixed percentage for every side and order type.

I would use exact decimal or scaled-integer helpers for actionable comparisons,
products, and step validation. Integer units are a legitimate approach if scale and
overflow rules are explicit. A decimal library is another choice; neither removes the
need to specify rounding.

The database's numeric precision is only one part of this contract. PostgreSQL can
round values to the declared scale on storage. It cannot recover digits already lost
before the request arrived. [PostgreSQL numeric
types](https://www.postgresql.org/docs/16/datatype-numeric.html).

The chart can convert a value into an approximate numeric coordinate because pixels
have finite resolution. That converted coordinate must never be fed back into the
order as the authoritative amount. Selecting a depth row should use its original exact
price value.

For input, I would preserve intermediate editing states such as an empty field or a
trailing decimal point. Validation can mark the draft incomplete without replacing it
with zero. I would reject unsupported syntax before submission and let the server
repeat authoritative validation.

A quick-amount control should respect the selected pair's step and available balance.
A hardcoded 0.001 quantity is not universally valid for every asset. A maximum-buy
control also needs a defined budget and fee policy; multiplying an approximate last
price is only an estimate.

Changing pair establishes a new instrument context. I would either reset the draft or
deliberately translate only compatible fields with clear feedback. Carrying a BTC
quantity and USD limit silently into an ETH-BTC form changes the meaning of the user's
action.

During submission, I freeze the exact values and metadata revision used for that
attempt. If the user edits another draft while waiting, the returning result attaches
to the submitted attempt and does not clear or reinterpret the newer draft.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Exact draft values with explicit asset units | Preserves user intent across validation and submission | More deliberate formatting and conversion boundaries |
| ❌ Parse everything into Number immediately | Convenient arithmetic | Loses precision and intermediate input meaning |
| ❌ Trust decimal storage alone | Simple backend claim | Does not validate ticks, units, or earlier rounding |

I would accept the helper and type overhead because these fields cause an external
state change. For nonactionable geometry and approximate portfolio allocation bars,
ordinary numbers remain useful. The boundary should be visible in the data model and
tests.

## 🔧 Deep dive: order recovery and account state — 9 minutes

One submitted intention gets one command identity. The client retains that identity
through transport retries and refresh recovery. The server binds it to the
authenticated account and normalized command, and stores a durable result.

A disabled submit button prevents repeated clicks in the current component. It does
not protect a refresh, another tab, or a response lost after the exchange committed.
Generating a new key on every retry merely gives every duplicate attempt a distinct
identity.

I would distinguish “received for processing,” “accepted with a durable reservation,”
and “filled.” If the system uses asynchronous admission, the API contract must
identify which milestone it acknowledges. The frontend should not label a queued
command as an executed trade.

| Result | What the person sees | Safe next action |
|--------|----------------------|------------------|
| Accepted open | Order reference, price, remaining quantity | Observe or request cancellation |
| Partially filled | Filled quantity and remaining disposition | Inspect fills or cancel eligible remainder |
| Filled | Canonical average price, quantity, fees | Inspect account state |
| Rejected | Specific reason tied to the attempt | Correct the draft before a new command |
| Unknown after timeout | Checking this order's status | Recover or retry the same command identity |

After a timeout, I would query by command identity with account authorization. A
private event can help identify the result, but public price updates cannot establish
whether this particular order exists.

The UI can preserve an unknown command across navigation with a minimal account-scoped
reference. It should not automatically submit it under another logged-in account. If
the account changes, recovery waits for the original account's authorized context.

Cancellation is another command with a race outcome. If a fill occurred first, the
server may cancel only the remainder or report that nothing remains. I would keep the
order visible with “cancellation pending” until the canonical result arrives.

Optimistically deleting an order row makes a partial fill easy to miss. The interface
should show cumulative execution and the final remainder state together. A cancelled
order can legitimately have a nonzero filled quantity.

After a mutation, the private order and balance views need compatible revisions or
explicit freshness. An updated order beside an old available balance is understandable
if labeled; silently recomputing spendable funds in the browser can conflict with
another order or fee adjustment.

I would separate holdings from approximate valuation. A balance comes from the account
authority. Its USD value depends on identified price marks and their age. A missing
price should display unavailable valuation, not a zero that appears to erase the
holding.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Durable command recovery and canonical account reads | Resolves ambiguous requests without extra orders | Requires recovery UI and versioned server contracts |
| ❌ Every timeout means failure | Easy error handling | Encourages a duplicate after a committed order |
| ❌ Recalculate spendable balance from visible fills | Immediate local feedback | Misses other orders, holds, and account changes |

Logout clears private query data, active subscriptions, and access to account-scoped
operation references. Late responses carry their original account generation and
cannot overwrite the next account's view. Public prices can remain available during
that transition.

Session expiry is not a reason to erase an unresolved command. The UI can retain its
nonsecret reference, require reauthentication, and then resolve it. Authorization and
command identity are separate concerns.

## 🛠️ Accessibility, performance, and delivery — 6 minutes

The chart is not the only way to understand the market. I would provide textual
current price and freshness, a readable depth table, and accessible order/fill
details. Keyboard users can choose a pair, edit price and quantity, review units,
submit, and cancel.

I would announce meaningful order outcomes and validation errors, not every ticker
update. Positive and negative change include signs or labels as well as color. Focus
stays in an edited input while market data changes around it.

Chart creation and disposal must have symmetrical lifecycles. The series receives
updates without destroying the chart and resetting zoom each time. A resize observer
can respond to actual container size, while a bounded history request supplies
additional data when the user pans.

The same discipline applies to effect cleanup and subscriptions. React's development
StrictMode cycle deliberately exercises setup and cleanup; a ref that prevents setup
after cleanup can leave an open connection without a handler. [React effect
lifecycle](https://react.dev/reference/react/useEffect).

I would route-split charting code so a login or portfolio visit does not require the
full trading renderer. A twelve-row market list does not need virtualization. A much
larger list can use virtualization and subscribe only to visible markets plus the
active instrument.

Error states should be local to the affected view. A failed candle request should not
disable order-history access. If market data is too stale to satisfy the chosen order
policy, the form explains that specific limitation rather than showing a permanent
loading spinner.

Client telemetry measures input delay, update-to-paint delay, resynchronization time,
unknown-command recovery, and long-session memory. It records safe identifiers and
aggregate timings rather than balances, credentials, or raw order drafts.

## 🧪 Verification and implementation boundary — 4 minutes

I would test a snapshot arriving while deltas are buffered, a missing sequence,
duplicate updates, a slow socket, and a reconnect with a changed symbol. The expected
result is a verified baseline or a visible stale state, never an unverified but
plausible book.

Order tests lose the response after acceptance, refresh, and recover the same command.
They also cancel during a partial fill, switch accounts while a query is pending, and
change the draft while an earlier attempt completes.

Precision cases include tiny quantities, large values, tick/step boundaries, non-USD
quotes, and fees in a different asset. Rendering tests keep keyboard input responsive
during bursts and verify that a chart update preserves the user's viewport.

The local demo has no sequence/resnapshot protocol, durable command lookup, private
order feed, or exact order arithmetic. It has global unkeyed chart/book state, request
races, a development subscription-lifecycle gap, and a chart recreated on candle
changes. Its sparklines and prices are simulated.

Those limitations inform the design without needing to recite every implementation bug
in the interview. I would demonstrate one trustworthy order journey and one market
resynchronization, then use measurements to decide whether workers, deeper history, or
shared public connections across tabs are worth their complexity.
