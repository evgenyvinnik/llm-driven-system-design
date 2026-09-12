# Apple Pay: full-stack system design interview

> “I would follow one purchase from the amount the user reviews to the
> result the merchant records. The difficult part is keeping that intent
> intact when the device, browser, server, and payment provider finish at
> different times.”

This is a proposed production design. It uses a wallet experience and a
merchant checkout to explain the integration boundaries; it does not claim
to reproduce Apple's internal architecture. The local project is an HTTP
simulator, compared with the proposal near the end.

## 🧭 Discussion plan

| Topic | Minutes |
|-------|---------|
| Scope and requirements | 5 |
| Architecture and contracts | 7 |
| Deep dive: one checkout across client and server | 10 |
| Deep dive: an uncertain payment result | 10 |
| Deep dive: device lifecycle and privacy | 8 |
| Scaling, verification, and implementation boundary | 5 |
| Total | 45 |

## 🎯 Clarify the system we own

A wallet manages a customer's payment credentials. A merchant owns an order
and its total. A processor routes authorization, and the issuer decides
whether it is approved. I would put these roles on the board before choosing
a database or a frontend state library.

We will design card enrollment and management, an ordinary user-confirmed
app/web checkout, payment recovery, and transaction history. Contactless
payment is a separate edge integration through a device and terminal; it
is not an HTTP request from a React wallet for every physical tap.

The merchant should not need access to all the customer's cards. It asks
for a supported payment capability and receives the information required
for the authorized purchase.

I would exclude transit express modes, person-to-person balances, subscriptions,
and a new settlement network. Authorization and capture are distinct; a
receipt saying “authorized” does not establish that settlement occurred.

### Functional requirements

- Enroll a card on an eligible device, with issuer verification if needed.
- Display safe card metadata and device-specific availability.
- Review a fixed merchant, amount, currency, and order version.
- Authorize through the supported platform integration.
- Submit one identified attempt and recover its result after interruption.
- Suspend device credentials and expose confirmation status.
- Show history and linked refund outcomes to authorized users.

### Non-functional requirements

| Concern | Proposed target or invariant |
|---------|------------------------------|
| Local UI | Selection feedback within 100 ms |
| Owned APIs | p99 under 200 ms, excluding external/human waits |
| Checkout deadline | Illustrative two seconds before a pending-recovery state |
| Availability | 99.99% for owned orchestration, separate from issuer acceptance |
| Correctness | One durable attempt per intended purchase operation |
| Privacy | Credentials do not enter ordinary display caches or analytics |
| Recovery | Reload and retry refer to the same unresolved operation |
| Accessibility | Complete review, authorization, pending, and result paths |

A physical terminal's radio exchange and its final issuer decision have
different latency boundaries. I would avoid promising that every purchase
completes in 500 ms merely because a UI animation does.

For capacity planning, assume 100 million daily authorizations at the
processor boundary: about 1,160 per second average, 11,600 at a tenfold peak.
At about 1 KB each, that is 100 GB/day raw before indexes and replication.
These are interview assumptions, not measured traffic from Apple or this app.

## 🏗️ Architecture I would draw

```
┌──────────────────────────┐        ┌──────────────────────────┐
│ Wallet / checkout UI     │───────▶│ Wallet API               │
│ Reviewed intent          │        │ Enrollment / lifecycle   │
└────────────┬─────────────┘        └────────────┬─────────────┘
             ▼                                   ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Platform / device        │        │ Token authority          │
│ Credential handoff       │        │ Enroll / revoke          │
└────────────┬─────────────┘        └──────────────────────────┘
             ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Merchant / processor     │───────▶│ Network / issuer         │
│ Durable payment attempt  │        │ Authorization outcome    │
└──────────────────────────┘        └──────────────────────────┘
```

