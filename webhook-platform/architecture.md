# Webhook Platform - Architecture

## System Overview

A platform that delivers HTTP notifications to URLs registered by its customers. A customer's systems emit events (`order.created`, `invoice.paid`) through an API. The platform stores each event once and fans it out to every endpoint whose filter matches. It signs and sends each request, retries failures with backoff, keeps a full delivery history and lets the customer replay anything. The payment-system and stripe projects in this repository deliver webhooks as one component; here delivery is the whole product.

Five problems make this harder than "POST in a loop":

1. **Delivery is at-least-once, never exactly-once.** A receiver can process an event and lose the connection before we read its 200. From our side that is a timeout, so we must send it again. The receiver dedupes by event id. Any design that claims exactly-once because "there is a queue" is wrong: the queue's guarantees end at our worker, and the HTTP hop to a stranger's server has no transaction around it.
2. **One customer must not hurt another.** An endpoint that is down for six hours, or worse hangs for 30 seconds per request, must not consume the worker capacity or the queue position that other customers' deliveries need.
3. **We make requests to URLs that customers type in, from inside our network.** Without care, `http://169.254.169.254/` reads cloud credentials (SSRF).
4. **Failures differ.** A 503 should be retried, a 410 means "stop", a 400 will never succeed. Retrying everything for three days is wasteful; retrying nothing loses data.
5. **Hand-offs can lose events.** "Commit to the database, then publish to the broker" loses the event if the process dies between the two steps.

**Learning goals:** transactional outbox, idempotent consumers and lease fencing; per-tenant isolation in a shared queue; backoff with full jitter and retry horizons; HMAC signatures with key rotation and replay windows; SSRF defence at connection time; separating "what happened" (events) from "what we tried" (attempts).

**Signal.** OpenAI, community attribution (not verified). See [CLAUDE.md](./CLAUDE.md).

## Requirements

### Functional Requirements

1. **Emit events.** Producers POST an event with an `Idempotency-Key`. A retried emit returns the original event, not a second one. Events are immutable: `event_id`, type, payload, creation time, and an optional ordering key with a sequence number.
2. **Manage endpoints.** URL, event-type filter (`*`, `order.*`, exact types), per-endpoint concurrency limit, enable/disable, signing secret with rotation.
3. **Fan out.** One delivery per (event, matching active endpoint).
4. **Deliver at least once.** Sign each request, retry transient failures with exponential backoff and full jitter until a retry horizon, then mark the delivery failed. Disable an endpoint that has failed for the whole horizon, and notify the customer.
5. **Classify failures.** Retry 5xx, 408, 429 (honouring `Retry-After`), timeouts, connection and DNS errors. Stop on 410 (and disable), invalid URL and SSRF-blocked (and disable), redirects and other 4xx (that delivery only).
6. **Record every attempt:** status code, latency, error class, next attempt time, truncated response body, worker, resolved IP.
7. **Replay** a single delivery or "all failed since T" for an endpoint. Replay creates new attempts for the same event id, never a new event.
8. **Console** for customers (endpoints, health, event log, delivery log, replay, notifications) and an operator view (queue depth, in-flight per endpoint, success rate).

### Non-Functional Requirements

| Property | Target | Why |
|----------|--------|-----|
| Intake availability | 99.99% | Producers are our customers' order and billing systems; they block or drop on our errors |
| Intake latency | p99 < 100 ms to a durable commit | Producers emit inline in their own request path |
| Durability | Zero accepted events lost | A lost `invoice.paid` is a support ticket and possibly money |
| Delivery latency (healthy endpoint) | p50 < 1 s, p99 < 5 s from emit to first attempt | Customers build workflows on webhooks (fulfil on payment) |
| Isolation | A down or hanging endpoint changes other customers' p99 by < 10% | The headline promise of a shared platform |
| Retry horizon | 3 days, then disable and notify | Covers a long weekend outage at the receiver |
| Duplicate rate | < 0.1% of deliveries in steady state, unbounded during incidents | At-least-once is the contract; receivers dedupe |
| Delivery history | 30 days searchable | Debugging "did you send it?" |
| Security | No request ever reaches a private, loopback, link-local or metadata address | SSRF is a full-compromise class bug |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Customer orgs with webhooks | ~100,000 | Illustrative for a large API platform |
| Endpoints | ~300,000 | ~3 per org (prod, staging, an integration) |
| Events | ~500M/day ≈ 5,800/s average, ~30,000/s peak | Peaks at batch jobs and incident fan-outs |
| Fan-out | ~1.5 deliveries per event | Most events match one endpoint; some match several |
| Deliveries | ~750M/day ≈ 8,700/s average, ~45,000/s peak | 500M × 1.5 |
| Attempts | ~1.1 per delivery normally; 10-15 for a delivery to a dead endpoint | Jittered exponential backoff over 3 days |
| Payload | ~2 KB average, 256 KB max | JSON objects |
| Event storage | ~1 TB/day, ~30 TB for 30 days | 500M × 2 KB; partitioned by day, old partitions dropped |
| Attempt rows | ~0.3 TB/day | ~1B rows × 300 B |
| Concurrent outbound requests | ~3,000 average, ~15,000 peak | 9k/s × ~0.3 s median receiver latency; slow receivers are capped per endpoint |
| Down endpoints at any moment | ~1-2% | Their backlog: up to a few million waiting deliveries |

The numbers say this is a write-heavy OLTP problem plus a large outbound HTTP fan-out. The queue is not the bottleneck: tens of thousands of small messages per second is routine for RabbitMQ or Kafka. The database writes per delivery and the number of open sockets to slow receivers are.

### Local Development Scale

Two orgs, five endpoints on one mock receiver, two delivery workers with 16 concurrent requests each, one publisher, one scheduler, two API instances. The demo load script emits 8 events per second per org. Retry timing is compressed: a 1 s backoff base, a 20 s cap and a 180 s horizon (production: 30 s, 6 h and 3 days), so the full retry → exhausted → disabled story plays out in about three minutes.

## High-Level Architecture

