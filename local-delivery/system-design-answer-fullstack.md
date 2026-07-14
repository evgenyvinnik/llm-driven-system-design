# Local Delivery Service - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 📋 Problem Statement

Design a last-mile delivery platform end to end — DoorDash, Instacart, Uber Eats. Three apps (customer, driver, merchant), one backend, and a physical world in the middle that refuses to be transactional.

Since this is the full-stack framing, I'll organize around **the seams** — the places where a client requirement forces a server design, or where a server guarantee determines what the UI is even allowed to promise. Delivery is unusually rich in these, because it has three clients with *adversarial incentives* sharing one data model:

- The **customer** wants a live dot on a map. That's a 10,000-writes-per-second firehose the backend has to survive, and it's 800× the order volume.
- The **driver** taps "Accept" in a parking garage on 1 bar of LTE. That single tap forces the entire exactly-once story, because two drivers arriving at one restaurant is a failure no `ROLLBACK` can undo.
- The **merchant** starts cooking on confirmation, which means *when* we match determines whether food sits cold or a driver waits unpaid. That's a backend scheduling decision driven entirely by a physical-world constraint.

## 🎯 Requirements Clarification

- **How stale can a driver's location be?** Three seconds. That number determines the entire storage strategy for the highest-volume data in the system.
- **Is matching optimizing for the customer, the driver, or the fleet?** They conflict. I'll pick, and say what it costs.
- **One metro or many?** Many — but drivers never cross metros, which hands us a free shard key.
- **Does the client ever compute money?** No. Prices, fees, and totals are server-authoritative. The cart *displays* a total; it never decides one.

### Functional Requirements

- Customer: browse merchants, build a cart, place an order, watch it arrive
- Driver: go online, receive offers, accept/reject, mark picked up and delivered
- Merchant: confirm orders, set prep time
- Real-time tracking with live location and ETA
- Two-way ratings

### Non-Functional Requirements

| Requirement | Target | Consequence across the stack |
|-------------|--------|------------------------------|
| Match latency | Driver assigned < 30s | Matching cannot be inside the order POST |
| Location freshness | 3s | Volatile geo-index; conflated WebSocket delivery |
| Order placement availability | 99.99% | Order commit must not depend on driver supply |
| ETA accuracy | ±3 min, 90% | The trust metric; drives the biggest support cost |
| Zero lost orders | Absolute | Idempotency keys in durable storage, not cache |

### Scale Estimates

The numbers that force the design:

- **1M orders/day ≈ 12/sec average, ~35/sec at the dinner peak.** Order volume is *tiny*. This is not a throughput problem.
- **30K concurrent drivers × 1 update / 3s = 10,000 writes/second.** Location is ~800× the order volume.
- Naively persisting that is **86 GB/day** of data with a **3-second useful life.**
- Tens of thousands of customers watching a map simultaneously at peak.

**The asymmetry is the whole story: orders are low-volume and must be perfect; locations are high-volume and are allowed to be lossy.** Every seam below follows from that single sentence.

## 🏗️ High-Level Architecture

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Customer    │   │   Driver     │   │  Merchant    │
│  React SPA   │   │   React SPA  │   │  React SPA   │
│  • cart      │   │  • offer     │   │  • confirm   │
│  • tracking  │   │    modal     │   │  • prep time │
│    map       │   │  • location  │   │              │
└──┬────────┬──┘   └──┬────────┬──┘   └──────┬───────┘
   │ REST   │ WSS     │ REST   │ WSS         │ REST
   ▼        ▼         ▼        ▼             ▼
┌──────────────────────────────────────────────────────┐
│  API Gateway — authn, role checks, rate limits        │
└──┬───────────┬──────────────┬─────────────┬──────────┘
   ▼           ▼              ▼             ▼
┌───────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐
│ Order │ │ Location │ │ Tracking  │ │ Notification │
│ Svc   │ │ Svc      │ │ Svc (WS)  │ │ Svc          │
└───┬───┘ └────┬─────┘ └─────▲─────┘ └──────────────┘
    │          │             │
    ▼          │ GEORADIUS   │ pub/sub
┌──────────┐   │             │
│ Matching │◀──┘             │
│ Svc      │                 │
│ 1 leader │                 │
│ per metro│                 │
└────┬─────┘                 │
     ▼                       │
