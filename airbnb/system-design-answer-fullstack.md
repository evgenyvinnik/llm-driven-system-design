# Airbnb - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

---

## 📋 Problem Statement

Design a property rental marketplace like Airbnb: end-to-end booking flow, availability calendar with complex UI and backend consistency, geographic search with map + PostGIS, and a two-sided review system.

---

## 🎯 Requirements Clarification

### Functional Requirements
1. **List** - Hosts create listings with photos, amenities, pricing
2. **Search** - Find properties by location, dates, filters
3. **Book** - Reserve with payment; prevent double-booking
4. **Review** - Two-way hidden-until-both rating system
5. **Message** - Host-guest communication

### Non-Functional Requirements
- **Consistency**: Strong for bookings (no double-booking)
- **Latency**: < 200ms search, 99.9% availability
- **Scale**: 10M listings, 1M bookings/day

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (React + TypeScript)                     │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │ SearchPage  │ │ ListingPage │ │ BookingFlow │ │HostDashboard│   │
│  │ - SearchBar │ │ - PhotoGrid │ │ - Calendar  │ │ - Calendar  │   │
│  │ - MapView   │ │ - BookWidget│ │ - Payment   │ │ - Listings  │   │
│  │ - Results   │ │ - Reviews   │ │ - Confirm   │ │ - Reservations│ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                    API Gateway (nginx)
                             │
┌────────────────────────────┴────────────────────────────────────────┐
│                    BACKEND (Node.js + Express)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │Listing Service│ │Booking Service│ │Search Service │               │
│  │ - CRUD        │ │ - Create      │ │ - Geo search  │               │
│  │ - Photos      │ │ - Prevent dbl │ │ - Availability│               │
│  │ - Calendar    │ │ - Cancel      │ │ - Ranking     │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────────┐
│                         DATA LAYER                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ PostgreSQL   │  │ Valkey/Redis │  │  RabbitMQ    │               │
│  │ + PostGIS    │  │ - Session    │  │ - Notifications│              │
│  │ - Listings   │  │ - Cache      │  │ - Email       │               │
│  │ - Bookings   │  │ - Rate limit │  │ - Analytics   │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🔍 Deep Dive 1: End-to-End Booking Flow

The booking flow demonstrates fullstack integration across all layers.

### Frontend: Booking Widget State Machine

The widget walks through: INITIAL (no dates) → PRICING (fetch availability) → READY (show breakdown, enable Reserve) → SUBMITTING (POST /api/bookings) → CONFIRMED (redirect to /trips) or ERROR (dates unavailable, re-fetch).

```
         ┌─────────────┐
         │   INITIAL   │
         └──────┬──────┘
                │ Select dates
                ▼
         ┌─────────────┐
         │   PRICING   │◄── GET /availability
         └──────┬──────┘
                │ Available
                ▼
         ┌─────────────┐
         │    READY    │  Price breakdown + Reserve btn
         └──────┬──────┘
                │ Click Reserve
                ▼
         ┌─────────────┐
         │  SUBMITTING │  POST /api/bookings
         └──────┬──────┘
        ┌───────┴───────┐
   Success           Conflict (409)
        ▼               ▼
  ┌──────────┐   ┌──────────┐
  │ CONFIRMED│   │  ERROR   │ Re-fetch availability
  └──────────┘   └──────────┘
```

### Backend: Booking Transaction Flow

```
POST /api/v1/bookings
         │
         ▼
┌─────────────────────┐
│   BEGIN TRANSACTION │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ SELECT listing      │  Row lock (FOR UPDATE)
│ Check OVERLAPS      │  Conflict? → ROLLBACK + 409
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ INSERT booking      │  Calculate pricing
│ INSERT avail_block  │  Mark dates as "booked"
│ COMMIT              │
└──────────┬──────────┘
           │
    ┌──────┴──────┬──────────────┐
    ▼             ▼              ▼
┌─────────┐ ┌──────────┐ ┌──────────────┐
│ Publish │ │ Invalidate│ │ Return 201   │
│ RabbitMQ│ │ Redis     │ │ with booking │
└─────────┘ └──────────┘ └──────────────┘
```

### Frontend-Backend Integration Points

| Step | Frontend Action | API Call | Backend Logic |
|------|-----------------|----------|---------------|
| 1 | Mount widget | GET /availability | Return cached blocks |
| 2 | Select dates | Calculate locally | - |
| 3 | Click Reserve | POST /bookings | Transaction with lock |
| 4 | Success | Redirect to /trips | Invalidate cache |
| 5 | Conflict | Show error, refetch | Return conflict dates |

---

## 🗺️ Deep Dive 2: Geographic Search Pipeline

