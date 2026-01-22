# Ticketmaster - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing an event ticketing platform like Ticketmaster, covering both the backend systems for handling traffic spikes and preventing overselling, and the frontend experience for seat selection and checkout. The key is designing the end-to-end flow where fast Redis locks enable responsive seat selection while PostgreSQL transactions ensure no double-selling."

---

## 1. Requirements Clarification (5 minutes)

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

## 2. High-Level Architecture (5 minutes)

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

## 3. Shared Type Definitions (5 minutes)

### Core Types

The system uses shared TypeScript types between frontend and backend to ensure consistency:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SHARED TYPES (types.ts)                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐     │
│  │     Venue       │    │     Event       │    │     Seat        │     │
│  ├─────────────────┤    ├─────────────────┤    ├─────────────────┤     │
│  │ id: string      │    │ id: string      │    │ id: string      │     │
│  │ name: string    │◀───│ venueId: string │    │ eventId: string │     │
│  │ capacity: number│    │ eventDate: Date │    │ section: string │     │
│  │ sectionConfig[] │    │ onSaleDate: Date│    │ row: string     │     │
│  │                 │    │ status: enum    │    │ price: number   │     │
│  │                 │    │ highDemand: bool│    │ status: enum    │     │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘     │
│                                                                          │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐     │
│  │   Reservation   │    │  QueuePosition  │    │     Order       │     │
│  ├─────────────────┤    ├─────────────────┤    ├─────────────────┤     │
│  │ sessionId       │    │ position: number│    │ id: string      │     │
│  │ eventId         │    │ estimatedWait   │    │ userId: string  │     │
│  │ seatIds[]       │    │ status: enum    │    │ status: enum    │     │
│  │ totalAmount     │    │ - queued        │    │ totalAmount     │     │
│  │ expiresAt: Date │    │ - active        │    │ paymentId       │     │
│  │ status: enum    │    │ - not_in_queue  │    │ seats[]         │     │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘     │
│                                                                          │
│  SeatStatus: 'available' | 'held' | 'sold'                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### API Request/Response Types

```
┌──────────────────────────────┐    ┌──────────────────────────────┐
│    ReserveSeatsRequest       │    │    ReserveSeatsResponse      │
├──────────────────────────────┤    ├──────────────────────────────┤
│ eventId: string              │───▶│ reservation: Reservation     │
│ seatIds: string[]            │    │ unavailableSeats: string[]   │
└──────────────────────────────┘    └──────────────────────────────┘

┌──────────────────────────────┐    ┌──────────────────────────────┐
│    CheckoutRequest           │    │    ApiResponse<T>            │
├──────────────────────────────┤    ├──────────────────────────────┤
│ idempotencyKey: string       │    │ success: boolean             │
│ paymentMethod: CardDetails   │    │ data?: T                     │
└──────────────────────────────┘    │ error?: string               │
                                    └──────────────────────────────┘
```

---

## 4. End-to-End Seat Reservation Flow (12 minutes)

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

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      ReservationTimer Component                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Props: expiresAt: Date                                                  │
│                                                                          │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │ Calculate       │────▶│ Display         │────▶│ When expired    │   │
│  │ remaining time  │     │ mm:ss           │     │ - Toast error   │   │
│  │ every 1 second  │     │                 │     │ - Clear select  │   │
│  └─────────────────┘     └─────────────────┘     │ - Navigate home │   │
│                                                  └─────────────────┘   │
│                                                                          │
│  Visual States:                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ timeRemaining >= 120s  │  Blue background, normal text          │   │
│  ├────────────────────────┼────────────────────────────────────────┤   │
│  │ timeRemaining < 120s   │  Red background, animate-pulse         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Virtual Waiting Room Flow (8 minutes)

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

## 6. Checkout with Idempotency (8 minutes)

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

