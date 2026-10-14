# 🔔 Notification System — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Sending a push notification is one HTTP call to Apple. What makes this a design problem is everything around that call: deciding whether to send at all — preferences, quiet hours in the user's own time zone, duplicates, rate limits — keeping a million-message campaign from delaying one password-reset email, and making retries safe when a provider can accept a message and our acknowledgement can still get lost. So I'll design for two promises: an accepted notification is never lost, and a retry never sends it twice."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the 17K/s campaign peak |
| High-level architecture | 10 min | One overview and three flows: accept, deliver, fail |
| Data model & API | 7 min | What lives where, and the contract callers depend on |
| Deep dive 1: never lose, never duplicate | 8 min | Transactional outbox plus an idempotent, leased claim |
| Deep dive 2: priority and provider limits | 7 min | Queue isolation, retries with a budget, breakers |
| Deep dive 3: whether and when to send | 5 min | Preferences, quiet hours, dedup, digests |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down who calls us and what they expect back, because a notification service is a platform: dozens of product teams will depend on its contract."

### Functional requirements

1. **Accept** a notification from an internal service: recipient, template and data (or raw content), channels to try, a priority — `critical`, `high`, `normal`, `low` — and optionally a time to send.
2. **Decide** per channel: respect channel and category opt-outs, defer non-critical messages past the user's quiet hours, drop duplicates, and enforce per-user and per-provider rate limits.
3. **Deliver** over push (APNs, FCM), email and SMS, with retries, provider failover and a dead-letter queue.
4. **Track** status per channel — queued, sent, delivered, bounced, failed — including the provider's delivery receipts; let callers cancel anything that hasn't started.
5. **Campaigns**: operators send one template to millions of users.

Out of scope: building our own push or SMS transport, content A/B testing, ML send-time optimization. I'll mention the in-app inbox and digests where they change the design.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Accept latency | p99 < 100 ms | Callers send from request paths: "order placed", "login from new device" |
| Durability | A `202 Accepted` notification is never lost | A missing password reset is a support ticket |
| Duplicates | At most one provider call per (notification, channel), outside a narrow crash window | Two identical pushes erode trust; two SMS cost money |
| Critical latency | Accepted → provider, p99 < 2 s, even during a campaign | One-time codes expire in minutes |
| Normal and bulk latency | p99 < 30 s; campaigns are throughput-bound | Nobody times a marketing email |
| Opt-out freshness | Applied to the next send within 5 s | And legally binding for unsubscribe links |
| Isolation | One provider's outage never blocks another channel | SMS trouble must not stop push |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Notifications | 500M/day → ~5,800/s average; campaign peaks of 1M/min ≈ 17K/s | Stateless accept tier; sharded writes |
| Deliveries | ~1.5 channels each → 750M/day, ~25K/s peak | Worker pools per channel |
| Mix | ~70% push, ~25% email, ~5% SMS | SMS is the cost center: 25M/day × ~$0.008 ≈ $200K/day |
| Preference reads | One per notification → 17K/s peak | Must be a cache hit, not a database read |
| Storage | Notifications ~250 GB/day, deliveries ~150 GB/day; 30 days ≈ 12 TB | Shard by recipient; age history out to object storage |
| Provider ceilings | SMS short code ~100 msg/s; email by IP reputation | Per-provider token buckets, not just per-user limits |

"Two numbers shape everything. 17,000 campaign messages a second means a single queue would put a password reset a minute behind the campaign. And 17,000 preference reads a second means preferences live in Redis."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system first, then walk the three journeys that matter: accepting a notification, delivering it, and hearing back from the provider."

