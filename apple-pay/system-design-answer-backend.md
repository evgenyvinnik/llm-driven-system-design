# Apple Pay: backend system design interview

> “I would start by separating the wallet, the merchant's payment processor,
> and the issuer. Otherwise it is easy to draw a wallet service that claims
> to authorize every tap even though the real payment path belongs to other
> participants.”

This answer proposes a wallet control plane and the merchant-side operation
handling needed to explain payment correctness. It does not claim to describe
Apple's internal service architecture. The repository implements a local
HTTP simulator, with a short implementation comparison at the end.

## 🧭 Discussion plan

| Topic | Minutes |
|-------|---------|
| Scope, invariants, and capacity | 5 |
| Architecture and data model | 7 |
| Deep dive: provisioning and token authority | 8 |
| Deep dive: retries and uncertain authorization | 12 |
| Deep dive: revocation and refunds | 8 |
| Scaling, operations, and implementation boundary | 5 |
| Total | 45 |

## 🎯 Define responsibility before infrastructure

I would ask whether we are the wallet provider, a merchant integration, or a
processor. A wallet enrolls and manages credentials. A merchant tracks its
order. The issuer makes the credit authorization decision through the
participating payment network and processor.

For the interview, I would draw those boundaries and design the wallet-owned
services in detail, then expand the merchant/processor boundary for the hard
retry problem. This makes clear which subsystem owns each record.

Physical contactless payments do not need a generic wallet REST handler
between every terminal and issuer. App/web integration has its own credential
handoff. I would share business concepts where appropriate without asserting
that their edge protocols are identical.

### Functional scope

- Enroll a card for one device and handle additional issuer verification.
- Show token associations and manage their lifecycle.
- Submit a merchant checkout through the approved provider integration.
- Track one authorization attempt through success, decline, and uncertainty.
- Expose authorized history and handle linked refund operations.
- Recover safely after process, dependency, and regional failures.

I would exclude account balances, peer-to-peer transfers, transit exceptions,
and a new card network. Capture and settlement are distinct lifecycle stages;
we discuss their relationship to authorization rather than implement a full
banking ledger in this session.

### The invariants

| Invariant | Why it matters |
|-----------|----------------|
| One operation identity per intended attempt | A lost response cannot create another purchase |
| A provider timeout is unresolved evidence | Prevents contradictory “declined” and “approved” outcomes |
| An operation result belongs to its authenticated actor | Retry caches must not leak another customer's data |
| Token activation/revocation has an authority | A local flag cannot establish network enforcement |
| Refund reservations cannot exceed available captured value | Concurrent requests must share one balance invariant |
| Audit/recovery work survives a process crash | A log line cannot substitute for durable state |

### Scale assumptions

Suppose the processor subsystem handles 100 million authorizations per day:
about 1,160 per second average and 11,600 per second at a tenfold peak.
These are planning assumptions, not Apple usage figures.

At approximately 1 KB per authorization record, that is 100 GB/day raw before
indexes, replication, attempts, and audit. Ninety hot days are about 9 TB.
These numbers justify separating current operational state from long history.

For wallet metadata, 100 million users with two devices and two cards per
device would create up to 400 million token associations. Enrollment volume
is lower but bursts around new devices, with slower issuer verification.

I would target p99 under 200 ms for owned API work, excluding external waits,
and use an illustrative two-second checkout deadline. Human verification
and issuer response times need separate measurements. The owned service's
99.99% availability target is not an issuer approval-rate promise.

## 🏗️ A small architecture

```
┌──────────────────────────┐        ┌──────────────────────────┐
│ Wallet + device          │───────▶│ Wallet control API       │
│ Protected credential     │        │ Enrollment / lifecycle   │
└────────────┬─────────────┘        └────────────┬─────────────┘
             ▼                                   ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Merchant / terminal      │        │ Token authority / TSP    │
│ Checkout identity        │        │ Enroll / revoke          │
└────────────┬─────────────┘        └──────────────────────────┘
             ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Merchant processor       │───────▶│ Network / issuer         │
│ Durable payment attempts │        │ Authorization outcome    │
└──────────────────────────┘        └──────────────────────────┘
```

Enrollment and lifecycle store wallet metadata and durable operation state.
The processor owns authorization attempts, provider references, and recovery.
Each subsystem publishes committed events through an outbox to its history
and notification consumers.

