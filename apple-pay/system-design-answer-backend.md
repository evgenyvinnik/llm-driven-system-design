# Apple Pay - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a mobile payment system like Apple Pay: users provision cards into a wallet, tap to pay at contactless terminals, pay inside merchant apps, and manage the lifecycle of those cards across multiple devices.

The defining constraint is unusual for a system design problem: **the most valuable data in the system is data we deliberately refuse to hold.** We never see the real card number. We never hold the cryptographic key that signs a payment. Everything else — the architecture, the failure modes, the scaling story — follows from that one decision, because it moves the entire security boundary off our servers and onto silicon we don't control and networks we don't own.

## 🎯 Requirements Clarification

Questions I'd ask before drawing anything:

- **Are we the wallet, the network, or the issuer?** We're the wallet. The card networks (Visa VTS, Mastercard MDES, Amex) run the Token Service Providers that mint tokens and de-tokenize them; the issuing banks make the approve/decline decision. We orchestrate, we never adjudicate.
- **Does money move through us?** No. We're in the authorization path, not the settlement path. That materially simplifies the data model — no ledger, no double-entry, no balance invariants — and it moves the hardest correctness problem from "don't lose money" to "don't authorize the same tap twice."
- **What's the latency budget actually measuring?** Tap-to-approval, as the user perceives it. I'll decompose that budget, because our server owns maybe a fifth of it.

### Functional Requirements

- **Provisioning**: Add a card to a device; obtain a device-specific token (DPAN) from the network TSP
- **Payment**: Authorize NFC (tap) and in-app payments, routed to the correct network and issuer
- **Token lifecycle**: Suspend, reactivate, refresh on expiry, and mass-suspend on a lost device
- **History**: Per-user, per-card transaction history with merchant details
- **Audit**: Every card access and payment operation logged for compliance

### Non-Functional Requirements

- **Latency**: p99 < 500ms tap-to-approval end to end
- **Availability**: 99.99% for the payment path — a wallet that fails at the register is worse than no wallet, because the user has already put their groceries on the belt
- **Security**: No raw PAN ever stored, logged, or transmitted through our servers unencrypted
- **Correctness**: A tap authorizes exactly once. Not zero times (the user waves the phone again and looks foolish), not twice (we double-charged them)

### Scale Estimates

Working these out matters, because they're what force the architecture:

- **Users and tokens**: 500M users × ~2 devices × ~1.5 cards ≈ **1.5B token rows**. Note that's an order of magnitude more than the ~300M distinct physical cards — a direct consequence of per-device tokenization, and it's the number that drives the lifecycle fan-out problem.
- **Transactions**: 500M/day ≈ **6K TPS average**. But payments are wildly non-uniform: they cluster at lunch, at the evening commute, and on a handful of days a year. A 3–4× peak factor gives **~20K TPS**, and the design has to survive that, not the average.
- **Work per transaction**: 1 token lookup, 1 ATC read + 1 ATC write, 1 idempotency check, 1 TSP cryptogram validation (network hop), 1 issuer authorization (network hop), 1 transaction insert, 1 audit insert. Two of those seven are external network calls we don't control, which is why the latency budget below allocates only ~40ms to us.
- **Storage**: ~500M transaction rows + ~1B audit rows per day. Transactions are hot for 90 days, then cold. Audit is cold from birth and retained **7 years** — roughly 2.5 trillion rows at steady state, which is not going in the same PostgreSQL cluster as the payment path.
- **Provisioning**: bursty and small — a few hundred per second normally, spiking on device-launch days. Low volume, high latency tolerance (seconds are fine), sometimes human-gated. Completely different shape from payments, which is the argument for a separate service.

## 🏗️ High-Level Architecture

