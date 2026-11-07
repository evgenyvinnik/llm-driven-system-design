# Webhook Platform — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → Intake → Delivery → Retries → Deep dives → Traces → Scale*

> "The prompt is: customers register URLs, we send them HTTP notifications when events happen, retry failures, keep history and support replay. Before drawing boxes I want to name the trap. Putting a queue in the middle does not give exactly-once delivery. The last hop is an HTTP request to a server we don't control, and if its 200 gets lost after it committed, only the receiver knows the event was handled. So my contract is at-least-once, with a stable event id on every attempt so receivers can dedupe. Everything else in the design serves three goals: never lose an accepted event between our own components; never let one customer's broken endpoint slow down another customer; and never let a customer-supplied URL reach inside our network."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | At-least-once is the contract; isolation and SSRF are first-class |
| Architecture | ~5 min | PostgreSQL decides, the queue carries pointers, retries wait in the database |
| Data model and API | ~5 min | Immutable events, deliveries, append-only attempts, outbox |
| Intake and delivery path | ~8 min | Idempotent emit + outbox in one transaction; claim → slot → sign → vet → send → record |
| Deep dives | ~12 min | Lost acks and dedupe; the six-hour outage; where retries wait |
| Traces, checklist, follow-ups | ~7 min | One success, one failure, six review questions, ordering and replay |
| Scale and wrap-up | ~3 min | Database writes break first, with a measured number |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who emits events, and do they retry? | Decides intake idempotency | Customers' backends call our API inline and retry on timeouts. Every emit carries an Idempotency-Key |
| Is exactly-once required? | It's impossible over HTTP; I want to say so early | At-least-once. Receivers dedupe by event id. We document it and ship a snippet |
| How long do we keep retrying? | Sets the retry horizon and storage | 3 days, then mark failed, disable the endpoint and notify the customer |
| Is ordering required? | Changes the whole delivery model | Not by default. Offer per-key sequence numbers. Discuss strict FIFO as an expensive opt-in |
| Who controls the URLs? | SSRF | Customers, fully, including DNS. Treat every URL as hostile |
| Can one customer be huge? | Isolation and per-endpoint limits | Yes. Some endpoints take thousands per second, some are down for days |

### Functional requirements

1. Emit an event with an Idempotency-Key. Events are immutable (id, type, payload, created time, optional ordering key and sequence).
2. Manage endpoints: URL, event-type filter, concurrency limit, enable/disable, signing secret with rotation.
3. Fan out one delivery per matching active endpoint.
4. Deliver signed requests at least once, with backoff and full jitter, up to a horizon. Then fail, disable and notify.
5. Classify failures: retry 5xx, 408, 429 with Retry-After, timeouts and connection errors. Stop on 410, invalid URL and SSRF-blocked, and disable. Other 4xx fail that delivery only.
6. Record every attempt: status, latency, error class, next attempt time, truncated body.
7. Replay one delivery or "all failed since T", as new attempts for the same event id.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Intake | p99 < 100 ms to a durable commit; 99.99% | Thin synchronous path: one transaction, no broker call |
| Durability | Zero accepted events lost | Outbox, not dual writes |
| Healthy-endpoint latency | p50 < 1 s emit → first attempt | Event-driven publisher and workers, no batch polling |
| Isolation | A dead or hanging endpoint moves others' p99 by < 10% | Per-endpoint caps; retries out of the shared queue |
| Retry horizon | 3 days | Durable retry state with arbitrary delays |
| Security | No request to private, loopback, link-local or metadata addresses | Vet at connection time, pin the IP, no redirects |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Events | ~500M/day, ~5,800/s average, ~30k/s peak | Illustrative large API platform |
| Deliveries | ~750M/day, ~9k/s average, ~45k/s peak | ~1.5 matching endpoints per event |
| Endpoints | ~300k; 1-2% down at any time | Their backlog is millions of waiting deliveries |
| Concurrent outbound requests | ~3k average, ~15k peak | 9k/s × ~0.3 s receiver latency; slow receivers capped |
| Payload storage | ~1 TB/day, 30-day retention | 2 KB average, partitioned by day |

> "The queue is not the hard part at these numbers. Fifty thousand small messages a second is routine for RabbitMQ or Kafka. The two things that actually hurt are the database writes per delivery, which I'll measure later, and the open sockets held by slow receivers. Those two numbers decide most of the design."

---