```
 Customer producers                                   Customer consoles (browser)
 (order, billing systems)                                       │
        │ POST /v1/events + Idempotency-Key                     │ session
        ▼                                                       ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ API gateway: auth (API keys, sessions), rate limits, payload caps         │
 └──────────────┬────────────────────────────────────────────┬──────────────┘
                ▼                                            ▼
 ┌──────────────────────────────┐            ┌──────────────────────────────┐
 │ Intake service (N)            │            │ Console API (N)               │
 │ ONE transaction:              │            │ endpoints, event log,         │
 │  event (unique org+key)       │            │ delivery log, replay, secrets │
 │  + deliveries (fan-out)       │            └──────────────┬───────────────┘
 │  + outbox rows                │                           │
 └──────────────┬───────────────┘                           │
                ▼                                            ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ PostgreSQL, sharded by org: events · deliveries · attempts · endpoints ·  │
 │ outbox · notifications      (source of truth for every state change)     │
 └───────┬──────────────────────────────────┬───────────────────────▲───────┘
         │ unpublished outbox rows           │ due retries            │ claim, record
         ▼                                   ▼ (per-endpoint fair)    │ (fenced)
 ┌──────────────────┐              ┌──────────────────────┐          │
 │ Outbox publisher │              │ Retry scheduler      │          │
 │ (confirm channel)│              │ next_attempt_at ≤ now│          │
 └────────┬─────────┘              └──────────┬───────────┘          │
          │ ticket {deliveryId, dispatchSeq}  │ (writes outbox rows)  │
          ▼                                   ▼                       │
 ┌──────────────────────────────────────────────────────┐            │
 │ RabbitMQ quorum queue "deliveries" (only work due now)│            │
 │ poison tickets → deliveries.poison                     │            │
 └────────────────────────┬─────────────────────────────┘            │
                          ▼                                           │
 ┌──────────────────────────────────────────────────────────────────┴──────┐
 │ Delivery workers (N): claim → per-endpoint slot (Valkey semaphore) →     │
 │ sign → resolve + vet IP → POST (pinned, no redirects, timeout) →         │
 │ classify → record attempt + next state → ack                             │
 └────────────────────────┬─────────────────────────────────────────────────┘
                          │ egress proxy / NAT with fixed IPs
                          ▼
                 Customer endpoints (the internet)
```

Three ideas carry the design:

1. **PostgreSQL decides, the queue only carries tickets.** Every state change (event, delivery, attempt, retry time) is a database row. A RabbitMQ message is a pointer `{deliveryId, dispatchSeq}`. Workers re-read and claim the row, so duplicate, stale and redelivered tickets are harmless. If the broker lost everything, a sweep could rebuild the queue from the database.
2. **Retries wait in the database, not in the queue or in a worker.** The queue only holds work that is due now. A delivery waiting for its next attempt is a row with `next_attempt_at`, and a scheduler moves it back into the queue when due.
3. **Every endpoint has its own in-flight limit across the whole fleet.** A worker that can't get a slot for an endpoint parks the delivery back in the database and moves on. A dead endpoint can occupy at most its own limit of worker slots and never sits in front of anyone else in the queue.

## Core Components

### 1. Intake: idempotent emit, fan-out and the outbox in one transaction

`POST /v1/events` with `Idempotency-Key` runs one transaction:

1. Take a transaction-scoped advisory lock on `hash(org, key)`, so concurrent retries of the same emit serialise.
2. Look up `(org_id, idempotency_key)`. If found with the same request hash, return the original event and its deliveries (`200`, `Idempotent-Replayed: true`). If found with a different hash, return `409 IDEMPOTENCY_KEY_REUSED`: the client has a bug, and silently returning the old event would hide it.
3. If the event has an ordering key, allocate the next sequence number for `(org, key)` with an upsert.
4. Insert the immutable event.
5. Select the org's **active** endpoints, match the event type against each filter, and insert one `queued` delivery per match.
6. Insert one outbox row per delivery and `NOTIFY` the publisher (delivered at commit).

**Success means the commit.** From then on the event, its deliveries and the outbox rows exist even if every other process dies. We never publish to the broker from the request path:

- publish-then-commit can announce an event that rolls back;
- commit-then-publish loses the event if the process dies in between.

### 2. Outbox publisher

The publisher claims unpublished outbox rows (`FOR UPDATE SKIP LOCKED`, so several publishers can run side by side), publishes one ticket per row on a confirm channel, waits for the broker's confirms, then marks the rows published and commits.

**If the publisher dies between publishing and committing,** the rows stay unpublished and are published again, so the queue gets two tickets for one dispatch. That is safe because the worker's claim is conditional (next section). The outbox gives at-least-once publishing; correctness comes from the idempotent consumer.

Rows are marked one by one (`published_at`), never with a "last published id" checkpoint: ids from concurrent transactions commit out of order, and a checkpoint would skip a row that committed late.

*Alternative considered:* change-data capture (Debezium tailing the WAL for outbox inserts). It removes the publisher's polling and the `UPDATE` per row, which matters at 45k deliveries/s. Locally the polling publisher with `LISTEN/NOTIFY` is simpler and has the same failure semantics.

### 3. The queue and the claim

The `deliveries` queue is a RabbitMQ **quorum queue** (replicated, durable). Tickets carry no payload. A worker handles a ticket like this:

```sql
-- claim: only the current dispatch of a queued delivery, or a redelivered ticket taking over
UPDATE deliveries SET state = 'in_flight', lease_token = $new, lease_until = now() + $lease, claimed_by = $worker
 WHERE id = $id AND dispatch_seq = $seq
   AND (state = 'queued' OR (state = 'in_flight' AND ($redelivered OR lease_until < now())))
RETURNING *;
```