```
┌────────────────────────────────────────────────────────────────┐
│   Device (iPhone / Watch)   ┌──────────────────────────────┐   │
│   Wallet UI ────────────────│  Secure Element              │   │
│                             │  • DPAN + per-token key      │   │
│                             │  • Cryptogram generation     │   │
│                             │  • ATC (monotonic counter)   │   │
│                             └──────────────────────────────┘   │
└──────────────┬─────────────────────────────┬───────────────────┘
        NFC ──▶│ Terminal ──▶ Acquirer       │ HTTPS (provisioning,
               │                             │        in-app, history)
               ▼                             ▼
┌────────────────────────────────────────────────────────────────┐
│           API Gateway (TLS, WAF, per-user rate limits)         │
└──────┬─────────────────────┬──────────────────────┬────────────┘
       ▼                     ▼                      ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ Provisioning │   │  Transaction     │   │ Token Lifecycle  │
│  Service     │   │  Service         │   │  Service         │
│ • BIN lookup │   │ • Idempotency    │   │ • Suspend/resume │
│ • TSP token  │   │ • ATC check      │   │ • Lost device    │
│   request    │   │ • Route to net   │   │ • Token refresh  │
│ • SE push    │   │ • Persist + emit │   │ • Issuer push-in │
└──────┬───────┘   └────────┬─────────┘   └────────┬─────────┘
       │                    │                      │
       │           ┌────────┴──────────┐           │
       │           ▼                   ▼           │
       │   ┌───────────────┐   ┌────────────────┐  │
       └──▶│  Network      │   │  Redis/Valkey  │◀─┘
           │  Adapters     │   │ • ATC watermark│
           │  (per-network │   │ • token cache  │
           │   circuit     │   │ • idempotency  │
           │   breakers)   │   │ • sessions     │
           └───────┬───────┘   └────────────────┘
                   ▼                   │
        ┌──────────────────────┐       ▼
        │ Visa VTS │ MDES │Amex│  ┌──────────────┐   ┌───────────┐
        └──────────┬───────────┘  │  PostgreSQL  │──▶│  Kafka    │
                   ▼              │ cards, txns, │   │ audit,    │
            Issuing Banks         │ ATC, audit   │   │ notifs,   │
                                  └──────────────┘   │ fraud     │
                                                     └───────────┘
```

The structural choice worth defending: **three services split by lifecycle phase, not by entity.** Provisioning is slow, low-volume, and involves human step-up verification. Transactions are fast, high-volume, and must never block. Lifecycle is event-driven and mostly triggered from outside (issuer pushes a card reissue; a user reports a lost phone). They have completely different scaling curves and completely different failure tolerances, so they get separate deployments and separate connection pools to the networks. A single "payments service" would let a provisioning surge — the morning a new iPhone ships — starve the transaction path.

## 💾 Data Model

Described as tables rather than DDL. The most important column in this schema is the one that isn't here: there is no `pan` column, anywhere.

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), email, password_hash, role | unique on email | |
| devices | id, user_id (FK), device_type, secure_element_id (unique), status | (user_id) | `status` drives lost-device suspension |
| provisioned_cards | id, user_id, device_id, **token_ref** (unique), network, last4, card_type, expiry, status, suspended_at, suspend_reason | (user_id), (device_id), (token_ref) | One row per **card × device**. `token_ref` is an opaque handle we exchange with the TSP — not the token itself |
| merchants | id, merchant_id (unique), name, category_code, public_key | (merchant_id) | Public key encrypts in-app payment payloads |
| transactions | id, card_id, merchant_id, token_ref, amount, currency, status, auth_code, decline_reason, transaction_type, created_at | (card_id, created_at DESC), (token_ref, created_at DESC) | Monthly partitions; the read pattern is always "recent, for one card" |
| token_atc | token_ref (PK), last_atc, updated_at | — | Replay watermark. Write-through: Redis + Postgres |
| audit_logs | id, user_id (SET NULL), action, resource_type, resource_id, result, ip, request_id, metadata (JSONB) | (user_id, created_at), (action, created_at) | Survives user deletion. Metadata redacted before write |

Two schema decisions carry weight:

**`provisioned_cards` is keyed by card × device, not by card.** This is the whole per-device tokenization model expressed in a unique constraint: one physical card provisioned to an iPhone and a Watch produces two rows, two `token_ref`s, two independent lifecycles. Suspending one is a single-row update.

**`transactions` is partitioned monthly and indexed for one query.** Users look at their recent history. Nobody scans a year of transactions across all cards. Monthly partitions mean the hot partition stays in memory and the 7-year audit retention doesn't slow down today's inserts.

## 🔌 API Design

```
POST   /api/cards                      → Provision card (Idempotency-Key required)
GET    /api/cards                      → List user's cards across devices
POST   /api/cards/:id/suspend          → Suspend one token
POST   /api/cards/:id/reactivate       → Reactivate after verification
DELETE /api/cards/:id                  → Remove token from device

POST   /api/payments/pay               → Authorize NFC or in-app payment (Idempotency-Key required)
GET    /api/payments/transactions      → History (paginated, filterable by card/status)

POST   /api/devices/:id/lost           → Mass-suspend every token on a device
POST   /api/devices/:id/found          → Restore

POST   /api/merchants/:id/refund       → Refund (Idempotency-Key required)
```

