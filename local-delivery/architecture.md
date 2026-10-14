# Local Delivery — Architecture

## System Overview

A last-mile delivery platform in the style of DoorDash, Instacart or Gopuff: customers order from local merchants, the platform finds a nearby courier, and the customer watches the order arrive. Three problems make it interesting. **Location is a firehose**: every online courier reports a position every few seconds, roughly a thousand times more writes than orders. **Assignment must be exactly once**: an order goes to one courier, and a courier who accepts must never find the order cancelled or given to someone else, because drivers cannot be rolled back. **Tracking must survive bad networks**: phones drop off in tunnels and elevators, and the screen must catch up without missing a state.

This document describes the production design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Redis + React implementation actually does.

**Learning goals**

- A geospatial index for "who is near this merchant", and why it lives in Redis instead of the order database.
- Sequential offers with an atomic claim: compare-and-set updates plus partial unique indexes so one order gets one courier.
- An order state machine where every transition is a guarded `UPDATE`.
- Leases with expiry, and `FOR UPDATE SKIP LOCKED`, so matching survives a crashed process.
- Idempotent order placement in the same transaction as the order.
- Live tracking with WebSockets: one Redis subscriber per node, snapshot then stream, versioned events.

## Requirements

### Functional requirements

1. Customers browse nearby merchants and menus, build a cart from one merchant, see the server's price, and place an order.
2. The platform offers each order to nearby couriers, one at a time, until one accepts.
3. Couriers go online and offline, receive offers with a countdown, accept or decline, and move the order through pickup and delivery.
4. Customers track their order live: status changes, the courier's position and an ETA.
5. Customers cancel before preparation starts; after delivery they rate the courier and the merchant.
6. Administrators see orders, couriers, merchants and platform statistics.

Out of scope: payments (an authorization step would sit before dispatch), batching several orders onto one courier, surge pricing, and the merchant tablet app.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Order placement availability | 99.99% | Revenue moment; must not depend on courier supply |
| Order placement latency | p99 < 300 ms | Placement returns before matching starts |
| Time to assign a courier | p50 < 30 s, p99 < 2 min | Food is cooking; customers watch a spinner |
| Location freshness | Courier position at most 3 s old on the customer's map | Below this a moving dot looks broken |
| Assignment correctness | Exactly one courier per order, never a cancelled order | Two couriers at one restaurant cannot be undone |
| Duplicate orders | Zero from retries | A double charge is a support ticket and a refund |
| ETA accuracy | Within 3 minutes for 90% of orders | The trust metric |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Orders | 1M/day → ~12/s average, ~35/s at the dinner peak | One PostgreSQL primary handles the order writes |
| Online couriers | 100K drivers, ~30% online → 30K concurrent | Sizes the geo index and the WebSocket fleet |
| Location pings | 30K couriers ÷ 3 s → ~10K writes/s | Hot path goes to Redis only, never to the order database |
| Location history if every ping were stored | 10K/s × ~100 B ≈ 1 MB/s ≈ 86 GB/day | Sample (1 in 3) and stream to Kafka and cold storage |
| Live trackers | ~50K customers watching at peak, 1 update per 3 s | ~17K pushed messages/s across the gateway fleet |
| Geo index size | 30K members × ~100 B ≈ 3 MB per region | Fits in one Redis per metro with room to spare |
| Offers | ~1.5 offers per order → ~50/s at peak | Durable offer rows in PostgreSQL are cheap |

The ratio drives everything: locations outnumber orders about 300 to 1 per second, but an order that is lost or double-assigned costs far more than a lost ping. Orders get transactions; locations get a volatile index that refreshes itself every 3 seconds.

### Local Development Scale