- **Stale tickets** (the delivery was re-dispatched, replayed or finished) don't match `dispatch_seq` or `state` and are dropped.
- **Duplicate tickets** (outbox republished) find the row already `in_flight` and are dropped.
- **A redelivered ticket** (RabbitMQ only redelivers after the previous consumer's channel closed, so that worker died or lost the broker) may take over an `in_flight` delivery. It records the previous attempt as `lost`: the receiver may or may not have got it. The new `lease_token` fences the old worker: if it is in fact alive, its final write matches nothing and is logged as `superseded`.
- A ticket redelivered 10 times (a worker crashes on it every time) is dead-lettered to `deliveries.poison` by the quorum queue's delivery limit, instead of crash-looping the fleet.

The worker acks only after the attempt and the next state are committed.

### 4. Per-endpoint isolation

```
 shared queue:  [acme] [globex-down] [acme] [globex-down] [globex-down] [acme] ...
                    │          │
                    ▼          ▼
 worker:   claim ─▶ slot for this endpoint? ──yes──▶ attempt (holds 1 of the endpoint's N slots)
                              │
                              no (endpoint already has N requests open)
                              ▼
                    park: state = scheduled, next_attempt_at = now() + ~300 ms, ack   (milliseconds)
```

- **Concurrency semaphore per endpoint**, in Valkey: a sorted set of lease tokens scored by expiry, acquired with one Lua script (drop expired leases, add ours if fewer than `limit` remain). A worker that dies holding a slot leaks it only until the lease expires. The script uses the server's `TIME`, so worker clock skew doesn't matter.
- **Probe mode:** after 5 consecutive failures the effective limit drops to 1. A known-dead endpoint ties up one request at a time; the first success restores the full limit.
- **Parking instead of waiting.** A ticket for a saturated endpoint costs a worker a few milliseconds (claim, failed acquire, park, ack), never a blocked slot.
- **The scheduler dispatches fairly.** For each active, unpaused endpoint it takes that endpoint's earliest due deliveries, up to its spare capacity (limit minus what is already queued or in flight). A dead endpoint with 50,000 due retries puts at most a handful of tickets in the shared queue.

Measured locally: with globex-main hanging (accepting connections and answering after 30 s, past the 3 s timeout), Acme's event-to-delivered latency stayed at p50 10-13 ms and p90 12-44 ms. The baseline with both healthy was p50 12-15 ms and p90 16-36 ms. The receiver never saw more than 4 concurrent requests on the hanging path, and about 55 Globex deliveries waited in PostgreSQL rather than in the queue.

### 5. Retries: backoff with full jitter, horizon, disable

- **Delay** for attempt *n*: `uniform(0, min(cap, base · 2^(n-1)))`, the AWS "full jitter" scheme. Production uses base 30 s and cap 6 h; locally base 1 s and cap 20 s. When an endpoint recovers, the thousands of deliveries that failed together retry spread across the whole window instead of in lockstep.
- **429 with `Retry-After`:** the delivery waits exactly that long (clamped to 1 h), and the whole endpoint is paused until then (`paused_until`). The receiver asked us to slow down, not just to retry one request later.
- **Horizon:** each delivery's retry window opens at its **first attempt** (or the first attempt after a replay), not at event creation, and lasts 3 days (locally 180 s). An attempt whose next retry would land past the window marks the delivery `failed` (exhausted). Starting the window at the first attempt means time the platform itself spent down or backlogged never counts against the customer. This was found by a real failure: the laptop slept for two minutes mid-demo, and the first attempt after waking was judged "exhausted" and disabled a healthy endpoint.
- **Disable:** when a delivery exhausts its window and the endpoint hasn't succeeded once since that window opened (`failing_since ≤ window_started_at`), the endpoint is disabled. Its waiting deliveries are marked failed and the org gets an in-app notification. A flaky endpoint that sometimes succeeds loses individual deliveries but stays enabled.
- **One clock for scheduling.** The worker decides the delay; the database turns it into a timestamp (`now() + delay`). The scheduler compares `next_attempt_at` with the same `now()`, so skew between application hosts and the database can't shift retries. This was also found by running: after the laptop slept, the Docker VM's clock lagged the host by about 3 s and every retry fired 3 s late.

**Where retries wait: PostgreSQL `next_attempt_at` + scheduler, not RabbitMQ TTL/dead-letter queues.**

| | ✅ PostgreSQL + scheduler | ❌ RabbitMQ TTL / DLX delay queues |
|---|---|---|
| Arbitrary per-message delay (full jitter, Retry-After) | A timestamp | Per-message TTL only expires at the queue head, so it needs fixed delay tiers (1 s, 10 s, 1 min…) and loses jitter |
| Cancel or reschedule (disable, replay, 429 pause) | `UPDATE … WHERE` | Messages in a delay queue can't be found or removed |
| Fairness per endpoint | The dispatch query caps per endpoint | A due wave of one endpoint's retries floods the work queue |
| Visibility ("next attempt in 37 s") | Query it | Opaque |
| Cost | A scheduler process; a partial index on `(endpoint_id, next_attempt_at) WHERE state = 'scheduled'` | No extra process |

### 6. Failure classification

| Result | Class | Action |
|--------|-------|--------|
| 2xx | ok | delivered |
| 5xx, 408, 425 | http_5xx / http_4xx | retry with backoff |
| 429 | http_429 | retry after Retry-After; pause the endpoint until then |
| timeout, reset, refused | timeout / connection_error | retry |
| DNS failure | dns_error | retry (DNS outages are transient) |
| 410 Gone | http_410 | fail, **disable the endpoint**, notify |
| invalid URL, SSRF-blocked | invalid_url / ssrf_blocked | fail, **disable the endpoint**, notify |
| 3xx | http_3xx | fail (redirects are never followed) |
| other 4xx | http_4xx | fail this delivery only |

Other 4xx are permanent **for that delivery**: the receiver read the request and refused it, and the same bytes will get the same answer. Retrying for three days only fills the receiver's logs. The customer fixes the handler and replays. The endpoint stays enabled, because other events may be accepted. The cost is that a misconfiguration that 401s everything (for example a receiver that missed a secret rotation) fails deliveries fast instead of retrying until it's fixed; replay covers that, and the delivery log says why each one failed.

### 7. Signatures and rotation

```
Webhook-Id: evt_01M6RMEGSGFS42SEYKNWW221P2       ← the dedupe key
Webhook-Signature: t=1793980800,v1=5f2b…,v1=9ac1…  ← HMAC-SHA256(secret, "t.body"); two v1 during rotation
Webhook-Attempt: 3
Webhook-Ordering-Key: order_1042   Webhook-Sequence: 7
```

- The timestamp is inside the signed bytes, so a captured request can't be refreshed. Receivers reject `|now - t| > 5 min`, which bounds replays of captured requests to the window; event-id dedupe covers the rest.
- **Rotation:** the new secret becomes current and the old one is still sent for an overlap window (default 24 h, locally 120 s). During the overlap each request carries two `v1` signatures. A receiver with only the old secret and one with only the new secret both verify, so the customer can deploy whenever they like. After the overlap only the new signature is sent.

Customer verification snippet (Node; any language with HMAC works the same way):

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto'

// rawBody: the exact bytes received (verify BEFORE JSON.parse). secrets: one, or two mid-rotation.
export function verifyWebhook(rawBody, header, secrets, toleranceSeconds = 300) {
  const parts = Object.groupBy(header.split(',').map((p) => p.split('=')), ([k]) => k)
  const t = Number(parts.t?.[0]?.[1])
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false
  const sigs = (parts.v1 ?? []).map(([, v]) => Buffer.from(v, 'hex'))
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
    return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected))
  })
}
// Then: if this Webhook-Id was already processed, return 200 and do nothing (at-least-once delivery).
```

The platform's own verifier is `backend/src/delivery/signing.ts`; the mock receiver uses it.

### 8. SSRF protection

Every attempt, immediately before connecting:

1. Parse the URL with the WHATWG parser. That normalises `http://2130706433/`, `http://0x7f.1/` and octal forms to `127.0.0.1` before we look at them. Require http(s) (https only in production) and refuse credentials in the URL.
2. Refuse internal names (`localhost`, `*.internal`, `*.local`) unless allowlisted.
3. Resolve the name and vet **every** address returned, not just the first. Otherwise a name with one public and one private A record can win a race. Blocked ranges:
   - IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local, cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4;
   - IPv6: `::`, `::1`, `::/96`, `fc00::/7` (includes `fd00:ec2::254`), `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001::/23`, `2001:db8::/32`, `100::/64`, `64:ff9b:1::/48`;
   - wrappers are unwrapped and the embedded IPv4 address is checked: IPv4-mapped `::ffff:a.b.c.d` (in both text forms), NAT64 `64:ff9b::/96`, 6to4 `2002::/16`.