┌──────────────┐  ┌──────────┴─────┐  ┌──────────────┐
│  PostgreSQL  │  │ Redis / Valkey │  │    Kafka     │
│ orders TRUTH │  │ • geo index    │  │ • loc events │
│ idempotency  │  │ • sessions     │  │ • order evts │
│ offers       │  │ • pub/sub      │  │ (durable tail│
│ last-known   │  │ • order event  │  │  for ETA ML) │
│   location   │  │   stream       │  └──────────────┘
└──────────────┘  └────────────────┘
```

The structural rule: **the location path and the order path share nothing on the hot path.** Locations go to Redis and Kafka and never touch PostgreSQL per-update. Orders go to PostgreSQL and are never eventually consistent. Merging them is how you build a checkout that goes down because too many drivers are driving.

## 💾 Data Model

| Table | Key Columns | Notes |
|-------|-------------|-------|
| users | id, email, password_hash, **role** (customer/driver/merchant/admin) | One identity, four roles — and three of them are adversarial |
| drivers | id (= users.id), status (offline/available/busy), rating, **acceptance_rate**, current_lat/lng | Partial index on location **where status='available'** — we only ever search the 30% that can work |
| merchants | id, name, lat, lng, **avg_prep_time_minutes**, is_open | `avg_prep_time` isn't decoration — it's the input that decides *when* to match |
| menu_items | id, merchant_id, name, price, is_available | |
| orders | id, customer_id, merchant_id, driver_id, **status**, delivery lat/lng, subtotal, delivery_fee, tip, total, per-state timestamps | The state machine is the `status` column |
| order_items | order_id, menu_item_id, **name, unit_price (denormalized)** | An order is a contract about a past moment. It must not re-price itself when the merchant raises prices tomorrow |
| driver_offers | order_id, driver_id, status, offered_at, **expires_at** | This table *is* the matching protocol, and the audit trail for "why did two drivers show up" |
| idempotency_keys | key (PK), user_id, response (JSONB), status | **In PostgreSQL, not Redis** — a lost key is a double charge |
| ratings | order_id, rater_id, rated_user_id, rating | |

Two decisions worth defending, both of which look like the "wrong" choice at first glance:

**Idempotency keys go in PostgreSQL even though Redis is faster.** Losing one means a customer's retry places a second real order with a second real charge. Meanwhile **driver locations go in volatile Redis** even though losing them sounds catastrophic. The rule isn't "Redis for speed, Postgres for safety" — it's **match the durability of the store to the lifetime and consequence of the data.** Location lives 3 seconds and self-heals. An idempotency key must outlive a retry storm.

**Order items denormalize name and price.** A foreign key would be cleaner and would also mean historical receipts silently change when a menu changes. Same reasoning as any receipt anywhere.

## 🔧 Seam 1: The Order Placement Flow — Where the Request Returns

This is the most important line in the whole design, and it's a decision the frontend and backend have to make *together*.

**The naive full-stack flow:** the customer taps Place Order; the server creates the order, finds a driver, and returns the assigned driver in the response. The UI shows a spinner until it has a driver. Clean, simple, and catastrophically wrong.

**How it concretely breaks.** Matching takes 30 seconds in the good case and, with sequential offers, can take *minutes* if drivers decline. So this design holds an HTTP request open for minutes, and:

- Every mobile network, load balancer, and proxy between the phone and the server will time out first. The customer gets an error for an order that *succeeded* — and now they tap again.
- Order placement's 99.99% availability target is now bounded by the availability of the geo-index, the Kafka cluster, **and whether enough human beings feel like working right now.** You cannot hit four nines on a number that depends on driver supply at 7pm on a Friday.
- The retry storm that follows is exactly what the idempotency key exists to survive — but we've engineered a system that generates them constantly.

**The correct seam: the request returns the moment the order is durably committed.**

```
 POST /orders  (X-Idempotency-Key)
      │
      ▼
 ┌────────────────────────────┐
 │ 1. Insert idempotency key  │  PK constraint = the guard.
 │ 2. Price the order         │  Server-authoritative. Always.
 │ 3. Authorize payment       │  Circuit-breakered external call
 │ 4. INSERT order (pending)  │  ← durable. It cannot be lost now.
 │ 5. Emit order.created      │
 └─────────────┬──────────────┘
               ▼
        201 Created  ────────────▶  the customer is DONE waiting
               │
               │  everything below is ASYNC and reaches the client
               │  over WebSocket, not over this response
               ▼
   merchant confirms → matching runs → driver accepts
   → picked_up → in_transit → delivered