One Express process serves the API, the WebSocket endpoint, the matching loops and the background jobs, against one PostgreSQL and one Redis. The seed has 3 merchants, 15 menu items, 2 customers, 3 couriers and an admin. `dev:server1..3` start extra instances on ports 3001–3003 against the same database and Redis, which is enough to watch dispatch leases move between instances. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
  ┌──────────────────────────┐                          ┌────────────────────────────┐
  │ Customer app             │                          │ Courier app                │
  │ cart · order tracking    │                          │ offers · GPS every 3 s     │
  └───┬──────────────────────┘                          └───────────────────┬────────┘
      │                  ▲                                  ▲               │
      │ (1) POST /orders │ WSS: status,                     │ WSS: offers   │ (3) POST /location
      │ Idempotency-Key  │ location, ETA                    │               │ POST …/accept
      ▼                  ▼                                  ▼               ▼
  ┌───────────────────────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS · session auth · rate limits · routes /api/* and /ws                  │
  └────────┬───────────────────────┬───────────────────────────────────────────────┬──────────┘
           │                       │                       ▲                       │
           │ /orders               │ /offers               │ /ws                   │ /location
           ▼                       ▼                       ▼                       ▼
  ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
  │ Order Service     │   │ Dispatch Service  │   │ Tracking Gateway  │   │ Location Service  │
  │ pricing · states  │   │ matching · offers │   │ WebSocket fan-out │   │ ping ingest       │
  └────────┬──────────┘   └───┬───────────┬───┘   └───────────┬───────┘   └───┬─────────┬─────┘
           │                  │           │                   ▲               │         │
           │ INSERT order,    │ offer,    │ (2) GEOSEARCH     │ SUBSCRIBE     │ GEOADD  │
           │ key, lease       │ claim     │                   │               │ PUBLISH │
           ▼                  ▼           ▼                   │               │         │ sample
  ┌────────────────────────────────┐    ┌─────────────────────┴──────┐        │         │
  │ PostgreSQL · source of truth   │    │ Redis · one per metro      │◀───────┘         │
  │ orders, offers, couriers, keys │    │ geo, last-seen, pub/sub    │                  │
  └────────────────────────────────┘    └────────────────────────────┘                  │
                                                                                        ▼
                                                                          ┌────────────────────┐
                                                                          │ Kafka · locations  │
                                                                          │ → history, ETA ML  │
                                                                          └────────────────────┘
```

1. **Place an order (1).** The customer app posts the cart with an `Idempotency-Key`. The Order Service prices it from the menu and, in one transaction, writes the order, its items, the idempotency record and a dispatch lease. It answers `201` straight away; finding a courier happens afterwards, so placement never waits on courier supply.
2. **Dispatch (2).** The Dispatch Service instance holding the order's lease searches the metro's Redis geo index for couriers who pinged recently, scores them, and writes a 30-second offer for the best one. The gateway pushes the offer to that courier. Accepting is one PostgreSQL transaction that claims the offer, assigns the order and marks the courier busy; a decline or timeout moves to the next courier.
3. **Track (3).** Courier apps post their position every 3 seconds (and every 10 seconds when parked, as a heartbeat). The Location Service writes it to Redis — geo index, last-seen time, and a publish on the courier's channel — and samples one ping in three to Kafka. Tracking Gateway nodes subscribed to that channel push the position and an ETA to the customer's socket.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer / API gateway | TLS, session auth, rate limits, routes `/api/*` and `/ws` | Connections | Sticky routing is not needed: any gateway node can serve any socket |
| Order Service | Pricing, order creation, state transitions, cancellation | Orders (~35/s peak) | Stateless; writes PostgreSQL; emits order events through an outbox |
| Dispatch Service | Matching loop, offers, the atomic claim, lease sweeper | Unassigned orders | Partitioned by metro; any instance can resume another's order after its lease expires |
| Location Service | Ping ingest | Online couriers (~10K/s) | Stateless; Redis-only hot path, sampled durable writes |
| Tracking Gateway | WebSocket fan-out of status, offers, positions and ETAs | Open sockets | One Redis subscriber per node; heartbeats; no replay, clients resync by snapshot |
| PostgreSQL | Orders, items, offers, couriers, idempotency keys | Orders | Source of truth; primary plus read replicas; partition `orders` by month |
| Redis (one per metro) | Geo index, last-seen times, pub/sub channels, sessions | Couriers per metro | Volatile by design: rebuilt from pings within seconds |
| Kafka | Sampled location events, order events | Pings | Feeds location history, ETA model training and notifications |

## Core Components / Request Flows

### Placing an order

```
Customer app                         Order Service                         PostgreSQL   Dispatch
      │                                    │                                    │           │
      │ 1 POST /orders, Idempotency-Key K  │                                    │           │
      │───────────────────────────────────▶│                                    │           │
      │                                    │ 2 BEGIN; INSERT key K ON CONFLICT  │           │
      │                                    │───────────────────────────────────▶│           │
      │                                    │ 3 1 row = new (0 = replay)         │           │
      │                                    │◀───────────────────────────────────│           │
      │                                    │ 4 INSERT order, items, lease       │           │
      │                                    │───────────────────────────────────▶│           │
      │                                    │ 5 store 201 under K; COMMIT        │           │
      │                                    │───────────────────────────────────▶│           │
      │ 6 201 {status: pending, v1}        │                                    │           │
      │◀───────────────────────────────────│                                    │           │
      ···································· after COMMIT ·····································
      │                                    │ 7 order.created (outbox)                       │
      │                                    │───────────────────────────────────────────────▶│
      │                                    │                                    │           │
```

- **Idempotency.** The client creates one key per checkout attempt and reuses it for every retry of that attempt. Step 2 inserts the key; a concurrent duplicate blocks on the unique index until the first transaction commits, then finds the stored `201` and returns it with `Idempotent-Replayed: true`. The same key from another user, or with a different body, gets `422` and learns nothing about the other request.
- **One transaction.** The key, the order, its line items and the dispatch lease commit together. A crash before `COMMIT` leaves nothing behind, so the client's retry simply runs again; there is no "pending forever" key.
- **Server-side pricing.** Prices come from the menu table, the delivery fee from the merchant-to-customer distance, and the arithmetic is in integer cents. The client sends item ids and quantities, never amounts. The cart page shows a quote from the same function (`POST /orders/quote`), so the total on the button is the total charged.
- **Hand-off.** Step 7 is an outbox event in production; the Dispatch instance that consumes it takes the lease. Matching never runs inside the customer's request.

### Dispatching: sequential offers and the atomic claim

```
Dispatch Service                              Redis   PostgreSQL    Courier app
        │                                       │          │             │
        │ 1 renew lease WHERE owner = me                   │             │
        │─────────────────────────────────────────────────▶│             │
        │ 2 GEOSEARCH 5 km + ZMSCORE last_seen  │          │             │
        │──────────────────────────────────────▶│          │             │
        │ 3 fresh couriers, nearest first       │          │             │
        │◀──────────────────────────────────────│          │             │
        │ 4 score; skip already offered         │          │             │
        │ 5 INSERT offer, expires in 30 s                  │             │
        │─────────────────────────────────────────────────▶│             │
        │ 6 push offer (via gateway)                                     │
        │───────────────────────────────────────────────────────────────▶│
        │ 7 POST /offers/{id}/accept                                     │
        │◀───────────────────────────────────────────────────────────────│
        │ 8 one tx: offer, order, courier                  │             │
        │─────────────────────────────────────────────────▶│             │
        │ 9 200 order | 409 taken                                        │
        │───────────────────────────────────────────────────────────────▶│
        │                                       │          │             │
```

- **Lease (step 1).** `orders.dispatch_owner` and `orders.dispatch_lease_until` say which instance runs the loop and until when. The owner renews before every offer and stops as soon as the renewal matches nothing: the order was assigned, cancelled, or taken over. Every instance runs a sweeper that claims unassigned orders with a missing or expired lease using `FOR UPDATE SKIP LOCKED`, so a crashed instance's orders resume within seconds on another.
- **Fresh couriers only (steps 2–3).** `GEOSEARCH` returns the nearest members; `ZMSCORE` on the last-seen sorted set drops anyone who has not pinged in 30 seconds. A phone that died keeps its last position in the geo index until a prune removes it, and without this check every order near it would wait 30 seconds for a ghost.
- **Scoring (step 4).** Distance 40%, rating 25%, acceptance rate 20%, current load 15%. Couriers already offered this order are skipped, read from the durable `driver_offers` table so a resumed loop does not re-offer to someone who declined.
- **Offer (step 5).** Partial unique indexes allow one pending offer per order and one per courier. The pending row is the courier's lease: while it lives, no other order can offer to them.
- **Claim (step 8).** One transaction: the offer goes `pending → accepted` only if unexpired and owned by this courier; the order goes to `driver_assigned` only if it is unassigned and still dispatchable; the courier goes to `busy` only if online. Any failure rolls back all three and the courier sees `409`. A third unique index allows at most one accepted offer per order.
- **Timeouts.** When the 30-second window closes the loop expires the offer with a compare-and-set. If that matches nothing, the courier answered in the last instant and their answer stands. After 5 offers, or 5 minutes without anyone nearby, the order is cancelled — but only if it is still unassigned.

### Courier location and live tracking

```
 Courier          Location Svc                   Redis                Gateway             Customer
    │                   │                          │                     │                    │
    │ 1 POST /location  │                          │                     │                    │
    │──────────────────▶│                          │                     │                    │
    │                   │ 2 GEOADD, ZADD, PUBLISH  │                     │                    │
    │                   │─────────────────────────▶│                     │                    │
    │                   │ 3 SET gate NX PX 10s     │                     │                    │
    │                   │─────────────────────────▶│                     │                    │
    │                   │                          │ 4 location message  │                    │
    │                   │                          │────────────────────▶│                    │
    │                   │                          │                     │ 5 stage-aware ETA  │
    │                   │                          │                     │ 6 lat, lng, eta    │
    │                   │                          │                     │───────────────────▶│
    ·································· customer reconnects ····································
    │                   │                          │                     │ 7 subscribe_order  │
    │                   │                          │                     │◀───────────────────│
    │                   │                          │                     │ 8 snapshot v4      │
    │                   │                          │                     │───────────────────▶│
    │                   │                          │                     │                    │
```

- **Hot path (step 2).** One Redis pipeline: `GEOADD` to the metro's geo set, `ZADD` the ping time to the last-seen set, refresh a small per-courier hash, and `PUBLISH` on `driver:{id}:location`. No database write.
- **Sampling (step 3).** `SET driver:{id}:persist_gate NX PX 10000` succeeds for the first ping in each 10-second window across all instances; that ping is also sent to Kafka (production) or written to PostgreSQL's last-known position and history (local).
- **Fan-out (steps 4–6).** Each gateway node holds one Redis subscriber and a reference-counted map from channel to local sockets: the first socket interested in a channel subscribes, the last one leaving unsubscribes. The gateway computes the ETA for each socket's order: before pickup, courier to merchant plus any wait for the food plus merchant to customer; after pickup, the last leg only. Distances are straight-line times a 1.3 road factor.
- **Courier assignment.** A status event carries the new courier's id; the gateway moves the customer's location subscription to that courier's channel, so the dot appears without the app resubscribing.
- **Reconnects (steps 7–8).** Pub/sub keeps nothing, so a reconnecting client resubscribes and the gateway answers with a fresh snapshot of the order. Status events are absolute and carry the order's `version`; the client keeps whichever copy has the higher version, so a late or duplicated event never moves the screen backwards.

### Order lifecycle

```
  pending ──▶ confirmed ──▶ preparing ──▶ ready_for_pickup        merchant progress
     │            │             │                 │
     └────────────┴──────┬──────┴─────────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
     cancelled                    driver_assigned ──▶ picked_up ──▶ in_transit ──▶ delivered
  customer: pending, confirmed    the atomic claim                  (picked_up ──▶ delivered
  dispatch: deadline, 5 offers    (offer, order, courier)            is also allowed)
```

Every transition is one `UPDATE … WHERE id = $1 AND status = ANY($allowed) [AND owner checks] RETURNING *` that also increments `version`. Zero rows means the move is illegal right now; the service reads the current row to answer `404`, `403` or `409`. Cancelling after a courier is assigned is not in the table: it would also have to release the courier, and that path (with reassignment) is listed under [known limitations](#known-limitations).

## Database Schema

### Production schema

PostgreSQL holds everything that must be correct. Amounts are integer cents.

```sql
CREATE TABLE orders (
  id                    UUID PRIMARY KEY,
  customer_id           UUID NOT NULL REFERENCES users(id),
  merchant_id           UUID NOT NULL REFERENCES merchants(id),
  driver_id             UUID REFERENCES drivers(id),       -- set only by the atomic claim
  status                TEXT NOT NULL DEFAULT 'pending',   -- see the lifecycle above
  version               INT  NOT NULL DEFAULT 1,           -- bumped by every transition
  delivery_lat          DOUBLE PRECISION NOT NULL,
  delivery_lng          DOUBLE PRECISION NOT NULL,
  subtotal_cents        INT NOT NULL CHECK (subtotal_cents >= 0),
  delivery_fee_cents    INT NOT NULL CHECK (delivery_fee_cents >= 0),
  tip_cents             INT NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  total_cents           INT NOT NULL CHECK (total_cents >= 0),
  dispatch_owner        TEXT,                              -- instance running the matching loop
  dispatch_lease_until  TIMESTAMPTZ,                       -- sweepers may claim after this
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_up_at          TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancellation_reason   TEXT
) PARTITION BY RANGE (created_at);                         -- monthly partitions

CREATE INDEX orders_waiting_for_courier ON orders (created_at)
  WHERE driver_id IS NULL AND status IN ('pending', 'confirmed', 'preparing', 'ready_for_pickup');
CREATE INDEX orders_by_customer ON orders (customer_id, created_at DESC);
CREATE INDEX orders_active_by_courier ON orders (driver_id)
  WHERE status IN ('driver_assigned', 'picked_up', 'in_transit');

CREATE TABLE order_items (
  order_id         UUID NOT NULL,
  menu_item_id     UUID,
  name             TEXT NOT NULL,                          -- copied: the receipt never changes
  quantity         INT  NOT NULL CHECK (quantity > 0),
  unit_price_cents INT  NOT NULL
);

CREATE TABLE driver_offers (
  id           UUID PRIMARY KEY,
  order_id     UUID NOT NULL,
  driver_id    UUID NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',            -- pending | accepted | rejected | expired
  offered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_pending_offer_per_order   ON driver_offers (order_id)  WHERE status = 'pending';
CREATE UNIQUE INDEX one_pending_offer_per_courier ON driver_offers (driver_id) WHERE status = 'pending';
CREATE UNIQUE INDEX one_accepted_offer_per_order  ON driver_offers (order_id)  WHERE status = 'accepted';

CREATE TABLE idempotency_keys (
  key          TEXT PRIMARY KEY,
  user_id      UUID NOT NULL,
  operation    TEXT NOT NULL,
  request_hash TEXT NOT NULL,                              -- SHA-256 of the canonical request
  response     JSONB,
  expires_at   TIMESTAMPTZ NOT NULL                        -- 24 h
);
```

`drivers` holds the courier's intent (`offline`, `available`, `busy`), rating, acceptance rate and a sampled last-known position; `merchants`, `menu_items`, `users`, `ratings` and `sessions` are conventional.

Redis, one instance per metro:

| Key | Type | Purpose |
|-----|------|---------|
| `drivers:locations` | GEO set | Position of every reachable courier |
| `drivers:last_seen` | Sorted set, score = epoch ms | Liveness; search ignores entries older than 30 s, a prune removes them after 2 min |
| `driver:{id}` | Hash, TTL 10 min | Latest position by id (seeds a new tracker's map) |
| `driver:{id}:persist_gate` | String, `PX 10000` | One durable sample per courier per 10 s |
| `driver:{id}:location`, `driver:{id}:offers`, `order:{id}:status` | Pub/sub channels | Fan-out to Tracking Gateway nodes |
| `session:{token}` | String, TTL = session expiry | Session cache |

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql); Docker loads it into a fresh volume and it is safe to load again by hand (every statement is guarded). The seed is [`backend/db-seed/seed.sql`](./backend/db-seed/seed.sql), also re-runnable. The constraints that carry the design are verbatim:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_offers_pending_per_order
  ON driver_offers(order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_offers_pending_per_driver
  ON driver_offers(driver_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_offers_accepted_per_order
  ON driver_offers(order_id) WHERE status = 'accepted';
```

| Production | Local | Difference |
|------------|-------|------------|
| Amounts in integer cents | `DECIMAL(10,2)` columns; the code prices in integer cents and writes 2-decimal strings | `NOT VALID` CHECKs reject negative amounts and quantities on new rows |
| `orders` partitioned by month | One unpartitioned table with `archived_at` / `retention_days` | `retention.ts` marks and deletes by age |
| `TIMESTAMPTZ` | `TIMESTAMP` | Comparisons that matter (`expires_at > NOW()`) happen inside PostgreSQL |
| `idempotency_keys.request_hash NOT NULL` | Nullable (added with `ADD COLUMN IF NOT EXISTS`) | Rows from before the column existed are compared without it |
| — | `delivery_zones`, `retention_policies` | Seeded but not read by the request path |

## API Design

### Production API

```
POST /api/v1/orders/quote                 price a cart: subtotal, delivery fee, tip, total
POST /api/v1/orders                       create; Idempotency-Key → 201 | 409 in flight | 422 reused or invalid
GET  /api/v1/orders/{id}                  snapshot incl. version (customer, assigned courier, admin)
POST /api/v1/orders/{id}/cancel           → 200 | 409 too late
POST /api/v1/orders/{id}/tip              → 200 | 409 cancelled
POST /api/v1/driver/go-online | go-offline   go-offline → 409 while a delivery is active
POST /api/v1/driver/location              {lat, lng, speed?, heading?} every 3 s; heartbeat every 10 s
GET  /api/v1/driver/offers/pending        the courier's live offer with expires_in_seconds
POST /api/v1/driver/offers/{id}/accept    the atomic claim → 200 order | 409 offer or order unavailable
POST /api/v1/driver/offers/{id}/reject
POST /api/v1/driver/orders/{id}/picked-up | in-transit | delivered   → 200 | 403 not yours | 409 wrong state
WSS  /ws                                  subscribe_order → order_snapshot, status_update, location_update
                                          subscribe_driver_offers → new_offer
```

- Errors are `{ success: false, error, code }` with stable codes (`INVALID_TRANSITION`, `ORDER_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `ORDER_UNAVAILABLE`, …), so clients branch on the code, not the message.
- Every state-changing courier call is safe to retry: a repeated `picked-up` gets `409` with the current state instead of re-stamping the time.
- A status event looks like `{"order_id": "…", "status": "picked_up", "driver_id": "…", "version": 4}`; a location event like `{"lat": 37.78, "lng": -122.41, "eta_seconds": 540}`.

### Local routes

Everything above exists locally under `/api/v1`, plus `auth/*` (register, login, logout, me), `merchants` (nearby, search, categories, menu), `orders/{id}/rate/driver|merchant`, and `admin/*` (stats, orders, drivers, merchants, customers, hourly and daily analytics). Operations: `/health/live` (liveness), `/health` (readiness; `503` during shutdown), `/metrics`.

## Key Design Decisions

### 1. Redis geo index with liveness, not PostGIS in the order database

Matching asks "which available couriers are within 5 km of this merchant" for every order, and the answer changes every few seconds. A Redis geo set answers `GEOSEARCH` in well under a millisecond and absorbs 10K position writes a second without touching the order database. PostGIS would answer the query in a few milliseconds, but the 10K writes a second would share the WAL, buffer cache and connection pool with order placement — checkout would slow down because couriers are driving. The cost is volatility: lose Redis and every courier disappears. That is acceptable because the data refreshes itself: every online courier pings within 3 seconds (10 when parked), so the index is whole again in one heartbeat. Liveness gets its own sorted set because a geo set cannot express "last seen"; without it a courier whose phone died stays matchable forever.

### 2. Sequential offers with an atomic claim, not broadcast

Offering an order to every nearby courier fills it faster, but 50 couriers racing to accept one order produce 49 failures, a thundering herd on one row, and a product where the fastest thumb wins. Sequential offers give one courier an exclusive 30-second window and let the scoring function pick who gets first refusal. The price is tail latency: five declines cost two and a half minutes. Correctness does not come from the sequencing, though; it comes from the claim. Accepting is a transaction of compare-and-set updates, and partial unique indexes make the database refuse a second live offer for an order, a second live offer for a courier, or a second acceptance. Those guarantees hold even if two dispatchers briefly believe they own the same order.

### 3. Dispatch leases instead of in-memory matching loops

A matching loop that only exists in one process dies with that process, and the order then waits forever. A lease row (`dispatch_owner`, `dispatch_lease_until`) makes the loop resumable: the owner renews it before each offer, and any instance's sweeper claims orders whose lease lapsed, with `FOR UPDATE SKIP LOCKED` so two sweepers never take the same order and never wait on each other. The loop's memory — who has been offered the order — is read back from `driver_offers`. A slow owner that loses its lease stops at its next renewal; if it was mid-offer, the offer still resolves safely through the claim transaction. This costs one `UPDATE` per offer and a sweep every 5 seconds per instance.

### 4. Order placement returns before matching

If placement waited for a courier it would hold a request open for up to minutes, time out on mobile networks while succeeding on the server, and tie 99.99% availability to whether enough people want to drive at 7 p.m. on a Friday. Placement commits the order and returns; the customer app moves to a live tracking screen that shows "finding your courier". The consequence is that the client must model an order as a subscription, not a request–response.

### 5. Idempotency key in the same database as the order

Everywhere else Redis would be the natural home for a short-lived key, but a key that commits separately from the order can disagree with it: written but the order never created (the retry is blocked), or the order created but the key lost (the retry creates a second order). Because both live in PostgreSQL, they commit in one transaction and cannot disagree. The cost is an extra row per order for 24 hours and, for a concurrent duplicate, a connection held for up to 5 seconds while it waits on the first request's lock.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Place order | At most one order per checkout attempt | `Idempotency-Key` row in the order's transaction; stored response replayed; `422` on reuse |
| Price | Server-authoritative, exact | Menu prices, integer cents, quote and create share one function |
| Assign courier | Exactly one courier, never a cancelled order | Claim transaction (offer, order, courier) + three partial unique indexes |
| Status transitions | Legal moves only, once each | `UPDATE … WHERE status = ANY($allowed)`; `409` otherwise |
| Cancel vs accept | One of them wins | Both are compare-and-set updates on the same order row; cancel also expires the live offer |
| Matching after a crash | Resumes within ~5 s of lease expiry | Lease + sweeper with `SKIP LOCKED`; exclusions from `driver_offers` |
| Courier location | At most ~3 s stale, lossy | Redis only; the next ping overwrites |
| Tracking events | Newest wins on the client | Absolute, versioned status events; snapshot on every (re)subscribe |
| Durable location sample | One per courier per 10 s | `SET NX PX` gate shared by all instances |

Order status events are published after `COMMIT`. In production the publish goes through a transactional outbox so a crash between commit and publish cannot lose it; locally the publish is best effort and a client that misses one catches up from the snapshot when it next subscribes.

## Security / Auth

- **Sessions, not JWTs.** A stolen courier session can accept real orders; revocation must be one `DEL`. Session tokens are cached in Redis and stored in PostgreSQL.
- **Roles and ownership in the query.** Customer, courier, merchant and admin routes are role-gated, and ownership is part of the guarded `UPDATE` (`customer_id = $me`, `driver_id = $me`), not a separate read. A courier cannot advance another courier's order, and an idempotency key cannot return another user's order.
- **Validation at the boundary.** Order, quote, tip and location bodies are schema-validated (types, ranges, at most 50 lines, quantities 1–50, tips 0–500, coordinates in range, delivery within 15 km).
- **Rate limits** at the gateway: per user for order creation, per courier slightly above one ping per 3 seconds, per IP for login.
- **Location spoofing** is the interesting abuse: a courier faking a position near busy merchants to win offers. Detection is statistical (impossible speeds, positions inconsistent with pickup and drop-off times), run on the Kafka stream.
- **WebSocket auth.** Browsers cannot set headers on a WebSocket, so the token travels in the query string and must be kept out of access logs; production would use a short-lived ticket exchanged over HTTPS.

## Observability

| Signal | Why |
|--------|-----|
| Time to assign (histogram, p50/p99 per metro) | The core SLO; the tail is where sequential offers hurt |
| Offers per assignment; accept / reject / expire counts | Health of the scoring function and of courier supply |
| Orders unassigned for > 5 min; lease takeovers by the sweeper | Catches stuck dispatch and crashing instances |
| Location pings/s vs couriers online; stale entries pruned | A gap means apps are failing to report and the index is going stale |
| ETA error (predicted vs actual delivery) | The trust metric and the training signal for a better ETA |
| WebSocket connections, reconnect rate, snapshot rate | Reconnect storms after deploys; tracking quality |
| Idempotent replays and `422`s | Retry behavior of clients; misuse of keys |

Locally, `prom-client` exposes HTTP, order, matching, assignment, delivery and circuit-breaker metrics at `/metrics`; Pino writes JSON logs with module context; `/health` reports database, Redis, the breaker state, the instance id and the number of open sockets.

## Failure Handling

| Failure | Behavior | Mitigation |
|---------|----------|------------|
| Dispatch instance crashes | Its orders stop being matched | Leases lapse in ≤ 45 s; another instance's sweeper resumes them |
| Graceful deploy | — | Readiness fails, sockets close with 1001, leases are released for immediate takeover |
| Redis (metro) down | No geo search: matching pauses; tracking stalls | Orders stay unassigned (never assigned blindly); circuit breaker defers matching with back-off; index rebuilds from pings |
| PostgreSQL primary down | No new orders or claims | `503`; replica promotion; tracking of positions continues from Redis |
| Courier phone dies | Stops pinging | Dropped from search after 30 s, pruned after 2 min |
| Offer unanswered | 30 s window lapses | Compare-and-set expiry; a last-instant acceptance still wins |
| Customer cancels during an offer | Cancel and accept race | One `UPDATE` wins; the loser gets `409` |
| Client reconnects | Missed events | Resubscribe → snapshot; versions discard stale events |
| Duplicate order submit | Retry storm | Idempotency key replays the first response |

The rule: degrade tracking before matching, and matching before order placement. An order accepted while matching is down is recoverable; a lost order is not.

## Scalability Considerations

1. **Shard by metro.** Couriers do not deliver across metros, so each metro gets its own Redis geo index and its own dispatch partition, with no cross-shard queries. A metro that outgrows one Redis splits into zones.
2. **Location ingest** scales horizontally (stateless); Redis per metro handles 10K+ writes/s; Kafka partitions by courier id.
3. **Tracking gateways** scale with sockets. One subscriber per node keeps Redis connections at nodes, not users; a very hot channel is still one message per node.
4. **PostgreSQL** carries ~35 order writes/s at peak, which one primary handles easily. The table grows (~1 GB/day); partition by month and move delivered orders to cold storage after 30 days. Dashboards and history read from replicas.
5. **Matching quality** is the first thing to improve after scale: greedy per-order matching ignores the next order. Batched assignment (solve all unassigned orders in a 30–60 s window as a bipartite matching) and multi-order routes raise fleet efficiency at the cost of latency and complexity — worth it once courier idle time shows the waste.
6. **ETA** is the first thing to fail users: straight-line distance ignores roads and parking. A routing engine first, then a model trained on the Kafka location history.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Courier index | Redis geo set + last-seen set | PostGIS in the order database | Sub-ms search; keeps 10K writes/s off the order database |
| Location durability | Volatile, sampled 1 in 3 to Kafka | Store every ping | Data expires in 3 s; 86 GB/day otherwise |
| Offer protocol | Sequential offers | Broadcast to all nearby | No herd, fair first refusal; costs tail latency |
| One courier per order | Claim transaction + partial unique indexes | Application locks | The database enforces it whatever the code path |
| Matching ownership | Leases + `SKIP LOCKED` sweeper | In-memory loop per order | Survives crashes and deploys |
| Status changes | Guarded `UPDATE` per transition | Read, check, write | No lost races; retries get `409` |
| Placement | Return on commit, match after | Wait for a courier | Availability independent of supply |
| Idempotency store | PostgreSQL, same transaction | Redis | Key and order cannot disagree |
| Tracking transport | WebSocket, snapshot + versioned events | Polling | Push every 3 s without 600K requests/min |
| Pub/sub fan-out | One subscriber per gateway node | One Redis connection per socket | Redis connections scale with nodes |
| ETA | Stage-aware, straight line × 1.3 | Courier-to-customer distance | Counts the trip to the merchant and the wait for food |

## Implementation Notes

### What runs locally

[`backend/src/index.ts`](./backend/src/index.ts) is one Express process that serves the REST API, the WebSocket endpoint at `/ws`, and three background jobs: hourly idempotency-key cleanup, a geo-index prune every 30 seconds, and the dispatch sweeper every 5 seconds. [Docker Compose](./docker-compose.yml) runs PostgreSQL 16 and Valkey 7. The React 19 frontend (TanStack Router, Zustand, Tailwind) has customer, courier and admin screens. Backend unit tests: `npm test` (vitest, 61 tests, all offline).

### Production patterns implemented

| Pattern | Where | What it does |
|---------|-------|--------------|
| Guarded state machine | [`services/order/stateMachine.ts`](./backend/src/services/order/stateMachine.ts) | Transition table; every change is one compare-and-set `UPDATE` that also bumps `version`; `404`/`403`/`409` from the current row |
| Atomic claim | [`services/order/assignment.ts`](./backend/src/services/order/assignment.ts) | Offer, order and courier in one transaction; unique-index violations mapped to "courier busy" or "order has an offer"; compare-and-set offer expiry that keeps a last-instant acceptance |
| Cancellation | [`services/order/cancel.ts`](./backend/src/services/order/cancel.ts) | Guarded cancel that expires the live offer in the same transaction |
| Dispatch leases | [`services/order/dispatch.ts`](./backend/src/services/order/dispatch.ts), [`matching.ts`](./backend/src/services/order/matching.ts) | Lease renewal per offer, release with back-off, `FOR UPDATE SKIP LOCKED` sweeper, lease release on shutdown; exclusions read from `driver_offers` |
| Circuit breaker | [`shared/circuitBreaker.ts`](./backend/src/shared/circuitBreaker.ts) | Opossum around a matching run; the fallback releases the lease with a 30 s back-off (the "retry queue") |
| Idempotent create | [`shared/idempotency.ts`](./backend/src/shared/idempotency.ts) | Key, order and items in one transaction; per-user; SHA-256 request fingerprint; `lock_timeout` 5 s → `409` |
| Server-side pricing | [`services/order/pricing.ts`](./backend/src/services/order/pricing.ts) | zod validation; menu prices in integer cents; same function behind `/orders/quote` and create |
| Geo liveness | [`utils/redis.ts`](./backend/src/utils/redis.ts) | `GEOSEARCH` + `ZMSCORE` freshness filter (30 s, `LOCATION_STALE_MS`), Lua prune after 2 min |
| Sampled persistence | [`services/driverService.ts`](./backend/src/services/driverService.ts) | `SET NX PX 10000` gate; one statement updates the last-known position and appends history |
| Tracking fan-out | [`websocket/handler.ts`](./backend/src/websocket/handler.ts), [`channelRegistry.ts`](./backend/src/websocket/channelRegistry.ts) | One subscriber per process, reference-counted channels, snapshot on subscribe, courier channel switch on assignment, 30 s ping/pong heartbeat |
| Stage-aware ETA | [`utils/geo.ts`](./backend/src/utils/geo.ts) | Courier → merchant → wait for food → customer before pickup; last leg after |
| Graceful shutdown | [`index.ts`](./backend/src/index.ts) | Readiness `503`, sockets closed with 1001, leases released, bounded drain, pools closed |
| Metrics, logs | [`shared/metrics.ts`](./backend/src/shared/metrics.ts), [`shared/logger.ts`](./backend/src/shared/logger.ts) | prom-client counters and histograms; Pino JSON logs with module context |

The client side of the same contracts: the cart sends one `Idempotency-Key` per checkout attempt and shows the server's quote ([`routes/cart.tsx`](./frontend/src/routes/cart.tsx)); the tracking page applies snapshots and status events by `version` and re-fetches details after each event ([`routes/orders.$orderId.tsx`](./frontend/src/routes/orders.$orderId.tsx)); the WebSocket client reconnects with capped, jittered back-off ([`services/websocket.ts`](./frontend/src/services/websocket.ts)); the courier dashboard re-fetches its pending offer on every (re)connect, sends a 10-second heartbeat, and sends each ping over the socket or, when it is down, over HTTP — never both ([`hooks/useDriverDashboard.ts`](./frontend/src/hooks/useDriverDashboard.ts)).

### Simplified or substituted

| Production | Local |
|------------|-------|
| Separate Order, Dispatch, Location and Tracking services | One Express process with route modules; matching loops run in the API process |
| Redis per metro | One Valkey/Redis instance, one geo set |
| Kafka for location events and the outbox | Sampled writes to `drivers.current_lat/lng` and `driver_location_history` in PostgreSQL; status published to Redis after `COMMIT` (best effort) |
| Offer answers delivered as events | The matching loop polls the offer row every second (≤ 31 s per offer) |
| Load balancer with rate limiting | None; no rate limiting is implemented |
| Short-lived WebSocket tickets, httpOnly cookies | Bearer token in `localStorage`, passed to `/ws` in the query string |

### Omitted

CDN, multi-region, metro sharding, payments, push and SMS notifications, batched or multi-stop assignment, surge pricing, a routing-engine ETA, a merchant API, Kubernetes, and a map widget (the tracking page shows coordinates and the ETA).

### Known limitations

- **No merchant flow.** Nothing sets `confirmed`, `preparing` or `ready_for_pickup`; matching starts as soon as an order is `pending`, and prep time feeds only the ETA, not when dispatch begins.
- **No reassignment.** If an assigned courier goes dark, the order stays `driver_assigned`; there is no liveness lease on active deliveries and no cancel-after-assignment path that releases the courier.
- **Matching is per-process work.** The circuit breaker counts whole matching runs and only thrown errors trip it.
- **Frontend data layer.** Pages fetch with `useEffect` into component state; there is no shared server-state cache, and lists are not paginated.
- **Retention.** [`shared/retention.ts`](./backend/src/shared/retention.ts) archives and deletes orders by age regardless of status.
- **Smoke test.** [`tests/smoke.spec.ts`](./tests/smoke.spec.ts) logs in as `alice@example.com`, which this project does not seed (the screenshot config uses `admin@delivery.local`).