4. **Connect to the vetted IP**, sending the original name in `Host` and TLS SNI. There is no second DNS lookup that could return something else. This is what defeats DNS rebinding: checking only at registration is useless when the customer controls DNS.
5. **Never follow redirects.** A 302 to `http://169.254.169.254/` would bypass every check; 3xx is a failed attempt.

A blocked target fails the delivery and disables the endpoint: every future attempt would be blocked too, and the customer must be told. Registration runs the same check to catch mistakes early, but it is not the security boundary.

In production the workers egress through a proxy or NAT with fixed public IPs, with no route to internal networks: network policy as a second layer behind the application check. Customers can then allowlist those IPs.

**Local exception:** the mock receiver runs on `localhost`, so `SSRF_ALLOWLIST` lists exact `host:port` pairs that may be reached anyway. The default is only the mock receiver's port. `127.0.0.1` on any other port is still blocked; the e2e test checks this against PostgreSQL's port.

### 9. Replay

Replay creates **new attempts on the same delivery** for the **same event id**:

- single delivery (failed or delivered);
- bulk: all failed deliveries of an endpoint created since T.

It moves the delivery to `queued`, bumps `dispatch_seq` (old tickets become stale), opens a fresh retry window and writes an outbox row, all in one transaction. The first attempt after a replay is recorded with `trigger = replay`. Because the event id is unchanged, a receiver that already applied the event dedupes it, and one that never got it applies it once. A new event id would defeat receiver-side dedupe and break any reference to the original event. Replay to a disabled endpoint is refused (409): re-enable first.

### 10. Ordering

Delivery order is **not** guaranteed, and the e2e suite demonstrates it: event A fails once and waits for its retry while event B, emitted after it, is delivered first.

**What strict per-endpoint ordering would cost.** Event n+1 can't be sent until event n is acknowledged. That means one request in flight per endpoint (or per key), so throughput is capped at 1/RTT: about 5 events/s at 200 ms. Worse, one poisoned event (a 500 on that payload) blocks everything behind it for the whole retry horizon: head-of-line blocking. For an endpoint down six hours, every later event waits six hours even after recovery, then drains serially. Most consumers don't need global order; they need not to apply an *older* state over a newer one.

**What we offer instead:** an optional `orderingKey` on emit (`order_1042`). The platform assigns a gap-free per-(org, key) sequence number in the emit transaction and sends it in the payload (`ordering_key`, `sequence`) and headers. A receiver keeps the highest sequence it applied per key and discards anything lower, or re-fetches current state from our API when it sees a gap. The mock receiver does exactly this and flags stale updates.

A strict-FIFO mode could be offered per endpoint later as an explicit opt-in with the cost spelled out (concurrency 1, a failing event blocks the endpoint).

### 11. Mock receiver

A separate process standing in for customers' servers, with a `/hooks/:name` path per endpoint. Per-path toggles, armed for the next N requests or until changed:

- respond slowly;
- return 500;
- drop the acknowledgment (process the event, then close the socket);
- return 410;
- return 429 with Retry-After.

It verifies signatures with the platform's own verifier, rejects stale timestamps, dedupes by `Webhook-Id`, discards stale sequences, counts concurrent open requests per path and logs everything it saw. Secrets come from an internal platform endpoint, standing in for the customer pasting the secret into their config. They can be pinned to simulate a receiver that missed a rotation.

### Worked example: one successful trace

A dropped acknowledgment, end to end (from the e2e run):

1. Acme's order service POSTs `order.cancelled` with `Idempotency-Key: order-102-cancelled`. The intake transaction takes the advisory lock, finds no existing row, inserts `evt_…`, matches `ep_acme_orders` (`order.*`) and `ep_acme_audit` (`*`), inserts two `queued` deliveries plus two outbox rows, commits, and NOTIFYs. The producer gets `201` in about 10 ms.
2. The publisher wakes on NOTIFY, claims both outbox rows, publishes two tickets on the confirm channel, waits for the confirms, and marks the rows published.
3. Worker-2 receives the ticket for the orders delivery and claims it (`queued` → `in_flight`, lease token T1). The endpoint is active and not paused, and a slot is free (1 of 4).
4. It signs `t.body` with the current secret, resolves `localhost` → 127.0.0.1 (allowlisted port), and POSTs to the pinned IP with `Webhook-Id: evt_…`, `Webhook-Attempt: 1`.
5. The receiver verifies the signature, records `evt_…` as processed, applies it, then closes the socket without answering (drop-ack toggle).
6. Worker-2 sees `ECONNRESET` → `connection_error` → retry. Full jitter draws 0.6 s. In one transaction, fenced on T1, it inserts attempt 1 and sets the delivery to `scheduled` with `next_attempt_at = now() + 0.6 s`; the endpoint's failure streak becomes 1. It releases the slot and acks the ticket.
7. The scheduler's next tick finds the delivery due. The endpoint has spare capacity, so it sets `queued`, bumps `dispatch_seq` to 2 and writes an outbox row. The publisher sends ticket 2.
8. Worker-1 claims it and POSTs attempt 2. The receiver finds `evt_…` already processed, answers `200 {"duplicate": true}` and does not apply it again. Worker-1 records attempt 2 `delivered`, resets the endpoint's failure streak, and acks.

