# Airbnb - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

---

## 📋 Problem Statement

Design a property rental marketplace like Airbnb: end-to-end booking flow, availability calendar with complex UI and backend consistency, geographic search with map + PostGIS, and two-sided reviews with hidden-until-both-submit logic.

---

## 🎯 Requirements Clarification

**Functional:** List properties, search by location/dates, book with payments, two-way reviews, host-guest messaging.

**Non-Functional:** 99.9% search availability, strong booking consistency (no double-booking), <200ms search latency, 10M listings, 1M bookings/day.

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

### Frontend: Booking Widget State Machine

```
┌──────────────────────────────────────────────────────────┐
│                    BOOKING WIDGET                         │
├──────────────────────────────────────────────────────────┤
│  $149 / night                                             │
│                                                          │
│  ┌─────────────────────┬─────────────────────┐          │
│  │  CHECK-IN           │  CHECK-OUT          │          │
│  │  [Dec 15, 2024]     │  [Dec 20, 2024]     │          │
│  └─────────────────────┴─────────────────────┘          │
│                                                          │
│  GUESTS: [2 guests]                                      │
│                                                          │
│  $149 x 5 nights         $745                           │
│  Cleaning fee            $85                            │
│  Service fee             $74                            │
│  ─────────────────────────────                          │
│  Total                   $904                           │
│                                                          │
│  [ Reserve ] or [ Request to Book ]                      │
└──────────────────────────────────────────────────────────┘
```

### Widget State Flow

```
         ┌─────────────┐
         │   INITIAL   │
         │  (no dates) │
         └──────┬──────┘
                │ User selects dates
                ▼
         ┌─────────────┐
         │   PRICING   │◄─────── Fetch availability
         │ (calculating)│        from backend
         └──────┬──────┘
                │ Dates available
                ▼
         ┌─────────────┐
         │    READY    │  Show price breakdown
         │ (can book)  │  Enable Reserve button
         └──────┬──────┘
                │ Click Reserve
                ▼
         ┌─────────────┐
         │  SUBMITTING │  Show loading spinner
         │             │  POST /api/bookings
         └──────┬──────┘
                │
        ┌───────┴───────┐
        │               │
   Success           Conflict
        │               │
        ▼               ▼
  ┌──────────┐   ┌──────────┐
  │ CONFIRMED│   │  ERROR   │ "Dates no longer available"
  │ Redirect │   │ Refresh  │ Re-fetch availability
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
           │
           ▼
┌─────────────────────┐
│ SELECT listing      │  Lock the row to prevent
│ FOR UPDATE          │  concurrent modifications
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check for conflicts │  WHERE (start, end)
│ OVERLAPS query      │  OVERLAPS ($checkIn, $checkOut)
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
 No conflicts  Conflicts found
    │             │
    ▼             ▼
┌─────────┐  ┌─────────────┐
│ Continue│  │ ROLLBACK    │
└────┬────┘  │ Return 409  │
     │       └─────────────┘
     ▼
┌─────────────────────┐
│ Calculate pricing   │
│ nights x rate +     │
│ cleaning + service  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ INSERT booking      │
│ INSERT avail_block  │  Mark dates as "booked"
│ INSERT conversation │  Create messaging thread
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│      COMMIT         │
└──────────┬──────────┘
           │
    ┌──────┴──────┬──────────────┐
    │             │              │
    ▼             ▼              ▼
┌─────────┐ ┌──────────┐ ┌──────────────┐
│ Publish │ │ Delete   │ │ Return 201   │
│ event   │ │ cache    │ │ with booking │
│ RabbitMQ│ │ Redis    │ │ JSON         │
└─────────┘ └──────────┘ └──────────────┘
     │
     ▼
┌─────────────────────┐
│ Worker sends email  │
│ and push notif      │
└─────────────────────┘
```

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

```
                ┌─────────────────┐
                │  URL Parameters │  Source of truth
                │  ?lat=34.05     │  for search state
                │  &lon=-118.24   │
                │  &checkIn=...   │
                └────────┬────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ SearchBar│   │ Filters  │   │  Map     │
   │ updates  │   │ update   │   │ bounds   │
   │ URL      │   │ URL      │   │ update   │
   └────┬─────┘   └────┬─────┘   └────┬─────┘
        │              │              │
        └──────────────┴──────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  useEffect on   │
              │  URL change     │
              │  triggers fetch │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  GET /search    │
              │  with all params│
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Update results │
              │  and map markers│
              └─────────────────┘
```

### Backend: PostGIS Search Query

