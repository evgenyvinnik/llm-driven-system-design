# Airbnb - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Problem Statement

Design the backend infrastructure for a property rental marketplace like Airbnb.

**Key Backend Challenges:**
- Geographic search with spatial indexing
- Availability calendar with efficient date-range storage
- Double-booking prevention under concurrent access
- Two-sided review system with hidden-until-both-submit semantics

---

## 🎯 Requirements Clarification

### Functional Requirements
| Feature | Description |
|---------|-------------|
| Listings | Hosts create properties with photos, amenities, pricing |
| Search | Geographic + availability + filter-based discovery |
| Booking | Reservations with double-booking prevention |
| Reviews | Two-sided ratings (host and guest) |
| Messaging | Host-guest communication |

### Non-Functional Requirements
| Requirement | Target |
|-------------|--------|
| Availability | 99.9% for search |
| Consistency | Strong for bookings (no double-booking) |
| Latency | < 200ms for search results |
| Scale | 10M listings, 1M bookings/day |

### Scale Estimates
- Active Listings: 10M
- Daily Bookings: 1M
- Daily Searches: 50M
- Average Stay: 3 nights
- Peak Concurrent Users: 200K

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway / Load Balancer                   │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Listing Service│    │Booking Service│    │ Search Service│
│               │    │               │    │               │
│ - CRUD        │    │ - Reserve     │    │ - Geo search  │
│ - Calendar    │    │ - Payment     │    │ - Availability│
│ - Pricing     │    │ - Cancellation│    │ - Ranking     │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────────┬────────────────┬──────────────────────────────┤
│   PostgreSQL    │     Valkey     │        RabbitMQ              │
│   + PostGIS     │   (Cache)      │   (Async Events)             │
└─────────────────┴────────────────┴──────────────────────────────┘
```

---

## 📅 Deep Dive: Availability Calendar Storage

### The Storage Problem

10M listings with 365 days/year creates massive storage requirements:

| Approach | Calculation | Total Rows |
|----------|-------------|------------|
| Day-by-day | 10M × 365 days | 3.65 billion |
| Date ranges | 10M × ~20 blocks | 200 million |

**Result:** Date ranges provide **18x storage reduction**

### Date Range Storage Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    availability_blocks table                     │
├─────────────────────────────────────────────────────────────────┤
│ id | listing_id | start_date | end_date | status | price | booking_id │
├────┼────────────┼────────────┼──────────┼────────┼───────┼────────────┤
│ 1  │ 42         │ 2025-06-01 │ 2025-06-15│available│ $150 │ NULL      │
│ 2  │ 42         │ 2025-06-15 │ 2025-06-20│ booked │ $150 │ 789       │
│ 3  │ 42         │ 2025-06-20 │ 2025-07-01│available│ $175 │ NULL      │
│ 4  │ 42         │ 2025-07-04 │ 2025-07-08│ blocked│ NULL │ NULL      │
└─────────────────────────────────────────────────────────────────┘
```

**Status values:** available, blocked, booked

### Availability Check Logic

```
Query: Are dates Jun 16-18 available for listing 42?

Check: Any blocks with status != 'available'
       WHERE (start_date, end_date) OVERLAPS (Jun 16, Jun 18)?

Result: Block #2 (Jun 15-20, booked) overlaps → NOT AVAILABLE
```

### Calendar Update with Overlap Handling

When host updates availability, existing blocks may overlap:

```
Before: [───── available Jun 1-30 ─────]

Host blocks Jun 10-15:

After:  [avail Jun 1-10][blocked Jun 10-15][avail Jun 15-30]

Steps:
1. Find overlapping blocks → Original Jun 1-30 block
2. Split before → Create Jun 1-10 available block
3. Split after → Create Jun 15-30 available block
4. Delete original → Remove Jun 1-30 block
5. Insert new → Create Jun 10-15 blocked block
```

All operations run in a single database transaction.

### Storage Alternatives

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Date ranges | 18x less storage, efficient range queries | Complex split/merge logic | ✅ Chosen |
| Day-by-day rows | Simple updates | 3.65B rows, slow queries | ❌ Rejected |
| Bitmap per month | Compact for dense data | Complex for custom pricing | ❌ Rejected |

---

## 🌍 Deep Dive: Geographic Search with PostGIS

### PostGIS Spatial Data

Each listing stores location as a GEOGRAPHY point (latitude/longitude in WGS84 coordinate system).