Every state-changing endpoint takes an `Idempotency-Key`. That's not a stylistic choice — I'll show below why it's the single mechanism holding the correctness story together.

## 🔄 Core Flow: Provisioning a Card

Provisioning is the flow where we most visibly *choose not to hold* something. Walking it step by step:

1. **BIN lookup.** The first 6–8 digits of the PAN identify the network and the issuing bank. This tells the provisioning service which TSP to talk to and which issuer's risk policy applies. This is the only part of the PAN we ever look at, and we look at it on the device.
2. **Client-side encryption.** The device encrypts the full PAN with the *network's* public key. Our servers receive an opaque blob. If someone tapped our TLS termination, packet-captured the request, and dumped our memory, they'd have ciphertext only Visa can open.
3. **Token request to the TSP.** We forward the blob plus device attestation (a signed statement from the Secure Element proving it is genuine hardware, not an emulator) and a device fingerprint. The TSP decrypts, checks the card with the issuer, and returns a `token_ref` plus provisioning payload for the SE.
4. **Risk decision — green path or yellow path.** The issuer scores the provisioning attempt. *Green path*: high confidence (the card is already on file with this Apple ID, the device is established) → activate immediately. *Yellow path*: the issuer wants step-up verification → we return the verification options (SMS to the number on file, call the bank, verify in the issuer's app) and the token stays in `pending_activation`.
5. **Secure channel to the SE.** The provisioning payload — DPAN and key material — is pushed to the Secure Element over a channel keyed to that specific SE. It transits our servers but is not readable by them.
6. **We persist a row.** `token_ref`, `network`, `last4`, `card_type`, `expiry`, `device_id`, `status`. That row is the entirety of our knowledge about a card.

> "The yellow path is the part people forget, and it's the part that determines whether the feature ships. If we treated every provisioning attempt as green, we'd be a card-testing service: someone with a stolen PAN could add it to their own phone and start spending. The issuer's step-up is the only thing between us and that, and it's why the provisioning service must model an *asynchronous, human-in-the-loop* state machine — `pending_activation` is a real state that can sit there for a day — rather than a synchronous request/response. That's the single biggest structural difference between provisioning and payment, and it's why they're separate services."

## 🔁 Token Lifecycle

Tokens are long-lived, and things happen to them. Four events matter:

| Event | Trigger | What happens |
|-------|---------|--------------|
| **Suspend** | User reports card lost/stolen; issuer suspects fraud | Every `token_ref` for that PAN is suspended across all devices. Cache entries are **deleted**, not updated. |
| **Reactivate** | Issuer confirms the card is safe | Status returns to active. The SE never lost the key material, so no re-provisioning is needed |
| **Refresh** | Token approaches expiry | Lifecycle service requests fresh material from the TSP and pushes it to the SE — invisible to the user |
| **Lost device** | User marks a device lost from another device or the web | Suspend every token bound to `device_id`. Other devices untouched. This is one indexed UPDATE plus a cache pipeline-delete |

The direction of these events matters architecturally: **most of them originate outside our system.** The issuer decides a card is compromised. The network pushes a reissue. That means the lifecycle service is primarily an *inbound event consumer* with an idempotent handler per event type, not an API surface — and it must tolerate receiving the same "card reissued" notification three times, because networks retry.

## 🔧 Deep Dive 1: Tokenization — Designing Ourselves Out of the Blast Radius

**The decision**: The server stores only a `token_ref` — an opaque handle. The device-specific token (DPAN) and the key that signs cryptograms live in the device's Secure Element. The real PAN lives only at the network's TSP. During provisioning, the PAN is encrypted on-device with the network's public key and passes through our servers as ciphertext we cannot decrypt.

**Why this works for this problem:**

> "We are a wallet with 500 million users and a billion cards. If we held PANs, we would be the most attractive single target on the internet, and every one of our engineers, every one of our servers, and every one of our backup tapes would fall inside the PCI-DSS cardholder data environment. By holding only a reference, a full compromise of our database yields an attacker a list of `token_ref` strings, `last4` digits, and merchant names. They cannot make a payment with any of it. The `token_ref` is useless without the SE key, and the SE key cannot be exfiltrated from silicon. We didn't reduce the breach risk — we changed what a breach is worth."

**How the alternative concretely breaks:** The obvious alternative is a server-side token vault: we hold the PANs, mint our own tokens, and de-tokenize at authorization time. Set aside compliance for a moment and look at the mechanics. At 20K TPS peak, every authorization now requires a decrypt operation against an HSM. HSMs do on the order of a few thousand crypto ops/second; you're now running an HSM cluster on the critical path of every tap, and HSMs don't autoscale — they're physical appliances with lead times measured in weeks. When the lunch rush hits and the HSM queue backs up, you don't degrade gracefully; you add tens of milliseconds of queuing to every payment until the 500ms budget blows and terminals start timing out. Meanwhile the operational cost is permanent: key ceremonies, dual control, quarterly ASV scans, and an audit surface that covers every service that can reach the vault.

And there's a security argument that's stronger than the operational one: a server-side vault has a *replay* problem it cannot solve. If our token is static and we de-tokenize it, then anyone who captures the token can spend it, forever, until we revoke it. The whole value of the EMV model is that the credential presented at the terminal is *dynamic* — which requires a key on the device, which means the device, not the server, is the root of trust. Once you accept that, the server-side vault buys you nothing and costs you everything.

**Per-device tokens, not per-card tokens.** The same physical Visa on an iPhone and a Watch gets two DPANs. This is what makes lost-device handling a single UPDATE rather than a crisis: mark the device lost, suspend the two or three tokens bound to it, and the user's Watch and iPad keep working. With one shared token per card, "I left my phone in a cab" means every device the user owns stops paying, and after they find the phone they must re-provision everything. For a system whose value proposition is "you can leave your wallet at home," that failure mode is disqualifying.

**What we give up:** token count explodes — 1B tokens instead of ~300M cards — and every lifecycle event fans out. When an issuer reissues a card, the TSP must push updated token material to every device that has it. We handle that with a lifecycle service consuming network push notifications and a fan-out job per card. We also give up the ability to answer "show me all activity on this physical card" with a single index lookup; we have to join through the user's token set. That's a reporting inconvenience, and a reporting inconvenience is a very good trade for a security property.

## 🔧 Deep Dive 2: Authorize Exactly Once — Where Replay Protection and Idempotency Collide

This is the subtlest part of the system, and it's where I've seen designs quietly break.

We have **two** mechanisms that both look like duplicate suppression, and they are *not* the same thing:

| Mechanism | Defends against | Signal |
|-----------|-----------------|--------|
| **ATC watermark** | A *malicious* replay: an attacker captured a token + cryptogram off the air and resubmits it | Application Transaction Counter must be **strictly greater** than the last one we saw for this token |
| **Idempotency key** | A *benign* retry: the terminal's network dropped our approval response and it re-sent the identical request | Same key → return the identical cached response |

Here's the trap. A benign retry from a terminal carries **the same ATC** — the Secure Element generated one cryptogram for one tap; the terminal is re-sending that same payload. If your transaction service checks the ATC first, the retry looks exactly like a replay attack: ATC ≤ watermark, reject. The user's payment was actually approved, the terminal never learned that, and now it's showing "declined" while the issuer has an authorization hold on the card. You've produced the worst outcome in payments: a transaction that is approved on one side and declined on the other, requiring a reconciliation job and a support call.

**So the ordering is load-bearing:**

1. **Idempotency check first.** Look up `Idempotency-Key` in Redis. If we have a completed result, return it verbatim, byte-for-byte, without touching the ATC, the network, or the database. A retry must be *invisible* to the rest of the system.
2. If the key is present but marked in-progress, return 409 — a concurrent duplicate is in flight and we won't race it.
3. Otherwise, acquire the key with SET NX and a 60s TTL, then validate the ATC: strictly greater than the watermark, or reject as `ATC_REPLAY`.
4. Validate the cryptogram with the network TSP; route to the issuer.
5. Persist the transaction, advance the ATC watermark, cache the result under the idempotency key for 24 hours.
6. On failure, delete the in-progress key so a retry can proceed.

> "The 60-second lock TTL versus the 24-hour result TTL is deliberate. The lock is short because a process that crashes mid-payment must not block the terminal's retry forever — after a minute, whatever we were doing is dead and the retry should get a fresh attempt. The result cache is long because a merchant's batch reconciliation can re-query hours later and must get the same answer it got at the register. Those are different questions with different time horizons, so they get different keys and different TTLs."

**Why ATC gaps must be allowed.** The Secure Element increments its counter on every cryptogram it generates — including taps that never reached us (the terminal was offline, the user pulled the phone away too fast). So we can see ATC jump from 41 to 47. We accept that. We enforce *monotonicity*, not *contiguity*. Enforcing contiguity would decline a legitimate payment every time a user's tap failed to register, which is a far more common event than a replay attack.

**The in-doubt case.** The nastiest failure isn't a duplicate — it's uncertainty. We send the authorization to the issuer and the connection dies before the response arrives. Did the issuer approve? We don't know. Two rules:

- We **never** silently retry an authorization we're unsure about — that's how you double-charge. We mark the transaction `in_doubt` and return a decline to the terminal (fail closed).
- A reconciliation worker reads the issuer's settlement file the next cycle. If the issuer approved something we declined, we send an automatic reversal. Fail-closed at the register plus asynchronous repair is strictly better than fail-open plus a customer dispute, because the customer's worst experience is "tap again," not "you charged me twice."

## 🔀 NFC vs In-App: Two Payments, One Pipeline

It's tempting to build two payment services. I wouldn't. They differ at the edges and are identical in the middle, so they share the core and differ only in the adapter that produces the authorization request.

| | NFC (tap) | In-app / web |
|---|---|---|
| Who initiates | Terminal, over the air | Merchant's app or JS SDK |
| Transport of the credential | EMV payload over NFC → terminal → acquirer → network | Payment token encrypted with the **merchant's** public key, POSTed to the merchant's server |
| Who sees the token first | The acquirer | The merchant |
| Unpredictable number | Supplied by the terminal | Supplied by the merchant session |
| ATC | Incremented by the SE | Incremented by the SE — identical |
| Cryptogram | Same SE, same key, same algorithm | Same |
| Our server's job | Idempotency → ATC → TSP validate → issuer route → persist | Identical |

The shared core is the important part. Both paths converge on the same five steps, so the idempotency semantics, the ATC watermark, the circuit breakers, and the transaction table are all shared. Splitting them into separate services would duplicate the hardest logic in the system — the exactly-once ordering from Deep Dive 2 — in two places, and the two copies would drift.

The one genuine divergence is **who the merchant trusts**. In-app, the merchant decrypts the payment token with their own private key, so the merchant's key management becomes part of our threat model: we store their public key, we rotate it, and a merchant with a leaked private key can read tokens sent to them (though still not spend them, because the cryptogram is bound to *their* merchant ID and *that* session's amount). NFC has no such surface — the merchant never holds a key.

