# 🛵 Local Delivery (DoorDash / Instacart) — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one order through its whole life — the cart, the Place order tap, the search for a courier, the Accept tap, the dot on the map — and get the contracts between client and server right, because every hard problem here sits on that seam. Three contracts carry the weight: an idempotency key and a server quote that make checkout safe and honest, a claim transaction that makes Accept and Cancel race safely, and a versioned snapshot-plus-events stream that keeps the tracking screen from ever going backwards."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, and targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from both apps to the data stores, plus three flows |
| Data model & API contract | 7 min | Server tables, client cache, the fields both sides rely on |
| Deep dive 1: one order per tap | 8 min | Idempotency and pricing from the button to the row |
| Deep dive 2: Accept versus Cancel | 7 min | One courier or none, and what each app shows |
| Deep dive 3: tracking that never goes backwards | 7 min | Snapshot, versions, reconnects, presence |
| Failures, scale, wrap-up | 3 min | What each failure looks like to each user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Customers browse nearby merchants, build a one-merchant cart, see the server's price, place an order, track it live (status, courier position, ETA), cancel before preparation, and rate afterwards. Couriers go online, receive 30-second offers, accept or decline, and step the order through pickup and delivery while their app shares GPS. Admins see orders, couriers and merchants. Out of scope: payments, batching orders onto one courier, surge pricing, the merchant tablet.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Order placement | 99.99% available, p99 < 300 ms, independent of courier supply |
| Backend | Time to assign | p50 < 30 s, p99 < 2 min |
| Backend | Assignment | Exactly one courier; never for a cancelled order |
| Frontend | Live updates | On screen < 1 s after the server publishes; resynced < 5 s after reconnect |
| Frontend | Browse | LCP < 2.5 s on mid-range Android over 4G; INP < 200 ms |
| Both | Checkout | One order per attempt, even across timeouts, double taps and reloads |
| Both | Tracking | The screen never shows an older state than it already showed |

**Scale.** 1M orders a day is ~12 a second, ~35 at the dinner peak — small. 30,000 online couriers pinging every 3 seconds is ~10,000 location writes a second — the firehose. Around 50,000 customers watching a map at peak means ~17,000 pushed updates a second.

"The client's 3-second GPS interval, multiplied by 30,000 couriers, *is* the backend's biggest write load. And the client's tracking screen, multiplied by 50,000, *is* the socket fleet. On this system the frontend's timers are the backend's capacity plan."

---

## 🏗️ End-to-End Architecture (8 min)

```
  ┌──────────────────────────┐                          ┌────────────────────────────┐
  │ Customer SPA             │                          │ Courier SPA                │
  │ Idempotency-Key, version │                          │ offers · GPS heartbeat     │
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

1. **Place (1).** The customer SPA posts the cart with the attempt's idempotency key. The Order Service prices it from the menu and commits the order, its items, the key and a dispatch lease in one transaction, then returns `201`. The SPA navigates to the tracking page; nobody waits for a courier inside a request.
2. **Dispatch (2).** The Dispatch Service instance holding the lease finds fresh couriers near the merchant in Redis, writes a 30-second offer, and the gateway pushes it to the courier SPA. Accept is one transaction that claims the offer and the order.
3. **Track (3).** The courier SPA posts its position every 3 seconds (10 when parked). The Location Service writes Redis and publishes; gateway nodes push position, ETA and status changes to the customer SPA's socket.

| Layer | Choice | Why |
|-------|--------|-----|
| Customer and courier SPAs | React, TanStack Query for server state, a small store for cart and session | Live, authenticated screens; one cache with one merge rule |
| Order Service | Stateless; PostgreSQL transactions | Pricing, creation, guarded transitions |
| Dispatch Service | Leases + `SKIP LOCKED` sweeper | Matching survives crashes and deploys |
| Location Service + Redis per metro | Geo index, last-seen, pub/sub | 10K writes/s kept off the order database |
| Tracking Gateway | WebSocket, one Redis subscriber per node | Push to both apps; Redis connections scale with nodes |
| PostgreSQL | Orders, offers, couriers, idempotency keys | The source of truth for anything that must be correct |

### Flow: checkout across the wire

```
Customer SPA                         Order Service                            PostgreSQL
      │                                    │                                       │
      │ 1 POST /orders/quote               │                                       │
      │───────────────────────────────────▶│                                       │
      │ 2 subtotal, fee, total             │                                       │
      │◀───────────────────────────────────│                                       │
      │ 3 tap Place order: key K           │                                       │
      │ 4 POST /orders, Idempotency-Key K  │                                       │
      │───────────────────────────────────▶│                                       │
      │                                    │ 5 one tx: key K, order, items, lease  │
      │                                    │──────────────────────────────────────▶│
      │ 6 201 lost in a tunnel             │                                       │
      │◀───────────────────────────────────│                                       │
      │ 7 retry with the same K            │                                       │
      │───────────────────────────────────▶│                                       │
      │                                    │ 8 INSERT key K: conflict              │
      │                                    │──────────────────────────────────────▶│
      │ 9 stored 201, Idempotent-Replayed  │                                       │
      │◀───────────────────────────────────│                                       │
      │                                    │                                       │