Result: the event was applied exactly once by the receiver because the receiver deduped, even though it was delivered twice. That is the at-least-once contract.

### Worked example: one failed trace

An endpoint goes down until its retry window runs out (horizon 20 s in the e2e run; 3 days in production):

1. `acme-audit` starts returning 500 to everything. An `invoice.refunded` event creates a delivery to it.
2. Attempt 1 (500) → retry after a jittered ≤ 1 s; attempt 2 → ≤ 2 s; attempt 3 → ≤ 4 s… The window opened at attempt 1, so the deadline is attempt 1 + 20 s. After 5 consecutive failures the endpoint enters probe mode (limit 1).
3. Attempt 12 fails, and its next retry would land past the deadline, so the delivery is marked `failed` with "Retry window exhausted".
4. In the same transaction, the endpoint's `failing_since` is at or before this delivery's window start, meaning it has not succeeded once in 20 s. The endpoint is disabled (`retry_horizon_exhausted`), its other waiting deliveries are marked failed, and Acme gets an in-app notification. New `*` events no longer fan out to it.
5. Alice opens the notification, fixes the receiver and re-enables the endpoint (failure streak and pause cleared). Replaying the failed delivery is refused while it is disabled (409) and accepted after.
6. The replay queues the same delivery with a fresh window. The attempt is recorded as `trigger = replay` and delivered; the receiver sees the original event id once. No new event was created.

### Design Review Checklist

| Question | Answer |
|----------|--------|
| Source of truth, and when is a write successful? | PostgreSQL. An emit succeeds when the transaction holding the event, its deliveries and their outbox rows commits (201). An attempt counts when its row and the delivery's next state commit, and only then is the ticket acked. RabbitMQ holds pointers that can be rebuilt from the database; Valkey holds sessions and semaphores, nothing that can't be lost |
| Client retries after losing the response? | Producer: same Idempotency-Key → the original event (200, Idempotent-Replayed); different body → 409; concurrent duplicates serialised by an advisory lock. Our retry to a receiver after losing its response: the same event id in `Webhook-Id`, and the receiver dedupes. Console replay: same delivery, same event id |
| Worker or server fails between two important steps? | API between commit and publish: the outbox row is committed, so the publisher sends it later. Publisher between publish and mark: republished, and the worker's conditional claim drops the duplicate. Worker mid-attempt: the ticket is unacked, RabbitMQ redelivers it, another worker takes over (the lost attempt is recorded as `lost`) and the receiver may see a duplicate. Worker after commit but before ack: redelivered ticket finds nothing to claim. Lease expiry plus a scheduler sweep is the backstop when a ticket never comes back; a stuck-queued sweep covers a ticket lost in the broker |
| Which ordering is actually required? | None globally. Per-endpoint FIFO is deliberately not offered by default (head-of-line blocking). Per-key sequence numbers let receivers order or discard stale updates. Per-delivery state transitions are serialised by the conditional claim and the lease token |
| Access with caches, indexes, async jobs? | Every console query is scoped by the session's org (another org's id is a 404). Producer API keys resolve to one org. Workers act as the system and never serve user data. The mock-receiver proxy filters to the caller's own endpoint paths. Operators see aggregates only. SSRF checks run in the worker at connection time, not only at registration |
| What breaks first at larger scale, and what evidence supports it? | PostgreSQL write volume: 6.6 row writes per delivery, measured with `pg_stat_database` (8.0 before throttling two no-op writes): delivery insert, outbox insert, outbox mark, claim, result, attempt insert, plus the event row shared across its fan-out. That is ~60k writes/s at 9k deliveries/s and ~300k/s at peak. Second, the scheduler's per-tick scan of every active endpoint (300k). See Scalability Considerations |

## Database Schema

The full DDL is in [`backend/src/db/init.sql`](./backend/src/db/init.sql). The core tables:

```sql
CREATE TABLE events (                       -- immutable
  id TEXT PRIMARY KEY,                      -- evt_<ULID>: time-ordered, append-mostly index
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  ordering_key TEXT, sequence BIGINT,       -- per-(org, key) sequence, assigned at emit
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, url TEXT NOT NULL,
  event_types TEXT[] NOT NULL DEFAULT '{*}',
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')), disabled_reason TEXT,
  max_concurrency INT NOT NULL DEFAULT 4,
  secret_current TEXT NOT NULL, secret_previous TEXT, previous_expires_at TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0, failing_since TIMESTAMPTZ,
  paused_until TIMESTAMPTZ                  -- 429 Retry-After
);

CREATE TABLE deliveries (                   -- one event × one endpoint
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, org_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','in_flight','scheduled','delivered','failed')),
  dispatch_seq INT NOT NULL DEFAULT 1,      -- bumped per ticket; older tickets are stale
  attempt_count INT NOT NULL DEFAULT 0, replay_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,              -- database clock
  window_started_at TIMESTAMPTZ, retry_deadline TIMESTAMPTZ NOT NULL,
  lease_token TEXT, lease_until TIMESTAMPTZ, claimed_by TEXT,
  UNIQUE (event_id, endpoint_id)
);
CREATE INDEX deliveries_due_idx    ON deliveries (endpoint_id, next_attempt_at) WHERE state = 'scheduled';
CREATE INDEX deliveries_active_idx ON deliveries (endpoint_id) WHERE state IN ('queued', 'in_flight');
CREATE INDEX deliveries_lease_idx  ON deliveries (lease_until) WHERE state = 'in_flight';

CREATE TABLE attempts (                     -- append-only
  id BIGSERIAL PRIMARY KEY, delivery_id TEXT NOT NULL, attempt_no INT NOT NULL,
  trigger TEXT NOT NULL,                    -- initial | retry | replay | recovered
  started_at TIMESTAMPTZ NOT NULL, latency_ms INT, status_code INT,
  error_class TEXT NOT NULL, error_message TEXT, response_body TEXT,   -- body truncated to 1 KB
  outcome TEXT NOT NULL,                    -- delivered | retry | failed | superseded | lost
  next_attempt_at TIMESTAMPTZ, worker_id TEXT, resolved_ip TEXT, signatures_sent INT
);

CREATE TABLE outbox (                       -- marked per row, never by checkpoint
  id BIGSERIAL PRIMARY KEY, delivery_id TEXT NOT NULL, dispatch_seq INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
```