```
GET /api/v1/search?lat=34.05&lon=-118.24&radius=25000&checkIn=...

         │
         ▼
┌─────────────────────────────────────────────┐
│  Step 1: Geographic Filter                  │
│  ST_DWithin(location, point, radius)        │
│  Uses GIST spatial index                    │
│                                             │
│  Returns: listings within 25km circle       │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  Step 2: Basic Filters                      │
│  - is_active = true                         │
│  - max_guests >= requested                  │
│  - price BETWEEN min AND max                │
│  - property_type IN (selected types)        │
│  - amenities && (selected amenities)        │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  Step 3: Availability Check (if dates)      │
│  Exclude listings WHERE EXISTS              │
│    availability_block with status != avail  │
│    that OVERLAPS with requested dates       │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  Step 4: Ranking                            │
│                                             │
│  relevance = rating x 0.4 +                 │
│              log(reviews + 1) x 0.3 +       │
│              (1 - distance/radius) x 0.3    │
│                                             │
│  OR sort by: price, distance, rating        │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  Step 5: Pagination + Photos                │
│  LIMIT 20 OFFSET (page-1)*20                │
│  Join primary photos for each listing       │
│  Return with distance in meters             │
└─────────────────────────────────────────────┘
```

Map-list synchronization uses a shared Zustand store: hovering a result card highlights the map marker (and vice versa). Dragging the map updates URL params with new bounds, triggering a re-fetch.

---

## 📅 Deep Dive 3: Availability Calendar System

### Frontend: Guest Calendar Component

```
┌─────────────────────────────────────────────────────────────────┐
│   <  December 2024  >                                           │
├─────────────────────────────────────────────────────────────────┤
│  Sun    Mon    Tue    Wed    Thu    Fri    Sat                  │
├─────────────────────────────────────────────────────────────────┤
│   1      2      3      4      5      6      7                   │
│  gray   gray   gray   gray  [---]  [---]  [---]  <-- past days  │
├─────────────────────────────────────────────────────────────────┤
│   8      9     10     11     12     13     14                   │
│  avail  avail  [===CHECK-IN===]   -----   -----  <-- selected   │
├─────────────────────────────────────────────────────────────────┤
│  15     16     17     18     19     20     21                   │
│ -----  -----  -----  -----  [CHECK-OUT]   XXXX  <-- blocked     │
├─────────────────────────────────────────────────────────────────┤
│  22     23     24     25     26     27     28                   │
│  XXXX   XXXX  avail  avail  avail  avail  avail                 │
├─────────────────────────────────────────────────────────────────┤
│  29     30     31                                               │
│ avail  avail  avail                                             │
└─────────────────────────────────────────────────────────────────┘

Legend:
  gray   = Past date (not selectable)
  avail  = Available (selectable)
  XXXX   = Blocked/Booked (not selectable, strikethrough)
  -----  = In selected range (highlighted background)
  [===]  = Selected start/end (bold, filled)
```

### Calendar Selection State Machine

```
                    ┌───────────────────┐
                    │     IDLE          │
                    │  No dates selected│
                    └─────────┬─────────┘
                              │ Click available date
                              ▼
                    ┌───────────────────┐
                    │  START_SELECTED   │
                    │  Waiting for end  │
                    │  date selection   │
                    └─────────┬─────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
      Click before      Click after       Click same
      start date        start date        date
            │                 │                 │
            ▼                 ▼                 ▼
    ┌───────────┐      ┌────────────┐   ┌───────────┐
    │ Swap dates│      │ Validate:  │   │ Clear all │
    │ new start │      │ - Min stay │   │ back to   │
    │ = clicked │      │ - No blocks│   │ IDLE      │
    └─────┬─────┘      └──────┬─────┘   └───────────┘
          │                   │
          │           ┌───────┴───────┐
          │           │               │
          │      Valid range     Invalid
          │           │               │
          ▼           ▼               ▼
    ┌─────────────────────┐    ┌─────────────┐
    │   RANGE_SELECTED    │    │ Show toast  │
    │   Both dates set    │    │ error msg   │
    │   Calculate price   │    │ Stay in     │
    └─────────────────────┘    │ START state │
                               └─────────────┘
```

### Backend: Calendar Update with Split/Merge