## 🏗️ High-Level Architecture (~5 min)

```
 Producers ──POST /events + Idempotency-Key──▶ ┌─────────────────────────────┐
                                               │ Intake API (N)               │
 Console ───────────session──────────────────▶ │ ONE txn: event + deliveries  │
                                               │          + outbox rows       │
                                               └──────────────┬──────────────┘
                                                              ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ PostgreSQL (sharded by org): events · deliveries · attempts · endpoints ·    │
 │ outbox · notifications             ◀── source of truth for every state ──▶  │
 └──────┬─────────────────────────────────┬─────────────────────────▲──────────┘
        │ unpublished outbox rows          │ due retries (fair,       │ claim + record
        ▼                                  ▼  per endpoint)           │ (fenced by lease)
 ┌────────────────┐               ┌────────────────────┐             │
 │ Outbox         │               │ Retry scheduler     │             │
 │ publisher      │               │ writes outbox rows  │             │
 └───────┬────────┘               └─────────┬──────────┘             │
         ▼ ticket {deliveryId, dispatchSeq} ▼                         │
 ┌────────────────────────────────────────────────────┐              │
 │ RabbitMQ quorum queue: only work that is due NOW    │              │
 └──────────────────────────┬─────────────────────────┘              │
                            ▼                                         │
 ┌────────────────────────────────────────────────────────────────────┴───────┐
 │ Delivery workers (N): claim → endpoint slot (Valkey semaphore) → sign →     │
 │ resolve + vet IP → POST to pinned IP (no redirects, timeout) → classify →    │
 │ record attempt + next state → ack                                            │
 └──────────────────────────┬──────────────────────────────────────────────────┘
                            ▼  fixed-IP egress, no route inward
                   Customer endpoints
```

> "I'll make three choices up front and defend them in the deep dives. First, PostgreSQL is the only source of truth. A queue message is just a pointer, a delivery id and a dispatch number, and the worker re-reads and claims the row. Second, retries never wait in the queue. A delivery waiting for its next attempt is a row with a next-attempt timestamp, and a scheduler puts it back in the queue when it's due. Third, every endpoint has a fleet-wide in-flight limit. When a worker can't get a slot, it parks the delivery back in the database in milliseconds, so a dead endpoint can never hold more than its own handful of worker slots."

---

## 💾 Data Model (~3 min)

| Table | Key columns | Indexes / constraints | Notes |
|-------|-------------|-----------------------|-------|
| events | id (evt_ ULID), org_id, type, payload JSONB, ordering_key, sequence, idempotency_key, request_hash | UNIQUE (org_id, idempotency_key) | Immutable. The hash detects a key reused with a different body |
| ordering_sequences | (org_id, ordering_key) PK, last_sequence | — | Upserted in the emit transaction: gap-free per key |
| endpoints | id, org_id, url, event_types[], status, max_concurrency, secret_current, secret_previous, previous_expires_at, consecutive_failures, failing_since, paused_until | (org_id) | Health and rotation live on the row |
| deliveries | id, event_id, endpoint_id, state, dispatch_seq, attempt_count, next_attempt_at, window_started_at, retry_deadline, lease_token, lease_until | UNIQUE (event_id, endpoint_id); partial (endpoint_id, next_attempt_at) WHERE scheduled; partial (endpoint_id) WHERE queued/in_flight | States: queued → in_flight → delivered / scheduled / failed |
| attempts | delivery_id, attempt_no, trigger, started_at, latency_ms, status_code, error_class, outcome, next_attempt_at, worker_id, resolved_ip | (delivery_id, id) | Append-only. Outcome includes "lost" and "superseded" for honesty about crashes |
| outbox | id, delivery_id, dispatch_seq, published_at | partial (id) WHERE unpublished | Marked per row, never by checkpoint |
| notifications | org_id, endpoint_id, kind, body, read_at | (org_id, created_at) | Written in the same transaction that disables an endpoint |

> "I separate what happened from what we tried. An event is a fact and never changes. A delivery is our obligation to one endpoint. Attempts are the evidence. When a customer asks 'did you send it?', the attempts table answers with timestamps, status codes and the IP we connected to."

---

## 🔌 API Design (~2 min)