```

"Steps 3 and 8 are two halves of one contract. The browser promises to send the same key for the same attempt — even after a reload, because the attempt lives in `sessionStorage` — and the server promises that a repeated key returns the stored response instead of doing the work again. Step 2 is the other contract: the number on the button comes from the same pricing function that step 5 uses, so the customer pays what they saw."

### Flow: a cancel and an accept collide

```
Customer SPA                     API                              PostgreSQL    Courier SPA
      │                           │                                    │             │
      │ 1 POST /orders/42/cancel  │                                    │             │
      │──────────────────────────▶│                                    │             │
      │                           │ 2 cancel if pending; expire offer  │             │
      │                           │───────────────────────────────────▶│             │
      │ 3 200 cancelled, v2       │                                    │             │
      │◀──────────────────────────│                                    │             │
      │                           │ 4 POST /offers/7/accept                          │
      │                           │◀─────────────────────────────────────────────────│
      │                           │ 5 claim: offer still pending? no   │             │
      │                           │───────────────────────────────────▶│             │
      │                           │ 6 409 OFFER_UNAVAILABLE                          │
      │                           │─────────────────────────────────────────────────▶│
      │                           │                          7 close modal, explain  │
      │                           │                                    │             │
```

"Both requests are compare-and-set updates on the same order row, so PostgreSQL serializes them. Here the cancel wins and also withdraws the live offer, so the claim in step 5 finds no pending offer and the courier gets `409`. Had the accept arrived first, the order would be `driver_assigned` and the cancel would get `409` instead. Each app has copy for its `409`."

### Flow: from the courier's phone to the customer's map

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

"Step 3 is the server side of the courier app's heartbeat: one ping per 10-second window is persisted, the rest exist only in Redis. Steps 7 and 8 are the reconnect contract: the socket keeps no history, so every subscription starts with a snapshot."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `orders` | `id`, `status`, `version`, `driver_id`, amounts in cents, `dispatch_owner`, `dispatch_lease_until` | Every transition is a guarded `UPDATE` that bumps `version` |
| PostgreSQL | `driver_offers` | `order_id`, `driver_id`, `status`, `expires_at` | Unique: one pending per order, one pending per courier, one accepted per order |
| PostgreSQL | `idempotency_keys` | `key`, `user_id`, `request_hash`, `response` | Same transaction as the order; 24 h |
| Redis | `drivers:locations`, `drivers:last_seen` | Geo set; sorted set of ping times | Search ignores couriers silent > 30 s |
| Redis | `order:{id}:status`, `driver:{id}:location`, `driver:{id}:offers` | Pub/sub channels | Fan-out to gateway nodes |

### Client side

| Cache key | Holds | Updated by |
|-----------|-------|------------|
| `['order', id]` | Order with `version` | Snapshot, status events, refetch — whichever has the higher version |
| `['order', id, 'position']` | `lat`, `lng`, `eta`, `receivedAt` | Location events |
| `['quote', cart, tip, location]` | Server price | Refetched on change; stale requests aborted |
| `['offer', 'pending']` | Offer with `expiresAt` | Offer push; re-read on every reconnect |
| Store: cart, session | Ids, quantities, user | Local; cart persisted |
| `sessionStorage`: checkout attempt | Idempotency key | Cleared on success; replaced when the cart changes |

### The contract

```
POST /api/v1/orders/quote                → subtotal, delivery_fee, tip, total (decimal strings)
POST /api/v1/orders + Idempotency-Key    → 201 order | 409 in flight | 422 reused or invalid
POST /api/v1/orders/{id}/cancel          → 200 | 409 a courier already accepted
POST /api/v1/driver/offers/{id}/accept   → 200 order | 409 OFFER_UNAVAILABLE | ORDER_UNAVAILABLE
GET  /api/v1/driver/offers/pending       → offer + expires_in_seconds | null
POST /api/v1/driver/location             {lat, lng} every 3 s moving, 10 s parked
WSS  /ws                                 order_snapshot · status_update {status, version} · location_update {eta}
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same body → same `201` for 24 h; another user or body → `422` | Retry after timeouts, double taps and reloads without a second order |
| Quote = create pricing | One function prices both | Show a total that is the total charged |
| `version` on order, events, snapshots | Incremented on every transition | Keep the newest copy whatever the arrival order |
| Snapshot on subscribe | Every subscription starts with the full order | Recover anything missed while disconnected |
| `409` + `code` on Accept, Cancel and courier steps | The move was not applied; the current state is unchanged | Show a specific message and refetch, never assume success |
| `expires_in` seconds on offers | Measured on the server's clock | Count down correctly on a phone with a skewed clock |
| Liveness window 30 s | Couriers silent longer get no offers | Send a heartbeat every 10 s while parked |