```

**What that forces on the client.** The UI can no longer say "here's your driver." It has to model an order as a **live subscription, not a request/response**. The customer navigates immediately to a tracking screen showing "Finding your driver…", and the driver appears when a `driver_assigned` event arrives over the socket. That is a strictly better UX *and* it's the only version that can be four-nines available — which is the nicest kind of trade-off, where the honest architecture and the good product point the same direction.

**When to match is itself a seam.** Matching at `ready_for_pickup` means the driver arrives late and the food sits. Matching at `confirmed` means the driver waits, unpaid, and starts hating the platform. The right answer is to schedule matching at `confirmed + (prep_time − estimated_travel_time)` — which is why `avg_prep_time_minutes` lives on the merchant table, and why the merchant app's "prep time" field is load-bearing infrastructure rather than a settings screen.

## 🔧 Seam 2: The Location Firehose — Client Behavior Dictates Server Storage

The driver's phone sends its position every 3 seconds. That client-side interval, multiplied by 30,000 drivers, *is* the 10K writes/second requirement. The frontend's timer is the backend's capacity plan.

**Three data paths, because the data has three different consumers with three different needs:**

| Path | Destination | Consumer | Durability |
|------|-------------|----------|------------|
| **Hot** | Redis geo-index | Matching (`GEORADIUS`) | ❌ Volatile — and that's *correct* |
| **Push** | Redis Pub/Sub → WebSocket | The customer's map | ❌ Lossy, conflated |
| **Durable tail** | Kafka | ETA model training, dispute resolution | ✅ Replayable |

**Why volatile is the right answer for the geo-index.** Redis losing it sounds catastrophic: every driver appears offline. But every online driver sends a position within 3 seconds, so the index **self-heals in one update cycle.** The data was going to be overwritten anyway. We're not tolerating volatility — we're exploiting the fact that the data expires faster than any recovery process could run.

**Why PostGIS in the main database would break this.** It's ~5–10ms per query versus sub-millisecond, which hurts on the match path. But the deeper problem is the *write* side: the 10K/sec firehose would now share a WAL, a buffer cache, and a connection pool with order placement. The 800×-larger stream would be competing with the revenue path. The isolation matters more than the speed.

**The client seam: what the map is allowed to do.**

- **Conflate.** A position is *state*, not an event — the newest strictly supersedes the older. If the customer's connection stalls, drop the queued positions and send only the latest. Nobody needs to know where the driver *was* four seconds ago.
- **Interpolate.** Updates arrive every 3s, but a dot that teleports every 3 seconds looks broken. The client animates between known positions — which means the *perceived* smoothness is a frontend concern, and the backend can send *less* data because of it. Solving a rendering problem on the client bought us real backend headroom.
- **Show staleness honestly.** If no update arrives for 10 seconds, the UI must say so. A frozen dot that looks live is worse than a dot labeled "last seen 30s ago," because the customer makes decisions ("should I go downstairs?") on it.

**And the opposite discipline for status events.** "Picked up" and "delivered" are **events**, not state. They are never conflated, and they ride a bounded, replayable per-order Redis Stream. A customer whose phone goes through a tunnel reconnects and *replays what they missed*, rather than silently skipping a state and staring at a map forever wondering if the food arrived.

> "Same transport, opposite delivery guarantees, decided by the semantics of the payload. Positions are state — droppable, conflatable, interpolatable. Status changes are events — each one is a fact, and losing one strands a human being. Knowing which of your streams is which is the single most useful lens I have for real-time systems, and it's a decision the client and the server have to agree on explicitly, or one of them will get it wrong."

## 🔧 Seam 3: The Accept Button — Exactly-Once Against a Physical World

The driver taps Accept in a parking garage. This one interaction contains the hardest correctness problem in the system, and it cannot be solved on either side alone.

**Two races, failing in opposite directions:**

**Race A — duplicate orders (client-caused).** The customer taps Place Order, the network hangs, the app retries. Without protection: two orders, two charges. The client generates an idempotency key; the server inserts it *before* doing the work, and the primary-key constraint kills the duplicate at the door. A completed key returns the cached response byte-for-byte — **including the original order ID**, so the client's retry lands on the same tracking screen rather than a second one.

**Race B — double assignment (server-caused).** Two drivers accept the same order, because an offer was retried or a stale request replayed. The guard is a conditional update: assign the driver **only where `driver_id IS NULL`**. Zero rows updated means someone else won; the losing driver is told instantly and re-queued. **The database row is the lock**, and nothing at the application layer is trustworthy under retry.

**The failure with no clean answer: the driver accepted and we never heard it.** The tap lands, the row updates, the response dies in the garage. The driver's app shows nothing. Ours shows them assigned. This is the state that produces "two drivers showed up" and "nobody showed up," and it's the one that actually happens.

There's no transaction that fixes it, because one of the participants is a human in a car. So the fix is a protocol spanning both sides:

1. **The driver app never trusts its own last-known state.** On reconnect it *asks the server* what it's assigned to. The server is the truth, always. This is a client-side rule with no server-side enforcement — which means it has to be a rule, and it has to be in the code review checklist.
2. **Assignment carries a liveness lease.** If an assigned driver stops sending location updates for N minutes, the order returns to the matching pool and is re-offered. That covers the dead battery, the driver who quit for the day, and the accidental tap. Note that this is only possible *because* location updates already exist — the firehose we built for the map turns out to be the heartbeat we need for correctness.
3. **Every offer and outcome is recorded**, so "why did two drivers arrive at the taco truck" has an answer at 2am, and so `acceptance_rate` is a fact rather than a guess.

> "The general principle: you cannot make the physical world atomic, so make the *record* atomic and give the world a way to reconcile against it. Every irreversible physical action — driving to a restaurant, handing over food — must be preceded by a state transition the database has committed **and the actor's device has confirmed reading.** The state machine isn't bookkeeping. It's the only thing standing between us and two drivers at one restaurant."

## 🔌 The API Contract: Three Clients, One Model

Three apps consuming one backend creates a specific temptation and a specific failure.

```
# Customer
GET    /api/v1/merchants?lat=&lng=       Browse nearby
GET    /api/v1/merchants/:id/menu
POST   /api/v1/orders                    X-Idempotency-Key REQUIRED
GET    /api/v1/orders/:id
WSS    /ws  → subscribe(order:{id})      Tracking + status events

