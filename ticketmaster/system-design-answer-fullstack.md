# Ticketmaster - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 🎯 Introduction (2 minutes)

"Thanks for this challenge. I'll be designing an event ticketing platform like Ticketmaster, covering both the backend systems for handling traffic spikes and preventing overselling, and the frontend experience for seat selection and checkout. The key is designing the end-to-end flow where fast Redis locks enable responsive seat selection while PostgreSQL transactions ensure no double-selling."

---

## ✅ 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Event Browsing** - Search and discover events with filtering
2. **Interactive Seat Selection** - Visual seat map with real-time availability
3. **Virtual Waiting Room** - Fair queue system for high-demand events
4. **Ticket Purchase** - Reserve seats, checkout with countdown, payment processing
5. **Order Management** - View tickets and order history

### Non-Functional Requirements

- **Scalability**: Handle 100x traffic spikes during on-sales
- **Consistency**: Zero overselling - each seat sold exactly once
- **Latency**: Seat reservation < 100ms, seat map load < 200ms
- **Availability**: 99.9% uptime, no downtime during high-profile events

### Full-Stack Focus Areas

- Shared TypeScript types between frontend and backend
- End-to-end seat reservation flow with optimistic UI
- Queue position polling with automatic admission
- Checkout flow with synchronized timer
- Real-time availability synchronization

---

## 🏗️ 2. High-Level Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       FRONTEND (React + TypeScript)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ Event        │  │ Seat Map     │  │ Waiting      │  │ Checkout    │  │
│  │ Discovery    │  │ (Canvas)     │  │ Room         │  │ Timer       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬───────┘  │
└─────────┼─────────────────┼─────────────────┼────────────────┼──────────┘
          │                 │                 │                │
          └─────────────────┴─────────────────┴────────────────┘
                                    │
                            ┌───────▼───────┐
                            │  API Gateway  │
                            │   (Express)   │
                            └───────┬───────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
         ▼                          ▼                          ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     Redis       │       │   PostgreSQL    │       │   RabbitMQ      │