Partial indexes keep the hot sets small: the scheduler reads only `scheduled` rows per endpoint, the capacity check reads only `queued`/`in_flight`, and the publisher reads only unpublished outbox rows. At production scale `events`, `deliveries` and `attempts` are range-partitioned by day and the whole schema is sharded by `org_id`.

## API Design

```
POST /api/v1/events                       producer (Bearer whk_… or session); Idempotency-Key required
                                          201 new · 200 + Idempotent-Replayed · 409 key reused · 413 too large
GET  /api/v1/events?type=&before=         event log with delivery counts
GET  /api/v1/events/:id                   event + one delivery per matched endpoint

GET  /api/v1/endpoints                    endpoints with health (1 h success rate, p50/p95, in flight, waiting, failed)
POST /api/v1/endpoints                    create (URL vetted; 422 SSRF_BLOCKED); returns the signing secret
GET  /api/v1/endpoints/:id                detail + health
PATCH /api/v1/endpoints/:id               url, description, eventTypes, maxConcurrency
POST /api/v1/endpoints/:id/enable|disable
POST /api/v1/endpoints/:id/rotate-secret  { overlapSeconds } → new secret; both sign until the overlap ends
GET  /api/v1/endpoints/:id/secret         current (and previous while overlapping)
GET  /api/v1/endpoints/:id/deliveries?state=pending|delivered|failed
POST /api/v1/endpoints/:id/replay         { since } → replay all failed since T (409 if disabled)

GET  /api/v1/deliveries/:id               delivery + every attempt + event
POST /api/v1/deliveries/:id/replay        202; same event id, new attempt (409 if pending or endpoint disabled)

GET  /api/v1/notifications · POST /api/v1/notifications/read-all
GET  /api/v1/receiver · PUT /api/v1/receiver/paths/:name · DELETE /api/v1/receiver/received   (mock receiver, org-filtered)
GET  /api/v1/ops/overview                 operator: queue depth, outbox lag, in-flight per endpoint, success rate
```

Example emit:

```bash
curl -X POST localhost:3000/api/v1/events \
  -H 'Authorization: Bearer whk_test_acme_local_0000000000000000' \
  -H 'Idempotency-Key: order-1042-created' -H 'Content-Type: application/json' \
  -d '{"type":"order.created","orderingKey":"order_1042","data":{"orderId":"1042","amount":4200}}'
# → 201 {"event":{"id":"evt_…","sequence":1,…},"deliveries":[{"id":"dlv_…","endpointId":"ep_acme_orders"},…],"replayed":false}
```

## Key Design Decisions

### 1. At-least-once with receiver-side dedupe, not exactly-once

Exactly-once delivery over HTTP to a third party is impossible: the 200 can be lost after the receiver committed, and only the receiver knows whether it did. A queue doesn't change that. Its acknowledgements cover the hop to our worker, not the hop to the customer. So we promise at-least-once, put a stable `Webhook-Id` (the event id) on every attempt including replays, and document that receivers must dedupe. The cost is pushing work onto every customer, which is why the docs ship a verification and dedupe snippet.

### 2. Transactional outbox, not dual writes

The event, its deliveries and the outbox rows commit together, so "accepted" can never mean "lost before the broker". The cost is a publisher process and roughly two extra writes per delivery (outbox insert and mark). At very high volume, CDC on the outbox table removes the mark.

### 3. Queue tickets as pointers, database as truth

Tickets carry `{deliveryId, dispatchSeq}`, and workers claim rows conditionally. Duplicate tickets (outbox republish), stale tickets (replay, reschedule) and redelivered tickets (worker crash) all resolve through the same claim. The alternative, putting the payload and retry state in the message, makes the broker a second source of truth that can disagree with the database and can't be queried, cancelled or replayed.

### 4. Retries wait in PostgreSQL; per-endpoint caps everywhere

See the table in Core Components §5. The queue only ever holds due work, so a dead endpoint's backlog doesn't sit in front of anyone. The cost is a scheduler, plus a database that must absorb the polling, done with partial indexes and one query per tick.

### 5. Per-endpoint concurrency semaphore with parking

The alternatives fail at the extremes:

- **One queue per endpoint** (300k queues): heavy for the broker and needs a fair-scheduling layer anyway.
- **Requeueing a ticket for a busy endpoint**: spins and starves.
- **Waiting in the worker** for a slot: lets one endpoint hold every worker.

Parking costs a database write per refused ticket, and the scheduler's capacity-aware dispatch keeps those rare.

### 6. Window starts at first attempt; disable only after a whole window of failure

A platform outage must not spend the customer's retry budget. A flaky endpoint that sometimes succeeds keeps its other deliveries flowing.

## Consistency and Idempotency

| Write | Source of truth | Success means | Retry behaviour |
|-------|-----------------|---------------|-----------------|
| Emit | `events` UNIQUE (org, idempotency_key) + advisory lock | Commit (201) | Same key + body → original event (200); different body → 409 |
| Fan-out | `deliveries` UNIQUE (event, endpoint) | Same transaction as the event | Can't run twice: the event insert is the gate |
| Publish | `outbox.published_at` per row | Broker confirm, then mark | Crash before mark → republished; consumer drops the duplicate |
| Claim | Conditional UPDATE on (id, dispatch_seq, state) | Row returned | Stale/duplicate ticket → no row → ack and drop |
| Attempt result | One transaction fenced on `lease_token` | Commit, then ack | Lease lost → attempt logged `superseded`, state untouched |
| Delivery to receiver | Receiver's processed-event store | 2xx read by us | Lost ack → retry with the same `Webhook-Id`; receiver dedupes |
| Replay | Same delivery row, `dispatch_seq` + 1 | Commit (202) | Second click while queued → 409 DELIVERY_PENDING |
| Endpoint disable | `status = 'active'` guard | Row updated | Idempotent: a second disable writes no second notification |

## Security / Auth

- **Producers:** API keys (`whk_…`, 192 random bits) stored as SHA-256 (indexable, unlike bcrypt, and safe for high-entropy keys). Each key resolves to exactly one org.
- **People:** session cookies (httpOnly, Valkey-backed, bcrypt passwords), login rate-limited per IP. Two roles:
  - customer: scoped to one org;
  - operator: aggregates only, no payloads.
