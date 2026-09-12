# DoorDash — frontend system design interview

A proposed design for a 45-minute frontend interview. The local application is a useful
starting point, but the reliability behaviors below are proposals unless the final
implementation comparison says otherwise.

## 🗣️ Opening and scope — 3 minutes

> “I'd design three experiences around the same order: a customer choosing dinner, a restaurant working through a queue, and a driver completing a delivery. They need different screens, but they must agree about whether an order exists and what can happen next.”

I'd first clarify whether the driver experience must run in a browser or can use a native
app. Reliable background location is a platform requirement, not something a React component
can guarantee. I'll design the customer and restaurant web apps, plus a foreground driver
web experience whose tracking limits are explicit.

The initial scope is one restaurant per order and one active order per driver. Customers
browse, maintain a cart, place an order, track it, and cancel within policy. Restaurants
confirm and advance preparation. Drivers receive an offer, accept it online, and confirm
pickup and delivery.

I would leave payment collection, multi-order batching, chat, and promotions outside this
interview. Checkout still needs a correct agreed total and a durable order receipt; adding a
card provider later would introduce a separate confirmation and recovery workflow.

### What success means to each user

| Persona | Important outcome | Failure the interface must reveal |
|---------|-------------------|----------------------------------|
| Customer | Understand the total and whether the order was accepted | A timed-out request whose outcome is unknown |
| Restaurant | See every accepted order and its next permitted action | A disconnected tablet displaying an apparently empty queue |
| Driver | Know the current assignment and report progress | An expired offer or delivery confirmation still pending |

For discussion, assume 200,000 connected clients across markets and up to 100,000 drivers
reporting every ten seconds at peak. Those numbers motivate bounded subscriptions and
efficient rendering; they are not load-test results.

I'd target committed order changes appearing within two seconds for connected clients. For
location, I'd display the observation age and mark points stale after an initial
thirty-second threshold. Socket connectivity and point freshness are separate signals.

## 🏗️ Client architecture and state — 5 minutes

This is the diagram I would draw, leaving backend service decomposition for follow-up:

```
┌──────────────────────────────────────────────────────┐
│ Customer routes │ Restaurant queue │ Driver delivery │
└──────────────────────────┬───────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────┐
│ View state + server snapshots + pending operations   │
└───────────────────┬────────────────────┬─────────────┘
                    ▼                    ▼
          ┌──────────────────┐  ┌──────────────────┐
          │ HTTP API client  │  │ Socket lifecycle │
          └─────────┬────────┘  └─────────┬────────┘
                    ▼                    ▼
          ┌────────────────────────────────────────┐
          │ Authorized API and event gateway       │
          └────────────────────────────────────────┘
```

The server owns order state, current catalog facts, assignment authority, and permissions.
The client owns unsubmitted choices, navigation, presentation, and the record of an
operation awaiting acknowledgement. A pending action is not the same thing as a new
authoritative order status.

| State | Location | Reason |
|-------|----------|--------|
| Cuisine/search/page | URL | Links and back navigation reproduce the query |
| Restaurant/menu response | Server-data cache keyed by query | Prevent unrelated queries overwriting one another |
| Cart quantities and last displayed prices | Persisted client store | Instant editing and reload continuity |
| Current order and revision | Server-data cache keyed by order ID | HTTP and socket updates reconcile into one view |
| Pending checkout/action ID | Small persisted operation record | Recover after a reload or uncertain response |
| Drawer, focus, selected tab | Component state | No cross-route owner is needed |
| Connection generation and subscriptions | One transport service | Mounting cards must not create sockets |

I'd use TanStack Router for navigation and Zustand for the small shared client-owned state.
A dedicated server-data layer can coordinate request cancellation, keys, and freshness. I
would not put every fetched response into an undifferentiated global store.

The API boundary normalizes response shape and money before components render. A TypeScript
type assertion cannot turn a numeric string into a number or rename `isActive` to
`is_active`. The boundary should reject malformed essential data and provide a recoverable
error instead of silently drawing zero dollars or an offline driver.

Shared code should include money formatting, status vocabulary, contract parsing, and
operation recovery. The kitchen queue and driver card can have separate layouts because they
prioritize different information. I'd share a component when its behavior really matches,
rather than forcing every role through a long list of flags.

## 🔧 Deep Dive 1: Checkout when the cart is stale — 9 minutes

### Decision: keep cart editing local and validate an agreed quote at submission

> “The cart remembers what the customer selected. It cannot certify that a restaurant is still open or that yesterday's price is still available.”

Suppose a customer adds a meal for $15 and returns after the restaurant changes it to $17.
Updating the total silently at submission produces an order they did not review. Rejecting
everything and clearing the cart also loses useful intent. I would retain the selection,
display the changed line, and ask the customer to accept the revised quote.