# Driver
POST   /api/v1/driver/go-online | go-offline
POST   /api/v1/driver/location           The firehose
POST   /api/v1/driver/offers/:id/accept  The race
POST   /api/v1/driver/orders/:id/picked-up | delivered
WSS    /ws  → subscribe(driver:{id})     Incoming offers

# Merchant
POST   /api/v1/merchant/orders/:id/confirm   Sets prep time
```

**The temptation is one `/orders/:id` that returns everything and lets each client pick what it needs.** It's DRY, it's one endpoint, and it's a data leak: the customer's payload would carry the driver's phone number and exact position, the driver's payload would carry the customer's payment details, and the merchant's would carry both. Role-based *field projection* is not optional here, and it must happen server-side. The three roles in this marketplace have adversarial incentives; "the client just won't render that field" is not an access-control strategy, it's a press release waiting to happen.

**Shared types, separate views.** The three frontends and the backend share one TypeScript definition of `Order`, `Driver`, `Merchant` — which means a field rename is a compile error rather than a runtime `undefined` in production. But each role gets a *projection* of that type, generated server-side, and the client's type reflects what it's actually allowed to see. That's the seam working: one source of truth for the shape, enforced boundaries on the content.

## 🔄 The Order State Machine — the Contract Every Client Renders

```
  pending ──▶ confirmed ──▶ preparing ──▶ ready_for_pickup
     │            │                              │
     │            │              (matching is scheduled here:
     │            │               confirmed + prep − travel)
     │            │                              ▼
     │            │                       driver_assigned
     │            │                              ▼
     │            │                          picked_up
     │            │                              ▼
     │            │                         in_transit
     │            │                              ▼
     ▼            ▼                          delivered
  cancelled ◀────────────────────────────────────┘
                            (only before pickup)