- **Org scoping:** every console query filters on the session's org, and another org's ids return 404 (no existence leak). The receiver proxy filters to the caller's own endpoint paths.
- **Outbound:** SSRF checks at connection time with IP pinning and no redirects; signed requests with rotation and a replay window; secrets are only shown to the owning org. In production secrets are encrypted at rest with a KMS key, and egress goes through fixed IPs with no route inward.
- **Abuse:** payload cap (256 KB), per-org emit rate limits at the gateway (not built locally), per-endpoint concurrency caps that also protect receivers from us.

## Observability

Prometheus metrics (`backend/src/shared/metrics.ts`), one registry per process on `/metrics`:

| Metric | What it shows |
|--------|---------------|
| `webhooks_events_emitted_total{outcome}` | created vs idempotent replays vs key conflicts: how often producers retry |
| `webhooks_outbox_oldest_unpublished_seconds` | Publisher lag; page if > 30 s |
| `webhooks_attempts_total{error_class,outcome}` | Failure mix: a spike in `timeout` vs `http_5xx` vs `ssrf_blocked` tells different stories |
| `webhooks_attempt_duration_seconds{outcome}` | Receiver latency distribution |
| `webhooks_tickets_total{result}` | attempted / stale / busy_parked / paused_parked / stolen_lease: parking rate = isolation doing its job; stolen leases = worker crashes |
| `webhooks_scheduler_dispatched_total{kind}` | retry / lease_reclaimed / stuck_requeued |
| `webhooks_endpoints_disabled_total{reason}` | Auto-disables by reason |
| `webhooks_worker_in_flight` | Open requests per worker |

The operator page adds RabbitMQ queue depth and unacked counts (management API), outbox backlog, success rate and attempt and end-to-end latency per org over 5 minutes, and in-flight vs limit per endpoint (database plus semaphore slots). Pino JSON logs carry the service name. Slow paths log warnings: broker confirm > 1 s, ticket preparation > 1 s, lost-worker takeovers. Every delivery's history is queryable in `attempts`.

Alerts worth having:

