# Apple Pay: architecture and implementation

## System Overview

A mobile wallet connects device-bound payment credentials, user authorization, merchant checkout, and existing payment networks. The central design challenge is preserving one payment intent across device interaction, external authorization, retries, and delayed results. Token provisioning and revocation have different latency and failure requirements from checkout.

This document first describes a **proposed production design**, then maps it to this repository's **local HTTP simulator** in Implementation Notes. The proposal is an interview-scale design, not a description of Apple's private infrastructure. Production targets are assumptions, not measured repository results.

The local application runs one Express process, PostgreSQL, Valkey, and React. It contains simulated tokenization and authorization, but no hardware security, NFC transport, actual network credentials, money movement, settlement, or native Apple Pay integration.

## Requirements

### Functional requirements — proposed production

- Enroll an eligible card on a specific device, including issuer verification when necessary.
- Show display-safe card metadata and device-specific availability.
- Support a merchant checkout with a fixed amount, currency, and order identity.
- Convey a payment credential through the appropriate native/contactless or app/web integration.
- Record merchant-side authorization outcomes and reconcile uncertain results.
- Suspend one token or all tokens on a lost device; expose propagation status.
- Provide authorized transaction history and refund status.

We separate three actors: the wallet manages credentials; the merchant/processor owns checkout and authorization attempts; the issuer decides whether to authorize. Authorization, capture, settlement, reversal, and refund remain distinct concepts.

### Non-functional requirements — proposed production

| Requirement | Design target / invariant |
|-------------|---------------------------|
| Wallet interaction | Visible selection feedback within 100 ms; responsive accessible controls |
| Owned online API | p99 under 200 ms excluding issuer/network waits and human verification |
| Checkout | Illustrative two-second response deadline; pending outcome if external status is unresolved |
| Availability | 99.99% for owned payment orchestration, measured separately from issuer approval |
| Correctness | One durable logical operation per checkout attempt; no duplicate external submission without a safe provider contract |
| Security | Minimize credential exposure; bind authorization to the intended operation and authorized actor |
| Revocation | Acknowledge request separately from confirmed enforcement at the credential authority |
| History | Eventual projection with read-after-write visibility for a known operation |

A sub-500 ms NFC exchange target would describe only a particular measured boundary. It must not be presented as a universal issuer-approval guarantee or a benchmark of this Express server.

## Capacity Estimation

Use 100 million daily authorizations as a planning example: about 1,160 per second on average and 11,600 per second at a tenfold peak. These figures describe the merchant/processor subsystem if it observes that volume; an ordinary wallet backend does not automatically receive every contactless authorization.

At roughly 1 KB per authorization record, raw history grows by about 100 GB/day before indexes, replicas, and separate attempt/audit records. A 90-day hot window would be about 9 TB raw. Retention must follow the applicable product and records policy; seven years is not a universal requirement for every row.

Assume 100 million users, two devices, and two cards per device: up to 400 million token associations. Device-specific tokens make lost-device operations narrow but increase enrollment and lifecycle traffic.

Provisioning peaks around device launches; authorization peaks around shopping activity. Separate resource budgets prevent a slow enrollment surge from starving checkout. Shard counts follow measured write, storage, and recovery limits rather than a fixed number chosen from request rate alone.

## High-Level Architecture

The diagram separates wallet control from merchant payment processing. Lines describe logical responsibility, not the precise Apple protocol.

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

The wallet control API also integrates with the token service provider (TSP) for enrollment and lifecycle requests. Its database stores associations and operation status; the processor keeps authorization attempts, provider references, and reconciliation work. Durable outboxes feed notification/history consumers. Static browser assets can use a CDN; neither cached assets nor metadata authorize spending.

