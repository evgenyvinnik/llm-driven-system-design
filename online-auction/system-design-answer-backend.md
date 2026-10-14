# 🔨 Online Auction (eBay-style) — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "An auction site doesn't have a throughput problem — ten million bids a day is about a hundred per second. It has two sharper problems. First, contention: one item can take fifty bids in its last ten seconds, and every one of them is a read-modify-write on the same row, where getting it wrong means two people are told they're winning. Second, the clock: auctions end at a wall-clock time that a last-second bid can move, and when that time passes something has to pick exactly one winner and tell everyone exactly once. Most of my design is about those two."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and why contention beats throughput |
| High-level architecture | 10 min | One overview diagram and the three core flows |
| Data model & API | 7 min | What lives where; the bid contract |
| Deep dive 1: hot auctions | 8 min | Serializing bids without melting the database |
| Deep dive 2: proxy bids and retries | 7 min | Second-price resolution and exactly-once bids |
| Deep dive 3: closing on time | 5 min | One winner, a moving deadline, many workers |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope, because 'auction site' could mean eBay's entire marketplace."

### Functional requirements

1. **List** an item: title, images, starting price, bid increment, optional hidden reserve, duration.
2. **Bid** manually (at least current price + increment), or set a **proxy maximum** that bids for me only as much as needed to lead.
3. **Watch** live: price, leader, bid history and countdown update in real time.
4. **Anti-sniping:** a bid in the last two minutes pushes the end out so two minutes remain.
5. **Close:** at the end, declare the winner, or "reserve not met", or "no bids", and notify winner, seller and losing bidders.
6. **Admin:** force-close or cancel any auction; sellers cancel only before the first bid.

Out of scope: payments and escrow, shipping, ratings, fraud scoring, Buy It Now.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Bid correctness | Judged against the latest committed price; a retry never bids twice; nothing accepted after the end | Money the user authorized, and legally binding |
| Bid latency | p99 < 300 ms, including waiting behind other bids | The final seconds are when it matters |
| Live updates | Watchers see a new price within 1 s (p95 < 500 ms) | Bidders react to each other |
| Closing | Winner decided within 2 s of the end, exactly once | People are watching the countdown hit zero |
| Availability | 99.95% for bidding, 99.99% for browsing | Browse can be served from caches |
| Durability | An acknowledged bid is never lost | Synchronous replica commit |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Users | 2M daily active, 200K concurrent at the evening peak | Stateless API and gateway tiers |
| Live auctions | 1M at once; 300K new listings/day | Listing writes are ~3.5/s, trivial |
| Bids | 10M/day → ~115/s average, ~1,500/s peak | One PostgreSQL primary is plenty |
| Hot auction | 50 bids in the last 10 s, 10K watchers | Contention on one row; 500K pushes in 10 s |
| Endings | 300K/day; ~5K in one peak minute | The closer needs ~100 closes/s with no misses |
| Storage | ~1.5 GB of bids/day (~550 GB/year); images ~600 GB/day | Relational data fits one sharded cluster; images go to object storage + CDN |