│  ┌───────────┐  │       │  ┌───────────┐  │       │  ┌───────────┐  │
│  │ Seat Locks│  │       │  │ Events    │  │       │  │ Notifs    │  │
│  │ Sessions  │  │       │  │ Seats     │  │       │  │ Cleanup   │  │
│  │ Queue     │  │       │  │ Orders    │  │       │  │ Tasks     │  │
│  │ Cache     │  │       │  │ Users     │  │       │  └───────────┘  │
│  └───────────┘  │       │  └───────────┘  │       └─────────────────┘
└─────────────────┘       └─────────────────┘
```

---

## 🧩 3. The Shared Contract (5 minutes)

Frontend and backend import the same type definitions, so a field that changes
shape breaks the build rather than a customer's checkout.

### Core domain objects

| Type | Key fields | Notes |
|------|-----------|-------|
| `Venue` | id, name, capacity, section config | Section templates are what per-event seat rows get materialized *from* |
| `Event` | id, venueId, eventDate, onSaleDate, status, highDemand | `onSaleDate` drives the promotion job; `highDemand` decides whether the waiting room engages |
| `Seat` | id, eventId, section, row, price, status | One row per physical seat per event — the unique inventory the whole design exists to protect |
| `Reservation` | sessionId, eventId, seatIds, totalAmount, **expiresAt**, status | `expiresAt` is server-authoritative and drives the client countdown |
| `QueuePosition` | position, estimatedWait, status (`queued` / `active` / `not_in_queue`) | The waiting room's entire client-facing surface |
| `Order` | id, userId, status, totalAmount, paymentId, seats | Written only after payment succeeds |

`SeatStatus` is the three-state enum everything hinges on: `available` → `held`
→ `sold`, with expiry returning `held` to `available`.

### Request and response envelopes

| Endpoint | Request carries | Response carries |
|----------|-----------------|------------------|
| Reserve seats | eventId, seatIds | the reservation, **plus `unavailableSeats`** |
| Checkout | idempotency key, payment method | the order |
| All endpoints | — | `{ success, data?, error? }` |

Two details in that table are load-bearing.

> "`unavailableSeats` comes back as a list rather than the whole request
> failing. During an on-sale a buyer picks four seats and loses one of them by
> milliseconds — returning a blanket error means they start over and lose the
> other three too, to someone else, while they're re-picking. Returning the
> three we *did* hold plus a named list of what slipped lets the UI say 'we got
> you A-12, A-13, A-15; A-14 just went' and keep them in the flow. Partial
> success is the honest shape of this operation, so the type reflects it."

> "`expiresAt` is an absolute server timestamp, not a duration. If I sent
> 'expires in 600 seconds' the client would start counting from whenever the
> response arrived, and clock skew plus network latency means their timer and
> the server's sweeper disagree — the seat can be released while the user still
> sees ninety seconds left, which reads as the site stealing their tickets. An
> absolute instant lets the client render a countdown that converges on the
> same moment the server will act."

The cost of a shared type package is that the two deploys are coupled: a
breaking change to `Seat` has to ship on both sides together, or be additive.
For one team on one release train that's cheaper than the class of bug it
eliminates.

---


## 🔒 4. Deep Dive: End-to-End Seat Reservation (12 minutes)

### Sequence Diagram

```
┌────────┐     ┌─────────┐     ┌───────┐     ┌────────────┐
│Frontend│     │ Express │     │ Redis │     │ PostgreSQL │
└───┬────┘     └────┬────┘     └───┬───┘     └─────┬──────┘
    │               │              │               │
    │ 1. Select seats (optimistic UI)             │
    ├───────────────▶               │              │
    │               │              │               │
    │ 2. POST /reserve             │               │
    ├──────────────▶│              │               │
    │               │              │               │
    │               │ 3. SET NX (lock)             │
    │               ├─────────────▶│               │
    │               │◀─────────────┤               │
    │               │              │               │
    │               │ 4. BEGIN transaction         │
    │               ├─────────────────────────────▶│
    │               │              │               │
    │               │ 5. SELECT FOR UPDATE NOWAIT  │
    │               ├─────────────────────────────▶│
    │               │◀─────────────────────────────┤
    │               │              │               │
    │               │ 6. UPDATE seats SET held     │
    │               ├─────────────────────────────▶│
    │               │              │               │
    │               │ 7. COMMIT                    │
    │               ├─────────────────────────────▶│
    │               │              │               │
    │               │ 8. SETEX reservation         │
    │               ├─────────────▶│               │
    │               │              │               │
    │◀──────────────┤              │               │
    │ 9. Reservation + unavailable │               │
    │               │              │               │
    │ 10. Update UI (remove unavailable)          │
    ▼               ▼              ▼               ▼
