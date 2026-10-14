# Online Auction (eBay-style) — Architecture

## System Overview

An online auction lets sellers list items with a starting price, an optional hidden reserve and an end time. Bidders place bids or set a proxy maximum that bids for them, and everyone watching sees the price move live until a winner is declared. It looks like a shopping site. In practice it is a concurrency problem with a clock attached. Almost every write is a read-modify-write against one contended row ("is this bid at least the current price plus the increment?"). That has to stay correct while dozens of bidders hit the same item in its final seconds. And auctions end on the wall clock, not on a request, so something has to notice the deadline, pick exactly one winner, and tell everyone exactly once — even when a last-second bid moved the deadline.

This document describes the production-scale design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Valkey + React implementation actually does.

**Learning goals**

- Serializing writes per auction with a row lock, and why optimistic retries are wrong for money a user authorized.
- Proxy (second-price) bidding as a pure function with explicit tie-break rules.
- Idempotency keys for a money-adjacent write: claim, replay, `422` on reuse, and a durable backstop.
- Closing on time, exactly once, across many scheduler instances, with a deadline that can move.
- Real-time fan-out with versioned events, so clients can detect stale and missed updates.

## Requirements

### Functional requirements

1. Sellers create auctions: title, description, images, starting price, bid increment, optional reserve, duration, snipe-protection window.
2. Bidders place **manual bids** (at least current price + increment) and set **proxy maximums** that bid only as much as needed to lead.
3. Watchers see price, leader, bid history and the countdown update live.
4. **Anti-sniping:** a bid inside the final window extends the end so a full window remains.
5. At the end, the system declares the winner (or "reserve not met" or "no bids") and notifies the winner, the seller and the losing bidders.
6. Sellers cancel before the first bid; administrators can force-close or cancel any auction.
7. Watchlists, in-app notifications, browse and search.

Out of scope: payments and escrow, shipping, seller ratings, fraud scoring, Buy It Now.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Bid correctness | Every accepted bid is judged against the latest committed price; a retried request never places a second bid; no bid is accepted after the end |
| Bid latency | p99 < 300 ms, including any wait behind other bids on the same auction |
| Live updates | Price changes reach watchers within 1 s (p95 < 500 ms) |
| Closing | Winner decided within 2 s of the end (p99 < 5 s), exactly once |
| Availability | 99.95% for bidding; 99.99% for browsing (cacheable) |
| Durability | An acknowledged bid is never lost (synchronous replica commit) |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Users | 2M daily active, 200K concurrent at the evening peak | Stateless API and gateway tiers behind a load balancer |
| Live auctions | 1M at any time; 300K new listings/day (~3.5/s) | Listing writes are light; browse is a search problem |
| Bids | 10M/day → ~115/s average, ~1,500/s peak | One PostgreSQL primary handles the volume; contention, not volume, is the problem |
| Hot auction | 50 bids in its final 10 s; 10K watchers | Serialize per auction; one item needs ~5 bids/s, far below the ~100–200 bids/s a single row lock sustains |
| Fan-out | Each accepted bid on a hot item → 10K pushes; 50 bids → 500K messages in 10 s | Gateways fan out locally; one event per bid crosses the backbone, not one per watcher |
| Endings | 300K/day; peaks of ~5K in one minute (sellers pick round times) | The closer must sustain ~100 closes/s without missing one |
| Storage | Bids ~150 B × 10M/day ≈ 1.5 GB/day (~550 GB/year); listings ~2 KB × 300K/day ≈ 220 GB/year; images ~2 MB/listing ≈ 600 GB/day | Relational data fits one sharded cluster for years; images go to object storage behind a CDN |

The two numbers that drive the design: the whole site needs only ~1,500 bids/s, but a single auction can take 50 bids in 10 seconds. So the hard part is **contention on one row**, not throughput. And one accepted bid can mean 10,000 pushes, so fan-out has to happen at the edge.

### Local Development Scale

One to three Express processes (`dev:server1..3` on 3001–3003), PostgreSQL, Valkey and the Vite dev server; tens of users and a few hundred auctions. Each API process also runs a scheduler loop, which is enough to exercise the multi-instance closing race. There is no load balancer, Kafka, outbox relay, CDN or search engine locally. Ports and setup are in the [README](./README.md).