```

This diagram is a **shared contract**, not an implementation detail — all three apps render a view of it, and each transition is a conditional update on the server (`WHERE status = <expected>`), not a read-then-write.

The client-side consequence is subtle and important: **no client may optimistically advance a state.** It's tempting — the driver taps "Picked Up," why not show it immediately? Because unlike a kanban card, this transition has a *physical* meaning: it tells the customer their food has left the restaurant, and it starts the delivery ETA clock. If the update fails and we've already told the customer, we've lied about the physical world. Optimism is affordable when the client can predict the result *and* the consequence of being wrong is cosmetic. Here it's neither.

Contrast that with the tip amount or a rating — safe to render optimistically, because being wrong for 200ms harms nobody. **The rule isn't "optimistic UI good"; it's "optimism is priced by the cost of being wrong."**

## 🧭 Consistency Model

| Data | Guarantee | Client implication |
|------|-----------|--------------------|
| Orders, state transitions | Strong, ACID, conditional updates | The client must treat the server as the sole authority — never optimistically advance a state |
| Driver assignment | Strong, single-writer | The offer modal must handle "too late" gracefully; it *will* happen |
| Idempotency keys | Durable (PostgreSQL) | The client must generate a key per *intent*, not per *request*, or retries won't dedupe |
| Driver location | Eventual, ≤ 3s, lossy | Client conflates and interpolates; shows staleness after 10s |
| Order status push | At-least-once, replayable | Client must be idempotent on receipt — the same "delivered" may arrive twice |
| Ratings | Eventual, async | Safe to render optimistically |

The row people get wrong is the last-but-one. At-least-once delivery means **the client must tolerate duplicates.** A UI that appends a status to a timeline on every event will show "Delivered" twice after a reconnect replay. Applying events by ID into a keyed map, rather than appending to a list, makes duplicate delivery harmless — a small client-side decision that only makes sense if you know what the server's delivery guarantee actually is.

## 🛠️ Failure Handling Across the Stack

| Failure | Server behavior | What each client shows |
|---------|-----------------|------------------------|
| Redis down | Geo-index gone → matching **pauses**; orders queue in `confirmed` | Customer: "Finding your driver" (honest, and true). Driver: no offers. Nothing lies |
| PostgreSQL down | New orders rejected (503); active tracking continues from Redis | Customer: checkout disabled with a clear message. **Never** a silent failure at the payment moment |
| Kafka down | Locations still flow to Redis; matching and tracking unaffected | Nothing user-visible. Analytics and ETA training lag. This is the whole point of it being a separate path |
| Matching circuit opens | Orders hold; admin paged | Customer still sees an honest "searching" state |
| WebSocket drops | — | Client reconnects with jittered backoff and **replays missed order events** from the stream. Locations need no replay — a fresh one arrives in 3s |
| Driver goes dark | Liveness lease expires → re-offer | Customer notified of the reassignment. Silence here is what generates support tickets |

The rule: **degrade matching before orders, and tracking before either.** Accepting an order you can't yet fulfill is recoverable — you can always find a driver later. Losing the order isn't.

## 🔐 Security in a Three-Sided Marketplace

- **Session tokens in Redis, not JWTs.** A compromised *driver* account steals real food and real money. Revocation must be one operation, not a fifteen-minute wait.
- **Role checks on every endpoint.** These three roles have genuinely adversarial incentives — a customer hitting the driver-location endpoint is an attack, not a curiosity.
- **Location spoofing is the interesting one.** A driver reporting a fake position near a busy merchant harvests more offers. The defense is statistical, not cryptographic: flag physically implausible movement (a 400 km/h "bicycle"), and cross-check reported positions against the actual delivery timeline. Note this is only possible because we kept the durable Kafka tail — a fraud control that falls out of a decision made for ETA training.
- **Money is never computed on the client.** The cart *displays* a total; the server *decides* one. A client-computed total is a client-editable total.

## 📊 What I'd Measure

| Signal | Layer | Why it's the right one here |
|--------|-------|------------------------------|
| Time-to-match p99 | Server | The core SLO. The tail is where the sequential-offer trade-off actually hurts |
| **Offer rejection rate by zone** | Server | A *supply* problem wearing an engineering costume. No matcher tuning fixes it — it's a pricing signal |
| Location ingest rate vs. drivers-online | Both | These must track exactly. A gap means driver apps are silently failing to report and the geo-index is going stale |
| **ETA error distribution** | Both | The trust metric, and the biggest driver of support volume |
| WebSocket reconnect rate | Client | Spikes mean the tracking experience is broken for people who will never file a bug |
| Orders stuck in a state past threshold | Server | The catch-all. An order sitting in `confirmed` for 10 minutes is now a human problem |

## 📈 Scalability: What Breaks First

1. **The Redis geo-index on writes.** The fix is *free*, and it's the nicest property in the system: **shard by metro.** Drivers do not deliver from San Francisco to Chicago. Each metro gets its own geo-index and its own matching leader, with **zero cross-shard queries** — the physical world already partitioned the data for us. Most sharding decisions are agonizing; this one is a gift.
2. **WebSocket connections** for tracking. Horizontal gateways with Redis Pub/Sub so any gateway serves any customer. Bursty in exactly the same way orders are — everyone tracks at dinner.
3. **PostgreSQL order writes** — 35/sec at peak is genuinely small. This is *not* the bottleneck people expect. What grows is the `orders` table; partition by month, archive after 30 days.
4. **The matching leader per metro** must be single-writer to keep the offer protocol coherent. That's a vertical ceiling per metro — but a metro is a bounded amount of demand, and if one outgrows a process, split it into zones. Geography keeps handing us shard keys.
5. **ETA quality**, which is not a throughput problem and is the first thing to actually fail the user. Haversine ignores roads, traffic, and the fifteen minutes it takes to park downtown — and it's *systematically optimistic exactly where orders are densest*. The upgrade is a routing engine, then a model trained on the Kafka history we've been quietly collecting.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Order POST returns | ✅ On durable commit, before matching | ❌ After a driver is assigned | Matching takes minutes; 99.99% can't depend on driver supply |
| Order UX model | ✅ Live subscription (WebSocket) | ❌ Request/response | Follows directly from the above — and it's a better product anyway |
| Geo-index | ✅ Redis, volatile | ❌ PostGIS in the main DB | Self-heals in 3s; isolates a 10K/sec firehose from the revenue path |
| Location durability | ✅ Volatile hot + durable Kafka tail | ❌ Persist every point | 86 GB/day of data with a 3-second lifetime |
| Location delivery | ✅ Conflated + client interpolation | ❌ Buffer every point | Position is state; newest supersedes. Interpolation buys backend headroom |
| Status delivery | ✅ At-least-once, replayable stream | ❌ Conflated like locations | Each status is a fact; losing one strands a human |
| Client on duplicate events | ✅ Apply by ID into a keyed map | ❌ Append to a list | At-least-once means duplicates *will* arrive |
| Idempotency store | ✅ PostgreSQL | ❌ Redis | A lost key is a double charge |
| Driver assignment | ✅ Conditional update on `driver_id IS NULL` | ❌ App-level lock | The row is the lock |
| Driver app state | ✅ Ask the server on reconnect | ❌ Trust local state | The phone was in a garage; the server was not |
| Money | ✅ Server-authoritative | ❌ Client-computed total | A client-computed total is a client-editable total |
| Sharding | ✅ By metro | ❌ By hash | Geography already partitioned the data |

## 🚀 Closing

Every seam in this design comes from one sentence: **orders are rare and must be perfect; locations are constant and are allowed to be lossy.** That asymmetry is why they get different databases, different durability, different delivery guarantees, and different client-side handling — and why the single worst thing you could do to this system is build one uniform "real-time data path" that treats them the same.

What I'd build next, in the order the business would feel it: **a real ETA** (Haversine is a placeholder wearing a lab coat, and every trust metric traces back to it — the Kafka stream already holds the ground truth); **batched multi-stop assignment** (two orders on the same block should ride together — that's where the margin is); and honest instrumentation of **supply**, because when there are no drivers near the merchant at 7pm, no scoring function saves you, and the correct response is pricing rather than engineering. Knowing which of your problems your architecture *can't* solve is part of designing it.