### Frontend: Search Page Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Location    ] [Check-in] - [Check-out] [Guests] [Search]          │
├─────────────────────────────────────────────────────────────────────┤
│  Filters: [Price] [Property Type] [Amenities] [Instant Book]        │
├────────────────────────────────┬────────────────────────────────────┤
│                                │                                    │
│     RESULTS LIST (50%)         │         MAP VIEW (50%)             │
│  ┌──────────────────────────┐  │  ┌────────────────────────────┐   │
│  │ [img] Cozy Studio $89    │◄─┼──┼─── $89                     │   │
│  │       4.8 (124 reviews)  │  │  │      \                     │   │
│  ├──────────────────────────┤  │  │       $149                 │   │
│  │ [img] Beach House $149   │◄─┼──┼─── Highlighted on hover    │   │
│  │       4.9 (89 reviews)   │  │  │                            │   │
│  ├──────────────────────────┤  │  │    $225                    │   │
│  │ [img] Luxury Villa $225  │  │  │              $189          │   │
│  │       4.7 (56 reviews)   │  │  │                            │   │
│  └──────────────────────────┘  │  └────────────────────────────┘   │
│                                │                                    │
│  [Load More Results...]        │  [Zoom] [Pan] updates results     │
└────────────────────────────────┴────────────────────────────────────┘
```

### Search State Flow

URL parameters are the single source of truth (`?lat=34.05&lon=-118.24&checkIn=...`). SearchBar, Filters, and Map all update URL params. A `useEffect` on URL change triggers `GET /search`, which updates both the results list and map markers. This gives us shareable URLs and working browser navigation for free.

### Backend: PostGIS Search Pipeline

```
GET /api/v1/search?lat=34.05&lon=-118.24&radius=25000&checkIn=...

┌─────────────────────────────────────────────┐
│  1. Geographic: ST_DWithin (GIST index)     │
│  2. Filters: active, guests, price, type    │
│  3. Availability: exclude OVERLAPS blocks   │
│  4. Rank: rating×0.4 + log(reviews)×0.3     │
│           + (1 - dist/radius)×0.3           │
│  5. Paginate: LIMIT 20, join primary photos │
└─────────────────────────────────────────────┘
```

The query runs as a single PostgreSQL statement combining all five steps. The GIST spatial index on `listings.location` makes Step 1 fast even at 10M listings. Step 3 uses a `NOT EXISTS` subquery against `availability_blocks` with the OVERLAPS operator to exclude unavailable listings.

### Map-List Synchronization

Hovering a result card highlights the corresponding map marker (and vice versa) via a shared `highlightedId` in the search store. Dragging the map updates URL bounds, which triggers a re-fetch for the new area.

---

## 📅 Deep Dive 3: Availability Calendar System

### Frontend: Guest Calendar Component

Each day cell renders in one of four states: past (gray, disabled), available (selectable), blocked/booked (strikethrough, disabled), or selected range (highlighted). The calendar fetches availability blocks from the backend and maps ranges to individual day states.

### Calendar Selection State Machine

```
         ┌───────────────────┐
         │       IDLE        │ No dates selected
         └─────────┬─────────┘
                   │ Click available date
                   ▼
         ┌───────────────────┐
         │  START_SELECTED   │ Waiting for end date
         └─────────┬─────────┘
                   │
     ┌─────────────┼──────────────┐
     ▼             ▼              ▼
 Click before  Click after   Click same
 start → swap  start → validate  → IDLE
                   │
            ┌──────┴──────┐
         Valid          Invalid
            ▼              ▼
   ┌────────────────┐  ┌──────────┐
   │ RANGE_SELECTED │  │ Toast    │
   │ Calculate price│  │ error    │
   └────────────────┘  └──────────┘
```

### Backend: Calendar Update with Split/Merge

When a host blocks dates, overlapping availability blocks must be split. Example: host blocks Dec 15-20 within an existing [Dec 1-31, available] block.

```
BEFORE: |============ available =============|
        Dec 1                            Dec 31

AFTER:  |== avail ==|== blocked ==|== avail ==|
        Dec 1    Dec 14  Dec 15  Dec 20  Dec 21  Dec 31
```

The backend finds overlapping blocks via OVERLAPS, deletes the original, and inserts up to three replacement blocks within a transaction. Redis availability cache is invalidated on commit.

### Availability Storage Model

| Approach | Storage | Pros | Cons |
|----------|---------|------|------|
| ✅ Date ranges | ~200M rows | 18x less storage | Complex split/merge logic |
| ❌ Day-by-day | 3.65B rows | Simple queries | Massive storage, slow inserts |

> "I'm choosing date ranges because at 10M listings with 365 days each, day-by-day storage creates 3.65 billion rows. Date ranges give us ~200M rows - an 18x reduction. The frontend can handle day-by-day display from range data, while the backend manages the split/merge complexity."

---

## ⭐ Deep Dive 4: Two-Sided Review System

### Review Visibility Timeline

```
Checkout date passes → 14-day review window opens
         │
    ┌────┴────┐
    ▼         ▼
  Guest     Host
  submits   submits
  (hidden)  (hidden)
    │         │
    └────┬────┘
         ▼