The cart stores menu IDs, quantities, configuration, and last displayed prices. The server
provides a short-lived quote that binds current item revisions, fees, delivery address,
currency, and total. The client shows that quote as the submission amount. If it expires or
a required item changes, the server returns a structured reconciliation result.

| Choice | Benefit | Cost for this product |
|--------|---------|-----------------------|
| ✅ Local cart plus authoritative quote | Quantity taps stay instant; submission has an agreed boundary | Quote expiry and item-level reconciliation need UI |
| ❌ Trust persisted prices | Very simple client | A restored cart can submit obsolete terms |
| ❌ Send every cart edit to the server | Centralized drafts | A weak connection delays ordinary browsing interactions |

A server-owned cart can help cross-device shopping later. It still needs checkout
validation, because a saved server draft can also outlive a menu revision. The trade-off is
about where edits happen, not whether stale data can exist.

### One operation survives an uncertain response

After the user confirms the quote, mint one operation ID and persist it with the agreed
payload before sending. Disable additional submission for that operation, but do not rely on
a disabled button for backend deduplication.

The server must atomically create the order, its lines, and an operation receipt. The
frontend then has three meaningful outcomes:

| Outcome | What the customer sees | Next step |
|---------|------------------------|-----------|
| Accepted with order ID | Order confirmation | Clear the submitted cart and navigate to that order |
| Explicit rejection | Specific item/address/quote problem | Preserve selections and repair the rejected request |
| Timeout or connection loss | “Checking whether your order was placed” | Look up or retry the same operation ID |

A timeout is not evidence of rejection. Minting a new UUID for the next button click defeats
deduplication even if the backend has a good idempotency implementation. If the customer
edits the basket while an operation is unresolved, keep the new draft separate until the
earlier operation's outcome is known.

A generic conflict is not automatically success either. The operation lookup must identify
this user and the same agreed payload. A response belonging to another payload is a real
conflict that should be surfaced, not treated as an existing order.

### Persistence and restaurant switching

I would keep cart persistence small and versioned. Save selection data, not a whole growing
history of API responses. Validate the persisted shape when loading, and partition or clear
account-specific details at logout. Delivery addresses do not need indefinite storage merely
because quantities do.

Opening another restaurant should not erase the current basket. If the user adds an item
from the new restaurant, explain the single-restaurant constraint and let them confirm
replacing the basket. This makes the destructive moment explicit and avoids accidental loss
during browsing.

For total calculations, display the server's rounded line, fee, and total amounts. Integer
minor units with a currency contract are easier to reason about than accumulating binary
floating-point values throughout components. The client can show a draft estimate, but it
should not invent its own tax rules.

The cost of this design is more states than “loading/success/error.” That complexity pays
for an understandable answer to the most important checkout question: did I place an order
already?

## 🔧 Deep Dive 2: Live tracking and missed events — 9 minutes

### Decision: use push for responsiveness and snapshots for recovery

A WebSocket can deliver updates quickly while connected, but reconnecting does not replay
everything missed. A kitchen tablet may lose its network, miss three new orders, and
reconnect to an apparently empty queue. Without reconciliation, the successful reconnect
makes the screen look healthier than it is.

I would use one authenticated connection per active application session, with subscriptions
scoped to the current user's permitted resources. The server must authorize each
subscription; hiding a channel name in the UI is not access control.

| Transport strategy | Benefit | Trade-off |
|--------------------|---------|-----------|
| ✅ Push plus snapshot reconciliation | Fast updates and explicit recovery | Requires versions, lifecycle handling, and reconnect logic |
| ❌ Push alone | Small happy-path implementation | Lost messages leave the screen permanently incomplete |
| ❌ Rapid polling everywhere | Simple recovery semantics | Repeated unchanged responses create large peak load |

At 200,000 connected clients, polling every two seconds could create 100,000 requests per
second before user actions. Slower polling is a useful fallback, but it cannot meet a
two-second kitchen visibility target consistently. Push earns its complexity when many
clients wait for infrequent but important changes.

### Closing the snapshot/subscription gap

On initial load or reconnect, establish the authorized subscription and buffer incoming
versioned updates while fetching a current snapshot. Apply the snapshot, then apply only
relevant updates newer than it. The server must define how its snapshot revision and
subscription acknowledgement relate; otherwise there is still a gap where an event can
disappear.

For one order, an order version supports monotonic updates. A restaurant queue also needs a
collection cursor or a full authoritative refresh, because an order absent from the old list
has no local version to compare. Limit buffering; if the gap or buffer grows too large,
fetch again instead of retaining unlimited events.