The diagram separates who owns credentials from who owns the order. It
compresses platform-specific handoffs rather than claiming every arrow is
a direct browser call. App/web payment credentials have a different handoff
from contactless transactions. [Apple's description of payment flows](https://support.apple.com/en-euro/guide/security/secfbd5c0e54/web).

The wallet API stores user/device associations, token metadata, and lifecycle
operations. The merchant/processor stores checkout attempts and external
references. PostgreSQL suits their local relationships and short atomic
transitions. Redis is useful for display caches and response acceleration.

Committed events pass through durable outboxes to history and notifications.
Those projections can lag briefly without putting a message broker between
every card-selection click and its visual feedback.

### State ownership across the stack

| Fact | Authority | Client treatment |
|------|-----------|------------------|
| Selected card | Current interaction | Update locally by stable ID |
| Order amount and currency | Merchant server | Display a versioned snapshot |
| Token activation | Token authority, reflected by wallet | Refresh metadata; do not infer from a card image |
| User's payment intent | Supported platform confirmation | Track the matching interaction |
| Payment outcome | Durable processor/provider operation | Render pending or conclusive result |
| History list | Authorized projection | Cache/page with freshness context |

React components render facts and collect intent. A shared interaction
controller owns the active checkout, operation reference, and asynchronous
transitions. Query state holds server data; sensitive entry fields remain
isolated from persisted application stores.

### API contracts, not handler implementations

These are proposed resources, not a listing of the repository's endpoints.

| Method | Resource | Purpose |
|--------|----------|---------|
| POST | `/wallet/enrollments` | Begin an identified card/device enrollment |
| GET | `/wallet/enrollments/:id` | Resume verification/activation state |
| GET | `/wallet/cards` | Authorized display-safe metadata |
| POST | `/wallet/devices/:id/suspensions` | Request and track device-scoped revocation |
| POST | `/merchant/checkouts` | Create a checkout with authoritative total |
| POST | `/merchant/checkouts/:id/attempts` | Submit one identified payment attempt |
| GET | `/merchant/payment-operations/:id` | Recover its current outcome |
| GET | `/wallet/transactions` | Page authorized history |
| POST | `/merchant/payments/:id/refunds` | Create a linked refund operation |

Every operation result requires the appropriate actor's authorization. An
opaque ID or a route containing a merchant ID is not an access-control rule.

## 🔧 Deep dive 1: one checkout from review to submission

### Decision

I would freeze the reviewed checkout version and bind one operation identity
to it. A user may edit an order before confirming, but asynchronous callbacks
cannot quietly substitute a different amount after confirmation begins.

> “The frontend and backend need to agree on what the person said yes to.
> A biometric success alone is not an approval to charge any current value
> in an editable amount field.”

### Walk through a $24.99 purchase

1. The merchant persists a checkout for $24.99 with currency and order version.
2. The client displays those values and eligible payment choices.
3. The user starts confirmation; the controller captures that exact intent.
4. The supported platform flow produces the permitted credential handoff.
5. The merchant validates the order version and claims the payment attempt.
6. The processor submits the attempt using a stable external reference.
7. The client displays the operation's authoritative status.

If shipping or tax changes, the merchant increments the order version and
requires a renewed review of the new total. A stale client cannot insist on
an old price by posting its own amount.

Currency formatting is presentation; the server validates the underlying
amount and supported currency precision. A three-character string and a
positive floating-point number are not a sufficient financial contract.

### One controller owns the interaction

I would use explicit states: reviewing, authorizing, submitting, pending,
approved, declined, and cancelled-before-submission. A few clear transitions
are easier to reason about than multiple independent loading flags.

Each asynchronous callback includes the interaction identity. If the user
closes an enrollment modal or changes checkout, an old callback is ignored.
Cancelling a local animation does not cancel an authorization already sent
to a provider.

The Pay button is disabled during active confirmation and submission. That
improves the experience, while server operation identity protects other tabs,
transport retries, and calls from clients that do not obey that button.

### Bind the client and server with operation identity

The operation key must exist before the first potentially ambiguous request.
The client or server may generate it, provided retries retain it and the
server associates it with the authenticated actor and canonical intent.

A key generated on every fetch describes transport attempts, not user intent.
A key derived only from amount and merchant confuses separate legitimate
purchases. I would use an opaque unique identity and a separate fingerprint
of the validated request.

Reusing that key with changed input produces a conflict. Retrying the same
operation returns its existing state. The client retains the reference across
reloads without persisting the payment credential itself.

### Trade-off and alternative

| Approach | Benefit | Failure or cost |
|----------|---------|-----------------|
| ✅ Versioned checkout and stable operation | Preserves reviewed intent across retries | More explicit state and contracts |
| ❌ Read mutable form state when a callback ends | Less coordination code | May submit a different amount/card than reviewed |
| ❌ Disable Pay as the only protection | Easy local double-click prevention | Does not cover retries or multiple clients |

The chosen design requires tests for late callbacks and order changes. I
would accept that work because it protects the interface's most important
statement: which purchase the customer actually confirmed.

## 🔧 Deep dive 2: recover an outcome without inventing certainty

### Decision

The server persists a durable attempt before external submission, and the
client treats an ambiguous timeout as pending. Both sides recover the same
operation rather than create a new one after any exception.

Imagine the issuer approves $24.99, then the response disappears. The client
cannot tell whether the request failed before submission or after approval.
A red banner saying “Declined” would communicate information we do not have.

### Server preparation and recovery

The processor creates an attempt with actor, checkout, key, request
fingerprint, provider reference, and current state. A unique constraint
serializes competing claims for that identity.

It commits that preparation before making the external request. Short
transactions update local state; none remain open while a provider is slow.
A worker lease coordinates execution but does not erase the operation when
its timeout expires.

The external integration needs a safe retry or status-lookup contract using
the stable reference. If the provider accepted a request, a process restart
must find that result instead of creating another authorization.

When the result is conclusive, update the attempt and append an outbox event
in one commit. History and notifications consume events with deduplication.
The checkout's final business state follows the appropriate authorization or
capture rule; the browser is not the source of truth.

### Client recovery

| Situation | What the interface does |
|-----------|-------------------------|
| Rejected before provider submission | Shows a correction or a clear non-submission error |
| Provider conclusively declined | Shows a decline and permitted next action |
| Submission may have happened | Shows pending and checks the operation |
| User reloads while pending | Restores the reference and queries authorized status |
| Approval arrives after a delay | Shows the same receipt and refreshes history |

I would poll pending operations with backoff or use a notification to prompt
a status refresh. A push event can be duplicated or delayed; the durable
status endpoint remains authoritative.

The user should not be encouraged to switch cards automatically while the
first attempt is unresolved. The merchant may need to cancel or reconcile
that attempt before accepting a replacement.

### Why a cache cannot settle the question

A Redis record with a 24-hour TTL can accelerate successful retries. It
cannot prove that a payment failed when the key is absent. The key might
have been evicted, expired, or never written after a successful SQL insert.

A short lock has the same limitation. Its expiry tells us that the local
worker may need recovery, not that a remote issuer did nothing. Late workers
also need fencing or conditional state transitions so they cannot overwrite
newer results.

We can aim for one externally effective operation when the provider contract
supports it. We should not claim universal exactly-once behavior across an
arbitrary remote service merely because local SQL transactions are serializable.

### A separate replay boundary

Credential replay protection belongs to the payment scheme. Apple describes
cryptograms computed using a key and transaction counter, plus additional
scheme-dependent data. Our HTTP key identifies a merchant operation; it does
not replace credential validation. [Apple authorization reference](https://support.apple.com/guide/security/payment-authorization-with-apple-pay-secc1f57e189/web).

A legitimate retry reads a previously authorized operation result. It should
not generate another cryptogram or another provider authorization just to
reconstruct the answer.

### What we give up

The pending state is less immediately satisfying than a green or red banner.
We also need recovery workers, provider references, and support visibility.
Those costs preserve truthful behavior when a system cannot know the answer
within the user's initial wait budget.

## 🔧 Deep dive 3: device lifecycle and privacy meet in the UI

### Decision

I would model each device's credential association explicitly and distinguish
requested lifecycle changes from confirmed enforcement. Display data is
cached carefully; payment eligibility remains authoritative elsewhere.

For enrollment, create an operation that can pause for issuer verification.
The UI displays “verification required” or “activation pending” instead of
claiming a usable card as soon as metadata is inserted locally.

Card input goes through the approved integration. If a custom form temporarily
handles sensitive fields, they do not enter localStorage, analytics, query
strings, or shared wallet state. The form clears them when their required
lifetime ends.

### One card across several devices

The customer's phone and watch can have distinct credential associations.
Losing the phone should affect the phone's tokens without disabling the watch.
That requires separate token identity and lifecycle state, not one shared
“card active” flag for every device.

Tokenization provides a constrained substitute for the PAN; domain restrictions
and lifecycle are part of its purpose. A random local identifier has none of
those guarantees by itself. [EMVCo tokenisation overview](https://www.emvco.com/emv-technologies/payment-tokenisation/).

The wallet can show issuer description, last four digits, network, and device.
Last four digits alone do not identify a card uniquely and should not be used
as a backend uniqueness constraint.

### Lost-device workflow

1. The user identifies the device and confirms the affected scope.
2. The server records a versioned revocation request and blocks local use.
3. Durable work dispatches lifecycle requests to the token authority.
4. The UI shows pending status until enforcement is confirmed.
5. Notifications invalidate cached metadata; refresh recovers missed updates.

An unreachable device or provider does not turn a local update into remote
enforcement. This is why “requested” is a useful product state, not merely
an implementation detail.

Out-of-order events must not reactivate a newer suspension. Lifecycle versions
or an authoritative state refresh resolve ordering. A reader that fetched an
old active record must not repopulate a stale cache after revocation.

### Privacy across account changes

A client cache has an account owner and an explicit persistence projection.
Logout clears it and invalidates in-flight requests for that account. A late
history response must not appear in the next person's session.

I would keep only a small recent display snapshot if the product needs offline
viewing. Offline card display does not imply offline browser payment. Device
and scheme-specific payment capabilities remain a separate contract.

A query library or Zustand can help organize state, but neither automatically
solves account isolation. That is a contract around cache keys, lifecycle,
response identity, and clearing behavior.

### Refunds continue the same story

A refund has a parent payment, its own operation ID, amount, and pending/final
status. The UI distinguishes partial from full refund and waits for the
processor's result.

The backend atomically reserves refundable value against the original captured
payment. Two concurrent $70 refunds on a $100 payment cannot both reserve
funds. Uncertain provider outcomes retain the reservation until reconciled.

A negative transaction row is useful for display but does not by itself prove
that the value invariant or external refund occurred.

### Trade-off

Immediate local selection is appropriate; confirmed activation and revocation
need evidence. This produces more UI states and lifecycle work than optimistic
updates everywhere. It also avoids telling the user that a lost payment
credential is blocked when only the local page has changed.

## 📜 History and rendering

The server exposes a display-safe history projection with cursor pagination
using time and stable ID. The client fetches a recent page, merges by ID, and
preserves order when new entries arrive.

After a confirmed payment, show its receipt immediately even if the history
projection lags. Merge that operation when it appears in the list so users
do not see two rows for the same purchase.

Virtualize a long retained history when needed, while keeping keyboard focus
and screen-reader semantics intact. A few wallet cards can remain a simple
list; a gesture carousel is a product choice rather than a scaling requirement.

## 📈 What breaks first and how I would respond

Provider concurrency and unresolved attempts can grow before CPU saturates.
Separate provider/workload budgets, deadlines, and circuit breakers prevent
slow enrollment from consuming authorization resources.

Large history writes need retention tiers, time partitioning, and eventually
sharding based on measured limits. Preserve operation uniqueness within the
chosen ownership boundary; a global index that cannot be enforced undermines
the correctness model.

A regional failover must fence the previous writer and recover provider
references before new submission. Asynchronous replicas may serve history,
but stale status cannot prove that an old region never authorized a payment.

For the frontend, measure interaction feedback, page usability, large-list
rendering, and pending recovery completion. Optimize actual bottlenecks before
adding broad persistence or an animation framework.

## 🧪 Validation across the boundary

- Drop the response after provider approval and recover the same operation.
- Retry one intent from two tabs and check the stable external reference.
- Change checkout version while authorization is pending.
- Deliver a late callback after cancellation or account change.
- Process duplicate and out-of-order lifecycle notifications.
- Race partial refunds against the same remaining balance.
- Complete review, pending recovery, and receipt navigation with a screen reader.

Track provider latency separately from owned latency, plus unresolved-attempt
age, outbox lag, revocation acknowledgement delay, and refund conflicts.
Logs should carry safe operation IDs, not raw payment credentials.

## ⚖️ Trade-offs to summarize aloud

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Fixed checkout version; ❌ mutable callback inputs | Matches what the user reviewed | Reconfirmation after changes |
| ✅ Durable operation; ❌ cache-only retry protection | Recovers across crashes | Explicit recovery machinery |
| ✅ Pending uncertainty; ❌ automatic decline on timeout | Preserves truthful outcome | Longer pending UX |
| ✅ Device-specific lifecycle; ❌ one global card flag | Narrow lost-device scope | More token associations |
| ✅ Bounded account cache; ❌ persist all shared state | Limits privacy and stale-data exposure | Careful clearing and merging |

## 🧩 Repository boundary

The local React app and Express server simulate devices, tokens, biometrics,
and authorization. The server receives PAN/CVV JSON during provisioning,
generates an unkeyed digest, and records amount-based simulated decisions.
It has no real platform payment API, cryptogram validation, or provider call.

The browser omits the required idempotency header, so protected card/payment
flows are currently blocked. The Redis middleware has no durable operation
record; biometric sessions are reusable; public merchant routes lack ownership
checks; refund writes are not atomic. Instantiated network breakers are unused
by the payment handler.

The app's card/history stores are memory-only and not cleared on logout.
There is no operation recovery, issuer activation workflow, or full accessible
modal. These are concrete gaps between the teaching simulator and this
proposal, documented with source references in the [architecture](./architecture.md).