```
POST /api/v1/events                       Bearer API key; Idempotency-Key required
                                          201 created · 200 + Idempotent-Replayed · 409 key reused · 413 too large
GET  /api/v1/events · /events/:id         event log; one delivery per matched endpoint
POST /api/v1/endpoints                    create; URL vetted (422 SSRF_BLOCKED); returns the secret
PATCH /api/v1/endpoints/:id               url, filter, concurrency
POST /api/v1/endpoints/:id/enable|disable
POST /api/v1/endpoints/:id/rotate-secret  overlap window: both secrets sign until it ends
GET  /api/v1/endpoints/:id/deliveries     delivery log with last result and next attempt
POST /api/v1/endpoints/:id/replay         replay all failed since T (409 while disabled)
GET  /api/v1/deliveries/:id               delivery + every attempt
POST /api/v1/deliveries/:id/replay        same event id, new attempt (202)
GET  /api/v1/ops/overview                 operator: queue depth, outbox lag, in-flight per endpoint
```

On the wire every request carries `Webhook-Id` (the event id, the dedupe key), `Webhook-Signature` with a timestamp and one or two v1 HMACs, `Webhook-Attempt`, and the ordering key and sequence when present.

---

## 📥 Intake: idempotent emit, fan-out and outbox (~4 min)

The emit is one PostgreSQL transaction:

1. Take a transaction-scoped advisory lock on (org, Idempotency-Key). Five concurrent retries of the same emit serialise here instead of racing on the unique constraint.
2. Look up (org, key). Same request hash → return the original event and its deliveries with `200` and `Idempotent-Replayed: true`. Different hash → `409`, because the client has a bug and quietly returning the old event would hide it.
3. If there is an ordering key, upsert its counter and take the next sequence number.
4. Insert the event, match the org's active endpoints against their filters (`*`, `order.*`, exact types), insert one queued delivery per match, insert one outbox row per delivery, and NOTIFY the publisher. The notification is delivered only at commit.

> "Success means that commit. I never call the broker from the request path. Publish-then-commit can announce an event that then rolls back. Commit-then-publish loses the event if the process dies between the two lines, and that window is real at fifty thousand requests a second. With the outbox, the event, its deliveries and the 'please publish this' rows are one atomic write. The publisher is a separate loop: it claims unpublished rows with SKIP LOCKED, publishes on a confirm channel, waits for the broker's confirms, then marks each row. If it dies after publishing but before marking, the next pass publishes again. That duplicate is harmless because of how workers claim."

---

## 🚚 Delivery path (~4 min)

For each ticket a worker does four things:

1. **Claim.** A conditional update: set in_flight with a fresh lease token, only if the row is still queued with the ticket's dispatch number. A stale ticket (the delivery was replayed or rescheduled) or a duplicate ticket (outbox republish) matches nothing and is dropped. A ticket RabbitMQ redelivered may take over an in_flight row, since redelivery means the previous consumer's channel died. The previous attempt is recorded as "lost, outcome unknown".
2. **Gate on the endpoint.**
   - Disabled: fail the delivery.
   - Paused by a 429: park until the pause ends.
   - No free slot in its Valkey semaphore: park for a few hundred milliseconds.

   Parking writes "scheduled, next attempt at now plus delay" and acks the ticket.
3. **Attempt.** Sign `timestamp.body` with the current secret (and the previous one during a rotation overlap). Resolve the host, vet every address, connect to the vetted IP with the original name in Host and SNI, no redirects, one deadline for the whole request.
4. **Record.** In one transaction fenced on the lease token: insert the attempt, set the next state, update endpoint health, maybe disable. Then ack.

> "The ack comes last, after the commit. If the worker dies anywhere before that, the ticket is redelivered and the delivery is attempted again. That is exactly where at-least-once comes from, and I'm fine with it, because the alternative, acking first, turns a crash into a lost delivery."

---

## ⏱️ Retries and failure classification (~3 min)

| Result | Class | Action |
|--------|-------|--------|
| 2xx | ok | Delivered; clear the endpoint's failure streak |
| 5xx, 408, 425 | server error | Retry with full jitter |
| 429 | rate limited | Wait exactly Retry-After (clamped to 1 h); pause the whole endpoint until then |
| Timeout, reset, refused, DNS failure | transport | Retry |
| 410 Gone | gone | Stop now, fail, disable the endpoint, notify |
| Invalid URL, SSRF-blocked | unsafe | Stop now, fail, disable, notify |
| 3xx | redirect | Fail; redirects are never followed |
| Other 4xx | rejected | Fail that delivery only; endpoint stays enabled |