"The frontend generates a unique idempotency key when the checkout page mounts (via useRef), and reuses it for retries. This prevents double-charges even if the user clicks 'Pay' multiple times."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       CheckoutPage Component                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Initialization:                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ idempotencyKeyRef = useRef(crypto.randomUUID())                  │   │
│  │ (Generated once, reused for retries)                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Layout:                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ ReservationTimer                         [ 8:45 ]       │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                                                                 │   │
│  │  ┌─────────────────────┐  ┌─────────────────────────────────┐  │   │
│  │  │ Order Summary       │  │ Payment Form                    │  │   │
│  │  │ ─────────────────── │  │ ───────────────────────────     │  │   │
│  │  │ Section A, Row 12   │  │ Card Number: [____________]     │  │   │
│  │  │   Seat 5   $125.00  │  │ Expiry:      [____] [____]      │  │   │
│  │  │   Seat 6   $125.00  │  │ CVC:         [___]              │  │   │
│  │  │ ─────────────────── │  │                                 │  │   │
│  │  │ Subtotal:  $250.00  │  │ [        Pay $262.50        ]   │  │   │
│  │  │ Fees:       $12.50  │  │                                 │  │   │
│  │  │ Total:     $262.50  │  └─────────────────────────────────┘  │   │
│  │  └─────────────────────┘                                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Error Handling:                                                         │
│  - 402: "Payment declined. Please try a different card."               │
│  - Other: "Checkout failed. Please try again."                         │
│  - Same idempotency key for retry (safe to re-submit)                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Real-Time Availability Sync (5 minutes)

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

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  useAvailabilityPolling Hook                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Poll Interval:                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ isOnSale = true   ──▶  5 seconds (high frequency)               │   │
│  │ isOnSale = false  ──▶  30 seconds (low frequency)               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Conflict Detection:                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ For each selectedSeat:                                           │   │
│  │   if (prev[seatId] === 'available' &&                            │   │
│  │       current[seatId] !== 'available') {                         │   │
│  │     removeSeat(seatId);                                          │   │
│  │     toast.warning('A selected seat was just taken');             │   │
│  │   }                                                              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Returns: { seats, availability }                                        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Background Cleanup (3 minutes)

### Expired Hold Cleanup Worker

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    cleanupExpiredHolds Worker                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Runs every 60 seconds:                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 1. UPDATE seats                                                  │   │
│  │    SET status = 'available',                                     │   │
│  │        held_by_session = NULL,                                   │   │
│  │        held_until = NULL                                         │   │
│  │    WHERE status = 'held' AND held_until < NOW()                  │   │
│  │    RETURNING id, event_id, held_by_session                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 2. For each expired seat:                                        │   │
│  │    DEL lock:seat:{event_id}:{seat_id}                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 3. For each affected event:                                      │   │
│  │    DEL availability:{event_id}                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 4. Log: { count: expired.length, events: eventIds.length }       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Trade-offs and Alternatives

| Decision | Chosen Approach | Alternative | Rationale |
|----------|-----------------|-------------|-----------|
| **Seat Locking** | Redis SET NX + PostgreSQL FOR UPDATE | Database-only locks | Redis gives sub-ms speed; PostgreSQL provides ACID |
| **Hold Duration** | 10 minutes | 5 min / 15 min | Balance between completion time and inventory release |
| **Queue Implementation** | Redis Sorted Set | Database polling | O(log N) operations, sub-ms latency |
| **Cache TTL** | Dynamic (5s on-sale, 30s otherwise) | Fixed TTL | Fresher data when it matters most |
| **Idempotency** | Redis cache + PostgreSQL column | Redis-only | Permanent record for auditing |
| **Checkout** | Synchronous payment | Async with webhooks | Simpler; immediate feedback to user |

---

## Summary

"I've designed a full-stack event ticketing platform with:

1. **Shared TypeScript types** ensuring consistency between frontend and backend for seats, reservations, and orders
2. **Two-phase seat reservation** with Redis locks (1ms) and PostgreSQL transactions (ACID), with optimistic UI updates on the frontend
3. **Virtual waiting room** with Redis sorted sets for fair queue management and frontend polling with auto-redirect
4. **Idempotent checkout** preventing double-charges through idempotency keys cached in both Redis and PostgreSQL
5. **Real-time availability sync** with dynamic cache TTLs (5s during sales, 30s otherwise) and conflict detection for selected seats

The key full-stack insight is that the frontend optimistically updates seat selections while the backend uses two-phase locking to guarantee consistency - when they diverge, the frontend gracefully handles the conflict by removing unavailable seats and notifying the user."