```
BEFORE: Host has availability block [Dec 1 - Dec 31]

Host blocks [Dec 15 - Dec 20]
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  Step 1: Find overlapping blocks                        │
│  WHERE (start, end) OVERLAPS (Dec 15, Dec 20)           │
│  Found: [Dec 1 - Dec 31, status=available]              │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Step 2: Split the existing block                       │
│                                                         │
│  BEFORE: |=========== available ============|           │
│          Dec 1                          Dec 31          │
│                                                         │
│  INSERT: |=== avail ===|                                │
│          Dec 1      Dec 14                              │
│                                                         │
│  INSERT:                 |==== blocked ====|            │
│                         Dec 15          Dec 20          │
│                                                         │
│  INSERT:                                  |== avail ==| │
│                                          Dec 21    Dec 31│
│                                                         │
│  DELETE: Original [Dec 1 - Dec 31] block                │
└─────────────────────────────────────────────────────────┘

AFTER: Three separate blocks with correct statuses
```

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Date ranges (~200M rows) | 18x less storage | Complex split/merge logic |
| ❌ Day-by-day (3.65B rows) | Simple queries | Massive storage, slow inserts |

---

## ⭐ Deep Dive 4: Two-Sided Review System

### Review Visibility Timeline

```
Booking completed (checkout date passes)
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  14-DAY REVIEW WINDOW OPENS                                     │
│                                                                 │
│  ┌───────────────────────┐    ┌───────────────────────┐        │
│  │  GUEST VIEW           │    │  HOST VIEW            │        │
│  │  "How was your stay?" │    │  "How was your guest?"│        │
│  │                       │    │                       │        │
│  │  [*****] Overall     │    │  [*****] Overall     │        │
│  │  [*****] Cleanliness │    │                       │        │
│  │  [*****] Location    │    │  [Write review...]    │        │
│  │  [*****] Value       │    │                       │        │
│  │                       │    │                       │        │
│  │  [Write review...]    │    │                       │        │
│  │                       │    │                       │        │
│  │  [Submit Review]      │    │  [Submit Review]      │        │
│  └───────────────────────┘    └───────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
         │                               │
         ▼                               ▼
    Guest submits                   Host submits
    (is_public=false)               (is_public=false)
         │                               │
         └───────────────┬───────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  TRIGGER FIRES      │
              │  Check if both      │
              │  reviews exist      │
              └──────────┬──────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
         Both exist            Only one
              │                     │
              ▼                     ▼
    ┌─────────────────┐    ┌─────────────────┐
    │ UPDATE both to  │    │ Wait for other  │
    │ is_public=true  │    │ party to submit │
    └─────────────────┘    └─────────────────┘
              │
              ▼
    ┌─────────────────┐
    │ TRIGGER: Update │
    │ listing rating  │
    │ and review_count│
    └─────────────────┘
```

Two database triggers automate this: (1) ON INSERT into reviews, check if the other party already submitted -- if so, set both to `is_public=true`. (2) When `is_public` becomes true for a guest review, recalculate the listing's average rating and review count. Host reviews don't affect listing rating.

### Why Hidden-Until-Both?

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Hidden until both | Honest feedback, no gaming | Delay in visibility |
| ❌ Immediate visibility | Simple implementation | Retaliation reviews, gaming |

---

## 🗄️ State Management

Zustand stores for Auth (user session) and Search (location, dates, filters). Booking state is component-local. URL params are the source of truth for search:

```
User types ──▶ Debounce 300ms ──▶ Geocode ──▶ setSearchParams()
                                                    │
                                                    ▼
Update UI (Results + Map) ◀── Fetch listings ◀── useEffect on URL

Benefits: Shareable URLs, browser navigation works, single source of truth
```

---

## 💾 Caching Strategy

### Multi-Layer Cache

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: React Query (Browser)                              │
│  - queryKey: ['listing', id]  staleTime: 15 min             │
│  - On mutation: invalidateQueries(['availability'])          │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: Redis/Valkey                                       │
│  - listing:123 (15 min), availability:123 (1 min)           │
│  - On booking: DEL availability:listingId                    │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: PostgreSQL                                         │
│  - Source of truth, populates caches on read                │
└──────────────────────────────────────────────────────────────┘
```

Listing details cache 15 min (invalidated on review/update). Availability caches only 1 min with aggressive invalidation on booking or host calendar changes. Search results tolerate 5 min staleness.

---

## 📊 Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Calendar storage | ✅ Date ranges | ❌ Day-by-day | 18x fewer rows; backend handles split/merge |
| Geo search | ✅ PostGIS | ❌ Elasticsearch | Single DB simplifies stack; no sync complexity |
| Double-booking | ✅ Transaction lock | ❌ Distributed lock | Single DB; frontend handles 409 conflicts gracefully |
| Reviews | ✅ Hidden until both | ❌ Immediate | Prevents retaliation; trigger-based automation |
| Search state | ✅ URL params | ❌ Store only | Shareable URLs; browser nav works; deep linking |
| Session auth | ✅ Cookies | ❌ JWT | HttpOnly secure; automatic credential sending |