## 🔧 Deep Dive 3: The 500ms Budget and Why Circuit Breakers Are Per-Network

The "< 500ms NFC payment" requirement is meaningless until you decompose it, because our servers own only a slice.

| Segment | Budget | Who owns it |
|---------|--------|-------------|
| SE cryptogram generation | ~50ms | Device (mitigated: pre-generate the next cryptogram before the tap) |
| NFC exchange, device ↔ terminal | ~100ms | Radio protocol; fixed |
| Terminal → acquirer → network | ~80ms | Not ours |
| **Our leg: token lookup + idempotency + ATC + routing** | **~40ms** | **Us** |
| TSP cryptogram validation | ~20ms | Network |
| Issuer authorization decision | ~150ms | Bank |
| Response path back | ~60ms | Shared |

Our 40ms is the whole reason for the caching architecture. A token lookup and an ATC read against PostgreSQL is two round-trips plus contention with 20K TPS of inserts; against Redis it's sub-millisecond. So:

- **Active tokens: cache-aside, 5-minute TTL.** Hot tokens (the card you use daily) stay warm.
- **Suspended tokens: never cached.** This is the one caching rule I'd write on the wall. If a suspended token could be served from cache with `status: active`, a stolen device gets a 5-minute window to spend. Suspension writes therefore *delete* the cache entry rather than update it, and the read path treats a cache miss for a token as a mandatory database read, not a fallback.
- **ATC watermarks: write-through, no TTL.** Redis is the read path; PostgreSQL is the durability path; both are written on every transaction.