┌─────────────────┐
│  Both exist?    │
└────────┬────────┘
    ┌────┴────┐
    ▼         ▼
  Yes        No
    │         │
    ▼         ▼
 Both →    Wait for
 is_public  other party
 = true
    │
    ▼
 Update listing
 rating + count
```

### Database Trigger Logic

Two PostgreSQL triggers handle this automatically. **ON INSERT into reviews**: check if the other party's review exists for the same booking; if so, set both to `is_public = true`. **ON UPDATE is_public**: if it's a guest review becoming public, recalculate the listing's average rating and review count. Host reviews don't affect listing rating.

### Frontend Review States

The review UI shows different states per booking: "Write Review" (window open, not submitted), "Waiting for other party" (submitted but hidden), "Published" (both submitted). The 14-day window countdown is displayed to create urgency. Guest reviews include sub-ratings (cleanliness, location, value) while host reviews are overall-only.

### Why Hidden-Until-Both?

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Hidden until both | Honest feedback, no gaming | Delay in visibility |
| ❌ Immediate visibility | Simple implementation | Retaliation reviews, gaming |

> "I'm choosing hidden-until-both because it prevents the 'you gave me 3 stars so I'll give you 1 star' retaliation pattern. This produces more honest feedback for the marketplace, even if it delays visibility slightly."

---

## 🗄️ State Management & API Layer

| Store | Purpose |
|-------|---------|
| Auth (Zustand) | User session, login/logout |
| Search (URL params) | Location, dates, guests, filters — URL is source of truth |
| Booking (local state) | Selected dates, guests, availability, submission state |

All API calls use `fetch` with `credentials: 'include'` (session cookies). Errors return typed codes: `DATES_UNAVAILABLE` triggers re-fetch + toast, `UNAUTHORIZED` redirects to `/login` with return URL.

---

## 💾 Caching Strategy

Three-layer cache: React Query (browser, staleTime-based) → Redis/Valkey (server, TTL-based) → PostgreSQL (source of truth).

| Data Type | Redis TTL | React Query staleTime | Invalidation |
|-----------|-----------|----------------------|--------------|
| Listing details | 15 min | 15 min | Review published, listing updated |
| Availability | 1 min | 30 sec | Booking created, calendar update |
| Search results | 5 min | 5 min | None (acceptable staleness) |

---

## 📊 Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Calendar storage | ✅ Date ranges | ❌ Day-by-day | 18x fewer rows; frontend handles display; backend handles split/merge |
| Geo search | ✅ PostGIS | ❌ Elasticsearch | Single DB simplifies stack; API returns distance for map markers |
| Double-booking | ✅ Transaction lock | ❌ Distributed lock | Single DB is simpler; frontend shows optimistic UI with error handling |
| Reviews | ✅ Hidden until both | ❌ Immediate | Trigger-based automation; frontend shows clear status messaging |
| State management | ✅ Zustand | ❌ Redux | Simpler API; sufficient for search/auth state |
| API caching | ✅ React Query | ❌ Manual useState | Automatic stale/refetch; reduces boilerplate |
| Session auth | ✅ Cookies | ❌ JWT | HttpOnly cookies secure; automatic credential sending |
| Search state | ✅ URL params | ❌ Store only | Shareable URLs; browser navigation works; deep linking |

---

## 📈 Scalability Path

**What breaks first**: Search queries at scale. PostGIS works well up to ~50M listings, but beyond that we'd add Elasticsearch as a read-optimized search index synced from PostgreSQL via CDC. The booking path scales well because it's a single-row lock per listing — contention only occurs on extremely popular listings.

**Read replicas**: Route all search and listing detail reads to replicas. Bookings stay on primary for strong consistency. Session reads go to Redis (already separated).

**Sharding strategy**: Shard listings by geographic region (continent/country). Most searches are geographically bounded, so cross-shard queries are rare. Bookings reference listing IDs and stay co-located with the listing shard.

---

## 🚀 Future Enhancements

1. **Real-time updates** - WebSocket for booking confirmations and messages
2. **Map clustering** - Frontend clustering for dense listing areas
3. **Smart pricing** - ML-based suggestions with host override UI
4. **Image optimization** - CDN with responsive srcset