```
┌─────────────────────────────────────────────────────────────────┐
│                       listings table                             │
├─────────────────────────────────────────────────────────────────┤
│ id | host_id | title | location (GEOGRAPHY) | amenities | price │
├────┼─────────┼───────┼──────────────────────┼───────────┼───────┤
│ 42 │ 101     │ Cozy..│ POINT(-122.4, 37.8) │ [wifi,...]│ $150  │
└─────────────────────────────────────────────────────────────────┘

Index: GIST spatial index on location column
```

### Radius Search Query Flow

```
User searches: "San Francisco, 25km radius"

┌─────────────┐     ┌─────────────────────────────────┐
│ Search API  │────▶│ PostGIS: ST_DWithin(location,   │
│             │     │   search_center, 25000 meters)  │
└─────────────┘     └─────────────────────────────────┘
                                    │
                                    ▼
                    Uses GIST index for O(log n) lookup
                    Returns listings within 25km circle
```

### Combined Search Pipeline

```
Step 1: Geographic Filter (fast, uses spatial index)
        ┌───────────────────────────────────────┐
        │ 10M listings → 500 within 25km radius │
        └───────────────────────────────────────┘
                          │
                          ▼
Step 2: Attribute Filter (guests, price, amenities)
        ┌───────────────────────────────────────┐
        │ 500 listings → 200 match filters      │
        └───────────────────────────────────────┘
                          │
                          ▼
Step 3: Availability Filter (exclude booked dates)
        ┌───────────────────────────────────────┐
        │ 200 listings → 150 available          │
        └───────────────────────────────────────┘
                          │
                          ▼
Step 4: Rank and Paginate
        ┌───────────────────────────────────────┐
        │ 150 listings → Top 20 by score        │
        └───────────────────────────────────────┘
```

### Search Ranking Factors

| Factor | Weight | Rationale |
|--------|--------|-----------|
| Distance to search center | High | Relevance to location |
| Rating (average stars) | Medium | Quality signal |
| Review count | Medium | Social proof |
| Price match to budget | Medium | Affordability |
| Host response rate | Low | Service quality |
| Instant book enabled | Bonus | Conversion optimization |

### Geo Search Alternatives

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| PostGIS | Single DB, GIST index, accurate distance | Limited to PostgreSQL | ✅ Chosen |
| Elasticsearch geo | Full-text + geo, facets | Sync complexity | ❌ Rejected |
| Geohash grid | Simple, cache-friendly | Less accurate at edges | ❌ Rejected |

---

## 🔒 Deep Dive: Double-Booking Prevention

### The Concurrency Problem

Two users try to book the same dates simultaneously:

```
Without Protection:

User A ──▶ Check availability ──▶ Available! ──▶ Create booking ──▶ ✓
User B ──▶ Check availability ──▶ Available! ──▶ Create booking ──▶ ✓

Result: BOTH bookings succeed! Double-booking occurs.
```

### Solution: Transaction with Row-Level Lock

```
With FOR UPDATE Lock:

User A ─┬─▶ BEGIN TRANSACTION
        │   Lock listing row (FOR UPDATE)
        │   Check availability → Available
        │   Create booking
        │   Insert availability block
        │   COMMIT
        │
User B ─┼─▶ BEGIN TRANSACTION
        │   Try to lock listing row → WAITS...
        │                              │
        ◀──────────────────────────────┘
        │   Lock acquired
        │   Check availability → BOOKED (User A's block exists)
        │   ROLLBACK with "Dates no longer available" error
```

### Booking Creation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Booking Service                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. BEGIN TRANSACTION                                            │
│     │                                                            │
│  2. SELECT * FROM listings WHERE id = ? FOR UPDATE               │
│     │  (Acquire exclusive row lock)                              │
│     │                                                            │
│  3. Check availability_blocks for conflicts                      │
│     │  WHERE status = 'booked'                                   │
│     │  AND (start_date, end_date) OVERLAPS (check_in, check_out) │
│     │                                                            │
│  4. IF conflicts exist → ROLLBACK with error                     │
│     │                                                            │
│  5. INSERT INTO bookings (listing_id, guest_id, dates, status)   │
│     │                                                            │
│  6. INSERT INTO availability_blocks (listing_id, dates, 'booked')│
│     │                                                            │
│  7. COMMIT                                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Instant Book vs Request to Book

```
┌───────────────────────────────────────────────────────────────────┐
│                    Booking Initiation                             │
└───────────────────────────────────────────────────────────────────┘
                          │
         ┌────────────────┴────────────────┐
         ▼                                 ▼
┌─────────────────────┐         ┌─────────────────────┐
│ Instant Book = TRUE │         │ Instant Book = FALSE│
├─────────────────────┤         ├─────────────────────┤
│ Create confirmed    │         │ Create pending      │
│ booking immediately │         │ booking request     │
│                     │         │                     │
│ Process payment     │         │ Notify host         │
│                     │         │                     │
│ Publish event:      │         │ Schedule 24h expiry │
│ booking.created     │         │                     │
│                     │         │ Host approves →     │
│ Guest confirmed     │         │ Process booking     │
└─────────────────────┘         └─────────────────────┘
```