> "Write-through for the ATC is the one place I'll pay a synchronous database write on the hot path, and it's worth spelling out why cache-aside fails here. Under cache-aside, the ATC lives in Redis and lazily loads from Postgres. Now Redis restarts, or evicts a cold key under memory pressure. The watermark for that token is gone. On the next payment we miss, load from Postgres — and if Postgres was only being written lazily, the value we load is stale by however many transactions Redis absorbed. A stale watermark is not a cache miss; it's an *open replay window*. Someone with a captured cryptogram whose ATC falls inside that window can spend it. Losing a cached price costs a database read. Losing a cached ATC costs a fraudulent transaction. Those are not the same failure, so they don't get the same caching strategy."

**Circuit breakers, one per network.** Each network adapter (Visa, Mastercard, Amex) is wrapped in its own breaker: 10s timeout, opens at a 50% error rate, 30s before half-open probing.

The alternative — a single shared breaker across all network calls, or worse, none — fails in a specific and ugly way. Suppose Visa's TSP degrades and starts taking 10 seconds instead of 20 milliseconds. Visa is roughly half our volume, so at 20K TPS that's 10K requests/second each holding a connection and an event-loop continuation for 10 seconds: 100,000 in-flight requests. The connection pool exhausts, the event loop's pending-callback queue grows without bound, memory climbs, and Node starts GC-thrashing. Now Mastercard and Amex payments — whose networks are perfectly healthy — begin timing out too, because there is no capacity left to serve them. A shared breaker eventually opens, but it opens on *everything*, so a Visa outage takes down Amex by design instead of by accident.