```
  ┌─────────────────────────────┐                         ┌────────────────────────────┐
  │ Product services            │                         │ Admin console              │
  │ auth · orders · social      │                         │ campaigns · templates      │
  └──────────────┬──────────────┘                         └─────────────┬──────────────┘
                 │ (1) POST /v1/notifications                           │ start campaign
                 ▼                                                      ▼
  ┌──────────────┴──────────────────────────────────────────────────────┴──────────────┐
  │ API gateway · service auth · per-caller quotas · TLS                               │
  └──────────────┬─────────────────────────────────────────────────────────────────────┘
                 ▼
  ┌─────────────────────────────┐                         ┌────────────────────────────┐
  │ Notification API            │  GET prefs, SET NX,     │ Redis                      │
  │ prefs · quiet hours · dedup │────────────────────────▶│ prefs cache · idempotency  │
  │ rate limits · render        │  rate-limit script      │ dedup keys · rate counters │
  └──────────────┬──────────────┘                         └────────────────────────────┘
                 │ 1 tx: notification + deliveries + outbox
                 ▼
  ┌─────────────────────────────┐  (2) SELECT due rows    ┌────────────────────────────┐
  │ PostgreSQL · by recipient   │◀────────────────────────│ Outbox relay               │
  │ notifications · deliveries  │  FOR UPDATE SKIP LOCKED │ due rows, critical first   │
  │ outbox · preferences        │                         └─────────────┬──────────────┘
  └─────────────────────────────┘                                       │ publish + confirm
          ▲             ▲                                               ▼
          │             │                                 ┌────────────────────────────┐
          │ delivered,  │                                 │ RabbitMQ                   │
          │ bounced     │                                 │ 12 queues + dead-letter    │
          │             │                                 └─────────────┬──────────────┘
          │             │                                               │ consume
          │             │ claim · mark sent                             ▼
          │             │ retry via outbox                ┌────────────────────────────┐
          │             └─────────────────────────────────┤ Channel workers            │
          │                                               │ push · email · sms pools   │
          │                                               └─────────────┬──────────────┘
          │                                                             │ send
          │                                                             ▼
  ┌───────┴─────────────────────┐  (3) POST /webhooks/ses ┌────────────────────────────┐
  │ Webhook receiver            │◀────────────────────────┤ APNs · FCM · SES · Twilio  │
  │ verify · dedupe · advance   │                         │ external providers         │
  └─────────────────────────────┘                         └────────────────────────────┘
```

1. **Accept (1).** A product service posts a notification with an `Idempotency-Key`. The Notification API checks preferences in Redis, pushes non-critical sends past quiet hours, claims dedup and rate-limit budget, renders the template, and commits the notification, one delivery row per channel and one outbox row per channel in one PostgreSQL transaction. It returns `202` — nothing has touched RabbitMQ yet.
2. **Deliver (2).** The outbox relay selects due rows, critical first, publishes each to its `{channel}.{priority}` queue and marks it published once RabbitMQ confirms. A channel worker claims the delivery row, calls the provider, records the result and acks.
3. **Receipts (3).** Providers call our webhook receiver with delivered, bounced or unregistered-token events; it verifies the signature, drops events it has seen, and moves the delivery row forward.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, service auth, per-caller quotas | Requests | Stops one noisy caller at the door |
| Notification API | Decide and commit; never publishes | Accept rate | Stateless |
| Redis Cluster | Preference cache, idempotency, dedup, rate counters | Users | Losing it slows accepts; never loses data |
| PostgreSQL | Notifications, deliveries, outbox, preferences | Recipients | Sharded by `user_id` |
| Outbox relay | Due rows → queues, with confirms | Accept rate | One per shard, `SKIP LOCKED` |
| RabbitMQ | 12 queues + dead-letter queue | Deliveries | Quorum queues |
| Channel workers | Claim, send, record | Deliveries per channel | Separate pools, breakers, token buckets |
| Webhook receiver | Receipts → status, suppression lists | Receipts | Idempotent by event ID |

"Why doesn't the API publish to RabbitMQ itself? Because then accepting a notification is two writes to two systems, and every crash between them is either a lost notification or a message pointing at nothing. I'll come back to that in the first deep dive — it's the core of the design."

### Flow 1: accepting a notification

```
Caller                       Notification API                           Redis   PostgreSQL
   │                                 │                                    │          │
   │ 1 POST, Idempotency-Key K       │                                    │          │
   │────────────────────────────────▶│                                    │          │
   │                                 │ 2 SET idem:{caller}:K NX EX 60     │          │
   │                                 │───────────────────────────────────▶│          │
   │                                 │ 3 GET prefs:{user}                 │          │
   │                                 │───────────────────────────────────▶│          │
   │                                 │ 4 deliver_at after quiet hours     │          │
   │                                 │ 5 dedup SET NX; rate-limit script  │          │
   │                                 │───────────────────────────────────▶│          │
   │                                 │ 6 1 tx: notification, deliveries, outbox      │
   │                                 │──────────────────────────────────────────────▶│
   │                                 │ 7 store 202 under K (24 h)         │          │
   │                                 │───────────────────────────────────▶│          │
   │ 8 202 {id, queued | scheduled}  │                                    │          │
   │◀────────────────────────────────│                                    │          │
   │                                 │                                    │          │
```