```

### Frontend: Seat Selection Store

"I'm using Zustand for the seat selection store because it provides optimistic updates with minimal boilerplate. When a user selects a seat, we immediately update the UI, then reconcile with the server response."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      SeatSelectionStore (Zustand)                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State:                          Actions:                                │
│  ┌─────────────────────┐        ┌─────────────────────────────────────┐ │
│  │ eventId: string     │        │ addSeat(seatId)                     │ │
│  │ selectedSeats: []   │        │   - Check max 6 seats               │ │
│  │ reservation: null   │        │   - Add to selectedSeats            │ │
│  │ isReserving: false  │        │                                     │ │
│  └─────────────────────┘        │ removeSeat(seatId)                  │ │
│                                 │   - Filter from selectedSeats       │ │
│                                 │                                     │ │
│  Reservation Flow:              │ reserveSeats()                      │ │
│  ┌───────────────────┐          │   1. Set isReserving = true         │ │
│  │ User selects seat │──────────│   2. POST /api/seats/reserve        │ │
│  └─────────┬─────────┘          │   3. Handle unavailable seats       │ │
│            ▼                    │   4. Set reservation                │ │
│  ┌───────────────────┐          │   5. Show toast if conflicts        │ │
│  │ Optimistic update │          └─────────────────────────────────────┘ │
│  └─────────┬─────────┘                                                  │
│            ▼                                                            │
│  ┌───────────────────┐                                                  │
│  │ Server response   │                                                  │
│  └─────────┬─────────┘                                                  │
│            ▼                                                            │
│  ┌───────────────────┐                                                  │
│  │ Reconcile state   │                                                  │
│  └───────────────────┘                                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Backend: Two-Phase Reservation

"The backend uses two-phase locking: first acquire Redis locks for speed (sub-millisecond), then confirm with PostgreSQL transaction for durability. This gives us both performance and ACID guarantees."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Two-Phase Reservation Process                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PHASE 1: Redis Locks (Speed)          PHASE 2: PostgreSQL (Durability) │
│  ┌─────────────────────────────┐       ┌─────────────────────────────┐  │
│  │                             │       │                             │  │
│  │  For each seat:             │       │  BEGIN TRANSACTION          │  │
│  │  ┌───────────────────────┐  │       │  ┌───────────────────────┐  │  │
│  │  │ SET lock:seat:{id}    │  │       │  │ SELECT ... FOR UPDATE │  │  │
│  │  │ NX EX 600             │  │──────▶│  │ NOWAIT                │  │  │
│  │  │ (10 min TTL)          │  │       │  └───────────────────────┘  │  │
│  │  └───────────────────────┘  │       │              │              │  │
│  │              │              │       │              ▼              │  │
│  │              ▼              │       │  ┌───────────────────────┐  │  │
│  │  ┌───────────────────────┐  │       │  │ Verify status =       │  │  │
│  │  │ Track acquired/failed │  │       │  │ 'available'           │  │  │
│  │  └───────────────────────┘  │       │  └───────────────────────┘  │  │
│  │                             │       │              │              │  │
│  └─────────────────────────────┘       │              ▼              │  │
│                                        │  ┌───────────────────────┐  │  │
│                                        │  │ UPDATE seats SET      │  │  │
│                                        │  │ status = 'held'       │  │  │
│                                        │  └───────────────────────┘  │  │
│                                        │              │              │  │
│                                        │              ▼              │  │
│                                        │  COMMIT                     │  │
│                                        └─────────────────────────────┘  │
│                                                                          │
│  On Error: ROLLBACK + Release Redis locks                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Reservation Countdown Timer

The timer takes the server's absolute `expiresAt`, recomputes the remaining
seconds once per second, and renders `mm:ss`. Under two minutes it switches to a
red, pulsing treatment; at zero it toasts an error, clears the selection, and
returns the user to the event.

> "Recomputing from an absolute timestamp rather than decrementing a counter is
> what keeps it honest — a decrementing timer drifts if the tab is backgrounded
> and `setInterval` is throttled, so the user sees time remaining after the
> server has already swept the hold. The two-minute threshold isn't cosmetic
> either: it's the point where we want someone to either finish or release the
> seats, and a pulsing red timer measurably moves people to decide."

---

## 🚪 5. Deep Dive: Virtual Waiting Room (8 minutes)

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Virtual Waiting Room                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Redis Data Structures:                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ queue:{eventId}              │ Sorted Set (ZADD with timestamp) │   │
│  │ active:{eventId}             │ Set of active session IDs        │   │
│  │ active_session:{event}:{sid} │ Key with TTL (15 min shopping)   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Constants:                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ MAX_CONCURRENT_SHOPPERS = 5000                                   │   │
│  │ SHOPPING_WINDOW = 900 seconds (15 minutes)                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Queue Join Flow

```
┌────────┐                    ┌─────────┐                    ┌───────┐
│  User  │                    │ Backend │                    │ Redis │
└───┬────┘                    └────┬────┘                    └───┬───┘
    │                              │                             │
    │ POST /queue/{eventId}/join   │                             │
    ├─────────────────────────────▶│                             │
    │                              │                             │
    │                              │ EXISTS active_session?      │
    │                              ├────────────────────────────▶│
    │                              │◀────────────────────────────┤
    │                              │                             │
    │                              │ [If not active]             │
    │                              │ ZRANK queue:{eventId}       │
    │                              ├────────────────────────────▶│
    │                              │◀────────────────────────────┤
    │                              │                             │
    │                              │ [If not in queue]           │
    │                              │ ZADD queue:{eventId}        │
    │                              ├────────────────────────────▶│
    │                              │                             │
    │◀─────────────────────────────┤                             │
    │ { position, estimatedWait }  │                             │
    ▼                              ▼                             ▼