The network/TSP participates in token provisioning and validation, and the
issuer decides authorization. Apple describes different contactless and
app/web credential flows; that is why I would keep their adapters separate.
[Apple payment flow reference](https://support.apple.com/en-euro/guide/security/secfbd5c0e54/web).

I would initially use PostgreSQL for relationships, unique operation claims,
and short transactional updates. Redis can cache display metadata or completed
responses, but durable payment identity does not depend on its retention.

### Data model worth putting on the board

| Record | Important fields | Constraint or access pattern |
|--------|------------------|------------------------------|
| Device | Owner, device reference, status/version | List/revoke by owner and device |
| Token association | Device, provider reference, display metadata, lifecycle state/version | Unique provider association; owner/device indexes |
| Enrollment | Actor, key, fingerprint, provider reference, step | Resume one request rather than mint another token |
| Checkout | Merchant, order/version, amount, currency | Authoritative reviewed intent |
| Payment attempt | Checkout, key, fingerprint, external reference, status/version | Unique actor + operation namespace + key |
| Refund | Original payment, reserved amount, provider reference, outcome | Serialize available refundable value |
| Provider event | Provider/event ID, verified payload, processing state | Deduplicate callbacks |
| Outbox/history | Event/aggregate IDs, version, display-safe payload | Recover publication and page history |

I would not draw every field. The important relationships are checkout to
attempt, payment to refunds, device to token associations, and operation to
its stable external reference.

Amounts use integer minor units with currency-specific rules or validated
decimals. A two-decimal database column alone does not validate every currency
or prevent JavaScript rounding before insertion.

## 🔧 Deep dive 1: provisioning and token authority

### Decision

I would integrate with an approved TSP/platform and keep ordinary wallet
storage limited to the references and metadata it needs. I would not treat
locally generated token-looking strings as payment credentials.

> “The useful property of a token is not that it looks random. It is that a
> participating authority knows where it can be used, how to validate it,
> and how to suspend it.”

Tokenization replaces a PAN with a constrained substitute. Depending on the
scheme, restrictions can include device, merchant, or transaction scenario.
That is stronger than simply renaming a database field. [EMVCo's definition
of payment tokenisation](https://www.emvco.com/emv-technologies/payment-tokenisation/).

### Enrollment is a workflow

1. Authenticate the user and verify the selected device association.
2. Create a durable enrollment identity before provider work.
3. Pass required card/device data through the approved integration.
4. Record issuer verification requirements if activation is pending.
5. Confirm protected credential delivery and activation.
6. Publish updated display metadata to the user's wallet.

The issuer may require the customer to complete a separate verification
step. A pending enrollment is a normal state that can outlive an HTTP request.
The client should resume it instead of requesting a second token on retry.

Provider timeouts during enrollment also require recovery. A local unique
constraint on newly generated token references cannot prevent two external
tokens if the system sends two independent requests first.

### Device scope and identity

I would use a device-specific token association so losing one device does
not invalidate every device the customer uses. A card on the phone and a
card on the watch are separate lifecycle objects.

The price is more associations and lifecycle fan-out. A card-level issuer
change may affect several devices; jobs need bounded concurrency, progress,
and retry identity for each affected association.

Last four digits are display metadata, not a unique card key. I would use the
provider's supported identity/reference model for duplicate detection and
cross-device associations, within its privacy constraints.

### Dynamic authorization is not an ordinary hash

Apple describes a cryptogram using a secret key and transaction counter, with
additional scheme-dependent inputs. Validation is performed by participating
payment authorities. A wallet-side unkeyed digest does not establish device
possession or enforce freshness. [Apple authorization reference](https://support.apple.com/guide/security/payment-authorization-with-apple-pay-secc1f57e189/web).

I would not invent the exact cryptographic recipe or a universal counter
watermark rule. Protocol replay policy belongs to the scheme and authorized
integration; our application-level retry contract is a separate layer.

### Why the alternative costs more

A server-owned PAN vault can be appropriate for a processor, but choosing it
here adds key custody, credential access controls, provider relationships,
and a much larger sensitive-data surface to the wallet's scope.

It also does not by itself solve replay: a static token may need additional
transaction authentication and domain restrictions. Hardware-backed dynamic
credentials and a vault are not mutually exclusive concepts in the broader
ecosystem; they address different responsibilities.

The chosen boundary gives up control over provider availability, supported
features, and verification UX. I would accept those dependencies rather than
pretend the wallet can replace the issuer's authority with local validation.

## 🔧 Deep dive 2: a timeout must not create a second authorization

### Decision

I would keep a durable operation record and a stable provider reference,
then reconcile uncertain submissions. Redis is an optimization around that
record, not the source of truth about whether external work happened.

Consider a purchase for $24.99. The provider approves it, but our process
crashes before returning the response. A retry arrives on another instance.
The question is not whether the original HTTP handler is still running. The
question is what happened to the provider operation.

### Claim, submit, finalize

First, an authenticated request claims the operation key with a unique
constraint covering actor and operation namespace. The record includes a
canonical request fingerprint, checkout version, and provider reference.

A retry with identical intent returns or resumes the existing operation.
A different amount under the same identity is rejected. Looking up a result
must still enforce ownership; knowing an idempotency key is not authorization.

Next, a worker claims the prepared attempt and submits the provider request.
That worker may have a lease, but the durable state remains after the lease
expires. We never hold an open SQL transaction while waiting on the issuer.

Finally, a conclusive result updates the attempt and writes an outbox event
in one short transaction. History, receipt delivery, and downstream order
updates consume those events idempotently.

### The uncertain interval

| Point of failure | Recovery |
|------------------|----------|
| Before durable preparation | Client can retry the same identity |
| Prepared, not submitted | Resume the existing operation |
| Provider may have accepted request | Query/reconcile the stable external reference |
| Result committed, response lost | Return the stored result |
| Event publication fails after commit | Outbox publisher retries |

The provider contract determines whether repeating the same external request
is safe, how long its idempotency window lasts, and how status can be queried.
If the provider offers neither safe retry nor reliable lookup, the system
cannot manufacture an exactly-once guarantee around it.

After an ambiguous timeout, show “pending” and prevent an automatic second
authorization. Recovery may discover approval, confirmed rejection, or a
need for a provider-defined reversal. We do not declare a decline merely
because our connection closed.

### Why a Redis lock is insufficient

A 60-second key can expire while a remote authorization continues. A second
worker may then submit another request. The first worker can also finish
late and overwrite a newer cache record if writes lack ownership checks.

Writing SQL and then Redis creates a crash window between them. Reversing
the order creates a different window. Neither order makes the two systems
and an issuer one atomic transaction.

Failing open when the only duplicate record is unavailable is especially
incompatible with a correctness guarantee. A robust design can lose the
response cache and fall back to the durable operation registry.

### Replay protection and retries

A duplicated transport request can carry the same previously accepted
credential. An authenticated operation lookup returns the recorded outcome
without generating a new credential or another external authorization.

A new operation with an invalid or reused credential is evaluated through
the scheme's validation rules. An HTTP idempotency key is not a substitute
for those rules, and a cryptogram is not a substitute for merchant order
identity. Both boundaries must be respected.

### Cost and trade-off

We add prepared/submitted/pending/final state, recovery workers, provider
lookup, and explicit pending UI. That is more machinery than response caching.
It also produces an explainable answer after the one failure that matters
most: approval whose response never reached the customer.

I would test crashes at each boundary and verify that one provider reference
remains associated with the attempt. Counting local transaction rows alone
cannot prove that an external system was invoked only once.

## 🔧 Deep dive 3: lifecycle changes need their own invariants

### Decision

I would model revocation as a versioned acknowledged workflow and refunds as
separate operations with an atomic value reservation. They are not generic
CRUD updates, even if their HTTP handlers initially look small.

### Lost-device revocation

A user reports a phone lost. We authenticate that action, record its device
scope, block new local operations, and dispatch token lifecycle requests to
the authority. We expose which tokens are pending and which are confirmed.

We cannot promise immediate remote enforcement from a local row update.
The device may be offline and the provider may be delayed. The relevant
boundary is whether the authority that accepts payment has enforced the rule.

A later “active” event must not undo a newer suspension. Use provider event
identity and lifecycle versions, then recover authoritative current state
when event ordering cannot be established.

Caching only active tokens does not solve freshness by itself. A reader can
fetch old active state just before suspension and repopulate a deleted cache.
Use version-aware reads/updates, invalidation, and a clearly defined authority
for decisions rather than claim that cache deletion creates strong consistency.

The trade-off is a visible pending state and more event handling. The simpler
alternative gives a comforting success message without proving enforcement.

### Refunds and partial value

For a captured $100 purchase, suppose two workers each request a $70 refund.
Independent checks that each amount is below $100 both pass. The invariant
is that the **combined reserved and completed refunds** fit the available
captured value.

I would lock or atomically update the payment's refundable balance and create
the refund reservation in one transaction. Then submit externally using the
refund's stable identity. A pending refund continues to reserve value until
its outcome is resolved.

A partial refund leaves the original partially refunded. The refund has a
parent payment, its own status, and a provider reference. Restrict eligible
original types; a negative refund record must not itself become the source
for an unintended refund-of-refund operation.

An append-only accounting model becomes relevant when we own capture and
money movement. For a wallet-only product, this belongs to the merchant or
processor subsystem rather than a fictitious wallet balance table.

### What this costs

These transitions introduce contention on an individual payment or token.
That is intentional: concurrent changes to the same invariant need an order.
Unrelated payments remain independent, so we do not need a global lock or
serializable transaction around every read endpoint.

## 📈 Scaling and failure containment

I would separate enrollment, authorization, lifecycle, and history resource
budgets before adding more database shards. Provider concurrency and queue
age can be bottlenecks even when CPU utilization is low.

Use per-provider deadlines, bounded concurrency, and circuit breakers.
Breakers reduce repeated calls after failure, while concurrency limits bound
damage before a breaker trips. Business declines should not automatically
count as transport failures.

Partition history by time and keep hot operation lookups indexed. Choose a
shard key that preserves operation uniqueness and local transitions; build
user history as a projection if authorization ownership differs from user
ownership. Benchmark before naming a shard count.

During regional failover, fence the old operation writer before admitting a
replacement. An asynchronously replicated status row is adequate for some
history reads, but not proof that a previous region never submitted a payment.

### Operational signals

| Signal | Interpretation |
|--------|----------------|
| Owned/provider latency separately | Identifies which budget is being consumed |
| Pending reconciliation count and age | Measures unresolved external uncertainty |
| Duplicate claim and fingerprint conflicts | Reveals retry behavior or client misuse |
| Lifecycle acknowledgement age | Finds revocation work that has not completed |
| Refund reservation conflicts | Checks the remaining-value invariant under contention |
| Outbox lag and durable audit backlog | Shows delayed downstream visibility |

Health probes need bounded dependency checks and graceful draining. A healthy
process does not prove that providers are reachable or recovery work is
progressing. Retention and access controls depend on the actual records held;
I would not claim certification from the presence of a logger.

## ⚖️ Decisions to defend

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ TSP/platform boundary; ❌ locally invented credentials | Real authority and lifecycle integration | Provider dependencies |
| ✅ Durable operation; ❌ Redis-only duplicate state | Recoverable after a lost response | Recovery state and workers |
| ✅ Pending uncertainty; ❌ timeout means decline | Avoids contradictory financial outcomes | Longer unresolved UX |
| ✅ Versioned revocation; ❌ local flag means blocked everywhere | Honest enforcement state | Asynchronous acknowledgement |
| ✅ Refund reservation; ❌ independent amount checks | Prevents concurrent over-refunds | Per-payment serialization |

## 🧩 Local implementation comparison

The repository has one Express process, PostgreSQL, and Valkey. The payment
service records simulated decisions after generating an unkeyed digest.
Cryptogram validation is unused; Redis counters are neither validated nor
persisted to the SQL ATC table. Network breakers exist but are not invoked
by the active payment handler.

Idempotency uses a short Redis lease and asynchronous response caching, with
no actor/method namespace or durable transaction constraint. Biometric
sessions are simulated and reusable. Merchant operations are public; refunds
use separate reads/inserts/updates and do not enforce a shared remaining
balance. The browser also omits the required idempotency header.

Those gaps make the project useful for discussing why the stronger design
is necessary. Exact routes, schema, and source evidence belong in the
[architecture](./architecture.md), leaving this interview focused on the
boundaries and invariants that make a payment outcome recoverable.