- **Backoff:** attempt n waits a uniform random time between zero and min(cap, base × 2^(n−1)). Production uses base 30 s and cap 6 h; locally 1 s and 20 s.
- **Horizon:** 3 days. The window opens at the delivery's first attempt, not at event creation.
- **Disable:** when a delivery exhausts its window and the endpoint hasn't had a single success since that window opened. The endpoint's waiting deliveries are failed and an in-app notification is written in the same transaction.
- **Probe mode:** after five consecutive failures the endpoint's effective limit drops to one request at a time; the first success restores it.

> "Two of those rules came from running the system, not from the whiteboard. I originally measured the window from event creation. Then my laptop slept for two minutes mid-demo, the first attempt after waking was already past the deadline, and one connection reset disabled a healthy endpoint. A platform outage was spending the customer's retry budget. Now the window opens at the first attempt. The second: after the same sleep, the database VM's clock lagged the host by about three seconds, and every retry fired three seconds late, because workers computed timestamps on their clock and the scheduler compared them with the database's. Now workers only decide the delay; the database turns it into now() plus delay. One clock for scheduling."

---

## 🔐 Signatures and SSRF (~2 min)

**Signatures.** HMAC-SHA256 over the timestamp, a dot, and the raw body; the header is `t=…,v1=…`. Putting the timestamp inside the signed bytes means a captured request can't be refreshed. Receivers reject timestamps more than 5 minutes off, and event-id dedupe covers replays inside the window. On rotation the old secret keeps signing next to the new one for an overlap window (24 h in production), so each request carries two v1 values. A receiver that still has the old secret verifies, and so does one that already has the new secret. After the overlap only the new one is sent, and an old-secret-only receiver starts returning 401. That 401 is a permanent 4xx, so those deliveries fail fast and are replayed after the receiver is updated.

**SSRF.** The rule that matters is *vet at connection time and connect to what you vetted*:

- **Parse with the WHATWG URL parser**, which normalises decimal, hex and octal IPv4 spellings before we look at them.
- **Refuse internal names**, then resolve and check every returned address against private, loopback, link-local and metadata, CGNAT, multicast and reserved ranges, for both IPv4 and IPv6. IPv4-mapped, NAT64 and 6to4 forms are unwrapped.
- **Open the socket to that exact IP.**
- **Never follow redirects.**

Registration runs the same check to catch mistakes early, but it is not the boundary: the customer controls DNS and can repoint the name a minute later. A blocked target disables the endpoint. In production the workers also egress through fixed IPs with no route inward, as a second layer.

> "Locally the mock receiver lives on localhost, so there's an explicit allowlist of exact host:port pairs, defaulting to only the receiver's port. 127.0.0.1 on any other port is still blocked; the end-to-end test checks it against PostgreSQL's port."

---

## 🔧 Deep Dive 1: The lost acknowledgment, and why this is at-least-once (~4 min)

**Decision.** At-least-once delivery with a stable `Webhook-Id` (the event id) on every attempt, replays included. Receivers must dedupe, and we document it with a verification and dedupe snippet.

**Why it works here.** The failure the interviewer is fishing for is this:

1. The receiver gets the request, writes to its database and commits.
2. Its 200 is lost: a load balancer idle timeout, a reset, or our worker crashing before it reads the response.

From our side that is indistinguishable from "never arrived", so the only safe move is to send it again. With a stable event id, the receiver's handler checks "have I processed evt_…?" (a unique constraint on processed event ids is enough), answers 200, and does nothing else. The event is applied once even though it was delivered twice. We built exactly this into the mock receiver: a drop-ack toggle that processes the event and then closes the socket. Attempt 1 records a connection reset and schedules a retry. Attempt 2 arrives with the same Webhook-Id, the receiver flags it as a duplicate and acks it, and the attempt is recorded as delivered. Killing a worker mid-request produces the same pattern from our side: RabbitMQ redelivers the unacked ticket, another worker takes over the lease, the lost attempt is logged as "outcome unknown", and the receiver sees a duplicate.

**Why the alternative fails.** "Exactly-once because we use a queue" confuses two hops. RabbitMQ's acks and Kafka's transactions give exactly-once processing *inside our system*: one worker handles a ticket, and the outbox ensures nothing is dropped between our database and our broker. The HTTP hop to a stranger's server has no transaction, so no protocol can make "they committed" and "we know they committed" atomic. Any design that suppresses retries to avoid duplicates turns every lost ack into a lost event, which is strictly worse for a payment notification. Trying to dedupe on our side ("we already got a 200 once") doesn't help either: the case that matters is when we never got the 200.