```

### Background Worker: Admit from Queue

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        admitFromQueue Worker                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Every N seconds:                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 1. activeCount = SCARD active:{eventId}                          │   │
│  │ 2. slotsAvailable = MAX_CONCURRENT - activeCount                 │   │
│  │ 3. nextUsers = ZRANGE queue:{eventId} 0 (slotsAvailable-1)       │   │
│  │ 4. For each user:                                                │   │
│  │    - SADD active:{eventId} sessionId                             │   │
│  │    - SETEX active_session:{eventId}:{sessionId} 900 "1"          │   │
│  │ 5. ZREM queue:{eventId} ...nextUsers                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  estimateWait(position) = ceil(position / 500) * 60 seconds             │
│  (Assumes ~500 users processed per minute)                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Queue Polling Hook

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      useQueuePolling Hook                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────────────┐   │
│  │ Join queue    │───▶│ Poll every    │───▶│ When status='active'  │   │
│  │ on mount      │    │ 3 seconds     │    │ - Clear interval      │   │
│  └───────────────┘    └───────────────┘    │ - Toast success       │   │
│                                            │ - Navigate to event   │   │
│                                            └───────────────────────┘   │
│                                                                          │
│  QueuePage UI:                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │              You're in the Queue                        │    │   │
│  │  │                                                         │    │   │
│  │  │                    [  12,345  ]                         │    │   │
│  │  │                 people ahead of you                     │    │   │
│  │  │                                                         │    │   │
│  │  │  Estimated wait: ~25 minutes                            │    │   │
│  │  │                                                         │    │   │
│  │  │  Don't refresh - we'll redirect you automatically       │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 💳 6. Deep Dive: Checkout with Idempotency (8 minutes)

### Idempotent Checkout Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Idempotent Checkout Process                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 1. Check Redis: GET idem:{idempotencyKey}                         │  │
│  │    └─▶ If exists, return cached result                            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 2. Check PostgreSQL: SELECT * FROM orders WHERE idempotency_key   │  │
│  │    └─▶ If exists, cache in Redis and return                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 3. Get reservation from Redis                                     │  │
│  │    └─▶ Check not expired                                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 4. Process payment (with circuit breaker)                         │  │
│  │    └─▶ On failure: return 402, don't continue                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 5. PostgreSQL Transaction:                                        │  │
│  │    - INSERT INTO orders (with idempotency_key)                    │  │
│  │    - UPDATE seats SET status = 'sold'                             │  │
│  │    - INSERT INTO order_items                                      │  │
│  │    - COMMIT                                                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 6. Cleanup:                                                       │  │
│  │    - DEL reservation:{sessionId}                                  │  │
│  │    - DEL lock:seat:{eventId}:{seatId} (for each seat)            │  │
│  │    - DEL availability:{eventId} (invalidate cache)               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 7. SETEX idem:{idempotencyKey} 86400 response                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Checkout Page

The page mints one idempotency key when it mounts and holds it in a ref, so
every retry from that page — a double-click on Pay, a resubmit after a network
blip — carries the same key. The button disables while in flight, but the key is
what actually guarantees safety.

> "Generating the key on mount rather than per click is the whole trick. Per
> click, a double-click produces two keys and two charges — the disabled button
> is a race, not a guarantee, because the second click can land before React
> re-renders. Minting it once ties the key to the *purchase intent* rather than
> to a UI event.
>
> The backend doesn't trust this anyway: when no key arrives it derives one from
> (session, event, sorted seat IDs), so a client that knows nothing about
> idempotency still can't double-charge. The client key is an optimization for
> the honest case; the derived key is the actual defense."

---

## 🔄 7. Real-Time Availability Sync (5 minutes)

### Backend: Availability Endpoint

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   GET /events/{eventId}/seats                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │ Check Redis     │────▶│ Cache Hit?      │─Yes─▶│ Return cached   │   │
│  │ availability:   │     └────────┬────────┘     │ response        │   │
│  │ {eventId}       │              │ No           └─────────────────┘   │
│  └─────────────────┘              ▼                                     │
│                       ┌─────────────────────┐                           │
│                       │ Query PostgreSQL    │                           │
│                       │ SELECT id, section, │                           │
│                       │ row, seat_number,   │                           │
│                       │ price, status       │                           │
│                       └──────────┬──────────┘                           │
│                                  ▼                                       │
│                       ┌─────────────────────┐                           │
│                       │ Build response:     │                           │
│                       │ { seats[], avail }  │                           │
│                       └──────────┬──────────┘                           │
│                                  ▼                                       │
│                       ┌─────────────────────┐                           │
│                       │ Cache with TTL:     │                           │
│                       │ on_sale: 5s         │                           │
│                       │ otherwise: 30s      │                           │
│                       └─────────────────────┘                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Availability Polling Hook

The seat map polls availability on an interval that tightens when the event is
live — a few seconds during an on-sale, much slower otherwise — and merges the
response into the store rather than replacing it, so a seat the user has
selected locally isn't yanked out from under their cursor by a refresh.

> "Polling rather than a WebSocket is a deliberate downgrade. A push channel
> would be strictly fresher, but it means holding a socket per shopper for the
> exact event where shoppers arrive by the hundred thousand — the connection
> count becomes the scaling problem before the data does. Polling a cached
> endpoint is absorbed by the cache layer, degrades gracefully under load, and
> the staleness it introduces is already bounded by the same few-second TTL the
> backend chose for correctness reasons. Reservation is what's authoritative
> anyway: the seat map is a hint, and the reserve call is the truth."

---

## 🧹 8. Background Cleanup (3 minutes)

### Expired Hold Cleanup Worker

A job runs every 60 seconds, finds `event_seats` rows whose `held_until` has
passed, returns them to `available`, and re-derives the event's available count
with a `COUNT(*)` rather than incrementing a counter.

> "Recomputing the count instead of decrementing is the important part. A
> counter that's incremented and decremented by several code paths — reserve,
> release, expire, checkout, cancel — will drift, and the drift is silent until
> an event shows seats it can't sell or hides seats it can. Recomputing is more
> expensive and cannot be wrong.
>
> The 60-second interval is the honest cost: a seat can be expired but still
> displayed as held for up to a minute. I'd rather have that lag than make the
> Redis key's TTL the mechanism, because when that key expires nothing tells
> Postgres, and the row stays held forever — the seat silently vanishes from
> the event and nobody finds out until the show."

---

## ⚖️ 9. Trade-offs Summary

| Decision | Chosen Approach | Alternative | Rationale |
|----------|-----------------|-------------|-----------|
| **Seat Locking** | Redis SET NX + PostgreSQL FOR UPDATE | Database-only locks | Redis gives sub-ms speed; PostgreSQL provides ACID |
| **Hold Duration** | 10 minutes | 5 min / 15 min | Balance between completion time and inventory release |
| **Queue Implementation** | Redis Sorted Set | Database polling | O(log N) operations, sub-ms latency |
| **Cache TTL** | Dynamic (5s on-sale, 30s otherwise) | Fixed TTL | Fresher data when it matters most |
| **Idempotency** | Redis cache + PostgreSQL column | Redis-only | Permanent record for auditing |
| **Checkout** | Synchronous payment | Async with webhooks | Simpler; immediate feedback to user |

---

## 📌 Summary

"I've designed a full-stack event ticketing platform with:

1. **Shared TypeScript types** ensuring consistency between frontend and backend for seats, reservations, and orders
2. **Two-phase seat reservation** with Redis locks (1ms) and PostgreSQL transactions (ACID), with optimistic UI updates on the frontend
3. **Virtual waiting room** with Redis sorted sets for fair queue management and frontend polling with auto-redirect
4. **Idempotent checkout** preventing double-charges through idempotency keys cached in both Redis and PostgreSQL
5. **Real-time availability sync** with dynamic cache TTLs (5s during sales, 30s otherwise) and conflict detection for selected seats

The key full-stack insight is that the frontend optimistically updates seat selections while the backend uses two-phase locking to guarantee consistency - when they diverge, the frontend gracefully handles the conflict by removing unavailable seats and notifying the user."