## High-Level Architecture

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

1. **Place a bid (1).** The browser posts the bid with an `Idempotency-Key`. The Auction API claims the key and the per-auction admission lock in Redis. It then runs one PostgreSQL transaction under the auction's row lock: it resolves proxies, inserts the bid rows, updates price, version and end time, and writes an outbox row. Then it commits and answers.
2. **Live update (2).** A relay publishes committed outbox rows to Kafka, keyed by auction ID. Every Realtime gateway consumes the topic and pushes `new_bid` to the sockets subscribed to that auction. Clients apply events by version.
3. **Close (3).** Closing workers read due auction IDs from a Redis sorted set scored by end time and claim each with `ZREM`. They close it in PostgreSQL under the same row lock. The outbox carries `auction_ended` to the gateways and to the notification workers.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routes `/api` and `/ws` | Connections | Sticky only for WebSocket upgrades |
| Auction API | Bids, listings, browse, auth | Requests (~1,500 bids/s peak) | Stateless; the transaction holds the state |
| Redis | Admission locks, idempotency keys, end-time sorted set, sessions | Hot keys | Losing it slows bidding and delays closes; it never corrupts them |
| Closing workers | Close due auctions exactly once | Endings per second | Dedicated pool; claim with `ZREM`, decide under the row lock |
| PostgreSQL | Source of truth: auctions, bids, proxies, notifications, outbox | Auctions (sharded by auction ID) | Primary + synchronous replica; read replicas for browse |
| Kafka | `auction-events`, keyed by auction ID | Events (~1,500/s peak) | Per-auction ordering; replayable for gateways, notifications, search |
| Realtime gateways | WebSocket subscriptions and local fan-out | Concurrent sockets (200K) | Each consumes all events and filters by local subscriptions |
| Notification workers | Email, push, in-app | Notifications | Idempotent by event ID |

Images live in object storage behind a CDN, and browse/search reads a search index fed from the same Kafka topic. Both are standard, so they're left out of the diagram.

## Core Components / Request Flows

### Placing a bid

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