"The two numbers that drive the design: the site needs only ~1,500 bids per second, but a single auction takes 50 bids in 10 seconds. So the problem is one contended row, not volume. And one accepted bid on a hot item becomes 10,000 pushes, so fan-out has to happen at the edge, not in the database."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the system, then walk through the three journeys: placing a bid, pushing the new price to watchers, and closing the auction."

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Bidder's browser · React SPA, WebSocket client                                               │
  └─────┬────────────────────────────────────────────────────────────────────────────────────────┘
        │ (1) POST /api/v1/auctions/{id}/bids, Idempotency-Key                          ▲
        │                                                                (2) WebSocket  │
        ▼                                                                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS · /api/* → Auction API · /ws → Realtime gateway                          │
  └─────┬────────────────────────────────────────────────────────────────────────────────────────┘
        │                                                                     WebSocket ▲
        ▼                                                                               ▼
  ┌───────────────┐          ┌────────────────────┐          ┌───────────────┐ ┌─────────────────┐
  │ Auction API   │ lock, key│ Redis              │ (3) claim│ Closing       │ │ Realtime        │
  │ bids, browse  │─────────▶│ bid locks, idem    │◀─────────│ workers       │ │ gateway: subs,  │
  │ stateless     │          │ keys, endings ZSET │ due, ZREM│ every 1 s     │ │ fan-out         │
  └──────┬────────┘          └────────────────────┘          └──────┬────────┘ └─────────────────┘
         │ row-locked bid tx + outbox row                           │ close tx          ▲
         │                                                          │                   │ consume
         ▼                                                          ▼                   │
  ┌─────────────────────────────────────────────────────────────────────┐      ┌────────┴────────┐
  │ PostgreSQL · auctions, bids, auto_bids, notifications, outbox       │─────▶│ Kafka           │
  │ source of truth · primary + read replicas                           │relay │ auction-events  │
  └─────────────────────────────────────────────────────────────────────┘      └────────┬────────┘
                                                                                        │ consume
                                                                                        ▼
                                                                               ┌─────────────────┐
                                                                               │ Notification    │
                                                                               │ workers: email, │
                                                                               │ push, in-app    │
                                                                               └─────────────────┘
```

1. **Bid (1).** The browser posts a bid with an idempotency key. The Auction API claims the key and a per-auction admission lock in Redis, then runs one PostgreSQL transaction under the auction's row lock. That transaction resolves proxies, inserts the bids, moves the price, version and end time, and writes an outbox row. Then it answers.
2. **Live update (2).** A relay publishes committed outbox rows to Kafka, keyed by auction ID. Every realtime gateway consumes the stream and pushes `new_bid` to the sockets watching that auction.
3. **Close (3).** Closing workers pull due auction IDs from a Redis sorted set scored by end time, claim each with `ZREM`, and close it in PostgreSQL under the same row lock. The outbox carries `auction_ended` to gateways and notification workers.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS; routes `/api` and `/ws` | Connections | WebSocket upgrades pinned to a gateway |
| Auction API | Bids, listings, browse, auth | ~1,500 bids/s peak | Stateless; all bid state is in the transaction |
| Redis | Admission locks, idempotency keys, endings sorted set, sessions | Hot keys | Losing it slows things down; never corrupts a bid |
| Closing workers | Close due auctions exactly once | Endings per second | Separate pool so a closing spike can't starve bids |
| PostgreSQL | Source of truth, including the outbox | Sharded by auction ID | Primary + synchronous replica |
| Kafka | `auction-events`, keyed by auction ID | ~1,500 events/s | Per-auction order; replayable |
| Realtime gateways | Sockets, subscriptions, local fan-out | 200K sockets | Each consumes all events, filters locally |
| Notification workers | Email, push, in-app | Notifications | Idempotent by event ID |

"Why a separate closer and gateway tier instead of doing everything in the API? Their failure profiles differ. A gateway holds 200K long-lived sockets and must restart without touching bids. The closer has a hard deadline at round times like 8 p.m. on Sunday, and I don't want a closing spike competing with bids for the same processes. They share the database and the event stream, so splitting them costs little."

### Flow 1: placing a bid

```
Bidder                                Auction API                            Redis   PostgreSQL
   │                                       │                                   │          │
   │ 1 POST /bids/{id}, Idempotency-Key K  │                                   │          │
   │──────────────────────────────────────▶│                                   │          │
   │                                       │ 2 SET idem:K pending NX           │          │
   │                                       │──────────────────────────────────▶│          │
   │                                       │ 3 SET lock:{id} NX, wait ≤ 1.5 s  │          │
   │                                       │──────────────────────────────────▶│          │
   │                                       │ 4 BEGIN; SELECT … FOR UPDATE                 │
   │                                       │─────────────────────────────────────────────▶│
   │                                       │ 5 price, leader, live proxies                │
   │                                       │◀─────────────────────────────────────────────│
   │                                       │ 6 resolveBid → rows, price        │          │
   │                                       │ 7 INSERT bids; UPDATE; COMMIT                │
   │                                       │─────────────────────────────────────────────▶│
   │                                       │ 8 store 201 under K; DEL lock     │          │
   │                                       │──────────────────────────────────▶│          │
   │ 9 201 {price, is_winning, version}    │                                   │          │
   │◀──────────────────────────────────────│                                   │          │
   │                                       │                                   │          │
```

"Steps 2 and 3 happen before I take a database connection. The idempotency claim turns a retried request into a replay. The admission lock keeps a burst of bidders waiting in Redis rather than in my connection pool. Step 4 is the real guarantee: `SELECT … FOR UPDATE` on the auction row serializes every bid, proxy change, close and cancel on that auction. Step 6 is a pure function I'll come back to. Step 7 commits the bid rows, the new price, `version + 1`, any snipe extension, the outbid notifications and the outbox row together, or not at all."

### Flow 2: pushing the new price

```
PostgreSQL               Relay                        Kafka       Gateway          Watcher
     │                     │                            │            │                │
     │ 1 read outbox rows  │                            │            │                │
     │◀────────────────────│                            │            │                │
     │ 2 new_bid v42       │                            │            │                │
     │────────────────────▶│                            │            │                │
     │                     │ 3 publish, key auction_id  │            │                │
     │                     │───────────────────────────▶│            │                │
     │                     │                            │ 4 consume  │                │
     │                     │                            │◀───────────│                │
     │                     │                            │            │ 5 new_bid v42  │
     │                     │                            │            │───────────────▶│
     │                     │                            │       6 42 = 41 + 1: apply  │
     ·························· socket drops and reconnects ···························
     │                     │                            │            │ 7 new_bid v45  │
     │                     │                            │            │───────────────▶│
     │                     │                            │    8 gap: refetch snapshot  │
     │                     │                            │            │                │
```

"Every state change increments `auctions.version` in the same transaction, and every event carries it. A client at version 41 applies 42, ignores anything at or below 41 (duplicates, late delivery), and refetches if it sees 45. That single integer turns an at-least-once, possibly reordered stream into a correct view, and gateways never need replay buffers."

### Flow 3: closing

```
Closing worker                           Redis   PostgreSQL                                  Kafka
       │                                   │          │                                        │
       │ 1 ZRANGEBYSCORE endings -inf now  │          │                                        │
       │──────────────────────────────────▶│          │                                        │
       │ 2 [a7, c2]                        │          │                                        │
       │◀──────────────────────────────────│          │                                        │
       │ 3 ZREM endings a7                 │          │                                        │
       │──────────────────────────────────▶│          │                                        │
       │ 4 1 = claimed (others get 0)      │          │                                        │
       │◀──────────────────────────────────│          │                                        │
       │ 5 BEGIN; SELECT a7 FOR UPDATE                │                                        │
       │─────────────────────────────────────────────▶│                                        │
       │ 6 active, end_time, leading bid              │                                        │
       │◀─────────────────────────────────────────────│                                        │
       │ 7 end moved? ZADD new end, stop   │          │                                        │
       │ 8 ended, winner, notices, outbox; COMMIT     │                                        │
       │─────────────────────────────────────────────▶│                                        │
       ····································· outbox relay ······································
       │                                   │          │ 9 auction_ended {winner, final_price}  │
       │                                   │          │───────────────────────────────────────▶│
       │                                   │          │                                        │
```

"Step 3 makes the work cheap to split: `ZREM` returns 1 to exactly one worker. Step 5 makes it correct: the close re-reads the auction under the row lock, so a second worker waits and then finds it already ended. Step 7 handles the moving deadline: if a last-second bid extended the auction, the worker puts the new end time back in the set and walks away."

---

## 💾 Data Model (4 min)

"PostgreSQL holds everything that must be right; Redis holds coordination state that can be rebuilt; Kafka holds events."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `auctions` | `id`, `seller_id`, `current_cents`, `increment_cents`, `reserve_cents` (hidden), `status`, `end_time`, `snipe_window`, `extension_count`, `winner_id`, `version` | Partial index on `end_time` where active; `version` bumps on every price change, close and cancel |
| PostgreSQL | `bids` | `id`, `auction_id`, `bidder_id`, `amount_cents`, `is_auto`, `seq`, `idempotency_key` | Append-only; `(auction_id, amount DESC, seq)` finds the leader; unique `(bidder_id, idempotency_key)` |
| PostgreSQL | `proxies` | `(auction_id, bidder_id)` PK, `max_cents`, `is_active`, `updated_at` | Only the leader's proxy is ever active |
| PostgreSQL | `outbox` | `id`, `auction_id`, `type`, `version`, `payload` | Same transaction as the change; relay marks published |
| PostgreSQL | `notifications` | `user_id`, `auction_id`, `type`, `read_at` | Sharded by user |
| Redis | `lock:auction:{id}` | Random token, 5 s TTL | Admission control only |
| Redis | `idem:{user}:{key}` | Fingerprint, state, stored response | 60 s claim, 24 h result |
| Redis | `auction_endings` | Sorted set: member = auction ID, score = end time (ms) | Rebuilt from PostgreSQL by a reconciler |

"Three modeling choices are worth saying out loud. Money is integer cents, because floats drift and `pg` hands decimals back as strings. The leader is not a column: it's the earliest bid at the highest amount, so it can't disagree with the bid history. And auctions, bids and proxies share the shard key `auction_id`, so every bid transaction touches one shard. At ~550 GB of bids per year I'd start with one primary and hash-shard when storage or write volume forces it."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/auctions/{id}/bids           {amount} + Idempotency-Key → 201 | 400 | 409 | 422 | 429
PUT    /api/v1/auctions/{id}/proxy          {max_amount} + Idempotency-Key → 200
DELETE /api/v1/auctions/{id}/proxy          withdraw maximum (takes the row lock)
GET    /api/v1/auctions/{id}                auction + leader-first bids + version
GET    /api/v1/auctions?q&status&cursor     browse, keyset pagination
DELETE /api/v1/auctions/{id}                seller cancel, only before the first bid
POST   /api/v1/admin/auctions/{id}/close    force close through the same close transaction
GET    /ws                                  subscribe {auction_id} → new_bid, auction_ended
```

- **A `201` is a decision, not a receipt.** The body says `current_price`, `is_winning`, `version` and `end_time`, so the bidder knows immediately whether a proxy outbid them, without waiting for the WebSocket.
- **Errors are specific.** `400` carries the real `minimum_bid`. `409 already_leading` means "raise your maximum instead". `422` means the idempotency key was reused with a different body. `429` carries `Retry-After`. All use `application/problem+json`.
- **Synchronous, not `202 Accepted`.** I considered queueing bids and answering `202`, but then the user doesn't learn the outcome of the most time-sensitive action on the site. Since one row lock handles 100+ bids/s per auction, a queue buys nothing.

---

## 🔧 Deep Dive 1: Serializing Bids on a Hot Auction (8 min)

"Two bidders read $100 and both bid $101. Exactly one of them may win. I have three ways to enforce that."

| Approach | How it works | Where it breaks |
|----------|--------------|-----------------|
| ❌ Optimistic version check | `UPDATE … WHERE version = $seen`; retry on 0 rows | A retry can't be automatic — the price has moved past what the user authorized |
| ❌ Single-consumer queue per auction | Bids go to a partition; one worker applies them | Correct, but the bidder waits for an async answer and we operate a queue to do what a row lock already does |
| ✅ Row lock + Redis admission lock | `SELECT … FOR UPDATE` inside the bid transaction, with a short Redis lock in front | Bids on one auction are strictly serial |

**Why the row lock works.** Inside the transaction I lock the auction row and read the current price and leader, then decide and write. A second bidder's transaction waits at the lock and then sees the committed result. Locally, eight simultaneous $101 bids against a $100 auction produce exactly one acceptance and seven "minimum is now $102". A lock holds for ~5 ms, so one auction sustains 100–200 bids per second. That's more than twenty times the hottest realistic closing burst, and separate auctions never contend.

**Why optimistic locking fails here specifically.** It's the textbook answer for contention, and it works when the loser can simply retry. A bid can't be retried blindly. If I lost the race at $101, resubmitting $101 is now invalid, and resubmitting $102 spends money I never agreed to. So every version conflict becomes a user-visible "try again". Conflicts cluster in the last seconds, exactly when the user can least afford it. With a lock, the loser waits a few milliseconds and gets a true answer instead.

**Why the admission lock exists.** The row lock alone is correct, but each waiter holds a pooled database connection while it waits. A 50-bidder burst on one item would park 50 connections and stall browse and login for everyone. So each bid first takes `SET lock:auction:{id} NX EX 5` in Redis, polling with 10–40 ms of jitter for up to 1.5 s. Only one bidder per auction holds a database connection at a time. I don't need fencing tokens: if the Redis lock expires mid-transaction, the next request still serializes on the row lock. Redis only decides who waits where.

**What I give up.** Per-auction throughput is capped by lock hold time, so I keep the transaction short: no network calls inside it, notifications as rows, events through the outbox. A request that can't get the admission lock within 1.5 s gets `429` with `Retry-After`. An earlier design rejected on the first collision, which turned ordinary contention into errors.

---

## 🔧 Deep Dive 2: Proxy Bids and Exactly-Once Bids (7 min)

"Proxy bidding is where naive implementations quietly cheat users, and retries are where they quietly double-charge them."

### Second-price resolution

A proxy is a maximum: the system bids only one increment above the strongest competitor, never above the maximum. I resolve every bid with a pure function that takes the locked state — price, increment, reserve, leader, active proxies — and returns the rows to insert, the new price, the proxies to switch off, and who was outbid. Everything is in integer cents.

| Situation | Outcome |
|-----------|---------|
| Manual $120 vs leader's proxy max $150 (increment $1) | Proxy stays ahead at $121; rows: $120 manual, then $121 auto |
| Manual $150 vs proxy max $150 | Tie goes to the proxy, which committed first: price $150 |
| Manual $200 vs proxy max $150 | New leader at exactly $200; the proxy is recorded at $150 and switched off |
| New proxy $300 vs proxy $150 | New proxy leads at $151 |
| Leader bids again | `409 already_leading`: raise your maximum instead |
| Winning maximum covers an unmet reserve | Price jumps to the reserve |

**Why a pure function.** The bugs here are subtle. A naive version charged a manual bidder an increment above what they typed when they tied a proxy, let a proxy bid past its own maximum, and ignored the second-best proxy entirely. Each of those is a one-line unit test against a pure function, and nearly impossible to test against inline SQL.

**Two invariants keep it small.** Only the leader may hold an active proxy, because every beaten proxy is switched off in the same transaction. And the leader is the earliest bid at the highest amount: rows are inserted in ascending amount, earlier commitment first at equal amounts. The closer uses the same ordering, so "who's winning" and "who won" can never disagree.

### Exactly-once bids

The failure I design for: a bidder on a train taps Bid, the request times out, and they tap again. Without care that's two bids, or a bid at a price they didn't intend.

1. **The client sends an `Idempotency-Key`**, one per submitted bid, reused only when retrying that same bid.
2. **The API claims it** with `SET idem:{user}:{key} pending NX EX 60` before doing any work. If the key has finished, it replays the stored response with `Idempotent-Replayed: true`. If it's still in flight, it answers `409` with `Retry-After: 1`. If it was used with a different body, it answers `422`.
3. **The bid row carries the key** under a unique `(bidder_id, idempotency_key)` index. If Redis loses the record, or the process dies between commit and storing the response, the retry finds the bid in PostgreSQL instead of placing another.

| Approach | Verdict |
|----------|---------|
| ✅ Client key + Redis claim + durable unique index | Correct across timeouts, double taps, concurrent duplicates and a lost Redis record |
| ❌ Server dedupe by `{auction, user, amount, second}` | Merges or misses depending on clock edges; can't tell a retry from a deliberate bid |
| ❌ Disable the button | Stops a double click, not a retry after a timeout |

"Keys are scoped by user, so one user's key can never replay another user's response. What I give up is a Redis round trip and a stored response per bid — cheap at ~1,500 bids/s."

---

## 🔧 Deep Dive 3: Closing on Time, Exactly Once (5 min)

"At 8:00:00 p.m. nothing calls my API, yet five thousand auctions need a winner within seconds — and some of them were extended at 7:59:59."

**The index.** `auction_endings` is a Redis sorted set: member = auction ID, score = end time. Each worker tick reads up to 100 due IDs with `ZRANGEBYSCORE`. A snipe extension is just a re-`ZADD` of the new end time.

**The claim.** For each due ID, the worker calls `ZREM`; only the worker that gets `1` proceeds. That spreads ~100 closes per second across the pool without a coordinator.

**The guarantee.** The close runs as one transaction that starts with `SELECT … FOR UPDATE` on the auction, the same lock bids take. It re-checks everything: not active means someone else closed it, so stop. `end_time` in the future means a last-second bid extended it, so re-add the new time and stop. Otherwise it reads the leading bid, compares it to the reserve in cents, sets `status`, `winner_id` and `winning_bid_id`, writes the winner, seller and loser notifications, switches off proxies and writes the outbox event — all in one commit. A second worker that somehow claims the same auction waits for that commit and finds it ended. Notifications are written exactly once because they're part of the state change.

**The safety net.** The sorted set is an index, not the truth. A reconciler re-adds every active auction ending within the next two minutes, or already overdue, from a partial index on `end_time`. A flushed Redis, a worker that died after its claim, or rows written straight to SQL delay a close by one reconcile interval instead of stranding it forever.

| Approach | Verdict |
|----------|---------|
| ✅ Sorted set + `ZREM` claim + close under the row lock + reconciler | Fast "what's due", work split without coordination, correctness from the database |
| ❌ Poll `WHERE end_time <= now()` every second from every worker | Works at small scale, but N workers race for the same rows and the primary pays forever |
| ❌ A timer per auction in process memory | Lost on restart; a moving deadline means cancelling and re-arming timers everywhere |
| ❌ Trust the sorted set alone | If Redis loses it, auctions silently never close |

"One more property matters: bids never depend on the closer. A bid is rejected once `end_time` has passed, checked under the row lock. A lagging closer delays the announcement but can never let a late bid in. What I give up is an unbounded tail — sustained bidding keeps extending the auction — so I cap extensions with `extension_count`."

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first:** fan-out on hot items (10K watchers × 50 bids), long before the bid path. I handle it at the gateways, one event per bid across the backbone. Next is the closing spike at round times (more workers; the claim spreads them). Then bid storage at ~550 GB/year (shard by auction ID; every transaction stays single-shard).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Burst on one auction | A short wait; rarely `429` | Bounded admission wait; correctness from the row lock |
| Redis down | Bidding refused with `503` | I won't bid without retry safety; closer falls back to the partial index |
| API dies after commit | Response lost | Retry with the same key is answered from the durable index |
| Closer dies after claim | Close delayed | Reconciler re-adds it within one interval |
| Kafka or relay lag | Prices update late | The bid response is authoritative; clients refetch on reconnect |
| Gateway restart | Sockets reconnect | Clients resubscribe and refetch the snapshot by version |
| Primary failover | Bids pause for seconds | Synchronous replica, so no acknowledged bid is lost |

**What I'd watch:** bid latency by outcome; admission-lock wait and failures, labeled by lock type and never by auction ID (per-auction labels would explode Prometheus); idempotent replays and conflicts; seconds between `end_time` and close commit (the closing SLO, alert above 5 s); reschedules from snipe extensions; reconciler re-adds; outbox relay lag; gateway consumer lag and push rate.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Bid concurrency | Row lock | Optimistic version check | A lost race can't be retried without exceeding what the user authorized |
| Burst control | Redis admission lock, 1.5 s bounded wait | Wait in the DB pool, or reject at once | Protects the shared pool without failing every collision |
| Bid response | Synchronous `201` with the outcome | Queue + `202` | The bidder needs to know immediately; one row lock is fast enough |
| Proxy logic | Pure second-price resolver in cents | Inline SQL branches | Every tie and cap is unit-testable |
| Retries | Client key + durable unique index | Server fingerprint | Never duplicates, never merges intentional bids |
| Closing | Sorted set + `ZREM` + close under row lock + reconciler | DB polling or in-memory timers | Fast, parallel, and PostgreSQL stays the truth |
| Events | Outbox → Kafka, versioned | Publish after commit | No lost or phantom events; clients detect gaps |

"With more time I'd add the payment and escrow flow after the close, with its own idempotent state machine. I'd also add shill-bidding detection on the event stream, and a server-time endpoint so every countdown agrees with the closer to within a few hundred milliseconds."
