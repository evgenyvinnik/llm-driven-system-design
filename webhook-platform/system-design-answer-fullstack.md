# Webhook Platform — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → End-to-end architecture → Data and API → Delivery path → Retries → Console → Deep dives → Traces → Scale*

> "Customers register callback URLs. Their systems emit events, and we promise a signed HTTP request to every matching URL. We keep retrying while the receiver is down, keep every attempt visible, and let the customer replay anything. I'll state the contract first because it's the trap in this question: delivery is at-least-once, never exactly-once. A receiver can commit the event and lose the connection before we read its 200, and only the receiver knows that happened. So every attempt carries the same event id and the receiver dedupes on it. End to end there are four parts. Intake commits the event, its fan-out and an outbox in one transaction. In the delivery pipeline, PostgreSQL decides and the queue only carries pointers. Per-endpoint isolation keeps one dead customer from slowing the others. And a console lets a customer answer 'did you send it, and what did my server say?' in ten seconds, then replay what failed."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | At-least-once contract, the isolation promise, failure classes, two kinds of user |
| Architecture, data, API | ~8 min | Outbox, pointer tickets, retries waiting in PostgreSQL, per-endpoint slots |
| Delivery path, retries, console | ~8 min | Claim → slot → sign → vetted connect → classify → record, and what the screen shows |
| Deep dives | ~15 min | Isolation, the database-to-broker hand-off, one delivery from row to pixel |
| Traces, checklist, follow-ups, scale | ~9 min | One success, one failure, the five follow-ups, what breaks first |

---

## 🎯 Requirements (~5 min)