**What we give up.** Every customer has to write dedupe logic, and some won't, so they'll occasionally double-apply during incidents. We mitigate with the docs snippet, the dedupe key in a header rather than buried in the payload, sequence numbers for state-change events, and a console that shows "Outcome unknown" and duplicate counts honestly instead of pretending. In steady state duplicates are rare (lost acks plus worker crashes); during an incident they can spike, and the contract says so.

---

## 🔧 Deep Dive 2: One customer's endpoint is down for six hours (~4 min)

**Decision.** Three mechanisms together:

1. Retries wait in PostgreSQL, not in the shared queue.
2. Each endpoint has a fleet-wide concurrency limit enforced by a Valkey semaphore; when a worker can't get a slot it parks the delivery back in the database.
3. The scheduler dispatches fairly: per endpoint, at most its spare capacity (limit minus what is already queued or in flight), and only one probe at a time after five consecutive failures.

**Why it works here.** "Down" comes in two flavours, and the second is the dangerous one.

- **A fast 500** costs us a quick request. Backoff keeps the rate low, and the endpoint's backlog sits in the database as scheduled rows, invisible to everyone else.
- **A hang**, where the receiver accepts the connection and never answers, holds a worker slot for the full timeout. Without a cap, a few thousand deliveries to one hanging endpoint would occupy every worker, and every other customer would queue behind them.

With the cap, that endpoint can hold at most its limit of requests (one in probe mode) across the whole fleet. Its other tickets cost a worker a few milliseconds each: claim, failed acquire, park, ack. The scheduler then stops feeding more of that endpoint's work into the queue, because it has no spare capacity.

I measured it with the bundled demo: Globex's main endpoint hung (answering after 30 s against a 3 s timeout) while both customers emitted events. Acme's event-to-delivered latency stayed at p50 about 10 ms and p90 about 12-14 ms, against a baseline of p50 12 ms and p90 15-25 ms. The receiver never saw more than 4 concurrent requests on the hanging path, and about 55 Globex deliveries sat in PostgreSQL instead of the queue.

**Why the alternatives fail.**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Shared queue + per-endpoint semaphore + park + fair dispatch | One queue; a dead endpoint holds ≤ N slots; its backlog lives in the database | Parking costs a database write; needs a scheduler |
| ❌ Shared queue, no per-endpoint limit | Simplest | Hanging endpoint occupies every worker; head-of-line blocking for everyone |
| ❌ Requeue the ticket when the endpoint is busy | No database write | Spins on the same messages, burns broker and worker CPU, starves fresh work |
| ❌ Wait in the worker for a slot | No re-dispatch | A worker blocked on one endpoint is a worker lost to everyone |
| ❌ One queue per endpoint | Natural isolation | 300k queues; still needs a fair scheduler across them; heavy on the broker |
| ❌ Retries in RabbitMQ delay queues | No scheduler | Due retries flood the shared queue in waves; can't cap per endpoint |

**What we give up.** A scheduler process and polling load on the database, kept cheap with partial indexes and one capacity-aware query per tick. A semaphore in Valkey: if Valkey is down, ticket handling errors and tickets are requeued, so delivery pauses but nothing is lost. A busy endpoint's tickets each cost a park write. There is also an honest gap for the six-hour case: with a 6 h backoff cap, a recovered endpoint's deliveries may wait hours for their next scheduled attempt. A "retry waiting deliveries now" action, or shortening backoff after the first success, would fix that; replay already covers failed ones.

---

## 🔧 Deep Dive 3: Where retries wait, and how nothing is lost between components (~4 min)

**Decision.** Retry state lives in PostgreSQL (`next_attempt_at` on the delivery row), a scheduler moves due deliveries back into the queue through the same outbox path as first attempts, and queue messages are pointers claimed conditionally.

**Why it works here.** Retries need things a broker is bad at:

- **Arbitrary delays.** Full jitter draws a different delay for every delivery, and a 429's Retry-After is whatever the receiver says.
- **Cancellation.** Disabling an endpoint must fail its waiting deliveries, and replay must supersede an old ticket.
- **Fairness and visibility.** Due retries must be capped per endpoint, and the console must show "next attempt in 37 s".