- outbox lag > 30 s;
- queue ready > 10k for 5 min (workers can't keep up; retries never sit in the queue, so this means real load);
- poison queue non-empty;
- global success rate down by more than 5 points with no single endpoint explaining it (our egress or DNS);
- `stolen_lease` rate > 0.1%.

## Failure Handling

| Failure | Effect | Handling |
|---------|--------|----------|
| Receiver 5xx / timeout / reset | Attempt fails | Retry with full-jitter backoff inside the window |
| Receiver hangs | A worker slot held until timeout | Per-endpoint semaphore caps it at N (1 in probe mode); excess parked in PostgreSQL |
| Receiver processed but ack lost | We retry a processed event | Same `Webhook-Id`; receiver dedupes. Documented as the contract |
| Receiver 429 | Asked to slow down | Delivery waits Retry-After; endpoint paused until then |
| Receiver 410 / blocked / invalid URL | Will never succeed | Fail, disable, notify |
| Endpoint down for the whole window | Deliveries exhausted | Disable, fail waiting deliveries, notify; replay after fixing |
| API dies after commit | Event accepted, not yet published | Outbox row published later |
| Publisher dies after publish, before mark | Duplicate ticket | Conditional claim drops it |
| Broker down or connection lost | No publishing or consuming | Intake keeps accepting into the outbox; publisher and workers reconnect with backoff and drain. Verified by stopping RabbitMQ mid-run |
| Worker killed mid-attempt | Unacked ticket | Broker redelivers; another worker takes over the lease (the lost attempt is recorded); the receiver may see a duplicate |
| Worker stalls past its lease | Two workers may send | Lease token fences the stale one's write (`superseded`); duplicate send possible (at-least-once) |
| Ticket lost in the broker | Delivery stuck `queued` | Stuck-queued sweep re-dispatches with a new `dispatch_seq` |
| Valkey down | Sessions and semaphores unavailable | Console sign-in fails; ticket handling errors and tickets are requeued after a pause. No data loss; production runs Valkey replicated |
| PostgreSQL down | Nothing can be accepted or recorded | Intake returns 503 (producers retry with the same key); workers requeue tickets |
| Platform asleep or backlogged longer than the window | First attempts happen late | The window opens at the first attempt, so the customer isn't penalised |
| Clock skew between hosts and database | Retries early or late | Scheduling timestamps use the database clock only |

## Scalability Considerations

**What breaks first: PostgreSQL writes.** Measured locally with `pg_stat_database` around 50 emits fanning out to 100 deliveries: 6.6 row writes per successful first-try delivery (351 inserts, 307 updates). Six of them are per delivery (delivery insert, outbox insert, outbox mark, claim, result, attempt insert), and the event row is shared across its fan-out. The first measurement was 8.0, because every emit also updated `api_keys.last_used_at` and every success rewrote the endpoint's health row even when nothing changed; both now write only when the value is stale. At the production average (9k deliveries/s) that is ~60k row writes/s; at the 45k/s peak ~300k/s. That is well past one primary. Mitigations, in order:

1. **Shard by `org_id`** across PostgreSQL clusters (or use Citus). Every query in the hot path is per org or per endpoint, so nothing crosses shards.
2. **CDC instead of the outbox mark** (Debezium on the WAL), removing one write per delivery.
3. **Keep cutting no-op writes.** Endpoint health on success and API-key "last used" are already conditional (that took 8.0 writes down to 6.6).
4. **Move attempts to an append-only store** (ClickHouse or partitioned tables with short retention in the OLTP database) and keep only the latest attempt summary on the delivery row.

**Second: the scheduler scan.** Each tick walks every active endpoint (300k) to find due work. Replace it with a "ready endpoints" structure: a Valkey sorted set of endpoint ids by next due time, maintained on park and retry. Shard schedulers by endpoint hash.

**Third: sockets to slow receivers.** 15k concurrent requests at peak, more during incidents. Per-endpoint caps bound the damage; workers scale horizontally, with HTTP keep-alive pools per endpoint. A dedicated "slow lane" worker pool for probe-mode endpoints keeps healthy traffic on fast workers.

**Hot endpoints.** One customer's endpoint receiving 5k events/s needs a high limit (say 200). The limit is per endpoint and configurable; the semaphore and dispatch query handle it unchanged.

**Queue.** A quorum queue handles tens of thousands of small messages per second. Beyond that, partition into N queues by endpoint hash, or move to Kafka with partitions keyed by endpoint. Because retries never sit in the queue, its depth tracks real load.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Delivery guarantee | At-least-once + receiver dedupe on `Webhook-Id` | Exactly-once | Impossible across an HTTP hop to a third party; a queue doesn't change that |
| DB → broker hand-off | Transactional outbox, per-row marks | Publish after commit | No lost events between commit and publish; duplicates are harmless |
| Queue message | Pointer `{deliveryId, dispatchSeq}` | Full payload + retry state | One source of truth; stale and duplicate tickets resolve via the claim |
| Where retries wait | PostgreSQL `next_attempt_at` + scheduler | RabbitMQ TTL/DLX tiers | Arbitrary delays, cancellable, per-endpoint fair, visible |
| Isolation | Per-endpoint semaphore + park + capacity-aware dispatch | Queue per endpoint / wait in worker | No head-of-line blocking; a dead endpoint holds ≤ N slots |
| Backoff | Exponential, full jitter, 3-day window from first attempt | Fixed intervals / from event creation | Spreads recovery storms; platform outages don't spend the budget |
| Other 4xx | Permanent for that delivery | Retry all non-2xx | Same bytes, same answer; replay after fixing |
| 410 / blocked URL | Fail + disable + notify | Keep retrying | Explicit "stop" signal; never-succeeding target |
| Ordering | None by default; per-key sequence numbers | Strict per-endpoint FIFO | FIFO caps throughput at 1/RTT and blocks on one bad event |
| Replay | New attempt, same event id | New event | Receiver dedupe and references stay valid |
| Signing | HMAC-SHA256 over `t.body`, two secrets during overlap | Single secret / asymmetric signatures | Simple for every language; rotation with no coordinated deploy |
| SSRF | Vet at connect time, pin IP, no redirects | Vet at registration only | DNS rebinding makes registration checks useless |
| Scheduling clock | Database `now()` only | Each host's clock | Skew can't shift retries (found when a laptop sleep skewed the VM clock) |

## Implementation Notes

### Local architecture

| Process | Default port | Entry | Production counterpart |
|---------|--------------|-------|------------------------|
| API (×2: `dev:server1`/`dev:server2` add 3001/3002) | 3000 | `backend/src/api/index.ts` | Intake + console API behind a gateway |
| Outbox publisher | 3100 (metrics) | `backend/src/publisher/index.ts` | Publisher fleet or CDC |
| Delivery workers (×2) | 3101, 3102 (metrics) | `backend/src/worker/index.ts` | Autoscaled worker fleet behind fixed-IP egress |
| Retry scheduler | 3103 (metrics) | `backend/src/scheduler/index.ts` | Sharded schedulers |
| Mock receiver | 3300 | `backend/src/receiver/index.ts` | Customers' servers |
| Frontend | 5173 | `frontend/` | Console SPA |
| PostgreSQL 16, RabbitMQ 3.13 (quorum queue), Valkey 7 | 5432, 5672/15672, 6379 | `docker-compose.yml` | Sharded PostgreSQL, RabbitMQ cluster, Valkey replicas |

### Production-grade patterns actually implemented

- **Idempotent intake** with an advisory lock, a request hash and a 409 on key reuse with a different body (`api/services/emit.ts`). Producers retry on timeouts; without this every retry is a second event and a second webhook.
- **Transactional outbox** with `LISTEN/NOTIFY` wake-up, confirm-channel publishing and per-row marks (`publisher/relay.ts`). Verified by stopping the publisher, emitting, and restarting it.
- **Conditional claim, lease tokens, takeover on redelivery, lost-attempt records** (`worker/handle.ts`). Verified by `SIGKILL`ing the worker that held an in-flight delivery: the other worker took over and the receiver flagged the duplicate.
- **Per-endpoint Valkey semaphore with server-side time** (`shared/semaphore.ts`), parking, probe mode, and capacity-aware fair dispatch (`scheduler/sweeps.ts`). Measured: Acme p50 unchanged at ~10-15 ms while Globex's endpoint hung; the receiver saw at most 4 concurrent requests.
- **Full-jitter backoff, Retry-After, window from first attempt, auto-disable with notification** (`delivery/backoff.ts`, `delivery/classify.ts`, `shared/dispatch.ts`).
- **Signing with rotation overlap and a replay window** (`delivery/signing.ts`), used by both the worker and the mock receiver.
- **SSRF vetting with IP pinning, wrapper unwrapping and no redirects** (`delivery/ssrf.ts` with 29 unit tests, `delivery/sender.ts` with 6 more against a local server).
- **Supervised broker connections** that reconnect after a drop (`shared/queue.ts`). Found when the laptop slept past two heartbeats and every connection died silently.
- **Quorum queue with a delivery limit and poison queue**, Prometheus metrics, Pino logs, `/health` and `/ready` on every process, zod validation, camelCase DTOs.

```typescript
// worker/handle.ts — claim: stale, duplicate and redelivered tickets all resolve here
UPDATE deliveries d SET state = 'in_flight', lease_token = $3, lease_until = now() + …, claimed_by = $5
  FROM prev WHERE d.id = prev.id AND d.dispatch_seq = $2
   AND (d.state = 'queued' OR (d.state = 'in_flight' AND ($6::boolean OR d.lease_until < now())))
```

**Write cost per delivery** (evidence for "what breaks first"): `pg_stat_database` deltas around 50 emits × 2 matching endpoints, read after PostgreSQL's lazy stats flush (~10 s): 6.6 row writes and ~6.7 commits per delivery. Before throttling `api_keys.last_used_at` and no-op endpoint-health updates it was 8.0.

### Simplified or substituted

- One PostgreSQL instead of an org-sharded fleet; no table partitioning.
- A polling publisher with `LISTEN/NOTIFY` instead of CDC.
- Compressed retry timing (seconds instead of hours and days); every knob is an environment variable.
- `SSRF_ALLOWLIST` lets the localhost mock receiver through, and plain http is allowed locally (production: https only, empty allowlist).
- Secrets stored in plain columns (production: KMS-encrypted).
- The mock receiver fetches its secrets from an internal endpoint, standing in for a customer copying the secret into their config.
- The console polls every 1.5-3 s instead of streaming updates.
- Single-node RabbitMQ (quorum queues still work on one node).

### Omitted

Multi-region delivery, fixed-IP egress proxies, per-org emit rate limits, customer-managed retry policies, a strict-FIFO mode, event-type schemas and catalog, payload transformations, mTLS to receivers, webhook "test endpoint" tooling, billing, and long-term archival of attempts.