### Lock Strategy Alternatives

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Row-level lock (FOR UPDATE) | Simple, single DB | Blocks concurrent readers | ✅ Chosen |
| Distributed lock (Redis) | Scales beyond single DB | Additional complexity | ❌ Rejected |
| Optimistic locking (version) | No blocking | Retry storms under contention | ❌ Rejected |

---

## ⭐ Deep Dive: Two-Sided Review System

### The Trust Problem

Reviews need protection against retaliation:
- If guest sees bad host review first, they may leave retaliatory bad review
- Solution: Hide reviews until BOTH parties submit

### Review Data Model

```
┌─────────────────────────────────────────────────────────────────┐
│                       reviews table                              │
├─────────────────────────────────────────────────────────────────┤
│ id | booking_id | author_type | rating | sub_ratings | is_public │
├────┼────────────┼─────────────┼────────┼─────────────┼───────────┤
│ 1  │ 789        │ guest       │ 4      │ {clean:5,..}│ FALSE     │
│ 2  │ 789        │ host        │ 5      │ {comm:5,..} │ FALSE     │
└─────────────────────────────────────────────────────────────────┘

Sub-ratings: cleanliness, communication, location, value (guest)
             communication, cleanliness, house_rules (host)
```

### Hidden Until Both Submit Flow

```
Timeline for booking #789:

Day 1: Checkout complete
       │
Day 5: Guest submits review (rating: 4 stars)
       └─▶ is_public = FALSE (host hasn't reviewed yet)
       └─▶ API returns: "Review submitted. Visible after host reviews."
       │
Day 8: Host submits review (rating: 5 stars)
       └─▶ Database trigger fires:
           - Count reviews for booking #789 = 2 (both types)
           - UPDATE reviews SET is_public = TRUE WHERE booking_id = 789
       └─▶ Both reviews now visible to everyone
       │
       └─▶ Rating aggregation trigger:
           - Recalculate listing average rating
           - Update listing.rating and listing.review_count
```

### Database Triggers

```
Trigger 1: check_and_publish_reviews
├── Fires: AFTER INSERT on reviews
├── Logic: IF COUNT(DISTINCT author_type) = 2 for booking
│          THEN SET is_public = TRUE for both reviews
└── Purpose: Atomically reveal both reviews together

Trigger 2: update_listing_rating
├── Fires: AFTER UPDATE of is_public on reviews
├── Logic: IF is_public = TRUE AND author_type = 'guest'
│          THEN recalculate listing.rating as AVG(all public guest ratings)
│          AND update listing.review_count
└── Purpose: Keep denormalized rating accurate
```

### Review Window Rules

| Rule | Duration | Action |
|------|----------|--------|
| Review window opens | Checkout date | Both can submit |
| Review window closes | 14 days after checkout | No more reviews allowed |
| Public visibility | When both submit OR window closes | Whichever comes first |
| Rating counts | Only public guest reviews | Host rating separate |

---

## 💾 Deep Dive: Caching Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CDN (CloudFront)                         │
│     Static assets, listing images, search result pages          │
│     TTL: 1 hour for images, 5 min for search pages              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Valkey/Redis Cluster                       │
│     Session cache, listing details, availability snapshots      │
│     TTL: 15 min listing, 1 min availability, 24h sessions       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PostgreSQL + PostGIS                           │
│                 Source of truth for all data                     │
└─────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern

```
Get Listing Details:

┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────▶│ Listing API  │────▶│   Valkey    │
└─────────────┘     └──────────────┘     └─────────────┘
                           │                    │
                           │  Cache hit? ◀──────┤
                           │      │             │
                    Yes ◀──┤      │ No          │
                           │      │             │
                           │      ▼             │
                           │ ┌─────────────┐    │
                           │ │ PostgreSQL  │    │
                           │ └─────────────┘    │
                           │      │             │
                           │      │ Set cache ──▶
                           │      │ (TTL: 15min)│
                           │      │             │
                           ▼      ▼             │
                    Return listing data         │
```

### Cache Invalidation Strategy

```
On Listing Update:
├── Delete listing:{id} from cache
├── Compute geohash of listing location (4-char precision)
└── Delete search:{geohash}:* keys (invalidate nearby search results)

On Booking Created:
├── Delete availability:{listing_id} from cache
└── Publish booking:created event (notify other services)
```