In the database all of these are one indexed `UPDATE` or `SELECT`. Every hand-off is covered:

- the emit writes the event, deliveries and outbox rows atomically;
- the publisher's republish after a crash is absorbed by the claim;
- a worker crash leaves an unacked ticket that RabbitMQ redelivers;
- a ticket that never comes back is caught by lease expiry and a scheduler sweep;
- a ticket lost inside the broker is caught by a stuck-queued sweep that re-dispatches with a new dispatch number, so the old ticket, if it ever shows up, is stale.

We also tested the broker going away: stop RabbitMQ, emit events (intake keeps returning 201, outbox rows wait), start it again. The publisher and workers reconnect and all deliveries complete. That test exists because the first version didn't reconnect. After the laptop slept past two heartbeats, every AMQP connection was dead and delivery stopped silently. Broker connections are now supervised with backoff.

**Why the alternative fails.** RabbitMQ per-message TTL only expires messages at the head of a queue, so one 6-hour message blocks the 1-second ones behind it. The workaround is fixed delay tiers (1 s, 10 s, 1 min, 10 min…) chained with dead-letter exchanges, which quantises the jitter and turns recovery into synchronised waves. A message sitting in a delay queue can't be found, cancelled or rescheduled, so "disable this endpoint" and "replay that delivery" become races. And the broker becomes a second source of truth for delivery state that can disagree with the database, which makes "did you send it?" unanswerable.

**What we give up.** About 6.6 row writes per delivery, measured with `pg_stat_database` around 100 deliveries. It was 8.0 until we stopped rewriting the API key's last-used time on every emit and the endpoint's health row on every success. We also need a scheduler and an outbox publisher to operate. At our scale those writes are the first thing that breaks, which is the scaling section.

---

## 🔀 Ordering and replay (~3 min)

**Ordering is not guaranteed by default.** Strict per-endpoint ordering means event n+1 can't be sent until event n is acknowledged:

- one request in flight per endpoint, capping throughput at about 1/RTT, around 5 events a second at 200 ms;
- one event that keeps failing blocks everything behind it for the whole three-day horizon;
- after a six-hour outage, every later event drains serially behind the backlog.

That is head-of-line blocking, and it is the opposite of the isolation we just built. Most consumers don't need global order. They need not to apply an older state over a newer one. So producers may pass an ordering key (say, `order_1042`). We assign a gap-free sequence per (org, key) inside the emit transaction and send it in the payload and headers. The receiver keeps the highest sequence applied per key and discards anything lower, or re-fetches current state when it sees a gap. Our end-to-end run demonstrates it: event A fails once and waits for its retry, B (sequence +1) is delivered first, and when A finally arrives the receiver marks it stale and ignores it. Strict FIFO could be a per-endpoint opt-in later, with concurrency 1 and the blocking cost stated plainly.

**Replay means a new attempt for the same event id, not a new event.** It moves the same delivery row back to queued, bumps its dispatch number (any old ticket becomes stale), opens a fresh retry window and writes an outbox row, all in one transaction. The attempt is logged with trigger "replay". Keeping the id means the receiver's dedupe still works: if it had applied the event, it acks and ignores; if it never got it, it applies it once. A new id would defeat dedupe and break every reference to the original event. Bulk replay ("all failed since T") does the same per row. Replay is refused while the endpoint is disabled, and replaying a delivery that is still pending returns 409.

---

## 🧪 Execution Traces (~4 min)

### ✅ Success: a dropped acknowledgment

1. Acme's order service POSTs `order.cancelled` with Idempotency-Key `order-102-cancelled`. The intake transaction takes the advisory lock, finds no prior event, inserts it, matches the orders endpoint (`order.*`) and the audit endpoint (`*`), inserts two queued deliveries and two outbox rows, commits and notifies. The producer gets 201 in about 10 ms.
2. The publisher wakes, claims both rows, publishes two pointer tickets on its confirm channel, waits for the broker's confirms, and marks the rows.
3. Worker 2 claims the orders delivery (queued → in_flight, lease token T1). The endpoint is active and unpaused, and it takes slot 1 of 4.
4. It signs `timestamp.body`, resolves the host to an allowed address, POSTs to the pinned IP with Webhook-Id `evt_…` and attempt 1.
5. The receiver verifies the signature, records `evt_…` as processed, applies it, then drops the connection without answering.
6. Worker 2 sees a reset: transport failure, retry. Full jitter draws 0.6 s. In one transaction fenced on T1 it inserts attempt 1 (connection error, will retry), sets the delivery scheduled with next attempt at database now plus 0.6 s, and bumps the endpoint's failure streak to 1. It releases the slot and acks.
7. The scheduler sees the delivery is due and the endpoint has spare capacity. It sets queued, bumps dispatch to 2 and writes an outbox row. The publisher sends ticket 2.
8. Worker 1 claims it, POSTs attempt 2, gets 200 with "duplicate: true" because the receiver recognised the event id and did not reapply it. It records attempt 2 delivered, clears the failure streak, and acks.