- **Steps 2–3 happen before any database connection is taken.** The idempotency claim turns a retry into a replay. The admission lock (`SET NX` with up to 1.5 s of jittered polling) lets a burst on one auction wait in Redis rather than in the PostgreSQL connection pool (see [decision 2](#2-a-redis-admission-lock-in-front-of-the-row-lock)).
- **Step 4 is the real guarantee.** `SELECT … FOR UPDATE` on the auction row serializes every bid, proxy change, close and cancel on that auction. Each one sees the state the previous one committed.
- **Step 6 is pure.** `resolveBid` gets the locked state (price, increment, reserve, leader, live proxies) and returns the rows to insert, the new price, the proxies to switch off, and who was outbid. The rules are below.
- **Step 7 is one transaction.** Bid rows, proxy rows, price, `version + 1`, a snipe extension of `end_time`, outbid notifications, and (in production) the outbox row commit together or not at all.

**Proxy resolution rules** (second-price, as on eBay):

| Situation | Result |
|-----------|--------|
| Manual bid below price + increment | `400` with the real minimum |
| Manual bid, leader has no proxy | The bid leads at exactly its amount |
| Manual bid X, leader's proxy max M ≥ X | Proxy stays ahead at min(M, X + increment); a tie (X = M) goes to the proxy, which committed first |
| Manual bid X > leader's proxy max M | New leader at exactly X; the proxy is recorded at M and switched off |
| New proxy P vs leading proxy M | Higher maximum leads at min(winner max, loser max + increment); the loser is switched off |
| Leader bids again | `409 already_leading` — they can only raise their maximum |
| Winning proxy max ≥ unmet reserve | Price jumps to the reserve |

Ties are broken by commitment time. Rows are inserted in ascending amount, and at an equal amount the earlier commitment goes first. So **the leader is always the earliest bid at the highest amount**, and the closing path uses exactly the same ordering to pick the winner. After every resolution only the leader may hold an active proxy.

### Live updates

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

Every price change, close and cancel increments `auctions.version` in the same transaction, and every event carries it. A client holding version 41 applies `v42` directly. It ignores anything ≤ 41, which handles duplicates and late delivery. A jump to `v45` means it missed something, so it refetches the snapshot. That one integer turns an at-least-once, possibly reordered stream into a correct view without per-client replay buffers. Gateways keep no history: on reconnect the client resubscribes and refetches.

### Closing an auction

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

- **The sorted set is an index, not the truth.** `auction_endings` (score = end time in ms) answers "what is due now" in O(log N + due) per tick. A reconciler periodically re-adds every active auction that ends within the next two minutes, or is already overdue. A flushed Redis, a worker that crashed after its claim, or rows written straight to SQL therefore delay a close by one reconcile interval instead of stranding the auction.
- **`ZREM` is the claim.** Exactly one caller gets `1`, so each due auction is attempted by one worker. That's only an efficiency measure.
- **The row lock is the guarantee.** The close re-reads the auction `FOR UPDATE`. If it is no longer active (another worker closed it), it stops. If `end_time` moved (snipe extension), it re-adds the new end and stops. Otherwise it writes the outcome, the winner and every notification in one transaction. Two workers can never both close an auction, because the second one waits for the first one's commit and then sees `status = 'ended'`.
- **Bids never depend on the closer.** A bid is rejected if `end_time` has passed, checked under the row lock. Closer lag delays the announcement, never lets a late bid in.

## Database Schema

### Production schema

```sql
-- Money as integer minor units; auctions and their bids share the shard key auction_id.
CREATE TABLE auctions (
    id                UUID PRIMARY KEY,
    seller_id         UUID NOT NULL,
    title             TEXT NOT NULL,
    starting_cents    BIGINT NOT NULL CHECK (starting_cents > 0),
    increment_cents   BIGINT NOT NULL DEFAULT 100,
    reserve_cents     BIGINT,                         -- hidden from bidders
    current_cents     BIGINT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active', -- active | ended | cancelled
    end_time          TIMESTAMPTZ NOT NULL,           -- moves forward with snipe protection
    snipe_window      INTERVAL NOT NULL DEFAULT '2 minutes',
    extension_count   INT NOT NULL DEFAULT 0,         -- caps snipe extensions
    winner_id         UUID,
    winning_bid_id    UUID,
    version           BIGINT NOT NULL DEFAULT 0,      -- +1 per price change, close, cancel
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auctions_due ON auctions (end_time) WHERE status = 'active';

CREATE TABLE bids (                                   -- append-only
    id                UUID PRIMARY KEY,
    auction_id        UUID NOT NULL REFERENCES auctions(id),
    bidder_id         UUID NOT NULL,
    amount_cents      BIGINT NOT NULL,
    is_auto           BOOLEAN NOT NULL,
    seq               BIGINT GENERATED ALWAYS AS IDENTITY,
    idempotency_key   TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bids_leader ON bids (auction_id, amount_cents DESC, seq);  -- leader = first row
CREATE UNIQUE INDEX bids_idem ON bids (bidder_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE proxies (
    auction_id        UUID NOT NULL REFERENCES auctions(id),
    bidder_id         UUID NOT NULL,
    max_cents         BIGINT NOT NULL,
    is_active         BOOLEAN NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL,           -- tie-break: earlier commitment wins
    PRIMARY KEY (auction_id, bidder_id)
);

CREATE TABLE outbox (                                 -- written in the same transaction
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    auction_id        UUID NOT NULL,
    type              TEXT NOT NULL,                  -- new_bid | auction_ended
    version           BIGINT NOT NULL,
    payload           JSONB NOT NULL,
    published_at      TIMESTAMPTZ
);
```

`notifications (id, user_id, auction_id, type, message, read_at)` is sharded by user. At ~550 GB of bids per year, `auctions`, `bids` and `proxies` are hash-sharded together by `auction_id`. A bid only ever touches one auction, so every transaction stays on one shard and needs no cross-shard coordination.

### Local schema

The local schema lives in [`backend/src/db/init.sql`](./backend/src/db/init.sql). It is re-runnable (`IF NOT EXISTS`, a guarded constraint, `CREATE OR REPLACE TRIGGER`) and loaded by Docker Compose into fresh volumes.

| Production | Local | Difference |
|------------|-------|------------|
| `*_cents BIGINT` | `DECIMAL(12,2)` columns | The bid engine converts to integer cents at the boundary |
| `auctions` | `auctions` (`current_price`, `bid_increment`, `reserve_price`, `end_time`, `snipe_protection_minutes`, `version`, `winner_id`, `winning_bid_id`) | No `extension_count`, so no snipe cap |
| `bids` | `bids` (`sequence_num SERIAL`, `idempotency_key`, `idx_bids_leader`, unique `idx_bids_idempotency`) | Same leader ordering and durable key |
| `proxies` | `auto_bids` (`max_amount`, `is_active`, `updated_at`) | Same |
| `outbox` | — | Events are published to Redis pub/sub after commit |
| `notifications` | `notifications` (`is_read`), written inside the bid and close transactions | No delivery channel |
| sessions in Redis | `session:{token}` in Valkey | The `sessions` table exists but is unused |

## API Design

### Production API

```
POST   /api/v1/auctions                      create listing (multipart, images to object storage)
GET    /api/v1/auctions?q&status&sort&cursor browse/search, keyset pagination
GET    /api/v1/auctions/{id}                 auction + leader-first bids + version
POST   /api/v1/auctions/{id}/bids            {amount} + Idempotency-Key → 201 | 400 | 409 | 422 | 429
PUT    /api/v1/auctions/{id}/proxy           {max_amount} + Idempotency-Key → 200
DELETE /api/v1/auctions/{id}/proxy           withdraw maximum (under the row lock)
DELETE /api/v1/auctions/{id}                 seller cancel, only before the first bid
POST   /api/v1/admin/auctions/{id}/close     force close (same transaction as the closer)
GET    /ws                                   subscribe {auction_id}; events new_bid, auction_ended
```

- **`201` body:** `{bid, current_price, is_winning, version, end_time, extended}`. A replay returns the stored body with `Idempotent-Replayed: true`.
- **Errors:** `400` below minimum (with `minimum_bid`), ended, own auction; `409 already_leading` or a key still in flight (`Retry-After: 1`); `422` key reused with a different body; `429` rate limited or the admission lock wasn't won within 1.5 s (`Retry-After`). All are `application/problem+json`.
- **Events:** `new_bid {auction_id, version, current_price, leader_id, end_time, extended, bids[]}` and `auction_ended {auction_id, version, outcome, winner_id, final_price}`.

### Local routes

The Express routes are not versioned: `POST /api/bids/:auctionId` (`{amount}`), `POST /api/bids/:auctionId/auto` (`{max_amount}`), `DELETE /api/bids/:auctionId/auto`, `GET /api/bids/:auctionId`, plus `/api/auth/*`, `/api/auctions/*`, `/api/notifications/*` and `/api/admin/*` as listed in the [README](./README.md). Errors are `{error, ...}` JSON rather than problem+json. Both bid endpoints accept `Idempotency-Key` (and the legacy `X-Idempotency-Key`).

## Key Design Decisions

### 1. Pessimistic row lock, not optimistic version checks

Every bid takes `SELECT … FOR UPDATE` on the auction row and holds it through validation, proxy resolution, inserts and the price update. Optimistic concurrency is the textbook answer for contention, and it fails here for an auction-specific reason. A bidder who loses the version race can't be retried automatically: by the time the retry runs, the price has moved past what they authorized. Resubmitting the same amount is now invalid, and resubmitting a higher one spends money they never agreed to. So every conflict becomes a user-visible failure, and conflicts peak in the final seconds, exactly when bidders care most. With the row lock, the second bidder waits a few milliseconds and gets a correct answer: either "you lead" or "the minimum is now $X". The cost is that bids on one auction are strictly serial, which caps one auction at roughly 100–200 bids/s. That is two orders of magnitude above the hottest real auction, and different auctions never contend.

### 2. A Redis admission lock in front of the row lock

The row lock alone is correct, but every waiter holds a pooled database connection while it waits. A hot auction's closing burst could drain the shared pool and stall unrelated requests (browse, login, other auctions). So each bid first takes `SET lock:auction:{id} NX EX 5` in Redis, polling with 10–40 ms jitter for up to 1.5 s before answering `429`, so only one bidder per auction holds a connection. The lock is an optimization, never a guarantee. If it expires mid-transaction, the next request still serializes on the row lock, so it needs no fencing token. An earlier version rejected immediately, which turned every collision into a user-visible failure. The bounded wait absorbs a realistic burst: in local tests, 32 simultaneous bids from two instances finished in under 0.5 s with no `429`.

### 3. Proxy bidding as a pure function

Proxy resolution has enough cases (ties, caps, reserves, stale proxies) that it is easy to get subtly wrong. A naive version charges a manual bidder an increment above what they typed, lets a proxy bid past its own maximum, or ignores the second-best proxy. So `resolveBid` takes the locked state, works in integer cents, and returns rows and side effects without touching I/O, which makes every rule unit-testable. Two invariants keep it simple: only the leader may hold an active proxy, and the leader is the earliest bid at the highest amount. The cost is a translation layer between the DECIMAL rows and the engine's cents, and a rule the UI must explain: a leader can't outbid themselves, only raise their maximum.

### 4. Endings in a sorted set, claimed with ZREM, reconciled from PostgreSQL

Polling `WHERE status = 'active' AND end_time <= now()` every second works and is cheap with a partial index. But it puts a query per worker per second on the primary forever, and it gives no natural way to split work between workers. A sorted set answers "what is due" from memory, and `ZREM` gives each due auction to exactly one worker. A snipe extension is just a re-`ZADD`. The danger is treating Redis as the truth: if the set is lost, auctions never close. So PostgreSQL stays authoritative. A reconciler re-adds active auctions ending within two minutes, and the close re-checks everything under the row lock. The cost is two moving parts (index plus reconciler) where one query would do. That pays off at ~100 closes/s across a worker pool.

### 5. Snipe protection inside the bid transaction

If a price change lands with less than the snipe window left, `end_time` moves to now + window in the same transaction. The row is locked, so no bid is ever judged against an end time another request is in the middle of changing. The closer re-reads `end_time` under the same lock, so a stale schedule entry reschedules instead of closing early. The price is a tail that can run long: sustained bidding extends the auction indefinitely. Production caps it with `extension_count`; the local build has no cap yet.

### 6. Events through a transactional outbox, versioned

Writing the bid and then publishing to a broker is a dual write. A crash between the two loses the event, and publishing before commit announces bids that may roll back. The outbox row commits with the bid, a relay publishes it to Kafka keyed by auction ID (per-auction order), and consumers deduplicate by `(auction_id, version)`. The cost is the relay (CDC or polling, ~100 ms of added latency) and a table to prune. The local build publishes to Redis pub/sub right after commit. That is at-most-once, and the version gap check on the client is what makes it recoverable.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Bid acceptance | Judged against the latest committed price; ≥ price + increment | `SELECT … FOR UPDATE` on the auction row |
| Bid retry | At most one bid per client request | `Idempotency-Key`: Redis `SET NX` claim + stored response (24 h); unique `(bidder_id, idempotency_key)` on `bids` as the durable backstop; `422` on reuse with a different body |
| Proxy maximum | Never exceeded; never bids against its own holder | `resolveBid` caps at the max; leader bids are rejected |
| Winner | Exactly one, decided once | Close under the row lock, conditional on `status = 'active'` and `end_time ≤ now` |
| Notifications | Written exactly once with the state change | Inserted in the bid or close transaction |
| Live view | Never moves backwards; gaps detected | `version` on every event and snapshot |
| Late bids | Rejected after `end_time`, even if the closer lags | End time checked under the row lock |

Idempotency keys are scoped to the user (`idem:{user}:{key}`), so one user's key can never replay another user's response. A request still in flight answers `409` with `Retry-After: 1`. A failed request releases its claim so the client can retry with the same key. A completed one is replayed with `Idempotent-Replayed: true`. If Redis loses the record, or the process dies between commit and storing the response, the retry finds the bid through the unique index and is answered from the database.

## Security / Auth

- **Authentication:** session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, backed by Redis. WebSocket connections authenticate with the same session.
- **Authorization:** sellers may not bid on their own auctions; only the seller (before the first bid) or an administrator may cancel; force-close is admin-only. The reserve price is never sent to bidders, only "reserve met / not met".
- **Abuse:** per-user bid rate limit (10/min) and per-IP limits at the edge; shill-bidding detection (seller-linked accounts) runs offline on the event stream.
- **Input validation:** amounts are positive with at most two decimals and are converted to integer cents; IDs are UUIDs (a malformed ID is a `404`, not a database error).

## Observability

- **Bid path:** latency by outcome; requests by kind (manual/proxy) and outcome (success, rejected, error); admission-lock wait time and failures (labelled by lock type, never by auction ID — per-auction labels explode Prometheus cardinality); idempotent replays and conflicts.
- **Closing:** closes by outcome (sold, reserve not met, no bids, cancelled); seconds between `end_time` and the close commit (the closing SLO, alert above 5 s); reschedules caused by snipe extensions; reconciler re-adds (non-zero in steady state means claims are being lost).
- **Fan-out:** outbox relay lag, Kafka consumer lag per gateway, connected sockets, pushes per second, slow-consumer disconnects.
- Structured logs carry the request ID, auction ID and bidder ID; traces span API → Redis → PostgreSQL.

## Failure Handling

| Failure | Behavior | Mitigation |
|---------|----------|------------|
| Burst on one auction | Bids queue for the admission lock | Bounded 1.5 s wait, then `429` + `Retry-After`; correctness from the row lock |
| Redis down | No admission lock or idempotency claim; endings index stale | Fail bids with `503` (don't bid without retry safety); closer falls back to polling the partial index |
| Process dies mid-bid | Transaction rolls back; lock expires in 5 s | Client retries with the same key |
| Process dies after commit | Response lost | Retry is answered from the durable key; the outbox still publishes |
| Closer dies after claim | Auction missing from the set | Reconciler re-adds it within one interval |
| Snipe extension races a close | Close sees the moved `end_time` under the lock | Reschedules instead of closing |
| Kafka or relay lag | Watchers see prices late | Bid responses are authoritative for the bidder; clients refetch on reconnect |
| Gateway restart | Sockets drop | Clients reconnect, resubscribe and refetch the snapshot |
| PostgreSQL primary down | No bids or closes | Fail over to the synchronous replica; closes catch up from the index |

## Scalability Considerations

1. **Hot auctions first.** One auction is bounded by one row lock (~100–200 bids/s), comfortably above real demand. The pressure shows up in fan-out instead: 10K watchers × 50 bids in 10 s. Gateways fan out locally, so one event per bid crosses the backbone.
2. **Bids scale by sharding on `auction_id`.** Auctions, bids and proxies co-locate, so every transaction is single-shard.
3. **Gateways scale horizontally** by connection count; each consumes the full event stream, which is only ~1,500 events/s at peak.
4. **Closing scales by worker count.** `ZREM` claims spread due auctions across workers, and the sorted set can be split by auction-ID hash if one Redis key gets hot.
5. **Browse and search** move to read replicas plus a search index fed from Kafka; listing pages are CDN-cacheable for a few seconds.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Bid concurrency | Row lock (`FOR UPDATE`) | Optimistic version check | A lost race can't be retried without exceeding what the user authorized |
| Burst handling | Redis admission lock, bounded wait | Wait in the DB pool / reject at once | Protects the shared pool without failing every collision |
| Proxy logic | Pure resolver, integer cents | Inline SQL branches | Every tie and cap rule is unit-testable |
| Bid retries | Client `Idempotency-Key` + durable unique index | Server body fingerprint | Retries never duplicate; intentional bids are never merged |
| Ending schedule | Redis sorted set + `ZREM` claim + reconciler | Poll PostgreSQL every second | Cheap "what's due", work split across workers, PostgreSQL stays the truth |
| Close guarantee | Conditional close under the row lock | Distributed lock around the closer | The database already serializes bids and closes |
| Anti-sniping | Extend in the bid transaction (capped) | Hard close | No bid judged against a moving deadline; cap bounds the tail |
| Events | Outbox → Kafka, versioned | Publish after commit | No lost or phantom events; versions let clients detect gaps |
| Live updates | WebSocket gateways | Polling | Sub-second updates for 10K watchers without 10K requests per second |

## Implementation Notes

The local project runs all three journeys (bid, live update, close) on one stack: Express API processes that each also run the WebSocket server and a scheduler loop, PostgreSQL 16, Valkey 7 from [`docker-compose.yml`](./docker-compose.yml), and a React 19 + TanStack Router + Zustand frontend. This section maps the design above to the code as of the 2026-10-10 review.

### Production design → local implementation

| Production design | Local implementation | Where |
|-------------------|----------------------|-------|
| Auction API, closing workers, gateways as separate pools | One Express process does all three; run `dev:server1..3` for several | [index.ts](./backend/src/index.ts) |
| Row-locked bid transaction | Implemented as designed, shared by manual and proxy bids | [routes/bids.ts](./backend/src/routes/bids.ts) |
| Pure proxy resolver in cents | Implemented, 16 unit tests | [services/bidEngine.ts](./backend/src/services/bidEngine.ts) |
| Admission lock with bounded wait | `SET NX EX 5`, random token, Lua compare-and-delete release, 1.5 s jittered wait | [redis.ts](./backend/src/redis.ts) |
| `Idempotency-Key` + durable backstop | Redis claim/replay/`422`, unique `(bidder_id, idempotency_key)` index | [shared/idempotency.ts](./backend/src/shared/idempotency.ts), [routes/bids.ts](./backend/src/routes/bids.ts) |
| Sorted set + `ZREM` claim + reconciler | Implemented; every API process runs the loop (1 s tick, 30 s reconcile, 2 min window) | [services/scheduler.ts](./backend/src/services/scheduler.ts) |
| Close/cancel under the row lock | Implemented, notifications inside the transaction | [services/auctionLifecycle.ts](./backend/src/services/auctionLifecycle.ts) |
| Outbox → Kafka → gateways | Redis pub/sub `auction:{id}` published after commit; each process pattern-subscribes and fans out to its sockets | [services/websocket.ts](./backend/src/services/websocket.ts) |
| Versioned events, client gap detection | `version` on every `new_bid`/`auction_ended`; the auction page applies `v+1`, ignores stale, refetches on gaps and reconnects | [utils/auctionEvents.ts](./frontend/src/utils/auctionEvents.ts) |
| Snipe extension, capped | Extension implemented; no cap | [routes/bids.ts](./backend/src/routes/bids.ts) |
| Integer cents in the schema | `DECIMAL(12,2)`, converted with `toCents`/`fromCents` | [services/bidEngine.ts](./backend/src/services/bidEngine.ts) |
| Search index, keyset pagination | `ILIKE` and `OFFSET` | [routes/auctions.ts](./backend/src/routes/auctions.ts) |

### The bid path

`placeBid(kind)` in [routes/bids.ts](./backend/src/routes/bids.ts) handles both endpoints. The order is: validate the amount (positive, at most two decimals) and the UUID, claim the `Idempotency-Key`, check the per-user rate limit (Lua `INCR` + `EXPIRE` in one step), take the admission lock, then run `applyBid` inside `withTransaction`:

```typescript
// backend/src/routes/bids.ts — inside one transaction, auction row locked
const resolution = resolveBid({ priceCents, incrementCents, reserveCents,
  leaderId: leader?.bidder_id ?? null, leaderSince, proxies }, action);
// then: upsert the caller's proxy, deactivate beaten proxies, insert bid rows in order
// (the caller's row carries the idempotency key), UPDATE price + version (+ end_time),
// INSERT outbid notifications
```

- The leader is read with `ORDER BY amount DESC, sequence_num ASC` (index `idx_bids_leader`). The bid-history endpoints use the same order, so the first row shown is always the leader.
- A snipe extension sets `end_time = now + snipe_protection_minutes`, and `0` disables protection. After commit the new end is `ZADD`ed and `new_bid` is published with `version`, `end_time`, `leader_id` and the inserted rows.
- Outbid notices go only to the displaced leader and exhausted proxies, not to every past bidder.
- Cancelling a proxy also locks the auction row, so a concurrent resolution never uses a proxy the user just withdrew.

### Closing and cancelling

[services/auctionLifecycle.ts](./backend/src/services/auctionLifecycle.ts) holds `closeAuction` and `cancelAuction`. Both start with `SELECT … FOR UPDATE`. The pure `decideClose` returns `skip` (not active), `reschedule` (end moved) or `close` with an outcome. The reserve is compared in cents, because comparing DECIMAL strings had treated "950.00" as above "1000.00". Winner, loser and seller notifications, the status change and proxy deactivation commit together. Redis updates happen after commit and are logged, not thrown, if they fail. A seller's "no bids yet" check runs after the row lock, so a bid can't slip in between check and cancel. Admins call the same functions with `force: true` and `allowWithBids: true`.

### Real-time updates

Each process pattern-subscribes to `auction:*` and forwards messages to its local sockets. WebSocket listeners are registered synchronously at connect time; the optional `?token=` session lookup finishes in the background, because auction updates are public. On the client, [auction.$auctionId.tsx](./frontend/src/routes/auction.$auctionId.tsx) keeps one stable subscription and applies `new_bid` through `applyBidEvent`. A refetch happens only on a version gap, an `auction_ended`, or a re-subscription after reconnect, and a slower snapshot never overwrites a newer state. [BidForm.tsx](./frontend/src/components/BidForm.tsx) sends one `Idempotency-Key` per submitted draft and reuses it when the same amount is resubmitted after a failure.

### Simplified or substituted

- Redis pub/sub after commit instead of an outbox and Kafka: at-most-once. A crash between commit and publish drops that event; clients recover on the next event (version gap) or on reconnect.
- The scheduler runs inside every API process instead of a dedicated pool. The `ZREM` claim keeps the duplicate work to an empty tick.
- `DECIMAL(12,2)` money in the database, sessions only in Redis, images on local disk via multer, `ILIKE` search with `OFFSET` pagination.
- Errors are `{error}` JSON, not problem+json; routes are not versioned.
- The frontend uses `fetch` + `useState` and a Zustand WebSocket store, not TanStack Query; only the auction detail page updates live.

### Omitted and known limitations

- No snipe-extension cap (`extension_count`), payments, escrow, email or push delivery, search index, CDN, multi-region deployment, or fraud detection. `shared/circuitBreaker.ts` exists but wraps nothing.
- Sessions live only in Redis, so with Redis down every authenticated request fails at login checks; a Redis error inside the bid pipeline (claim, rate limit, admission lock) answers `503` with `Retry-After` rather than bidding without retry safety. The rate limit is a per-user fixed window.
- WebSockets have no server heartbeat, so a dead socket lingers until TCP notices. The session token travels in the `?token=` query string.
- Seeded data must respect the proxy invariant: the seed now records the proxy responses on the Leica and the Aeron, so only leaders hold active proxies.

### Verification (2026-10-10)

- `npm test` in `backend/` runs 26 offline vitest tests: proxy resolution and money handling (16), close decisions including the string-reserve bug (5), and idempotency helpers (5). Backend and frontend `tsc --noEmit` are clean, the frontend `npm run build` succeeds, and backend lint is clean. The frontend lint error in `authStore.ts` predates this review.
- Runtime, against PostgreSQL 16 and a private Redis with **two API instances** (4700, 4701): `init.sql` loaded twice, seed loaded, and 28 checks pass. Among them:
  - Proxy answers and ties on the seeded Leica, including a tie at the proxy maximum going to the proxy and the leader's `409`.
  - Replay, `422` and six concurrent duplicates producing one bid row; a retry after deleting the Redis record answered from the database.
  - Eight simultaneous $101 bids producing exactly one acceptance.
  - A 24-bid shuffled burst across both instances whose rows each beat the previous price, with `version` equal to the accepted count.
  - One versioned WebSocket event per accepted bid delivered across instances.
  - Exactly one won/sold/lost notification per close with two schedulers; a 950 bid against a 1,000 reserve closing as reserve-not-met.
  - A stale schedule entry rescheduled rather than closing a snipe-extended auction; admin force-close; the seller cancel rules.
- The runtime checks found and fixed two WebSocket defects that had kept live updates from ever reaching a browser:
  - The server pattern-subscribed but listened for `message` instead of `pmessage`.
  - Socket listeners were attached only after an awaited session lookup, so an immediate `subscribe` was dropped.
