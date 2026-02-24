# Calendly - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

---

## Introduction

"I'll design a meeting scheduling platform like Calendly, covering the end-to-end architecture from frontend to database. The core challenges are preventing double bookings while providing a responsive booking experience, and handling timezone complexity across the entire stack. I need to think about where computation lives - client vs. server - and how the two coordinate on conflict prevention."

---

## 🎯 Requirements Clarification

### Functional Requirements

1. **Availability Management** - Hosts define weekly working hours
2. **Meeting Types** - Configurable durations with buffers
3. **Guest Booking Flow** - View slots, select time, submit form, confirm
4. **Calendar Integration** - Sync with Google Calendar
5. **Notifications** - Email confirmations and reminders

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Consistency | Zero double bookings | A single double booking destroys trust |
| Availability check | < 200ms | Users browse many dates |
| Booking submission | < 500ms | Acceptable for form submit |
| Bundle size | < 200KB gzipped | Mobile guests on slow connections |

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Frontend (SPA)                          │
│              Zustand + TanStack Router + Tailwind                │
└─────────────────────────────────────┬───────────────────────────┘
                                      │ REST API (JSON over HTTPS)
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Express API Layer                             │
│                (Auth, Rate Limiting, Validation)                 │
└─────────────────────────────────────┬───────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│  PostgreSQL     │        │  Redis/Valkey   │        │    RabbitMQ     │
│  (Bookings)     │        │  (Cache, Locks) │        │  (Notifications)│
└─────────────────┘        └─────────────────┘        └─────────────────┘
```

---

## 🔧 Deep Dive: Where Should Computation Live?

> "The fundamental fullstack question is: what should the client do vs. the server? I'll walk through three key areas where this decision matters."

### Timezone Conversion: Client or Server?

**The problem:** Slots are stored in UTC. A guest in Tokyo booking with a host in New York needs to see times in their local timezone.

**Option A: Server converts to guest's timezone**
- Server accepts timezone parameter in availability request
- Returns slots already formatted for that timezone

**Option B: Server returns UTC, client converts**
- Server always returns UTC timestamps
- Client uses `Intl.DateTimeFormat` to display in local timezone

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Client-side conversion | Instant timezone switching, better caching | Requires modern browser APIs |
| ❌ Server-side conversion | Simpler client code | Refetch required on timezone change |

**Why I chose client-side conversion:**

> "Timezone switching is a common user behavior. Guests frequently toggle between their local time and the host's timezone to verify 'wait, what time is this really?' If every timezone change requires an API call, that's 200ms+ of latency each time. With client-side conversion, the switch is instant - I just re-render with different Intl options.

> The trade-off is client complexity. I need timezone-aware formatting logic in the frontend. But modern browsers all support `Intl.DateTimeFormat`, so this works reliably. The UX benefit of instant switching outweighs the implementation cost."

### Conflict Detection: Client Pre-Check or Server Only?

**The problem:** A guest selects a slot, fills out the form, and clicks submit. Between selection and submission, someone else might have booked that slot.

**Option A: Server validation only**
- Guest submits form
- Server checks availability, returns 409 if conflict
- Guest starts over

**Option B: Client pre-check + server validation**
- When guest selects a slot, client calls "check availability" endpoint
- If available, show form
- Server still validates on submit (double-check)

**Option C: Optimistic locking with version**
- Availability response includes a version number
- Booking request includes that version
- Server rejects if version doesn't match

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Pre-check + server validation | Catches 95% of conflicts early, better UX | Extra API call |
| ❌ Server only | Fewer API calls | User fills form then gets conflict |
| ❌ Version-based | Most accurate | Complex, version tracking overhead |

**Why I chose pre-check + server validation:**

> "Imagine the guest experience with server-only validation: they browse dates, find a time, carefully type their name and email, maybe add notes... then get 'Sorry, this slot was just booked.' They've wasted 30-60 seconds. That's terrible UX.

> With pre-check, when they click a time slot, I immediately verify it's still available. If someone just booked it, they see an error before investing effort in the form. The pre-check catches 95% of conflicts because most races happen between slot display and selection, not between form fill and submit.

> The extra API call is worth it. The pre-check is fast (< 50ms) and dramatically improves the user experience. The server still validates on final submission as defense in depth - the pre-check is optimization, not security."

### Caching: Server or Client?

**The problem:** Availability calculation is expensive (merges multiple data sources). Users browse many dates. Do I cache on server, client, or both?

**Option A: Server-only cache (Redis)**
- All availability responses cached server-side
- Clients always get cached data or fresh calculation

**Option B: Client-only cache (in-memory)**
- Client caches responses for 3-5 minutes
- Reduces API calls during browsing session

**Option C: Both**
- Server caches availability (5-minute TTL)
- Client caches responses for current session

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Both (server + client) | Fastest browsing, reduced server load | Two caches to invalidate |
| ❌ Server only | Single source of truth | Every date browse hits server |
| ❌ Client only | Works offline-ish | First load always slow |

**Why I chose both:**

> "Client caching makes date browsing feel instant. A user clicks Monday, looks at slots, clicks Wednesday, changes mind and clicks Monday again. With client cache, that second Monday click returns instantly from memory. Without it, they wait 200ms each time.

> Server caching reduces database load. If 100 guests are looking at the same host's availability, the first request calculates it and the next 99 hit Redis. This is critical for popular hosts.

> The challenge is cache invalidation. When a booking happens, I need to invalidate both caches. Server invalidation is straightforward - delete the Redis key. Client invalidation happens on the 409 response (if pre-check fails) or on successful booking (clear local cache). The complexity is manageable and the performance benefit is significant."

---

## 📋 API Contract

### Key Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/:username/:slug` | Get meeting type details |
| GET | `/availability` | Get available slots for date range |
| GET | `/availability/check` | Pre-check single slot |
| POST | `/bookings` | Create booking (with idempotency key) |
| GET | `/bookings/:id` | Get booking confirmation |