"Steps 2 through 5 are all Redis and all cheap. Step 6 is the commitment point: the notification, its delivery rows and its outbox rows commit together, so they exist together or not at all. Only after that do I store the `202` under the idempotency key, so a caller who retries gets the same notification ID back instead of a second notification."

### Flow 2: relaying and delivering

```
Outbox relay                   PostgreSQL   RabbitMQ         Email worker                Provider
      │                             │           │                  │                         │
      │ 1 SELECT due … SKIP LOCKED  │           │                  │                         │
      │────────────────────────────▶│           │                  │                         │
      │ 2 publish to email.high                 │                  │                         │
      │────────────────────────────────────────▶│                  │                         │
      │ 3 publisher confirm                     │                  │                         │
      │◀────────────────────────────────────────│                  │                         │
      │ 4 SET published_at; COMMIT  │           │                  │                         │
      │────────────────────────────▶│           │                  │                         │
      │                             │           │ 5 {id, channel}  │                         │
      │                             │           │─────────────────▶│                         │
      │                             │ 6 claim: pending → sending   │                         │
      │                             │◀─────────────────────────────│                         │
      │                             │           │                  │ 7 send, key = id:email  │
      │                             │           │                  │────────────────────────▶│
      │                             │           │                  │ 8 202 accepted          │
      │                             │           │                  │◀────────────────────────│
      │                             │ 9 mark sent (fenced)         │                         │
      │                             │◀─────────────────────────────│                         │
      │                             │           │ 10 ack           │                         │
      │                             │           │◀─────────────────│                         │
      │                             │           │                  │                         │
```

"The relay holds row locks with `FOR UPDATE SKIP LOCKED`, so I can run several relays per shard and they never publish the same row in the same pass. If a relay crashes mid-batch, the batch rolls back and gets published again — which is fine, because step 6 is a claim, not a read. A worker only calls the provider if it moved the row from `pending` to `sending` itself."

### Flow 3: a provider that keeps failing

```
RabbitMQ                    Email worker         Provider           PostgreSQL   Outbox relay
    │                             │                  │                   │             │
    │ 1 message (attempt 2 of 5)  │                  │                   │             │
    │────────────────────────────▶│                  │                   │             │
    │                             │ 2 claim, attempts = 2                │             │
    │                             │─────────────────────────────────────▶│             │
    │                             │ 3 send           │                   │             │
    │                             │─────────────────▶│                   │             │
    │                             │ 4 503 / timeout  │                   │             │
    │                             │◀─────────────────│                   │             │
    │                             │ 5 retrying + outbox row due in 10 s  │             │
    │                             │─────────────────────────────────────▶│             │
    │ 6 ack                       │                  │                   │             │
    │◀────────────────────────────│                  │                   │             │
    ··································· 10 s later ·····································
    │ 7 republish (attempt 3)                                                          │
    │◀─────────────────────────────────────────────────────────────────────────────────│
    ······························ attempt 5 also fails ································
    │                             │ 8 failed, exhausted                  │             │
    │                             │─────────────────────────────────────▶│             │
    │ 9 nack → dead-letter queue  │                  │                   │             │
    │◀────────────────────────────│                  │                   │             │
    │                             │                  │                   │             │
```

"A failed attempt doesn't sleep in the worker and doesn't `nack` back onto the queue. It becomes a new outbox row due ten seconds later, written in the same transaction that marks the delivery `retrying`. Only when the retry budget is spent does the message go to the dead-letter queue — not a copy per failed attempt."

---

## 💾 Data Model (4 min)