Per-network breakers bound the blast radius to the sick network. When Visa's breaker opens, Visa taps get an immediate graceful decline (`responseCode: "CB"`) in under a millisecond, and Mastercard traffic never notices. The cost is that we do decline real Visa payments during the outage — but declining fast is a far better outcome than declining slowly, because a fast decline lets the customer pull out a physical card while a slow one leaves them staring at a spinner at the front of the line.

## 🛠️ Failure Handling: The Decision Table

Every dependency can fail. What matters is that we've decided *in advance* what each failure means, because at 20K TPS you don't get to think about it live.

| Dependency down | Behavior | Why |
|-----------------|----------|-----|
| **Redis** | Payments continue; token lookup and ATC read fall back to PostgreSQL | Redis is a latency optimization, not a correctness dependency. We blow the 40ms budget and eat the p99 regression rather than declining every payment in the world |
| **Redis (idempotency specifically)** | Fail **closed** on the idempotency check — reject with 503 | This is the one place we don't fail open. Without the idempotency store we cannot distinguish a retry from a new tap, and "approve it and hope" is how you double-charge |
| **PostgreSQL primary** | Payments decline; readiness probe fails; instance pulled from the LB | We cannot record a transaction we cannot persist. An authorization we can't prove happened is worse than a decline |
| **One network TSP** | That network's breaker opens; graceful decline in <1ms for that network only | Blast radius bounded (see Deep Dive 3) |
| **Issuer link** | Timeout → mark `in_doubt`, decline, reconcile from the settlement file | Fail closed, repair asynchronously |
| **Kafka (audit/notifications)** | Payments unaffected; events buffer locally and drain on recovery | Audit is a compliance obligation, not a payment precondition. It must be *eventually* complete, not *synchronously* complete |

The through-line: **the payment path fails closed, the observability path fails open.** A wallet that declines is embarrassing. A wallet that double-charges is a lawsuit, and a wallet that can't prove what it did is a regulatory finding.

## 🛡️ Security and Compliance