---

## 🔧 Deep Dive 1: One Order per Tap, at the Right Price (8 min)

"The scenario: a customer on a train taps Place order, the request times out, and they tap again. Without care we create two orders, charge twice and dispatch two couriers. Each layer has a job."

**Browser.** On tap, the SPA creates a key with `crypto.randomUUID()` for this checkout attempt and keeps it in `sessionStorage`. Automatic retries, the Retry button and a reload that finds the attempt pending all reuse it. Editing the cart, tip or address resets it, because that is a different request. The button is disabled while pending, but correctness doesn't depend on that.

**API.** The Order Service opens a transaction and inserts the key. If the insert succeeds, it prices the cart, inserts the order and items, stores the `201` body under the key and commits — all or nothing, so a crash mid-request leaves no half-made order and no orphaned key. If the key already exists, a concurrent first attempt is still running, and the insert waits on the unique index until it commits, then returns the stored `201`. A different user or a different body with the same key gets `422`, without seeing the other request's data.

**Database.** The key's primary key prevents a duplicate attempt; the `CHECK` constraints on quantities and amounts are the last line of defense against a malformed cart.

**Price.** The cart sends item ids and quantities. The quote endpoint and the create endpoint call the same pricing function — menu prices, a distance-based delivery fee, integer cents — so the total the customer saw is the total they pay.

| Approach | Verdict |
|----------|---------|
| ✅ Client key per attempt + key in the order's transaction | Correct across timeouts, reloads and concurrent duplicates |
| ❌ Key stored in Redis next to an order in PostgreSQL | Two commits can disagree: a key without an order, or an order without a key |
| ❌ Dedupe by request body | Merges intentional repeats (the same lunch two days running) |
| ❌ Client-computed total | Wrong as soon as the fee depends on distance |

"What I give up: a few hundred milliseconds of 'Placing order…' instead of optimism, an extra row per order for 24 hours, and a held connection while a duplicate waits behind the first request — capped at 5 seconds, after which it gets `409` and retries."

---

## 🔧 Deep Dive 2: Accept versus Cancel — One Courier or None (7 min)

"Two couriers driving to one restaurant, or a courier driving for an order the customer cancelled, can't be rolled back. This deep dive is about making those outcomes impossible and making the losing side's screen honest."

**Server.** Accepting is one transaction of three compare-and-set updates: the offer from `pending` to `accepted` if unexpired and owned by this courier, the order from unassigned to `driver_assigned` if still dispatchable, the courier to `busy` if still online. Any zero-row update rolls back all three. Partial unique indexes allow one pending offer per order, one per courier, and one accepted offer per order, so the guarantee holds even if two dispatchers briefly overlap. Cancel is a compare-and-set too (`WHERE status IN ('pending','confirmed') AND customer_id = $me`) and withdraws the live offer in the same transaction.

**Courier app.** Accept is pessimistic: the modal disables its buttons and waits. `200` adds the delivery; `409 ORDER_UNAVAILABLE` closes the modal with "This order is no longer available". The countdown uses the server's remaining seconds, and after any reconnect the app re-reads its pending offer, because a push can be missed.

**Customer app.** Cancel is pessimistic too. A `409` means a courier won the race: the page refetches and says "A courier already accepted — the order can't be cancelled now", and the timeline shows the assignment.

**The lifecycle is a shared contract.** Both apps render the same states, and the server decides every move. No client advances a state optimistically: "picked up" tells the customer their food left the restaurant and starts the delivery ETA, so showing it before the server agrees is a lie about the physical world. Optimism is fine for things that are cheap to be wrong about — a rating, a tip — and wrong for things that send people driving.

| Approach | Verdict |
|----------|---------|
| ✅ Claim transaction + unique indexes; pessimistic buttons with `409` copy | One courier or none; each side sees the truth |
| ❌ Broadcast offers, first accept wins | A herd on one row; 49 couriers see failures |
| ❌ Read-check-write in each route | Cancel and accept both succeed |
| ❌ Optimistic Accept in the courier app | A courier starts driving for an order they don't have |