Delivered twice, applied once. That is the contract working.

### ❌ Failure: an endpoint down for its whole retry window

1. Acme's audit endpoint starts returning 500 for everything. A new event creates a delivery to it.
2. Attempt 1 fails at time W, so the window is W + 3 days (20 s in the test). Retries follow with jittered delays of up to 1 s, 2 s, 4 s and so on. After five consecutive failures the endpoint drops to one probe at a time, and other Acme deliveries to it park in the database.
3. An attempt fails and its next draw would land past the window, so the delivery is marked failed: retry window exhausted.
4. In the same transaction the endpoint's failure streak started at or before W, so it hasn't succeeded once in the window. The endpoint is disabled, its other waiting deliveries are marked failed, and a notification is written for Acme. New events stop fanning out to it.
5. Alice sees the badge, fixes the receiver and re-enables the endpoint (streak and pause cleared). A replay while it was still disabled got 409; after re-enabling, "replay all failed since T" queues the failed deliveries with fresh windows.
6. Each replayed delivery is attempted with trigger "replay" and delivered. The receiver sees each original event id once. No new events were created.

---

## ✅ Design Review Checklist

| Question | Answer |
|----------|--------|
| What is the source of truth, and when is a write successful? | PostgreSQL. An emit succeeds when the transaction holding the event, its deliveries and their outbox rows commits. An attempt counts when its row and the delivery's next state commit, and only then is the ticket acked. The queue holds rebuildable pointers; Valkey holds sessions and semaphores |
| What happens when a client retries after losing the response? | A producer retry with the same key gets the original event (200); a different body gets 409; concurrent duplicates serialise on an advisory lock. Our own retry to a receiver carries the same Webhook-Id, and the receiver dedupes |
| What happens when a worker or server fails between two important steps? | API after commit: the outbox row is published later. Publisher after publish, before mark: republished and dropped by the conditional claim. Worker mid-attempt: unacked ticket redelivered, lease taken over, lost attempt recorded, possible duplicate at the receiver. Worker after commit, before ack: redelivered ticket finds nothing to claim. Lost tickets: lease and stuck-queued sweeps |
| Which ordering or consistency guarantee is actually required? | No global or per-endpoint order. Per-key sequence numbers for receivers that care. Per-delivery transitions serialised by the conditional claim and the lease token |
| How is access enforced with caches, indexes or asynchronous jobs? | Every console query is scoped by the session's org (other orgs' ids are 404s). API keys map to one org. Workers act as the system and serve no user data. The receiver proxy filters to the caller's own endpoints. SSRF is enforced by the worker at connection time, not only at registration |
| What breaks first at much larger scale, and what's the evidence? | PostgreSQL writes: 6.6 row writes per delivery, measured, so ~60k/s at the average and ~300k/s at peak. Next, the scheduler scanning every active endpoint per tick. Then open sockets to slow receivers |

---

## ❓ Follow-ups

**A receiver processes an event but its acknowledgment is lost. What happens next?** We record a timeout or reset and retry with backoff. The next attempt carries the same Webhook-Id, so the receiver recognises it, returns 200 and doesn't reapply it. We never claim exactly-once; the receiver's dedupe is what makes the duplicate harmless (Deep Dive 1).

**One customer's endpoint is down for six hours. Can it block others?** No. Its retries wait in PostgreSQL, not in the shared queue. It can hold at most its concurrency limit of worker slots (one while probing), and its extra tickets are parked in milliseconds. Measured: the other customer's p50 didn't move (Deep Dive 2). If it's still down when its window runs out, it's disabled and the customer is notified.