### TTL Strategy by Data Type

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Listing details | 15 min | Property details change infrequently |
| Availability | 1 min | Must be fresh to prevent conflicts |
| Search results | 5 min | Slightly stale is acceptable |
| User sessions | 24 hours | Long-lived authentication |
| Rate limit counters | 1 min | Fraud detection windows |

---

## 📨 Deep Dive: Async Processing with RabbitMQ

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       API Services                               │
│            Listing / Booking / Search / Review                   │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                     RabbitMQ Exchange                            │
│                    (Topic Exchange)                              │
├─────────────────┬─────────────────┬─────────────────────────────┤
│ booking.created │ listing.updated │ notification.send            │
│ booking.cancel  │ review.submitted│ search.reindex               │
└─────────────────┴─────────────────┴─────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Notification  │    │ Search Index  │    │  Analytics    │
│   Worker      │    │   Worker      │    │   Worker      │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Event Message Structure

```
{
  eventId: "uuid-12345",
  eventType: "booking.created",
  timestamp: "2025-06-15T10:30:00Z",
  data: {
    bookingId: 789,
    listingId: 42,
    guestId: 101,
    checkIn: "2025-07-01",
    checkOut: "2025-07-05"
  }
}
```

### Idempotent Consumer Pattern

```
Worker receives message:

1. Extract eventId from message
        │
2. Check Redis: processed:{eventId} exists?
        │
   ┌────┴────┐
   │         │
  Yes       No
   │         │
   ▼         ▼
 ACK msg   Process message
(skip)          │
                ▼
           Set Redis key: processed:{eventId} = 1
           (TTL: 7 days)
                │
                ▼
           ACK message
```

### Retry and Dead Letter Queue

```
Message Processing:

Attempt 1 → Fails → Increment retry count in header
                    │
Attempt 2 → Fails → Increment retry count
                    │
Attempt 3 → Fails → Retry count = 3 (max reached)
                    │
                    ▼
           Route to Dead Letter Queue (DLQ)
           For manual investigation
```

---

## 📊 Deep Dive: Observability

### Key Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| http_request_duration_seconds | Histogram | method, route, status | Latency SLI |
| bookings_total | Counter | status, instant_book | Business metric |
| search_latency_seconds | Histogram | has_dates, has_guests | Search SLI |
| cache_hit_ratio | Gauge | cache_type | Cache efficiency |

### SLI/SLO Definitions

| SLI | Definition | SLO Target | Alert Threshold |
|-----|------------|------------|-----------------|
| Availability | Successful requests / Total | 99.9% | < 99.5% for 5 min |
| Search Latency | p95 response time | < 200ms | > 500ms for 5 min |
| Booking Latency | p95 confirmation time | < 1s | > 2s for 5 min |
| Double-Booking Rate | Conflicting bookings / Total | 0% | > 0 in 1 hour |
| Cache Hit Rate | Cache hits / Total requests | > 80% | < 60% for 15 min |

### Distributed Tracing Flow

```
Create Booking Request:

[API Gateway] ──span──▶ [Booking Service] ──span──▶ [PostgreSQL]
      │                        │
      │                        └──span──▶ [Valkey Cache]
      │
      └──span──▶ [Notification Worker] ──span──▶ [Email Service]

Each span captures:
- Operation name (createBooking, db.query, cache.set)
- Duration
- Attributes (booking_id, listing_id, guest_id)
- Status (success/error)
```

---

## 📈 Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Calendar storage | ✅ Date ranges | ❌ Day-by-day | 18x storage reduction |
| Geo search | ✅ PostGIS | ❌ Elasticsearch | Single database, no sync |
| Double-booking prevention | ✅ Row lock | ❌ Distributed lock | Simpler with single DB |
| Review visibility | ✅ Hidden until both | ❌ Immediate | Prevents retaliation |
| Cache pattern | ✅ Cache-aside | ❌ Write-through | Simpler invalidation |
| Message queue | ✅ RabbitMQ | ❌ Kafka | Sufficient for booking scale |
| Tracing | ✅ OpenTelemetry | ❌ Zipkin | Vendor-neutral ecosystem |

---

## 🚀 Future Enhancements

| Enhancement | Benefit |
|-------------|---------|
| Elasticsearch integration | Full-text search on descriptions |
| Dynamic pricing | ML-based demand-responsive pricing |
| Multi-region deployment | Read replicas with geo-routing |
| Kafka for events | Higher throughput event streaming |
| Payment integration | Stripe/Adyen with PCI compliance |
| Fraud detection | ML model for suspicious patterns |