Events with an old order version should not move a delivered order back to preparing. Events
from a previous route, account, or connection generation should be discarded even if they
arrive late. Request cancellation helps save work, but a generation check is still useful
when cancellation loses a race.

### Position and status have different clocks

Location needs a tracking-session ID, sequence, and observation timestamp. Order state needs
its own revision. A delayed GPS report cannot undo delivery completion, and a newer order
revision does not make an old position fresh.

The tracker displays both connection state and last observation age. A connected socket can
carry stale GPS because the driver's device stopped reporting. Conversely, a brief socket
interruption may leave a reasonably recent observation on screen. Label those conditions
independently.

I'd animate between received positions only within a bounded interval. Smoothing can make
sparse updates easier to follow, but it introduces presentation delay and cannot establish
where the driver actually traveled between two points. Stop animation when observations
become stale; do not extrapolate movement indefinitely.

ETA should be a range with an update time and stage context. If the estimate is stale, say
so rather than keeping a confident countdown running. Explain a delay only when the backend
supplies a supported reason; the client cannot deduce traffic from a slow marker.

### Transport lifecycle is owned in one place

The connection owner tracks intentional shutdown, active generation, reconnect timer,
subscriptions, and a bounded retry policy with jitter. Unmounting a route unsubscribes it.
Logging out cancels timers and prevents an old `onclose` callback from opening a new socket
under stale identity.

A heartbeat detects dead connections, but it does not prove that the server delivered every
event. Reconnect still requires a snapshot. If push remains unavailable, show that condition
and use a bounded refresh fallback instead of silently spinning forever.

For slow consumers, keep the latest location per active order. Business events cannot simply
be dropped without a recovery signal; after a gap, force snapshot reconciliation. A browser
should not process a minute of obsolete movement before learning that an order was
delivered.

## 🔧 Deep Dive 3: A driver action during a network outage — 8 minutes

### Decision: retain intent locally, but reserve authority for the server

> “The phone can remember that the driver tapped ‘Delivered.’ It cannot declare the assignment complete to everyone else until the server accepts that operation.”

The driver may reach a building with poor reception after physically handing over the order.
Losing that action forces them to repeat work later, but showing a final success before
acknowledgement may free capacity or trigger downstream effects incorrectly.

I would persist a minimal pending delivery operation with its operation ID, order ID,
assignment identity, expected state, and observation time. The screen says “Delivery
confirmation pending” and retries that same operation after reconnecting. Once the server
returns the matching receipt, it becomes complete.

| Action | Can retain intent while offline? | Server condition on replay |
|--------|---------------------------------|----------------------------|
| Delivery confirmation | Yes, as visibly pending | Same assignment and permitted current state, or same accepted receipt |
| Pickup confirmation | Potentially, with a pending state | Assignment and order remain valid; no blind replay after cancellation |
| Offer acceptance | Do not present as accepted offline | Exact unexpired offer must still reserve this driver/order |
| Going online | Remember desired preference only | Server confirms eligibility and starts a fresh tracking session |

These actions are not inherently safe just because the UI queues them. Cancellation,
reassignment, or a manual support action may change authority before replay. A rejected
pending operation needs a resolution screen, not endless automatic retries or a forced local
state change.

An offer is particularly time-sensitive. The client can show a countdown based on the server
deadline, but only the server can decide whether acceptance won the race against expiry. A
local countdown reaching zero should disable acceptance, while an apparently positive
countdown is still not permission to override a server rejection.

### Cost of local persistence

| Approach | Why choose it or avoid it? |
|----------|----------------------------|
| ✅ Persist a small operation record until resolved | Survives app restart and supports an honest pending state |
| ❌ Treat every offline tap as final success | Other clients and dispatch may disagree about reality |
| ❌ Drop all failed actions immediately | Driver loses the record of a completed physical task |

The trade-off is recovery complexity and sensitive data retention. Store only what is needed
to identify the operation, scope it to the account, expire resolved records, and handle
logout explicitly. A queued operation must never be replayed under the next person's session
on a shared device.

Location is different from delivery intent. I would keep the latest unsent observation
rather than replay every old point after reconnecting. Include sample time and sequence,
stop tracking when appropriate, and discard late GPS callbacks from a prior tracking
generation.

Start with a ten-second foreground cadence, then measure battery cost and freshness before
introducing adaptive intervals. GPS acquisition, device state, and radio behavior matter;
interpolation alone does not prove a particular interval is optimal.

The driver interface should support use when safely stopped: large targets, short
instructions, high contrast, and one clear primary action. It should avoid requiring
sustained interaction during driving. Native background tracking and push are separate
platform capabilities to evaluate if the product needs them.

## 🍳 Restaurant queue, discovery, and accessibility — 5 minutes