**Clarifying questions (and the answers I'll assume)**

| Question | Assumption |
|----------|------------|
| Who emits events? | Customer back ends with an API key, plus a "send test event" form in the console |
| What delivery guarantee? | At-least-once; receivers dedupe on the event id we send with every attempt |
| Is ordering required? | Not by default; optional per-key sequence numbers |
| How long do we retry? | 3 days from the first attempt, then fail, disable the endpoint and notify |
| Who uses the console? | Customer developers, each scoped to one org; our operators, who see aggregates only |
| Can customers point us at any URL? | They type it in, so every connection is SSRF-vetted at connect time |

**Functional**

1. Emit events with an `Idempotency-Key`. A retried emit returns the original event, never a second one. Events are immutable.
2. Manage endpoints: URL, event-type filter (`*`, `order.*`, exact types), concurrency limit, enable/disable, a signing secret with rotation.
3. Fan out to one delivery per (event, matching active endpoint).
4. Deliver at least once. Sign each request, retry transient failures with full-jitter backoff inside a retry window, and stop on permanent ones.
5. Record every attempt: status, latency, error class, next attempt time, truncated response body, worker and resolved IP.
6. Replay one delivery, or every delivery to an endpoint that failed since T. Replay makes new attempts for the same event id.
7. Console: endpoints with health, event log, delivery log with attempts, replay, secrets, notifications, a mock-receiver panel, and an operator view.

**Non-functional**

| Property | Target |
|----------|--------|
| Intake availability | 99.99%: producers are order and billing systems that block on our errors |
| Intake latency | p99 < 100 ms to a durable commit |
| Durability | Zero accepted events lost |
| Delivery latency (healthy endpoint) | p50 < 1 s, p99 < 5 s from emit to first attempt |
| Isolation | A down or hanging endpoint moves other customers' p99 by < 10% |
| Retry horizon | 3 days, then disable and notify |
| Duplicates | < 0.1% of deliveries in steady state; unbounded during incidents |
| History | 30 days searchable |
| Security | No request ever reaches a private, loopback, link-local or metadata address |

**Scale (assumptions)**

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Endpoints | ~300,000 (100k orgs × ~3) | Per-endpoint state must be a row and a sorted set, not a queue |
| Events | ~500M/day ≈ 5,800/s, ~30,000/s peak | Intake is an OLTP write path |
| Deliveries | ~1.5 per event ≈ 8,700/s, ~45,000/s peak | Routine for a broker, heavy for one database primary |
| Attempts | ~1.1 per delivery; 10-15 to a dead endpoint | Append-only history, partitioned by day |
| Payload | ~2 KB average, 256 KB cap | ~1 TB/day of events; drop partitions after 30 days |
| Open outbound requests | ~3,000 average, ~15,000 peak | Slow receivers, not the queue, consume capacity |
| Down endpoints | ~1-2% at any moment | Millions of waiting deliveries that must not sit in the queue |

> "The numbers say the queue isn't the bottleneck. Tens of thousands of small messages a second is routine. What limits us is database writes per delivery and the sockets that slow receivers hold open."

---

## 🏗️ End-to-End Architecture (~4 min)

```
 Producers (order, billing systems)                       Customer console (React SPA)
        │ POST /v1/events + Idempotency-Key                        │ session · polls 1.5-3 s
        ▼                                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ API instances: intake (one transaction) · console REST (org-scoped) · ops        │
 └────────────────────────────────────────┬─────────────────────────────────────────┘
                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ PostgreSQL: events · endpoints · deliveries · attempts · outbox · notifications  │
 │ source of truth for every state change · its clock schedules every retry         │
 └──────┬─────────────────────────────┬─────────────────────────────────────┬───────┘
        │ outbox rows                 ▲ due retries → outbox rows           ▲ claim, park,
        ▼                             │ (capped per endpoint)               │ record (fenced)
 ┌──────────────────┐      ┌──────────┴───────────┐                         │
 │ Outbox publisher │      │ Retry scheduler      │                         │
 │ confirm channel  │      │ + lease/stuck sweeps │                         │
 └────────┬─────────┘      └──────────────────────┘                         │
          │ ticket {deliveryId, dispatchSeq}: a pointer, no payload         │
          ▼                                                                 │
 ┌────────────────────────────────────────────┐                             │
 │ RabbitMQ quorum queue "deliveries"         │──▶ poison queue (10×)       │
 │ holds only work that is due now            │                             │
 └────────────────────┬───────────────────────┘                             │
                      ▼                                                     │
 ┌──────────────────────────────────────────────────────────────────────────┴───────┐
 │ Delivery workers (N): claim → endpoint slot (Valkey semaphore) or park →         │
 │ sign → resolve + vet every IP → POST to the pinned IP, no redirects, timeout →   │
 │ classify → record attempt + next state → release slot → ack                      │
 └────────────────────┬─────────────────────────────────────────────────────────────┘
                      │ fixed-IP egress, no route inward
                      ▼
          Customer endpoints (internet) · locally: mock receiver with fault toggles
```

> "Three ideas carry this. First, PostgreSQL decides and the queue only carries tickets. Every state change is a row, and a message is just 'delivery X, dispatch number N', so duplicate and stale tickets are harmless. If the broker lost everything, a sweep could rebuild the queue from the database. Second, retries wait in the database, not in the queue or in a worker. Third, every endpoint has its own in-flight limit across the whole fleet. A worker that can't get a slot parks the delivery and moves on."

---

## 💾 Data Model (~2 min)

| Table | Key columns | Indexes | Notes |
|-------|-------------|---------|-------|
| events | id (`evt_` + ULID), org_id, type, payload, ordering_key, sequence, idempotency_key, request_hash | unique (org_id, idempotency_key); (org_id, created_at) | Immutable; day-partitioned and sharded by org at scale |
| ordering_sequences | (org_id, key) → last sequence | primary key | Gap-free counter, upserted inside the emit transaction |
| endpoints | url, event_types, status, max_concurrency (default 4), current and previous secret + expiry, consecutive_failures, failing_since, paused_until | (org_id, created_at) | Health and the 429 pause live on the row |
| deliveries | event_id, endpoint_id, state, dispatch_seq, attempt_count, replay_count, next_attempt_at, window_started_at, retry_deadline, lease_token, lease_until | unique (event_id, endpoint_id); partial (endpoint_id, next_attempt_at) for scheduled; partial (endpoint_id) for queued/in_flight; partial lease_until for in_flight | States: queued → in_flight → scheduled, delivered or failed |
| attempts | delivery_id, attempt_no, trigger, status_code, latency_ms, error_class, outcome, next_attempt_at, response_body (1 KB), worker_id, resolved_ip | (delivery_id, id) | Append-only. Trigger: initial, retry, replay, recovered. Outcome: delivered, retry, failed, superseded, lost |
| outbox | delivery_id, dispatch_seq, published_at | partial on id where unpublished | Marked row by row, never with a checkpoint |
| notifications | org_id, endpoint_id, kind, title, body, read_at | (org_id, created_at) | Written in the same transaction as an auto-disable |

> "The partial indexes keep the hot sets small. The scheduler reads only scheduled rows per endpoint, the capacity check reads only queued and in-flight rows, and the publisher reads only unpublished outbox rows."

---

## 🔌 API (~2 min)

```
POST  /api/v1/events                       producer (API key or session); Idempotency-Key required
                                           201 new · 200 Idempotent-Replayed · 409 key reused · 413
GET   /api/v1/events · /events/:id         event log; one event with a delivery per matched endpoint
GET   /api/v1/endpoints · /endpoints/:id   endpoints with health: success 1 h, p50/p95, in flight, waiting
POST  /api/v1/endpoints                    create; URL vetted early (422 SSRF_BLOCKED); returns secret
PATCH /api/v1/endpoints/:id                url, event types, max concurrency
POST  /api/v1/endpoints/:id/enable|disable
POST  /api/v1/endpoints/:id/rotate-secret  both secrets sign until the overlap ends
GET   /api/v1/endpoints/:id/deliveries     filter: pending | delivered | failed
POST  /api/v1/endpoints/:id/replay         replay all failed since T (409 if disabled)
GET   /api/v1/deliveries/:id               delivery + every attempt + event
POST  /api/v1/deliveries/:id/replay        202; same event id, new attempt (409 pending or disabled)
GET   /api/v1/notifications · POST /api/v1/notifications/read-all
GET   /api/v1/receiver · PUT /api/v1/receiver/paths/:name    mock receiver panel, org-filtered
GET   /api/v1/ops/overview                 operator: queue depth, outbox lag, in flight vs limit
```

---

## 🔄 Request Flow: One Emit to One Delivered Row (~3 min)

1. **Producer.** It POSTs `order.created` with an `Idempotency-Key`.
2. **Intake transaction.** A transaction-scoped advisory lock on (org, key) serialises concurrent retries. Then it looks up the key. Same request hash → return the original event with `200 Idempotent-Replayed`. Different hash → `409 IDEMPOTENCY_KEY_REUSED`, because silently returning the old event would hide a client bug. If the key is new, it allocates a sequence number when an ordering key is present and inserts the event. It matches the org's active endpoints' filters and inserts one `queued` delivery and one outbox row per match. Then it commits, and a NOTIFY fires at commit. Locally the producer gets 201 in about 10 ms.
3. **Publisher.** It wakes on the NOTIFY and locks a batch of unpublished outbox rows, skipping rows another publisher holds. It publishes one ticket per row on a confirm channel, waits for the broker's confirms, marks each row published, and commits.
4. **Claim.** A worker takes the ticket and runs a conditional update. The row must still have this `dispatch_seq` and be `queued`, or be `in_flight` with this ticket redelivered or the lease expired. The update sets `in_flight` with a fresh lease token. If no row matches, the ticket was stale or a duplicate: ack and drop.
5. **Gate.** A disabled endpoint fails the delivery. An endpoint paused by a 429 parks the delivery until the pause ends. Otherwise the worker asks the Valkey semaphore for one of the endpoint's N slots (1 in probe mode). If none is free, it parks the delivery about 300 ms out with jitter, then acks.
6. **Sign.** HMAC-SHA256 over `timestamp.body` with the current secret, plus the previous one during a rotation overlap. Headers: `Webhook-Id` (the event id, which is the dedupe key), `Webhook-Signature`, `Webhook-Attempt`, and the ordering key and sequence when present.
7. **Vetted connect.** The WHATWG parser normalises decimal, hex and octal IP tricks. Internal names are refused. The worker resolves the name and vets **every** returned address against the blocked ranges, unwrapping IPv4-mapped, NAT64 and 6to4 addresses. Then it connects to the vetted IP with the original Host and TLS SNI, under one deadline (3 s locally). Redirects are never followed, and it reads at most 64 KB.
8. **Classify and record.** One transaction, fenced on the lease token: insert the attempt; set the delivery to `delivered`, `scheduled` (database `now()` + delay) or `failed`; update the endpoint's failure streak; disable and notify if required. Then release the slot and ack.
9. **Console.** The delivery page polls every 1.5 s. The next poll shows the new attempt row and the state chip.

> "Every step is either idempotent or comes after a durable write. That's how the publisher and the queue can both be at-least-once and the whole system can still be correct: correctness lives in the conditional claim, not in any one hop."

---

## ⏳ Retries and Failure Classes (~4 min)

**Backoff.** Attempt *n* waits `uniform(0, min(cap, base × 2^(n-1)))`, the "full jitter" scheme: base 30 s and cap 6 h in production, 1 s and 20 s locally. When an endpoint recovers, the thousands of deliveries that failed together retry spread across the window instead of in lockstep. A 429 with `Retry-After` waits exactly that long, clamped to 1 h, and pauses the **whole endpoint** until then. The receiver asked us to slow down, not just to retry one request later.

**Horizon.** The retry window opens at a delivery's **first attempt** (or the first after a replay) and lasts 3 days (180 s locally). If an attempt's next retry would land past the window, the delivery is `failed` ("Retry window exhausted"). The endpoint is disabled only if it hasn't succeeded once since that window opened. A flaky endpoint loses individual deliveries but stays enabled.

**Where retries wait**

| | ✅ PostgreSQL `next_attempt_at` + scheduler | ❌ RabbitMQ TTL / dead-letter delay queues |
|---|---|---|
| Arbitrary delay (jitter, Retry-After) | A timestamp | A per-message TTL only expires at the queue head, so fixed tiers (1 s, 10 s, 1 min…) and no jitter |
| Cancel or reschedule (disable, replay, 429 pause) | An update on the row | A message in a delay queue can't be found or removed |
| Fairness per endpoint | The dispatch query caps each endpoint at its spare capacity | A due wave of one endpoint's retries floods the work queue |
| Visibility ("next attempt in 37 s") | Query it | Opaque |
| Cost | A scheduler process and a partial index | No extra process |

> "If retries sat in delay queues, disabling an endpoint would leave thousands of messages I can't cancel, the console couldn't say when the next attempt is, and a recovering endpoint's whole backlog would land in the work queue at once. A timestamp in a row fixes all three. The cost is a scheduler that polls a partial index."

**Permanent vs transient**

| Result | Class | Action | Why |
|--------|-------|--------|-----|
| 2xx | ok | delivered | — |
| 5xx, 408, 425 | http_5xx / http_4xx | retry with backoff | The receiver may recover |
| 429 | http_429 | wait Retry-After; pause the endpoint | An explicit "slow down" |
| timeout, reset, refused, DNS failure | timeout / connection_error / dns_error | retry | Network and DNS outages are transient |
| 410 Gone | http_410 | fail, **disable**, notify | An explicit "stop sending" |
| invalid URL, SSRF-blocked | invalid_url / ssrf_blocked | fail, **disable**, notify | Every future attempt would be blocked too |
| 3xx | http_3xx | fail that delivery | Redirects are never followed |
| other 4xx | http_4xx | fail that delivery only | Same bytes, same answer; the customer fixes and replays |

---

## 🔐 Signing and SSRF in Brief (~2 min)

**Signatures.** The timestamp is part of the signed bytes, so a captured request can't be refreshed with a new one. Receivers reject `|now − t|` over 5 minutes, which bounds replays of captured requests; event-id dedupe covers the rest. **Rotation:** the new secret becomes current and the old one keeps signing for an overlap window (24 h by default, 120 s locally). During the overlap, each request carries two `v1` signatures. A receiver holding only the old secret verifies, and so does one holding only the new secret, so the customer can deploy whenever they like.

**SSRF.** Customers type URLs that we fetch from inside our network, so `http://169.254.169.254/` would read cloud credentials. The check runs in the worker on every attempt, not only at registration.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Resolve, vet every address, connect to that IP, never follow redirects | No second lookup to rebind; a 302 to a metadata address is just a failed attempt | Custom connect logic (Host and SNI set by hand) |
| ❌ Vet only at registration | Simple | The customer controls DNS: point the name at a public IP to register, then at 10.0.0.5 |
| ❌ Vet, then let the HTTP client resolve again | Uses the stock client | DNS rebinding wins the race between the two lookups |

> "Registration runs the same check to catch typos early, but it's not the security boundary. In production, workers also egress through fixed IPs with no route inward, so network policy backs up the application check."

---

## 🖥️ The Console (~4 min)

| Page | Shows | Actions |
|------|-------|---------|
| Endpoints | Each endpoint with a status chip (Active, Paused (429), Failing · probing, Disabled) and a success bar | Create (URL vetted) |
| Endpoint detail | Health tiles (success 1 h, p50/p95, in flight / limit, waiting / failed, last success); deliveries filtered pending, delivered or failed | Enable/disable, rotate secret with overlap, settings, "replay failed since T" |
| Delivery | State chip, attempts "(replayed ×2)", "next attempt in 37 s", end of the retry window, and the attempt timeline with the backoff between attempts | Replay, disabled while pending |
| Events | Event log with delivery counts; an event's page lists one delivery per matched endpoint | Send a test event |
| Receiver (local) | Per-path toggles (Healthy, 500, Slow, Drop ack, 429, 410), armed for the next N requests or until changed; what the receiver saw | Arm faults, clear the log |
| Notifications | Auto-disable notices with the reason and last error | Mark all read |
| Ops (operator role) | Queue ready/unacked, outbox backlog and oldest age, 5-minute success rate, in flight vs limit per endpoint, poison count | None: aggregates only, no payloads |

**Frontend structure.** File-based routes with TanStack Router. Zustand holds just the session and the unread-notification count, which the shell refreshes every 5 s. Every page uses one small polling hook: fetch now, refetch every 1.5-3 s while the tab is visible, through the same org-scoped REST endpoints as the first load. No client cache needs invalidating, and an action such as replay simply triggers a reload.

**The UI/backend contract**

| Field | Backend meaning | UI use |
|-------|-----------------|--------|
| `delivery.state` | queued, in_flight, scheduled, delivered, failed | Chip; Replay enabled only when delivered or failed |
| `delivery.nextAttemptAt` | Database timestamp of the next try | "next attempt in 37 s" |
| `delivery.retryDeadline` | End of the window opened at the first attempt | "Retry window ends 14:03" |
| `attempt.trigger` | initial, retry, replay, recovered | "first attempt", "retry", "manual replay", "taken over from a lost worker" |
| `attempt.outcome` | delivered, retry, failed, superseded, lost | "Delivered", "Will retry", "Stopped", "Superseded", "Outcome unknown" |
| `attempt.resolvedIp`, `signaturesSent` | The vetted IP we connected to; 1 or 2 signatures | "connected to 127.0.0.1"; "2 signatures (rotation overlap)" |
| `endpoint.status` + health | Disabled reason, failure streak, paused_until, in flight vs limit | Active, Paused (429), Failing · probing, Disabled |
| Error `code` | IDEMPOTENCY_KEY_REUSED, SSRF_BLOCKED, DELIVERY_PENDING, ENDPOINT_DISABLED | A specific message beside the action |

**How the UI tells the truth about at-least-once.**

- "Delivered" means "we read a 2xx". Nothing more is claimed, and the timeline shows every try.
- If a worker died mid-attempt, that attempt reads "Outcome unknown" (`lost`), and the next one reads "taken over from a lost worker". A stalled worker's late result shows as "Superseded".
- Replay says what it does. The button's tooltip is "New attempt for the same event id", replayed attempts are labelled "manual replay", and the bulk card explains that receivers deduping on `Webhook-Id` won't apply anything twice.
- The receiver panel counts "Duplicates caught" and flags each one, so the contract can be demonstrated, not just asserted. It also flags "Stale (discarded)" for out-of-order sequence numbers.
- During a rotation overlap, the attempt row shows "2 signatures".

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: Per-endpoint isolation (fleet-wide semaphore, parking, capacity-aware dispatch)

**Decision.** Each endpoint has an in-flight limit (default 4), enforced across every worker by a Valkey semaphore. It's a sorted set of lease tokens scored by expiry. One Lua script drops expired leases and adds ours if fewer than the limit remain, using the Valkey server's clock. A worker that can't get a slot **parks** the delivery: state `scheduled`, next attempt about 300 ms out, then ack. The scheduler dispatches each endpoint only up to its spare capacity (limit minus queued and in flight). After 5 consecutive failures the limit drops to 1 (probe mode), and the first success restores it.

**Why it works here.** The promise is "another customer's outage moves your p99 by less than 10%". A hanging endpoint is worse than a dead one, because every request holds a socket for the full timeout. With the cap, a dead endpoint holds at most N slots fleet-wide, and 1 once it's being probed. A ticket for a saturated endpoint costs a worker a few milliseconds: claim, failed acquire, park, ack. Because dispatch is capacity-aware, a dead endpoint with 50,000 due retries puts only a handful of tickets in the shared queue; the rest wait as rows. Leases expire, so a worker that dies holding a slot leaks it only briefly. I measured it locally. I made globex-main hang: it accepts the connection and answers after 30 s, past our 3 s timeout. Acme's event-to-delivered latency stayed at p50 10-13 ms and p90 12-44 ms. The healthy baseline was p50 12-15 ms and p90 16-36 ms. The receiver never saw more than 4 concurrent requests on the hanging path, and about 55 Globex deliveries waited in PostgreSQL, not in the queue.

**Why the alternatives fail.**

- **Waiting in the worker.** Locally there are 32 request slots (2 workers × 16). Globex tickets arrive interleaved with Acme's, and each Globex request holds a slot for 3 s. Within seconds all 32 slots are holding Globex requests and Acme's tickets sit behind them, which is exactly the cross-customer harm we promised away. Waiting for a semaphore slot inside the worker only moves the problem: the worker is idle but still occupied.
- **Requeueing a busy ticket to the tail.** It comes straight back, spinning through the broker thousands of times a second for no work. It loses its place too, so under load it starves.
- **A queue per endpoint.** That's 300,000 queues, each a replicated log with its own memory and consensus overhead. Consumers can't subscribe fairly to 300k queues, so you still need a layer that decides which queue to read next. That is the fair scheduler you were trying to avoid, now on top of a broker that can't carry the load.

**What I give up.** A database write for each parked ticket. These are rare because dispatch is capacity-aware, but not zero when a burst lands. Up to ~300 ms of extra latency for an endpoint already at its limit. A scheduler process, and Valkey on the hot path: if Valkey is down, tickets error and are requeued after a pause, so no data is lost but nothing is delivered either. The limit is also a ceiling: a hot endpoint receiving 5k events/s needs its limit raised to around 200.

### Deep dive 2: The hand-off (transactional outbox, pointer tickets and a conditional claim)

**Decision.** Intake commits the event, its deliveries and their outbox rows together. A publisher moves outbox rows to RabbitMQ on a confirm channel and marks each row only after the broker confirms. A ticket is only `{deliveryId, dispatchSeq}`. Workers claim the delivery with a conditional update and ack only after the attempt and the next state have committed.

**Why it works.** "Accepted" means "committed", so there's no moment where a producer has a 201 but the event exists only in a process's memory. Every failure between two steps becomes either "do it again" or "a duplicate ticket", and duplicate tickets are harmless by construction:

| Failure between steps | What's left | How it resolves |
|-----------------------|-------------|-----------------|
| API dies after commit | Unpublished outbox row | The publisher sends it later |
| Publisher dies after publish, before marking | Rows still unpublished | Republished; the second ticket finds the row in flight or done and is dropped |
| Delivery rescheduled or replayed | Old ticket in the queue | `dispatch_seq` was bumped, so the old ticket matches nothing |
| Worker dies mid-attempt | Unacked ticket | RabbitMQ redelivers; a new worker takes over with a fresh lease token and records the old attempt as `lost` |
| Worker stalls past its lease | Two workers may have sent | The stale worker's write is fenced on its old token and logged `superseded` |
| Ticket lost in the broker | Delivery stuck `queued` | A stuck-queued sweep re-dispatches with a new `dispatch_seq` |
| A ticket crashes a worker every time | Crash loop | After 10 redeliveries the quorum queue dead-letters it to the poison queue |

Rows are marked one by one, never with a "last published id" checkpoint. Ids from concurrent transactions commit out of order, so a checkpoint would skip a row that committed late.

**Why the alternatives fail.**

- **Commit, then publish from the request handler.** If the process dies between the two, the delivery sits `queued` forever and nothing in the queue knows it exists. Fixing that takes a sweep for unpublished deliveries, which is an outbox built badly.
- **Publish, then commit.** A worker can receive a ticket for an event that then rolls back, or isn't visible yet. It either sends a webhook for something that never happened or drops a ticket it should have kept.
- **Payload and retry state in the message.** The broker becomes a second source of truth that can disagree with the database. You can't cancel a disabled endpoint's waiting messages or show "next attempt in 37 s". Replay would mean rebuilding a message instead of updating a row.

**What I give up.** About two extra writes per delivery (the outbox insert and the mark) and a publisher process. At 45k deliveries/s that's real; change-data capture on the WAL would remove the mark. At-least-once publishing also means at-least-once tickets, so every consumer I add later has to be idempotent too.

### Deep dive 3: One delivery from database to pixel (polling, and why replay keeps the event id)

**Decision.** The console polls every 1.5-3 s through the same org-scoped REST endpoints, only while the tab is visible. Replay is a state change on the **existing delivery**: back to `queued`, `dispatch_seq` + 1, a fresh retry window and an outbox row, in one transaction. It never creates a new event.

**Why it works.** The customer's question is "did you send it, and what did my server say?" Delivery state changes on a scale of seconds to hours, so 1.5 s is well within what a person debugging tolerates. Polling has no second data path. Each refresh is a fresh read under the session's org scope, so there's no push channel to secure, filter per viewer or resynchronise after a reconnect. The delivery page renders exactly what the database says: the state chip, "next attempt in 37 s" computed from a database timestamp, and the attempt timeline. Replay fits the same model. The click returns 202, the page reloads, and the next polls show queued, then in flight, then a new attempt labelled "manual replay" under the earlier ones. Because the event id is unchanged, the receiver sees the same `Webhook-Id`. A receiver that already applied the event answers "duplicate"; one that never got it applies it once.

**Why the alternatives fail.**

- **SSE pushed from workers.** To push "attempt recorded" we'd need pub/sub from every worker to every API instance, per-connection org filtering on the push path, and a catch-up refetch after every dropped stream. That refetch is the polling we'd be replacing. For a debugging console, it's a second channel that can disagree with the first for little gain.
- **Pushing data instead of ids.** The access check would then live in two places, REST and the stream.
- **Replay as a new event.** A new id defeats receiver dedupe. A receiver that had already applied "order cancelled" applies it again, and every reference to the original id breaks: the customer's logs, a support ticket, our own history, which would split across two events.

**What I give up.** Up to 1.5-3 s of staleness, plus requests from tabs that are visible but idle. At production scale, thousands of consoles polling delivery lists is read load on the OLTP database. The next step is a read replica, then SSE invalidations that carry only ids and refetch through REST. Keeping the id also means a customer who wants "send this as new" must emit a new event. A second replay click while one is pending is refused (409 `DELIVERY_PENDING`); the UI prevents it by disabling the button.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a dropped acknowledgment, deduped (from the e2e run)

1. Acme's order service POSTs `order.cancelled` with key `order-102-cancelled`. Intake takes the advisory lock and finds no existing row. It inserts the event and matches `ep_acme_orders` (`order.*`) and `ep_acme_audit` (`*`). It inserts two `queued` deliveries and two outbox rows, commits and NOTIFYs. 201 in about 10 ms.
2. The publisher wakes, publishes two tickets on the confirm channel, waits for confirms and marks both rows.
3. Worker-2 claims the orders delivery (`queued` → `in_flight`, lease T1). The endpoint is active and unpaused, and slot 1 of 4 is free.
4. It signs, resolves `localhost` to 127.0.0.1 (an allowlisted port), and POSTs to the pinned IP with `Webhook-Id: evt_…` and `Webhook-Attempt: 1`.
5. The receiver's drop-ack toggle is armed. It verifies the signature, records `evt_…` as processed, applies it, then closes the socket without answering.
6. Worker-2 sees a reset: `connection_error`, retry. Full jitter draws 0.6 s. In one transaction fenced on T1, it inserts attempt 1 and sets `scheduled` at `now()` + 0.6 s; the endpoint's failure streak becomes 1. It releases the slot and acks. The console now shows "Retry scheduled", with attempt 1 reading "Connection error · Will retry".
7. The scheduler finds the delivery due with spare capacity. It sets `queued`, bumps `dispatch_seq` to 2 and writes an outbox row. Ticket 2 goes out.
8. Worker-1 claims it and sends attempt 2. The receiver finds `evt_…` already processed, answers 200 with a duplicate flag and does not apply it again. Worker-1 records `delivered`, resets the streak and acks.
9. The console shows "Delivered" with two attempts. The receiver panel flags the second request "Duplicate" and the duplicates counter goes up by one.

Delivered twice, applied once. That's because the receiver deduped, not because anything happened exactly once.

### Failed trace: an endpoint down past its window (20 s horizon in the e2e run; 3 days in production)

1. The `acme-audit` path is set to return 500 until changed. An `invoice.refunded` event creates a delivery to it.
2. Attempt 1 gets a 500 (`http_5xx`), so it retries after a jittered ≤ 1 s; attempt 2 after ≤ 2 s; attempt 3 after ≤ 4 s… The window opened at attempt 1, so the deadline is attempt 1 + 20 s. After 5 consecutive failures the endpoint is probed one request at a time, and the endpoints page shows "Failing · probing".
3. Attempt 12 fails, and its next retry would land past the deadline. The delivery becomes `failed` with "Retry window exhausted".
4. In the same transaction, `failing_since` is at or before this delivery's window start: the endpoint hasn't succeeded once in the whole window. It's disabled (`retry_horizon_exhausted`), its other waiting deliveries are failed, and a notification is written. New `*` events stop fanning out to it.
5. Within 5 s the nav badge shows one unread. Alice reads the reason, sets the receiver back to Healthy and re-enables the endpoint, which clears the streak and the pause. Replay before re-enabling returns 409; after re-enabling it returns 202.
6. Replay queues the same delivery with a fresh window. Attempt 13 is recorded with trigger `replay` and is delivered. The receiver sees the original event id once, and no new event was created.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL. An emit succeeds when the event, its deliveries and their outbox rows commit (201). An attempt counts when its row and the delivery's next state commit, and only then is the ticket acked. RabbitMQ holds pointers that can be rebuilt; Valkey holds sessions and semaphores, which can be lost. The UI treats an action as done only after a 2xx, then reloads |
| Client retries after losing the response? | Producer: same key → the original event (200, Idempotent-Replayed); different body → 409; concurrent duplicates serialised by the advisory lock. Our retry after losing a receiver's response: the same `Webhook-Id`, deduped by the receiver. Console replay double-click: 409 `DELIVERY_PENDING` |
| Failure between two important steps? | After commit: the outbox publishes later. After publish, before mark: duplicate ticket, dropped by the claim. Mid-attempt: redelivery and takeover, attempt recorded `lost`, receiver may see a duplicate. After commit, before ack: the redelivered ticket finds nothing to claim. Lease-expiry and stuck-queued sweeps are the backstop |
| Which ordering is required? | None globally, and no per-endpoint FIFO by default. Per-key sequence numbers let receivers discard stale updates. Each delivery's transitions are serialised by the conditional claim and the lease token |
| Access with caches, indexes, async jobs? | Every console query is filtered by the session's org; another org's id returns 404. An API key resolves to exactly one org. Workers act as the system and never serve user data. The receiver proxy filters to the caller's own paths. Operators see aggregates only. SSRF is checked in the worker at connect time, not only at registration. Polling means there's no push path to secure |
| What breaks first, and the evidence? | PostgreSQL writes: 6.6 row writes per successful delivery, measured with `pg_stat_database` (delivery insert, outbox insert, outbox mark, claim, result, attempt insert, plus the shared event row). It was 8.0 before no-op health and API-key writes were made conditional. That's ~60k writes/s on average and ~300k/s at peak, well past one primary. Second, the scheduler's scan of 300k endpoints per tick |

---

## ❓ Follow-ups

- **A receiver processes an event but its acknowledgment is lost.** From our side that's a timeout or a reset, indistinguishable from "never arrived", so we retry with the same `Webhook-Id`. The receiver keeps processed event ids and answers 200 to a repeat without applying it. It is never exactly-once. The queue's guarantees end at our worker, and there's no transaction around the HTTP hop to a stranger's server. We keep duplicates under 0.1% in steady state and ship a snippet in the docs that shows receivers how to verify and dedupe.
- **One endpoint is down for six hours. Can it block other customers?** No. It holds at most its limit of slots fleet-wide, and 1 once probing. Its due retries wait as rows, dispatch caps it at its spare capacity, and any ticket that does arrive parks in milliseconds. Six hours is inside the 3-day window, so it isn't disabled: the backoff ceiling grows toward the 6 h cap, and after recovery the backlog drains spread out by jitter. The hanging-endpoint measurement above is the evidence.
- **Do events require ordering, and what does that cost?** Not by default. Strict per-endpoint FIFO means one request in flight, so throughput is capped at 1/RTT, about 5 events/s at 200 ms. One poisoned event blocks everything behind it for the whole horizon (head-of-line blocking), and after a six-hour outage every later event waits and then drains serially. Instead, an optional `orderingKey` gets a gap-free per-(org, key) sequence number in the emit transaction. The receiver keeps the highest sequence it has applied per key and discards anything lower, or re-fetches current state on a gap. The e2e suite shows that order isn't guaranteed: event A fails once while B, emitted after it, is delivered first. Strict FIFO could later be an explicit opt-in with that cost stated.
- **What does replay mean?** The same event id and a new attempt on the same delivery: `dispatch_seq` + 1, a fresh window, trigger `replay`. It is refused while the delivery is pending or the endpoint is disabled.
- **Permanent vs transient failures.** Retry what the same bytes might get through later: 5xx, 408, 425, timeouts, resets, DNS failures, and 429 with `Retry-After` plus an endpoint pause. Stop what never will. A 410 fails the delivery and disables the endpoint, because it means "stop sending". An invalid URL or an SSRF block also disables, because every future attempt would be blocked. Other 4xx and 3xx fail that delivery only; the endpoint stays enabled and the customer fixes their handler and replays. The cost: a receiver that 401s everything after missing a secret rotation fails fast instead of retrying until it's fixed. Replay covers that, and the log says why each delivery failed.

---

## 🚨 Failure Handling (~2 min)

| Failure | Backend | UI |
|---------|---------|----|
| Receiver 5xx, timeout, reset | Full-jitter retry inside the window | "Retry scheduled", "next attempt in…" |
| Receiver hangs | Capped at N slots (1 when probing); excess parked in PostgreSQL | "Failing · probing"; in flight / limit tile |
| Receiver 429 | Wait Retry-After; pause the endpoint | "Paused (429)" chip |
| 410, invalid URL, SSRF-blocked | Fail, disable, notify | "Disabled" with reason; notification badge |
| Worker killed mid-attempt | Redelivery, takeover, old attempt `lost` | "Outcome unknown" attempt row |
| Broker down | Intake keeps accepting into the outbox; supervised connections reconnect and drain | Ops: outbox backlog and age climbing |
| Valkey down | Tickets error and requeue after a pause; no data lost | Sign-in fails; deliveries resume when Valkey returns |
| PostgreSQL down | Intake returns 503 and producers retry with the same key | Console shows the error note |
| Platform asleep or backlogged past the window | Window opens at the first attempt, so the customer isn't penalised | Retry window end shown per delivery |

## 🐛 Lessons From Running It (~1 min)

- **The retry window must start at the first attempt, not at event creation.** The laptop slept for two minutes mid-demo. The first attempt after waking was judged "exhausted" and disabled a perfectly healthy endpoint. Time the platform spends down or backlogged must never spend the customer's retry budget.
- **Broker connections need a supervisor.** After a sleep longer than two heartbeats, every RabbitMQ connection died silently. Workers stopped consuming without crashing, while intake kept accepting. Connections are now supervised and reconnect with backoff. This was verified by stopping RabbitMQ mid-run: everything drained on reconnect. The outbox-lag alert is what would page on this in production.
- **Schedule on one clock, the database's.** After the same sleep, the Docker VM's clock lagged the host by about 3 s and every retry fired 3 s late. Now the worker decides the delay, the database turns it into `now()` + delay, and the scheduler compares against the same `now()`.

## 🧪 Testing Strategy (~1 min)

- **Classification and backoff:** every status and transport class maps to the right action; full jitter stays inside its bound; the window opens at the first attempt; `Retry-After` is clamped.
- **Signing:** both secrets sign during the overlap, and after it an old-secret-only receiver rejects. Timestamps outside the window are rejected in both directions, and changing `t` breaks the signature.
- **SSRF and sender:** decimal, hex and octal IP forms; IPv4-mapped, NAT64 and 6to4 wrappers; mixed public and private DNS answers; no redirects; the allowlist admits only exact host:port pairs.
- **API:** supertest with mocked database and cache. Covered: org scoping (another org's id is a 404, never a 403), idempotent emit, a 409 on key reuse, the metadata address refused at registration, and customers kept out of the operator view.
- **End to end and fault drills:** a scripted story drives drop-ack, 500s, 429, 410 and horizon exhaustion through the real stack. Separately: SIGKILL the worker holding an in-flight delivery, stop RabbitMQ mid-run, stop the publisher and restart it, and check that 127.0.0.1 on PostgreSQL's port is blocked.

---

## 📈 Scale (~2 min)

| Component | First limit | Next step |
|-----------|-------------|-----------|
| PostgreSQL writes | 6.6 per delivery (measured) → ~60k/s average, ~300k/s peak | Shard by org_id (every hot query is per org or per endpoint); CDC instead of the outbox mark; attempts to an append-only store (no-op health writes already skipped) |
| Scheduler | Each tick walks all 300k active endpoints | A Valkey sorted set of ready endpoints keyed by next due time; schedulers sharded by endpoint hash |
| Outbound sockets | ~15k concurrent at peak, more in incidents | Keep-alive pools per endpoint; a slow-lane worker pool for probe-mode endpoints |
| Hot endpoint | 5k events/s to one URL | Raise its limit to ~200; semaphore and dispatch unchanged |
| Queue | Comfortable at tens of thousands of messages/s | Partition by endpoint hash, or Kafka keyed by endpoint; depth tracks real load because retries never sit there |
| Console reads | Thousands of tabs polling delivery lists | Read replica; then SSE invalidations with refetch |

---

## ⚖️ Trade-offs Summary

| Approach | Pros | Cons |
|----------|------|------|
| ✅ At-least-once + receiver dedupe on `Webhook-Id` | Honest; survives lost acks | Every customer must dedupe |
| ❌ Exactly-once claim | Sounds better | Impossible across an HTTP hop to a third party |
| ✅ Transactional outbox, per-row marks | No lost events; duplicates harmless | ~2 extra writes per delivery, a publisher |
| ❌ Publish after commit | Simpler | Loses the event if the process dies in between |
| ✅ Pointer tickets + conditional claim | One source of truth; stale, duplicate and redelivered tickets all resolve the same way | A database read per ticket |
| ✅ Retries in PostgreSQL + scheduler | Any delay, cancellable, fair, visible | Scheduler polling |
| ❌ RabbitMQ delay queues | No extra process | Fixed tiers, can't cancel, floods on recovery |
| ✅ Per-endpoint semaphore + park + capped dispatch | A dead endpoint holds ≤ N slots | A write per parked ticket; Valkey on the hot path |
| ❌ Queue per endpoint / wait in worker | Simple to describe | 300k queues, or one endpoint holds every worker |
| ✅ Window from first attempt, full jitter | Platform outages don't spend the budget; no retry storms | Total retry time can exceed 3 days from creation |
| ✅ No ordering; per-key sequence numbers | Full concurrency; receivers discard stale updates | Receivers do the ordering |
| ❌ Strict per-endpoint FIFO | Simple for receivers | 1/RTT throughput; head-of-line blocking |
| ✅ Replay = new attempt, same event id | Dedupe and references stay valid | "Send as new" needs a new emit |
| ✅ Vet IP at connect, pin it, no redirects | Defeats DNS rebinding and redirect tricks | Custom connect logic |
| ✅ Console polling 1.5-3 s | One read path, one access check | Seconds of staleness; read load at scale |

---

## 📝 Wrap-up (~1 min)

> "The platform never promises exactly-once. It promises at-least-once with a stable event id, and both the backend and the screen are built around being honest about that. PostgreSQL decides everything. The outbox means 'accepted' can't be lost, and the conditional claim makes every duplicate ticket harmless. Retries wait as timestamps in rows, so they can be cancelled, kept fair and shown on screen. A fleet-wide slot per endpoint means one customer's six-hour outage costs everyone else nothing measurable. The console shows every attempt, including the ones whose outcome we don't know, and replay reuses the event id so receivers stay correct. Next steps: sharding by org, a ready-endpoints index for the scheduler, and SSE invalidations for the console."

### How the local implementation compares

| Production | Local |
|------------|-------|
| Org-sharded PostgreSQL, day partitions | One PostgreSQL 16 |
| CDC on the outbox | Polling publisher woken by LISTEN/NOTIFY |
| RabbitMQ cluster | Single-node RabbitMQ with a quorum queue |
| Retries over 3 days (base 30 s, cap 6 h) | Base 1 s, cap 20 s, 180 s horizon |
| Fixed-IP egress, https only, KMS-encrypted secrets | Allowlisted mock-receiver port, plain http, plain columns |
| Customers' servers | A mock receiver with slow, 500, drop-ack, 429 and 410 toggles |

Two API instances, one publisher, two workers with 16 concurrent requests each, and one scheduler run against the mock receiver. A demo script emits 8 events per second per org, so the full retry → exhausted → disabled story plays out in about three minutes. The claim, lease takeover, semaphore, parking, full-jitter backoff, SSRF vetting with the pinned sender (29 unit tests), signing with rotation, and the console with replay and receiver toggles are all implemented. They were verified end to end, including by killing a worker mid-attempt and stopping the broker mid-run.