- **PAN never touches us in plaintext.** Encrypted with the network's public key on the device; forwarded as opaque ciphertext.
- **Redaction at the logger, not at the call site.** The structured logger has a redaction layer that strips PAN-shaped and CVV-shaped fields from any object it serializes. Relying on developers to remember not to log a request body is a control that fails on the first busy Friday.
- **Audit log is append-only and outlives its subjects.** `user_id` is `ON DELETE SET NULL`, so a GDPR deletion request removes the user without destroying the compliance record of what was done.
- **Rate limiting is a fraud control, not just a capacity control.** An attacker with a list of stolen card numbers tests them with small payments. Per-user and per-device limits on `POST /api/payments/pay` and `POST /api/cards` cap that to a handful of attempts. Login is limited per IP against credential stuffing.
- **Device attestation is part of provisioning, not an afterthought.** The Secure Element signs a statement proving it is genuine Apple silicon. Without it, an emulator could request tokens for stolen PANs at machine speed. Attestation is what makes the yellow-path risk model tractable — the issuer is scoring a real device, not an unknown client.
- **Biometric authorization is a device-side gate with a server-side receipt.** The Face ID / Touch ID match happens entirely in the Secure Enclave; our server never sees biometric data. What we see is a short-lived, single-use authorization session (5-minute TTL) that the payment request must present. This matters for a reason people miss: the session must be scoped to *one* payment. A long-lived "the user is biometrically authenticated" flag would mean one Face ID scan authorizes an unbounded number of charges.
- **Pre-generated cryptograms are a security/latency trade we make deliberately.** The SE prepares the *next* cryptogram before the user taps, so the 50ms of hardware crypto is off the critical path. The cost is a small window in which a valid unused cryptogram exists in the SE — bounded, because it is still bound to the ATC and useless without a terminal supplying a matching amount and unpredictable number.
- **Consistency levels are explicit** — see the table below. Provisioning and authorization are serializable; history reads are eventual.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| `payment_duration_seconds` histogram, by network | The SLO. Regression is visible at the register within seconds |
| `payment_transactions_total{status, type, network}` | Approval rate. A drop on one network is the earliest signal of a TSP problem |
| `circuit_breaker_state` gauge, per network | 0/1/2 — the single most actionable alert in the system |
| ATC rejection counter | A spike means either a replay attack or, far more likely, a bug in our ordering logic |
| `in_doubt` transaction count | Should be near zero. Nonzero means the reconciliation worker has work — and if it climbs, an issuer link is flapping |
| Idempotency replay rate | High replay rate means terminals are retrying, which means *something upstream* is slow. It's a leading indicator of the latency SLO breaking |

Every log line carries a `request_id` that correlates the biometric session, token lookup, ATC check, network call, and issuer response into one traceable payment.

The SLOs I'd hold the team to:

| SLI | Target | Page when |
|-----|--------|-----------|
| Tap-to-approval p99 | < 500ms | > 500ms sustained 2 min |
| Our-leg p99 (the 40ms we own) | < 40ms | > 60ms sustained 5 min |
| Approval rate, per network | > 95% | < 90% for 5 min on any one network |
| Payment API availability | 99.99% | < 99.9% for 5 min |
| `in_doubt` transactions | ≈ 0 | Any sustained nonzero rate |

The one I'd watch hardest is **approval rate broken out by network**, because it's the metric that catches the failures our own instrumentation can't see. Our latency can be perfect while Visa silently starts declining everything — from our servers' point of view, the system is healthy and fast; from the customer's point of view at the register, it is completely broken. Approval rate is the only signal that lives on the user's side of the boundary.

## 🧭 Consistency Model

Not everything needs the same guarantee, and pretending it does is how you build a system that's slow *and* wrong.

| Operation | Level | Why |
|-----------|-------|-----|
| Card provisioning | Serializable | Two concurrent "add this card" requests must not mint two tokens for the same card on the same device |
| Payment authorization | Serializable (on the ATC + transaction write) | The exactly-once guarantee lives here |
| Token status change (suspend) | Strong, with synchronous cache invalidation | A suspension that hasn't propagated is a spendable window |
| Transaction history | Eventual, read-your-writes | You must see the payment you just made. You need not see it within 5ms |
| Audit log | Eventual, but **complete** | Latency doesn't matter; loss does. Kafka with at-least-once delivery and a dedup key on the consumer |

## 📈 Scalability: What Breaks First