The restaurant screen should show an unmistakable disconnected state and a persistent count
of unacknowledged new orders. A transient toast is insufficient for a tablet someone checks
between tasks. Optional sound needs an explicit enable/test control, and visual alerts must
remain useful without hearing it.

A successful transition response should immediately reconcile the corresponding card using
its returned revision. Waiting only for the socket event makes a successful button press
appear ineffective when push is delayed. The event may then arrive again; version-aware
merging makes that harmless.

At a busy restaurant, group orders by preparation stage and show age or promised-ready time.
Keep focus stable when a card moves, and announce meaningful status changes accessibly.
Don't read every GPS update through a screen reader or reorder a focused card unexpectedly.

For discovery, start with paginated results and stable image dimensions. Use correctly sized
images, lazy loading below the fold, and URL-backed filters. Virtualize genuinely large
lists if profiling shows DOM cost, preserving keyboard navigation and focus. Five seeded
restaurants do not justify claiming virtualization is already necessary or implemented.

A search error should be distinguishable from “no restaurants match.” If a request for one
cuisine finishes after the user selects another, its response should stay under its original
cache key. Similar protection is needed when switching restaurant dashboards or accounts.

| Accessibility concern | Design response |
|-----------------------|-----------------|
| Status conveyed only by color | Text labels and explicit next actions |
| Quantity controls are just “+” and “−” | Accessible names include item and action |
| Checkout error is disconnected from a field | Associate message, focus the invalid field, preserve inputs |
| Tracking depends on a map | Text status, freshness, ETA, and address remain available |
| Long kitchen shift | Strong contrast, scalable text, stable focus and persistent alerts |

I'd split substantial route code and optional map dependencies so browsing does not download
the full driver workflow. Measure real bundle output and interaction latency rather than
assuming file-based routing automatically provides the desired split.

## 🧪 Validation and implementation comparison — 6 minutes

The most valuable tests control the network, clock, and event order. I would combine
deterministic client tests with API contract tests and a small three-persona end-to-end
journey.

| Scenario | Expected result |
|----------|-----------------|
| Price changes before checkout | Revised quote appears; no silent acceptance |
| Create commits but response is lost | Reload resolves the original operation; one order exists |
| Restaurant disconnects while new orders arrive | Reconciliation restores all current relevant orders |
| Old snapshot arrives after a newer event | UI does not move backward |
| GPS stops while socket stays connected | Position becomes stale independently |
| Logout with a reconnect timer pending | No old-session socket or queued action restarts |
| Delivery replay after reassignment | Pending intent is rejected or escalated, not blindly applied |
| Driver receives readiness update | Correct next action becomes available without a manual reload |

I would monitor client connection age, snapshot recovery failures, unresolved checkout
operations, and user-visible stale tracking. Avoid recording precise location or full
addresses in routine frontend error telemetry.

### What the checked-in application actually does

The React/TanStack Router app uses local route state plus persisted auth and cart stores. It
fetches through one API module and reuses an `OrderCard`. The cart performs optimistic local
quantity edits, but there is no server quote, item reconciliation screen, or durable
pending-operation record.

Checkout generates random San Francisco coordinates and a fresh idempotency UUID per API
call. Opening another restaurant clears the existing basket. Auth state persists, but the
existing session-refresh action is not called at startup; logout does not clear cart/address
persistence.

The tracker displays coordinates in a placeholder, not a map. Its socket hook reconnects
without snapshot recovery or visible freshness, and array-dependent effects plus uncancelled
reconnect timers can churn connections. Server subscriptions are unauthenticated. The
restaurant dashboard sends the wrong open-state property and waits solely for socket status
updates; driver stats use a different field naming convention from the UI, and driver
subscriptions miss subsequent preparation events.

There is no offline action queue, offer acceptance flow, native background location,
audio-alert workflow, or menu-management UI. Those are proposed improvements in this answer.
The [architecture](./architecture.md#implementation-notes) traces the current behavior to
source; the [README](./README.md) explains setup and demo constraints.

### Trade-offs I would defend

| Decision | Chosen | Alternative | Cost accepted |
|----------|--------|-------------|---------------|
| Cart and checkout | ✅ Local edits plus agreed server quote | ❌ Trust saved prices | Reconciliation and pending-operation UI |
| Tracking | ✅ Push with snapshots and freshness | ❌ Socket connection alone | Versioning and lifecycle complexity |
| Offline driver actions | ✅ Persist pending intent, require server acceptance | ❌ Local final success | Conflict resolution after reconnect |

> “I'd finish with the uncertainty boundaries: a cart is a draft, a timeout can hide a successful order, and a received coordinate may already be old. Making those distinctions explicit gives all three users a screen they can act on.”