**The last-instant accept.** When an offer's window closes, the matcher expires it with a compare-and-set. If that matches nothing, the courier accepted at the last moment, and the acceptance stands rather than the order going to a second courier.

"What I give up is speed: sequential offers can take minutes when couriers decline, and both apps show a spinner on their critical button. I'd rather show 'finding your courier' for longer than send two cars."

---

## 🔧 Deep Dive 3: Tracking That Never Goes Backwards (7 min)

"A WebSocket will drop — tunnels, elevators, a deploy. The contract has to say what happens to the missed messages, because pub/sub won't remember them."

**Server.** Each gateway node holds one Redis subscriber and a reference-counted map from channels to its sockets. Subscribing to an order subscribes the socket to the order's status channel and, once there is a courier, to that courier's location channel, then sends a full snapshot. Status events are absolute and carry the order's `version`. When a courier is assigned, the gateway moves the socket to the new courier's location channel itself. Each position goes out with a stage-aware ETA: before pickup, courier to merchant plus any wait for the food plus merchant to customer; after pickup, only the last leg. A 30-second ping/pong drops dead sockets.

**Client.** On close, the SPA reconnects after 1, 2, 4… up to 30 seconds, each randomized, so a deploy that drops every socket doesn't bring them back in lockstep. On open it resubscribes and receives a snapshot. The cache keeps whichever copy of the order has the higher version, so a late event never undoes a snapshot. After each status event the SPA refetches the order to pick up the courier's name and timestamps, through the same version check. While reconnecting it shows a banner, and the map says how old the last position is instead of pretending to be live.

**Presence is a contract too.** The server stops offering orders to a courier who hasn't pinged for 30 seconds — otherwise a dead phone would hold every nearby order for a 30-second timeout. Browsers report GPS only on movement, so the courier app re-sends its last position every 10 seconds while online. Each ping goes over the socket when it's open and over HTTP otherwise, never both, so customers don't get duplicate positions.

| Approach | Verdict |
|----------|---------|
| ✅ Snapshot on subscribe + versioned absolute events | Reconnects recover; duplicates and reordering are harmless |
| ❌ Event replay from a per-order stream | Works, but every node must track offsets; the snapshot is simpler and the state is small |
| ❌ Client applies events in arrival order | A late event moves the timeline backwards |
| ❌ Polling every 3 s | ~17K requests/s at peak, and still half a second of average lag |

"What I give up: a persistent connection per tracking customer and a snapshot per reconnect. Both are cheap next to a customer who saw 'delivered' and then 'picked up'."

---

## 📈 Failures & Scale (2 min)

| Failure | Customer sees | Courier sees | Mitigation |
|---------|---------------|--------------|------------|
| Response lost at checkout | "Retry is safe"; the retry returns the same order | — | Idempotency key in the order's transaction |
| Dispatch instance crashes | "Finding your courier" a little longer | Offers resume | Lease expiry + sweeper on another instance |
| Metro Redis down | Map freezes; search takes longer | No new offers | Matching pauses rather than guessing; index rebuilds from pings |
| Socket drops | "Reconnecting…" banner, last position aged | Offer re-read on reconnect | Backoff with jitter; snapshot on resubscribe |
| Cancel races Accept | `409`: "a courier already accepted" — or a clean cancel | `409`: "no longer available" — or the order | One compare-and-set wins |
| PostgreSQL primary down | Checkout disabled with a message | Accept fails with retry | `503`; replica promotion |

**What breaks first as we grow:** courier efficiency at peak (greedy matching; batched assignment is the fix), then one metro's Redis on writes (split into zones — couriers never cross metros, so geography is a free shard key), then gateway connections (horizontal), then the size of the orders table (monthly partitions).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Checkout safety | Client key + key in the order's transaction | Body dedupe or a disabled button | Retries can't duplicate; intentional repeats still work |
| Price | Server quote, same function as create | Client total | The customer pays what they saw |
| One courier per order | Claim transaction + unique indexes | Read-check-write | Database-enforced on every path |
| Critical buttons | Pessimistic with specific `409` copy | Optimistic | Physical-world states can't be undone |
| Tracking | Snapshot + versioned events over WebSocket | Polling or arrival-order events | Push latency; never backwards |
| Courier presence | 10 s heartbeat vs 30 s server window | Movement-only pings | Parked couriers stay matchable, dead phones don't |
| Placement | Return on commit; track asynchronously | Wait for a courier | Availability independent of supply |

"With more time: schedule dispatch at confirmation plus prep time minus travel time so couriers arrive as food is ready, reassign when an assigned courier goes silent, Web Push for backgrounded tabs, and a routing-engine ETA trained on the location history."