### Availability Response

Returns UTC timestamps grouped by date. The client converts to display timezone without refetching.

### Booking Request

Includes idempotency key header to handle network retries. The key is generated client-side as a hash of `meetingTypeId:startTime:email:timestamp`. If the same request is retried, server returns the previous result.

### Error Handling

- **409 Conflict** - Slot was booked since last check, response includes alternative slots
- **422 Validation Error** - Invalid form data, response includes field-level errors
- **429 Rate Limited** - Too many requests, response includes retry-after header

---

## 🔧 Deep Dive: Double Booking Prevention (End-to-End)

> "This is where frontend and backend must coordinate tightly. Neither can solve it alone."

### The Full Flow

```
Guest clicks slot ──▶ Client pre-check ──▶ Show form if available
                              │
                              ▼ (If unavailable)
                        Show "slot taken" + alternatives

Guest submits form ──▶ Client generates idempotency key
                   ──▶ Server receives booking request
                              │
                              ▼
                   ┌──────────────────────────────────┐
                   │   SERVER VALIDATION LAYERS       │
                   ├──────────────────────────────────┤
                   │ 1. Check idempotency cache       │
                   │ 2. Acquire distributed lock      │
                   │ 3. Row-level lock (FOR UPDATE)   │
                   │ 4. Overlap query check           │
                   │ 5. Insert with unique index      │
                   └──────────────────────────────────┘
                              │
                              ▼
                   Success ──▶ Invalidate caches ──▶ Queue email ──▶ Return confirmation
                   Conflict ──▶ Return 409 + alternatives
```

### Why Five Layers?

> "Each layer catches different failure modes:

> **Idempotency** catches the 'user clicked twice' or 'network retry' case. Without it, a slow connection could result in duplicate bookings.

> **Distributed lock** catches concurrent requests to the same host. If two guests are booking simultaneously, one waits rather than both racing to the database.

> **Row-level lock** serializes within the transaction. Even if the distributed lock fails (Redis down), this layer still works.

> **Overlap query** is an explicit check before insert. It catches edge cases like overlapping (but not identical) bookings.

> **Unique index** is the last line of defense. If all else fails, the database constraint prevents duplicates. This catches bugs in application code.

> Is this overkill? Maybe. But a single double-booking creates a customer support nightmare and destroys trust. The cost of these layers is complexity. The cost of missing them is reputation."

---