"PostgreSQL holds anything that must be correct, sharded by recipient so one notification's rows live together. Redis holds copies and short-lived keys."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `notifications` | `id`, `user_id`, `category`, `template_id` + version, `content` (rendered), `priority`, `status`, `deliver_at`, `dedupe_key` | `(user_id, created_at DESC, id)` for history; unique `(user_id, dedupe_key)` |
| PostgreSQL | `deliveries` | (`notification_id`, `channel`) PK, `status`, `attempts`, `lease_expires_at`, `provider_message_id` | The state machine; `attempts` doubles as the fencing token |
| PostgreSQL | `delivery_outbox` | `id`, `notification_id`, `channel`, `priority`, `available_at`, `published_at` | Partial index on unpublished rows by `(priority, available_at)`; deleted after a day |
| PostgreSQL | `preferences` | `user_id`, channel and category toggles, quiet start/end in local minutes, IANA `time_zone`, `version` | Read through the Redis cache |
| PostgreSQL | `provider_events` | (`provider`, `event_id`) PK, message ID, type | Makes webhook handling idempotent |
| PostgreSQL | `device_tokens`, `templates`, `suppression_list` | Token per device; versioned templates per channel and locale | Unregistered tokens and hard bounces feed suppression |
| Redis | `prefs:{user}` | Serialized preferences | 5-minute TTL, deleted on every preference write |
| Redis | `idempotency:{caller}:{key}` | State, body fingerprint, stored response | 60 s while processing, 24 h once completed |
| Redis | `dedup:{user}:{hash}`, `ratelimit:…` | Claims and counters | Windowed TTLs |

"Why shard by recipient rather than by notification ID? Because the accept transaction touches the notification, its deliveries and its outbox rows — keyed by user, they're on one shard, and the transaction stays local. History and the in-app inbox are also per-user queries. The price is that a celebrity-sized fan-out lands on many shards — which is exactly what I want for campaigns."

---

## 🔌 API Design (3 min)

```
POST   /v1/notifications                 Idempotency-Key → 202 {id, status, deliver_at} | 409 | 422 | 429
GET    /v1/notifications/{id}            status with per-channel deliveries
DELETE /v1/notifications/{id}            cancel what hasn't started → 200 | 409 already sending
GET    /v1/me/notifications?cursor=…     inbox and history, keyset pagination
GET    /v1/me/preferences                preferences + version
PATCH  /v1/me/preferences                If-Match: version → 200 | 412
POST   /v1/campaigns/{id}/start          operator; starts a resumable fan-out job → 202
POST   /v1/webhooks/{provider}           signed receipts → 200, idempotent by event ID
```

- **`202 Accepted`, not `201`.** The notification exists, but delivery is asynchronous. The body says `queued` or `scheduled` with `deliver_at` — or why nothing will happen: `suppressed` (opted out) or `deduplicated`.
- **Idempotency-Key semantics:** same key and body → the stored `202`; same key while the first request runs → `409` with `Retry-After: 1`; same key, different body → `422`. Keys are scoped per caller.
- **`429` with `Retry-After`** when a per-user limit would be exceeded; all channels are admitted together or not at all.
- **Errors** as `application/problem+json`; a user token may only target its own user.

---

## 🔧 Deep Dive 1: Never Lose, Never Double-Send (8 min)

"This is the heart of it. There are two independent failure windows, and each needs its own mechanism."

### Window one: between the database and the queue

The naive accept path is "insert the notification, then publish to RabbitMQ". If the process dies between the two, or the broker is briefly unavailable, the notification is in the database marked `pending` and nothing will ever send it. Flip the order and you get a message for a notification whose insert rolled back. Retrying the publish in memory doesn't help — the memory dies with the process.

**The transactional outbox** makes it one write. The accept transaction inserts an outbox row per channel next to the notification. A relay reads unpublished, due rows, publishes them with publisher confirms, and marks them published. The broker being down now means "delivery is late", never "notification is lost" — and the API no longer depends on RabbitMQ at all.

| Approach | Verdict |
|----------|---------|
| ✅ Transactional outbox + relay | Atomic with the notification; durable; doubles as the scheduler via `available_at` |
| ❌ Insert, then publish | Lost notifications on crash or broker outage; API availability tied to the broker |
| ❌ Publish, then insert | Messages for notifications that never committed |
| ❌ Change-data capture (Debezium) | Same guarantee, but a Kafka Connect cluster to run; worth it only if many services need the stream |

"What I give up: one extra row per delivery, a relay to operate, and up to one polling interval of latency. For critical messages I wake the relay with `LISTEN/NOTIFY` on commit, so the 2-second target holds."

### Window two: between the provider and our acknowledgement

A worker calls APNs, APNs accepts, and the worker dies before acking. RabbitMQ redelivers, and a naive worker sends again. Exactly-once isn't available here — no transaction spans RabbitMQ, PostgreSQL and Apple. So I accept at-least-once delivery and make the consumer idempotent.