1. **Transaction + audit writes to PostgreSQL.** Matching payments to issuers is I/O-bound on external networks, but every payment lands two rows. At 20K TPS that's 40K inserts/second, which a single Postgres primary cannot absorb. Fix, in order: (a) move audit writes off the hot path onto Kafka with a consumer batching inserts — the payment must not wait for its own audit row; (b) partition `transactions` monthly; (c) shard by `token_ref` hash across 16 shards. Sharding by `token_ref` rather than `user_id` is deliberate: it's the key present on the payment request (we haven't looked up the user yet), so the router can pick a shard without a lookup. The cost is that "all of a user's transactions" becomes a scatter-gather across shards — acceptable, because that's a history page with a 200ms budget, not a payment with a 40ms one.

2. **The ATC watermark write.** It's a read-modify-write per transaction on a single key. It doesn't hot-spot — 1B tokens means near-perfect key distribution — but it does mean the write-through Postgres update is on the critical path. If that becomes the bottleneck, the escape hatch is to make the ATC durable via an append-only Kafka topic (the watermark is a fold over the log) rather than a synchronous row update, accepting a small window of recovery replay after a Redis loss.

3. **Network adapter connection pools.** Each TSP link has a finite concurrency. We size pools per network, per region, and we bulkhead them — provisioning and transaction services get *separate* pools to the same network, so an iPhone-launch-day provisioning surge cannot consume the connections that payments need.

4. **Audit log volume.** 500M rows/day × 7 years is the largest table in the system by an order of magnitude and it's never read in the hot path. It moves to a cheap columnar store with monthly partitions and lifecycle-tiered storage; Postgres keeps only the trailing 90 days.

5. **Lifecycle fan-out.** This one is easy to miss because it's low-volume until it isn't. When a large issuer reissues a BIN range — a breach at a retailer, say — that's tens of millions of cards, each fanning out to every device that holds it. A naive implementation does this synchronously in a loop and takes down the TSP link. It needs to be a rate-limited, resumable batch job with a per-network concurrency budget, and it must be able to run for hours without blocking normal traffic.

Everything else scales horizontally: API and service instances are stateless, Redis clusters by key hash, and read replicas absorb history queries.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Credential storage | ✅ `token_ref` only; keys in the SE | ❌ Server-side PAN vault | Breach yields nothing spendable; no HSM on the hot path |
| Token scope | ✅ Per device × card | ❌ One token per card | Lost-device suspension is one UPDATE, not a re-provisioning event |
| Duplicate suppression | ✅ Idempotency key checked **before** ATC | ❌ ATC check first | A benign retry carries the same ATC and would be misread as an attack |
| ATC storage | ✅ Write-through Redis + Postgres | ❌ Cache-aside | A lost watermark is an open replay window, not a cache miss |
| Suspended tokens | ✅ Never cached | ❌ Cached with short TTL | A cached "active" on a stolen device is a spendable window |
| Network resilience | ✅ Per-network circuit breaker + bulkheaded pools | ❌ Shared breaker | A Visa outage must not exhaust the pool that serves Amex |
| In-doubt authorizations | ✅ Fail closed + async reversal | ❌ Retry on timeout | "Tap again" beats "we charged you twice" |
| Store | ✅ PostgreSQL, serializable on the payment path | ❌ Cassandra/DynamoDB | Duplicate-token and double-auth prevention need real transactions; 20K TPS is well within reach when sharded |
| Audit writes | ✅ Async via Kafka | ❌ Synchronous insert | Compliance logging must not spend the payment's latency budget |

## 🚀 Closing: What I'd Build Next

Three things, in priority order:

**Real-time fraud scoring** in the authorization path — a model consuming the Kafka transaction stream that scores velocity, geography, and merchant-category anomalies and feeds a risk signal to the issuer. The hard part isn't the model; it's the 40ms budget. A synchronous model call doesn't fit. The realistic design scores *asynchronously* and enforces at the *next* transaction, which means accepting that the first fraudulent charge gets through and the second doesn't. That's an uncomfortable trade-off and I'd want to say it out loud rather than pretend the model is free.

**Multi-region active-active.** This is genuinely hard here, and the reason is the ATC watermark: it's a strongly-consistent, monotonic counter, and a globally-replicated strongly-consistent counter is exactly the thing distributed systems are bad at. The honest design is to *not* replicate it — pin each token to a home region, route by a region hint encoded in the token, and accept that a regional failover means a brief window where that region's tokens fall back to a slower, quorum-read path. Pretending you can have a globally consistent counter at 20K TPS across continents is how you end up with a system that is slow everywhere to protect against a failure that happens once a year.

**Stand-in processing.** When an issuer link is down, the network can authorize on the bank's behalf within pre-agreed risk limits (amount ceilings, merchant categories, velocity). This is a policy engine plus a settlement-reconciliation problem, and it's the difference between a payment system that degrades and one that stops. It's also where the "fail closed" rule I defended earlier gets renegotiated — under stand-in, we deliberately approve without certainty, because the issuer has pre-authorized us to take that risk on their behalf. Knowing *when* the fail-closed rule is allowed to bend, and having the counterparty agree to it in writing, is what separates a payments architecture from a payments demo.