**Do events require ordering? What does it cost?** Not by default. Strict per-endpoint order means one in flight per endpoint and head-of-line blocking: one bad event stalls everything behind it for days. Per-key sequence numbers let receivers discard stale updates without that cost.

**What does replay mean: the same event id, or a new event?** The same event id, as a new attempt on the same delivery with a fresh retry window. Receivers' dedupe and references stay valid.

**How should permanent failures differ from transient ones?** Transient (5xx, 408, 429, timeouts, connection and DNS errors) are retried with full jitter; 429 honours Retry-After and pauses the endpoint. Permanent stops at once. 410, invalid URL and SSRF-blocked also disable the endpoint, because nothing will ever succeed there. Other 4xx and redirects fail that delivery only: the same bytes will get the same answer, and the customer replays after fixing the handler.

**What if Valkey or RabbitMQ disappears?** Intake keeps accepting into the outbox while the broker is down. Workers and the publisher reconnect and drain; we tested it by stopping RabbitMQ mid-run. Without Valkey, ticket handling errors and tickets are requeued after a pause, so delivery pauses without loss.

---

## 📈 Scalability (~3 min)

| What breaks | When | Evidence | Fix |
|-------------|------|----------|-----|
| PostgreSQL writes | ~9k deliveries/s average, 45k/s peak | 6.6 row writes per delivery, measured with pg_stat_database | Shard by org (every hot query is per org or endpoint); CDC on the outbox instead of the mark write; attempts to an append-only store with a summary on the delivery row |
| Scheduler scan | ~300k endpoints scanned per 250 ms tick | One lateral query per tick walks all active endpoints | A "ready endpoints" sorted set keyed by next due time; shard schedulers by endpoint hash |
| Sockets to slow receivers | 15k+ concurrent at peak, more in incidents | Concurrency = rate × receiver latency; hangs hold sockets for the timeout | Per-endpoint caps already bound it; a separate worker pool for probing endpoints; keep-alive pools for healthy ones |
| One hot endpoint | A customer at thousands/s | Limit defaults to 4 | Per-endpoint limit is configurable; nothing else changes |
| Queue | Well beyond 50k msgs/s | Retries never sit in it, so depth equals real load | Partition by endpoint hash or move to Kafka keyed by endpoint |

> "The single number I'd monitor is writes per delivery. It's the cost driver, it's measurable, and every optimisation I listed moves it."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Guarantee | At-least-once + Webhook-Id dedupe | Exactly-once | Impossible across the HTTP hop; suppressing retries loses events |
| DB → broker | Transactional outbox, per-row marks | Publish after commit | No loss between commit and publish; duplicates absorbed by the claim |
| Queue message | Pointer + dispatch number | Payload + retry state | One source of truth; stale and duplicate tickets are harmless |
| Retry wait | PostgreSQL next_attempt_at + scheduler | RabbitMQ TTL/DLX tiers | Arbitrary delays, cancellable, fair, visible |
| Isolation | Per-endpoint semaphore + park + fair dispatch | Shared queue alone / queue per endpoint | A dead endpoint holds ≤ N slots; no head-of-line blocking |
| Backoff | Full jitter; window from first attempt; disable after a full window of failure | Fixed intervals; window from creation | No retry storms; platform outages don't spend the customer's budget |
| Other 4xx | Permanent for that delivery | Retry all non-2xx | Same bytes, same answer; replay after the fix |
| Ordering | Per-key sequence numbers | Strict FIFO per endpoint | FIFO caps throughput and blocks on one bad event |
| Replay | Same event id, new attempt | New event | Keeps dedupe and references valid |
| Signing | HMAC over timestamp.body, two secrets during overlap | Single secret swap | Rotation without a coordinated deploy |
| SSRF | Vet every resolved IP at connect, pin, no redirects | Registration-time check | DNS rebinding defeats registration checks |
| Scheduling clock | Database now() only | Host clocks | Skew can't shift retries |

> "To wrap up: the platform promises at-least-once and makes duplicates cheap to detect. It never loses an accepted event, because the event, its deliveries and the publish intent commit together and every later step is idempotent. One customer's outage stays that customer's problem: retries live in the database, and each endpoint has its own in-flight budget. And it treats customer URLs as hostile at the moment of connection. The local build runs all of it: two API instances, the outbox publisher, two workers, the scheduler and a mock receiver that can drop acks, hang, 500, 429 and 410 on demand. An 80-check end-to-end script exercises every one of those paths against the real stack."