**The claim.** Before calling a provider, the worker runs one conditional update: move this (notification, channel) row from `pending` or `retrying` to `sending`, increment `attempts`, and set a 60-second lease. If no row qualifies — already sent, cancelled, or held by a live lease — the message is a duplicate and is acked without sending. That one statement handles redeliveries, relay replays and duplicated retries alike.

**The lease and the fence.** If the worker dies, the lease expires and a sweeper re-enqueues the delivery. But what if the "dead" worker was only paused — a long GC, a network partition — and wakes up to write `failed` over the new worker's `sent`? The final write includes `WHERE attempts = <my claim>`; the takeover incremented `attempts`, so the stale write matches nothing. The attempt counter is a fencing token.

**The remaining window** is a worker dying after the provider accepted and before recording `sent`. I narrow it with provider-side keys: email APIs accept an idempotency key, APNs collapses pushes with the same `apns-collapse-id`, FCM uses `collapse_key`. I pass `{notification_id}:{channel}` everywhere it's supported.

| Approach | Verdict |
|----------|---------|
| ✅ Leased claim + fencing + provider keys | Duplicates only in a crash-mid-send window, and mostly collapsed by the provider |
| ❌ Check-then-send ("if not sent, send") | Two workers both see "not sent" and both send |
| ❌ Redis `SETNX` per message ID | Works until the key expires or Redis fails over; the state belongs with the delivery row |
| ❌ Distributed transaction | No provider participates in 2PC |

"The trade-off is explicit: I'd rather send a rare duplicate push than drop a password reset. I'd say that to the product team in those words."

---

## 🔧 Deep Dive 2: Priority Isolation and Provider Limits (7 min)

"The scenario: marketing starts a campaign to 20 million users at 9:00. At 9:01 someone requests a password reset. That email has to arrive in seconds."

**Separate queues, not a priority field.** With one queue per channel, the reset email sits behind 20 million campaign messages no matter what its priority field says. RabbitMQ's `x-max-priority` only reorders what's still waiting, and prefetched campaign messages are already in the consumer's buffer. So I use one queue per channel and priority — 12 queues — with dedicated consumers for each. Critical consumers are idle most of the time, which is the point: they're capacity reserved for the moment it matters. Prefetch is larger on critical queues and smaller for SMS, which carriers throttle hardest.

**The relay respects priority too.** If the outbox holds a million campaign rows, the relay must not publish them before the reset email. Its query orders by `(priority, available_at)`, so critical rows always go first.

**Campaigns are a job, not a request.** A campaign start enqueues a fan-out job that pages through the audience by user ID, accepting notifications at `low` priority in batches of 1,000 and checkpointing its cursor. Each recipient gets a `dedupe_key` of `campaign:{id}:{user}` with a unique index, so a resumed job can't notify anyone twice.

**Provider limits are token buckets at the worker.** Per-user limits protect users; they don't protect providers. An SMS short code does about 100 messages a second; exceeding it gets us throttled or blocked. Each channel worker takes a token from a Redis token bucket per provider before sending; with no token, it reschedules the delivery a moment later instead of failing it.

**Failures:** each provider sits behind a circuit breaker — five consecutive failures open it for 30 seconds. While it's open, deliveries are deferred without spending attempts, and where we have a secondary provider (SES → SendGrid, Twilio → a second SMS vendor) the worker fails over. Transient errors retry through the outbox with exponential backoff and jitter — about 5, 10, 20 and 40 seconds — and the fifth failure marks the delivery failed and dead-letters the message. Permanent errors (unregistered token, hard bounce) fail immediately and update the suppression list.

| Approach | Verdict |
|----------|---------|
| ✅ Queue per channel × priority + priority-ordered relay | Critical traffic never waits behind bulk |
| ❌ One queue with a priority field | Head-of-line blocking behind the campaign |
| ❌ RabbitMQ priority queues | Reorders only waiting messages; prefetch defeats it |
| ❌ Kafka topics per priority | Partition order means one stuck message blocks the ones behind it; retries need retry topics |

"What I give up: 12 queues to declare, monitor and alert on, and four more for every new channel. I'd also have idle critical consumers on purpose. Both are cheap compared to explaining why a login code took four minutes."

---

## 🔧 Deep Dive 3: Deciding Whether and When to Send (5 min)

"Most notifications we accept should be shaped before they're sent — some dropped, some delayed, some merged."