## 🔧 Deep Dive: Guest Booking UX

### Progressive Disclosure

The booking flow reveals complexity gradually to reduce cognitive load:

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: Calendar (low commitment)                               │
│  Show month view with available dates marked                     │
│  User clicks a date ──▶ Fetch time slots                         │
├─────────────────────────────────────────────────────────────────┤
│  Step 2: Time slots appear (medium commitment)                   │
│  Show available times grouped by morning/afternoon/evening       │
│  User clicks a time ──▶ Pre-check availability                   │
├─────────────────────────────────────────────────────────────────┤
│  Step 3: Form slides in (commitment)                             │
│  Name, email, optional notes                                     │
│  User submits ──▶ Create booking with idempotency                │
├─────────────────────────────────────────────────────────────────┤
│  Step 4: Confirmation (done)                                     │
│  Show meeting details in guest's timezone                        │
│  Offer "Add to Calendar" links                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Why Not Multi-Page Wizard?

> "Multi-page flows (page 1: date, page 2: time, page 3: form) have measurably higher abandonment. Each page transition is a chance for the user to leave. Research shows 3x higher abandonment when users see a loading spinner during booking.

> With progressive disclosure on a single page, users see context throughout. The calendar stays visible while they pick a time. The selected time stays visible while they fill the form. This continuity builds confidence.

> The trade-off is state complexity. I'm managing step transitions, animations, and conditional rendering all in one component. But this complexity is contained and predictable, unlike the routing/state-sync issues of multi-page flows."

---

## 📱 Responsive Design

### Layout Adaptation

| Viewport | Layout |
|----------|--------|
| Desktop | Calendar and time slots side by side |
| Tablet | Calendar full width, slots below |
| Mobile | Calendar stacked, bottom sheet for slots/form |

### Mobile-Specific UX

- Touch targets minimum 44x44px
- Bottom sheet pattern for time slots and form (stays out of way)
- Sticky timezone selector (always accessible)
- Reduced animation to save battery

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why Alternative Fails |
|----------|--------|-------------|----------------------|
| Timezone conversion | Client-side | Server-side | Requires refetch on timezone change |
| Conflict detection | Pre-check + server | Server only | User wastes time filling form |
| Caching strategy | Both client + server | Server only | Browsing feels slow |
| Booking flow | Progressive disclosure | Multi-page | Higher abandonment between pages |
| Time storage | UTC only | Local timezone | DST breaks data |
| Notifications | Async queue | Synchronous | Email failures block bookings |

---

## 🔐 Authentication Flow

### Session-Based Auth

Host authentication uses HTTP-only cookies with Redis session storage:

1. Login sends credentials, server validates, creates session in Redis
2. Session ID stored in HTTP-only cookie (not accessible to JavaScript)
3. Each request includes cookie, server looks up session
4. Logout deletes session from Redis

**Why sessions over JWT:**

> "JWT would let me go stateless, but I'd lose the ability to revoke tokens immediately. If a host reports their account compromised, I need to invalidate their session right now, not wait for token expiry.

> Session lookup adds ~2ms per request (Redis is fast). That's acceptable for the security benefit of immediate revocation."

### Guest Booking (Unauthenticated)

Guest booking pages are public - no authentication required. Rate limiting prevents abuse (20 requests/minute per IP). The idempotency key prevents duplicate submissions.

---

## 🎯 Summary

"The Calendly fullstack architecture is shaped by two core principles:

**1. Client and server coordinate on conflict prevention.** The client pre-checks to provide early feedback. The server validates to ensure correctness. Neither trusts the other completely - defense in depth.

**2. Computation goes where it provides the best UX.** Timezone conversion on the client enables instant switching. Caching on both layers makes browsing feel instant. Server-side locking guarantees consistency.

The key fullstack insight is that these aren't separate systems - they're one system split across two environments. The API contract is the handshake between them. I chose REST with UTC timestamps and idempotency keys because it's simple, cacheable, and handles network failures gracefully.

The biggest risk is cache inconsistency - a client sees stale availability and gets surprised by a 409. I mitigate this with pre-checks and clear error messaging. The tradeoff (fast browsing vs. occasional conflicts) is worth it for the UX improvement."