Apple documents an NFC path involving the device and terminal, while app/web credentials involve Apple servers and merchant-specific encryption. These are different edge protocols; a single wallet REST endpoint should not be drawn as a mandatory intermediary for every physical tap. [Apple's payment flows](https://support.apple.com/en-euro/guide/security/secfbd5c0e54/web).

## Core Components / Request Flows

### Card provisioning

1. The authenticated user selects a target device and starts a durable enrollment operation.
2. A supported payment integration handles card data and device evidence according to its provider contract.
3. The TSP/issuer evaluates eligibility and risk; additional verification can leave enrollment pending.
4. Protected credential delivery and activation are confirmed before the wallet presents the token as usable.
5. Metadata and the enrollment result become visible to the owner; failures are resumable by operation ID.

Do not use last four digits as card identity. Unrelated cards can share them. A provider-approved reference and device association distinguish enrollments without retaining the original PAN in the ordinary wallet catalog.

Tokenization constrains use of a substitute credential to permitted domains such as device, merchant, or scenario. It reduces exposure; it is not proof that every database field is harmless or that all compliance obligations disappear. [EMVCo tokenisation overview](https://www.emvco.com/emv-technologies/payment-tokenisation/).

### Device authorization and credential use

For ordinary user-confirmed payments, the secure device boundary verifies intent and authentication before releasing payment credentials. Apple describes cryptograms derived from a key and transaction counter, with additional scheme-dependent inputs such as terminal unpredictability or an app/web anti-replay value. Validation belongs with the participating network/issuer, not a made-up wallet hash check. [Apple's authorization description](https://support.apple.com/guide/security/payment-authorization-with-apple-pay-secc1f57e189/web).

The proposal uses these roles, without claiming to reproduce the cryptographic protocol. Exact fields, counter handling, and replay policy follow the approved integration. A complete transaction-bound cryptogram cannot generally be computed before the inputs it authenticates are known.

### Merchant checkout and authorization

1. The merchant persists the order and authoritative total.
2. A checkout attempt fixes order version, currency, amount, and selected credential context.
3. The customer confirms the displayed intent through the supported platform flow.
4. An authenticated merchant/processor request claims a durable operation identity.
5. A worker or request handler sends the provider request with a stable external reference and a bounded deadline.
6. A conclusive provider response advances the operation and writes an outbox event transactionally.
7. A timeout after possible submission leaves the operation unresolved; reconciliation queries the provider using the existing reference.
8. The client reads the same operation until it has a conclusive outcome.

The processor does not hold a database transaction open during an issuer call. Durable preparation, external submission, and durable finalization are separate stages. No local SQL isolation level makes the external authorization part of the database commit.

### Revocation and refunds

Revocation first records the requested token/device scope, then dispatches lifecycle work. A lost phone should not suspend the user's watch credential. A local status update can block local requests immediately, but external enforcement requires acknowledgement from the token authority.

A refund is its own durable operation linked to an original captured payment. Reserve available refundable value atomically before provider submission; retain pending refund reservations during uncertainty. A partial refund does not imply that the whole original payment was refunded.

The repository combines these actors into one server and has no capture or settlement state. Its negative transaction rows demonstrate a refund display, not this accounting model.

## Database Schema

### Proposed production model

| Entity | Important fields / constraints | Access pattern |
|--------|--------------------------------|----------------|
| Wallet account | ID, identity reference, account state | Authenticate and list owned devices |
| Device | Owner, device reference, status, version | Fetch a user's devices; revoke a device |
| Token association | Owner/device, provider reference, display metadata, activation/lifecycle state | Unique provider association; indexes on owner/device |
| Enrollment operation | Actor, operation key, request fingerprint, provider reference, current step | Resume enrollment without requesting another token |
| Checkout | Merchant, order/version, amount in minor units, currency, state | Verify total and intent before confirmation |
| Payment attempt | Checkout, operation key, request fingerprint, provider reference, outcome/version | Unique actor + operation namespace + key |
| Refund operation | Original payment, amount, pending/final outcome, provider reference | Lock original payment's refundable balance |
| Provider inbox | Provider + event ID, verified payload reference, processing status | Deduplicate and order callbacks |
| Outbox | Event ID, aggregate ID/version, payload, delivery state | Recover publication after database commit |
| History projection | Owner, effective time, stable ID, display-safe result | Keyset pagination by time and ID |

Store integer minor units with currency rules or validated decimal representations. A currency code's length alone does not establish validity or precision. Keep sensitive payloads out of general history; use access-controlled references if protocol records must be retained.

### Existing local schema

The executable schema is [backend/src/db/init.sql](./backend/src/db/init.sql). This inventory describes it without suggesting that proposed tables already exist.

| Table | Existing columns / indexes | Material limitation |
|-------|---------------------------|---------------------|
| `users` | UUID, unique email, password hash, name, role, timestamps | Role is text; admin middleware is unused |
| `devices` | Owner FK, unique `secure_element_id`, type/status; owner index | Simulated identifier, not attestation |
| `provisioned_cards` | Owner/device FKs, unique `token_ref`, full `token_dpan`, last4, expiry, default/status; owner/device/token indexes | No uniqueness for active enrollment or one default; no status checks |
| `merchants` | Unique external-style merchant ID, name/category, optional public key/webhook, status | No merchant account ownership relation |
| `transactions` | Card/merchant FKs, token reference, cryptogram, decimal amount, currency, status/type, auth/decline text | No operation key, external reference, refund parent, capture, or reconciliation state |
| `biometric_sessions` | User/device FKs, challenge, status, five-minute expiry | No payment binding or consumed state |
| `audit_logs` | Actor, action/resource/result, request/session IDs, metadata; several audit indexes | Ordinary mutable table; no append-only enforcement |
| `token_atc` | Token reference PK, last counter, update time | Created/seeded but never read or updated by application logic |

Transaction indexes cover card/time, token/time, and merchant; there is no time partitioning or sharding. Most timestamps are `TIMESTAMP` without time zone. PostgreSQL returns `DECIMAL` values as strings by default, although frontend interfaces declare transaction amounts as numbers.

The schema accepts `'refund'` transaction types despite TypeScript unions omitting them. Text state columns also accept seed values such as a device status of `'suspended'` that do not match the device union. Neither comments nor TypeScript constrain SQL writers.

## API Design

### Proposed contract principles

Every financial/enrollment operation has a stable identity and an authorized status lookup. Merchant identity comes from authenticated credentials, never an arbitrary route parameter alone. Reusing a key for a different canonical request returns a conflict; retrying the same operation returns its existing status.

A response distinguishes confirmed approval, confirmed decline, pending reconciliation, and failure before submission. An HTTP timeout or generic server error cannot alone establish which financial outcome occurred.

Example proposed operation response:

```json
{
  "operation_id": "op_example",
  "status": "pending_reconciliation",
  "amount_minor": 2499,
  "currency": "USD",
  "status_url": "/api/payment-operations/op_example"
}
```

This is a proposed API shape, not the local response format.

### Implemented local routes

| Method / route | Access and behavior |
|----------------|---------------------|
| `POST /api/auth/register`, `/login` | Public; Zod inputs; login returns `sessionId` and user |
| `GET /api/auth/me`; `POST /api/auth/logout` | User session |
| `GET/POST /api/auth/devices` | List/register owned simulated devices |
| `DELETE /api/auth/devices/:deviceId`; `POST .../:deviceId/lost` | Owner checks; multi-statement state changes |
| `GET /api/cards`, `/:cardId` | Owner reads with explicit safe card projection |
| `POST /api/cards` | Session plus required idempotency key; receives plaintext PAN/CVV in parsed JSON |
| `POST /api/cards/:cardId/suspend`, `/reactivate`, `/default`; `DELETE /api/cards/:cardId` | Session plus required key |
| `POST /api/payments/biometric/initiate`, `/verify` | Session plus required key |
| `POST /api/payments/biometric/simulate`; `GET .../biometric/:sessionId` | Session, but no ownership check on supplied biometric session ID |
| `POST /api/payments/pay` | User auth, biometric middleware, idempotency middleware, then validation/service |
| `GET /api/payments/transactions`, `/transactions/:transactionId` | Owner-scoped SQL reads |
| `GET /api/merchants`, `/:merchantId`, `/:merchantId/transactions` | Public reads; history exposes transaction fields |
| `POST /api/merchants/:merchantId/sessions`, `/process`, `/refund` | Public mutations requiring an idempotency key |

User history accepts `limit`, `offset`, `card_id`, and `status`; numeric pagination is parsed without bounds/strict validation. Lists sort by creation time without an ID tie-breaker, and count/page are separate queries. There is no operation-key lookup for recovering a lost payment response.

## Key Design Decisions

### Delegate credential authority to the payment ecosystem

A wallet needs device-specific payment use and revocation. A real provider integration supplies that domain policy and issuer relationship. Keeping ordinary wallet storage limited to associations reduces the number of services that need payment secrets.

A custom server token vault can be legitimate in a processor design, but it would add key custody and provider obligations to this wallet's scope. A random string generator alone supplies neither token acceptance nor replay protection. The cost of delegation is dependence on provider capabilities, onboarding, lifecycle callbacks, and recovery procedures.

### Make the operation record durable before external work

A Redis lock can suppress concurrent requests while the key exists. It cannot explain an issuer approval after the server crashes before caching the result. The chosen design keeps operation identity and external reference in durable storage and retains uncertainty until reconciliation resolves it.

Database uniqueness serializes competing claims; short state transitions prevent two workers from creating separate attempts. Provider idempotency or lookup is still required at the external boundary. This adds explicit recovery machinery and a pending UX, but avoids pretending that a cache TTL decides whether a charge happened.

### Treat revocation as a versioned workflow

A token's authority may be external and the device may be unreachable. We record a versioned lifecycle request and show whether it is requested, locally blocked, or externally confirmed. Replayed/out-of-order events cannot reactivate a later suspension.

A single local update with cache deletion is easier, but can leave the external credential usable and can race a reader that repopulates stale state. Version checks and acknowledgement-based state require more coordination. They give the user an accurate account of what has been enforced.

## Consistency and Idempotency

### Proposed production guarantees

- Authenticate and authorize the actor before looking up an operation result.
- Bind the key to actor, operation namespace, canonical request, and authoritative checkout version.
- Persist intent and provider reference before submission; use atomic claim/state transitions.
- Keep unknown outcomes pending. A lock expiry means a worker lease expired, not that external work failed.
- Reconcile the same external reference before initiating a replacement authorization.
- Publish notifications via a durable outbox, and deduplicate provider callbacks by event ID.
- Use short SQL transactions for local invariants, including refundable amount reservations.

Protocol replay protection is a separate concern from an HTTP retry. Returning an already-authorized actor's stored result does not generate another credential or another authorization. Network replay rules should follow the payment scheme rather than a blanket wallet-side counter comparison.

### What local middleware actually guarantees

[shared/idempotency.ts](./backend/src/shared/idempotency.ts) requires the exact `Idempotency-Key` header, length 16–128. It checks a Redis response record, otherwise claims an in-progress record with `SET NX EX 60`. Completed JSON responses are written asynchronously with a 24-hour TTL. In-progress requests return 409; a different stored body hash returns 422.

The limitations matter:

1. The key uses `req.path` and the supplied key, without user, HTTP method, or router mount prefix. Separate actors and routes can collide; authorized users must not share private response caches this way.
2. The body fingerprint is a 32-bit string hash, not a collision-resistant canonical request digest.
3. SQL writes and Redis results do not commit together. A payment row can exist even when the caller receives 500 after a Redis failure.
4. Redis check errors allow the handler to proceed. User authentication still depends on Redis; this fallback does not make the entire API Redis-independent.
5. All JSON statuses are initially cached, while a finish handler deletes records for 4xx/5xx responses. Errors therefore are not retained as durable operation outcomes.
6. An expired lease allows another execution; completion/cleanup are not conditional on lease ownership.
7. Biometric middleware runs before replay lookup, so a completed payment cannot be replayed through this route after the biometric session expires without renewed verification.
8. The browser never sends the key, so it does not reach these protected handlers normally.

The separate `executeIdempotent` helper is exported but unused. There is no transaction-row unique constraint backing idempotency and no durable reconciliation worker.

## Security / Auth

### Proposed production boundary

Use authenticated device/user and merchant identities, least-privilege data projections, TLS, protected credential handling, and narrowly scoped authorization. Treat local display metadata as untrusted for payment eligibility. Device revocation and account-session revocation are separate operations.

For a browser account surface, an HttpOnly cookie can reduce JavaScript access to the session credential; CSRF and XSS defenses still matter. Native payment authorization uses the supported platform boundary. A JavaScript animation or a reusable server boolean is not evidence of biometric verification.

### Local behavior and gaps

- Passwords use bcrypt cost 10. A UUID session is stored only in Redis with a one-hour sliding TTL.
- The client stores the session in localStorage and sends `X-Session-Id`; there is no session cookie or `express-session` middleware.
- Login accepts an optional device ID without proving it belongs to the account before writing it into the session. Later device activity updates include ownership, but their result is not checked.
- Biometric initiation requires an owned active device, generates a random challenge, and writes SQL plus Redis separately.
- Verification accepts the literal response `'verified'` or a string containing the challenge's first ten characters. Verify/simulate/status access does not check ownership of the supplied session.
- The Redis verification path does not enforce pending status or original SQL expiry. Successful verification extends only Redis TTL; payment middleware uses the original SQL expiry.
- Payment requires a verified SQL session owned by the current user, but does not bind it to the selected card's device, amount, merchant, or a single use.
- Card status is read before payment; device status is not rechecked, and suspension is not serialized with authorization. Reactivating a suspended card does not require its device to be active.
- Merchant history, authorization simulation, and refunds have no authentication. `adminMiddleware` exists but is not mounted.
- There is no rate limiter, device attestation, issuer step-up, payment signature verification, encrypted token storage, or compliance certification.

PAN/CVV are not persisted by the provisioning service, but the API receives them and stores full simulated DPANs. Card reads project safe fields; user and public merchant transaction reads return token references and cryptograms. Data minimization must be assessed per endpoint, not inferred from a single card projection.

## Observability

### Proposed production signals

Track owned latency, provider latency, conclusive declines, failures before submission, unresolved attempts, reconciliation age, duplicate suppression, lifecycle acknowledgement delay, and refundable-balance conflicts. Approval rate is a business/risk signal, not equivalent to service availability.

Use durable IDs to correlate checkout, attempt, provider request, callback, refund, and notification. Avoid amounts, customer IDs, arbitrary paths, and credential material as unbounded metric labels. Audit completion needs durable capture plus an explicit retention policy.

### Existing instrumentation

| Implementation | What it measures / misses |
|----------------|--------------------------|
| `metrics.ts` | HTTP duration/count; payment duration/result/amount; provisioning and Redis idempotency counters |
| Payment route labels | Successful payments are labeled `visa` regardless of actual card; declined labels use `unknown` |
| Amount metric | Named USD even though API accepts arbitrary three-character currencies |
| Circuit gauges | Created at startup; 0 closed, 0.5 half-open, 1 open; actual payment handlers do not fire them |
| Declared gauges/histograms | Active-card count, DB pool, and DB query instruments are not updated by the DB helper |
| Request logger | Request/response records with supplied/generated request ID; service logs generally use module loggers instead of `req.log` |
| Audit helper | Selected provisioning, suspension, biometric, payment, and refund events; not every auth/device/card operation |

`audit_logs` persistence errors are swallowed after logging. Events are outside the financial write transaction, and the table is not immutable. Audit metadata redaction covers selected top-level keys; Pino redaction covers configured paths, not arbitrary nested objects or error strings. The audit row stores the session ID itself. These are partial diagnostics, not a complete compliance control.

HTTP route labels omit mounted prefixes when `req.route.path` exists; fallback paths normalize UUID-looking values but can still have unbounded variants. Health and metrics are public.

## Failure Handling

| Failure | Local behavior | Proposed production handling |
|---------|----------------|------------------------------|
| Redis unavailable at startup | Server does not listen | Readiness and bounded recovery according to service role |
| Redis auth failure | Protected requests return 500 | Refuse unauthorized work; preserve already-durable attempts |
| Redis write after payment insert | Request can fail after transaction is recorded | Resume by durable operation; no blind resubmission |
| Simulated network error | Recorded as a decline with a retry message | Distinguish known decline from unknown provider outcome |
| Audit insert failure | Operation continues; log records failure | Outbox-backed retry and backlog alerting |
| Default-card removal | Card deleted and Redis keys removed, then invalid SQL fails | Atomic lifecycle/default transition |
| Concurrent refunds | Both can pass the initial approved check | Serialize refundable balance reservation |
| Process termination | SIGTERM closes dependencies and exits | Stop accepting HTTP, drain bounded work, preserve recovery state |

Three Opossum breakers are instantiated with 10-second timeout, 50% error threshold, minimum volume five, and 30-second reset. They wrap separate simulator functions, but `authorizeWithNetwork` is unused by routes/services. Consequently, healthy breaker statistics say nothing about actual payment traffic.

Readiness/deep health query PostgreSQL and Redis, including Redis memory info, without an overall deadline. They do not check schema, fixtures, operation recovery, or credential availability. The HTTP server is not retained for graceful close; SIGINT has no custom handler.

## Scalability Considerations

The production proposal first separates enrollment, lifecycle, merchant attempts, and history workloads. It then measures database contention, provider concurrency, outbox lag, and history query costs before adding shards.

Partition large historical records by time and route writes by a stable ownership key. Keep uniqueness for operation identity enforceable within its partition or a dedicated registry. A user's cross-token history should be an authorized projection rather than repeated scatter-gather over payment shards.

Use bounded concurrency per provider and per workload as well as circuit breakers. A breaker alone does not prevent exhaustion before it trips. Apply deadlines that fit the checkout budget and respect provider retry/reconciliation contracts.

For regional failure, fence the prior operation writer before promoting another. Asynchronous replicas can serve history but must not independently authorize the same unresolved attempt. Availability during a partition is constrained by the correctness boundary and provider contract.

The local multi-instance scripts share PostgreSQL and Redis but introduce no load balancer, fenced workers, durable operation identity, or atomic counter handling. Running more processes exposes races; it does not demonstrate a safe distributed payment service.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Credential authority | Approved TSP/platform integration | Wallet-owned token generator | Provider policy and acceptance are essential |
| Operation identity | Durable actor-scoped record | Redis-only response cache | Survives response loss and cache eviction |
| External uncertainty | Pending state plus reconciliation | Declare decline after timeout | Avoids conflicting outcomes and duplicate attempts |
| Revocation | Versioned acknowledged workflow | Local flag plus cache deletion | Separates requested and enforced state |
| Refund correctness | Atomic remaining-value reservation | Check then separate inserts | Bounds concurrent partial refunds |
| History | Eventual authorized projection | Global synchronous payment joins | Keeps reads off authorization resources |
| Provider resilience | Per-provider budgets and deadlines | Shared unrestricted pool | Limits cascading failures |

## Implementation Notes

### What runs locally

[backend/src/index.ts](./backend/src/index.ts) mounts four route groups on port 3000. PostgreSQL and Valkey use their Compose defaults; React/Vite runs on 5173 and proxies `/api`. Setup and seed commands are in the [README](./README.md).

The backend package emits CommonJS under its current NodeNext/package settings; its TypeScript source uses import syntax with `.js` local specifiers. There is no separately deployed tokenization service or processor: service classes execute in the same Express process.

### Provisioning and token lifecycle

[services/tokenization.ts](./backend/src/services/tokenization.ts) checks Luhn, simplified network prefixes, expiry, and an owned active device. It checks duplicate active cards by last4 and counts active cards to choose a default, then inserts SQL and writes Redis separately. Concurrent requests can pass both checks; different cards with the same last4 can be rejected incorrectly.

[utils/crypto.ts](./backend/src/utils/crypto.ts) generates a random token reference and a prefix plus random **hexadecimal** DPAN suffix. The latter can contain letters and is not an EMV-valid card-number generator. No issuer verifies the CVV, eligibility, or ownership.

Provisioning stores `token:{tokenRef}` and `se:{deviceId}:{tokenRef}` for one year. The latter contains DPAN and counter zero. These are server-readable JSON values, not protected hardware secrets.

Suspending a card updates SQL and an existing token cache entry, dropping that key's TTL. Reactivation changes SQL only. Removing a card deletes its Redis entries; removing a default then executes `UPDATE ... ORDER BY ... LIMIT`, which PostgreSQL does not support in that form. Prior writes have already committed. [PostgreSQL UPDATE syntax](https://www.postgresql.org/docs/16/sql-update.html).

Device removal/loss updates cards and device status in separate SQL statements without clearing Redis token/SE state or account sessions. A removed card can be suspended again because suspension excludes only already-suspended cards; it can then be reactivated. Default selection clears all user defaults and sets one in separate statements, with no uniqueness constraint.

### Payment, counters, and refunds

[services/payment.ts](./backend/src/services/payment.ts) reads card ownership/status and an active merchant, computes a truncated unkeyed SHA-256 digest, executes its private amount/expiry/random simulator, and inserts an approved/declined transaction. It then updates Redis state and a recent-transaction list before returning.

The digest includes token reference, amount, merchant identifier, and timestamp, but no secret, currency, or ATC. `validateCryptogram` is unused and has no buffer-length guard before `timingSafeEqual`. The payment simulator ignores its cryptogram argument.

Counter updates read/modify/write the Redis JSON, can lose concurrent increments, remove its TTL, and return zero if the key is absent. Counters are neither included in the cryptogram nor validated against a watermark. Seeded SQL counters do not initialize Redis and do not provide replay protection.

Refunds read an approved transaction, insert a negative approved row with type `'refund'`, and mark the original fully refunded in separate statements. There is no refund parent link, remaining-balance reservation, or provider call. Partial refunds still close the original; concurrent different keys can over-refund. Even an approved refund row can be passed back as an original because the query does not restrict payment type.

[Merchant routes](./backend/src/routes/merchants.ts) implement a separate simulator: `/process` accepts any cryptogram/token string and approves amounts below 10000 without a transaction insert. Its checkout-session object is not persisted, checked for expiry, or tied to payment submission.

### Wired infrastructure and its boundaries

The Redis lease illustrates concurrent exclusion:

```typescript
// Pattern in shared/idempotency.ts; not a durable payment guarantee.
await redis.set(cacheKey, JSON.stringify(inProgress), 'EX', 60, 'NX');
```

Its limitations are traced in [Consistency and Idempotency](#consistency-and-idempotency). [Logging](./backend/src/shared/logger.ts), [metrics](./backend/src/shared/metrics.ts), [audit](./backend/src/shared/audit.ts), and [health](./backend/src/shared/health.ts) are mounted/used to varying extents. [Circuit-breaker helpers](./backend/src/shared/circuit-breaker.ts) are initialized but not wired into the authorization path. No rate limiter, message queue, or background reconciler exists.

Card lists and history query PostgreSQL directly. Redis's seven-day recent-transaction list and token lookup entries are not read by these endpoints. There is no two-minute card cache, 30-second history cache, or SQL-backed ATC write-through behavior.

### Frontend behavior

[stores/index.ts](./frontend/src/stores/index.ts) defines auth, wallet, transaction, and payment stores. Only the session ID is persisted; cards/history are memory-only. [services/api.ts](./frontend/src/services/api.ts) reads session IDs from browser storage, sends two custom auth headers, and throws away structured error details such as declined transaction IDs. It never sends `Idempotency-Key` and has no abort/deadline or operation-recovery contract.

The root restores authentication; `Layout` waits for `authChecked` before redirecting. Page effects still start independently. Logout clears auth/browser session fields but does not reset wallet, history, or payment stores, so stale account data can remain during a subsequent account's load. Requests have no account-generation guard.

Wallet cards form a vertical list with CSS hover transforms, not a gesture carousel. Add Card is a single form; PAN/CVV live transiently in component state. There is no issuer-verification step, camera scan, offline cache, service worker, Framer Motion, or TanStack Virtual.

[pay.tsx](./frontend/src/routes/pay.tsx) uses several booleans and mutable form fields. It does not freeze the reviewed intent, disable the Pay button during biometric initiation, or preserve a recoverable operation ID. The [biometric modal](./frontend/src/components/BiometricModal.tsx) displays “Authenticated” for one second **before** calling the server verification callback. Its timeout lacks cleanup, and it has no focus trap, dialog semantics, reduced-motion handling, or status announcements. There is no actual biometric API call.

The final payment banner waits for the HTTP result, but an error becomes a generic failure message even if a transaction was already inserted. Biometric session storage is not cleared after payment; the server also allows repeated use until SQL expiry.

History groups by display dates and Load More requests the first N+50 records again. Different years can share a month/day group. There is no filter/search UI or pagination cursor. Merchant selection requests can resolve out of order; session-creation errors are console-only. The merchant page displays ten records from the default 50-row response and does not initiate a customer payment or refund.

### Fixtures, substitutions, and omissions

The SQL seed creates four users, seven devices/cards/merchants, ten transactions, six ATC rows, and six audit examples. Shared password `password123` was verified against the seed hash. It supplies no Redis token/SE data. Several card expiries and the login form's demo credentials are stale; Alice has two default markers. The seed can append audit rows on rerun and conflict with independently created identities.

Software JSON/hash simulation substitutes for TSP, hardware credentials, and cryptograms. A React button substitutes for device authentication. HTTP type labels substitute for NFC/app/web transports. These substitutions demonstrate shapes of interactions while omitting their security guarantees.

Omitted production components include real network/issuer integration, secure provisioning, merchant authentication, atomic financial state, durable idempotency, reconciliation, capture/settlement, provider callbacks, outboxes, notifications, rate limiting, multi-region recovery, and an administrative interface.