**Preferences on the hot path.** At 17,000 accepts a second, a PostgreSQL read per notification is the throughput ceiling. Preferences are cache-aside in Redis with a 5-minute TTL, and every preference write deletes the cache key, so a change applies to the next send. The TTL is only a backstop for a missed invalidation. Unsubscribe links write through to PostgreSQL before they confirm, because that one is a legal obligation.

**Quiet hours in the recipient's time zone.** I store quiet hours as minutes from local midnight plus an IANA zone — "22:00 to 07:00, Asia/Tokyo" — and evaluate them with the zone's rules. Using server time would wake Tokyo users at 3 a.m. A deferred send gets `available_at` = the next 07:00 in Tokyo; I compute that once and correct it across DST transitions, because 07:00 can be 23 or 25 hours away. Critical messages bypass quiet hours.

**Re-check at send time.** A message deferred eight hours can outlive consent. The worker re-checks the cached channel and category opt-out right before sending; it's one Redis read.

**Three kinds of duplicate, three mechanisms.** The caller's retry is caught by the `Idempotency-Key`. A fan-out that runs twice is caught by `dedupe_key`. And "the same content to the same user twice in a minute" — two services both reacting to one event — is caught by a content hash claimed with `SET NX` for a short window, released if nothing ends up being sent.

**Digests.** Low-priority social notifications ("Ana liked your photo") are merged: instead of an outbox row, the accept path appends to a per-user digest buffer keyed by category, and one outbox row per buffer is due at the end of the digest window — 30 minutes, or the end of quiet hours. The digest renders "Ana and 11 others liked your photo".

| Approach | Verdict |
|----------|---------|
| ✅ Cache + invalidation, re-check at send | Database off the hot path; opt-outs honored even for deferred sends |
| ❌ Database read per send | 17K reads/s for data that changes a few times a year per user |
| ❌ TTL-only cache | A user who opts out keeps getting messages for minutes |
| ✅ IANA zone + local minutes | Correct local time, DST included |
| ❌ UTC offsets | Wrong for half the year wherever DST applies |

"What I give up: a second preference check per delivery, and digest buffers that delay low-priority messages by design. Users notice fewer, better notifications more than they notice slower ones."

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first, in order:** SMS provider throughput (add short codes and vendors, cap per-user SMS hard), email reputation during large campaigns (warm-up, bounce-rate circuit breakers that pause the campaign), then history storage (age out after 30 days to object storage).

| Failure | What callers and users see | Mitigation |
|---------|----------------------------|------------|
| RabbitMQ down | Accepts still `202`; deliveries late | Outbox absorbs; relay retries; outbox-lag alert |
| A provider down | That channel defers; others normal | Breaker, failover, retry budget, DLQ |
| Worker dies mid-send | Usually nothing; rarely a duplicate | Lease sweeper, fencing, provider collapse keys |
| Redis down | Slower accepts; idempotency and dedup fail open | Preferences from PostgreSQL; alert immediately |
| PostgreSQL shard down | `503` for that shard's users; callers retry | Replica promotion; the same idempotency key makes retries safe |
| Campaign spike | Bulk queues back up | Isolation; critical latency unchanged |

**What I'd watch:** outbox lag (the age of the oldest due, unpublished row — the single best "is delivery working" signal), critical accepted-to-sent p99, queue depth per channel and priority, delivery outcomes per provider (`sent`, `retry_scheduled`, `deferred`, `dead_lettered`), breaker state, bounce and complaint rates, and dead-letter growth.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Accept → queue | Transactional outbox | Insert then publish | No lost or phantom notifications |
| Semantics | At-least-once + leased, fenced claim | Exactly-once | Not achievable with providers; duplicates bounded |
| Priority | Queue per channel × priority | Priority field | Campaigns can't delay critical traffic |
| Retries | Outbox rows, backoff, budget, DLQ | In-process retry or `nack` | Durable and bounded |
| Provider limits | Token bucket per provider at the worker | Per-user limits only | Providers have hard ceilings |
| Preferences | Redis cache, invalidated on write, re-checked at send | Database per send | Hot path off PostgreSQL; consent honored |
| Queue technology | RabbitMQ | Kafka | Per-message ack, retry, DLQ |

"With more time I'd build the in-app inbox with a WebSocket gateway and read state, a dead-letter replay tool with per-provider filters, and send-time optimization for marketing traffic."
