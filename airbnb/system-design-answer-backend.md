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

Results are ranked by a weighted score combining distance to search center (highest weight), rating and review count (quality signal), price match to budget, and instant-book availability (conversion bonus).

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

Within the transaction: (1) BEGIN, (2) SELECT listing FOR UPDATE to acquire the row lock, (3) check availability_blocks for overlapping booked ranges, (4) ROLLBACK if conflicts exist, (5) INSERT booking, (6) INSERT availability_block as 'booked', (7) COMMIT.

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

Two database triggers handle atomicity: (1) after each review insert, check if both author types exist for the booking — if so, set `is_public = TRUE` for both; (2) after a review becomes public, recalculate the listing's denormalized average rating and review count. The review window opens at checkout and closes after 14 days. Reviews become public when both parties submit or the window closes, whichever comes first.

---

## 📦 Caching and Async Processing

### Caching Strategy

Three-tier cache: CDN (images, static assets), Valkey/Redis (listing details, availability, sessions), PostgreSQL as source of truth. We use cache-aside: check Valkey first, fall back to DB, populate cache on miss.

**Cache invalidation:** On listing update, delete `listing:{id}` and nearby search result keys (keyed by geohash). On booking, delete `availability:{listing_id}` and publish event.

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Listing details | 15 min | Changes infrequently |
| Availability | 1 min | Must be fresh to prevent conflicts |
| Search results | 5 min | Slightly stale acceptable |
| User sessions | 24 hours | Long-lived authentication |

### Async Events via RabbitMQ

Non-critical work (notifications, search reindexing, analytics) is handled asynchronously through a topic exchange with routing keys like `booking.created`, `listing.updated`, `review.submitted`. Dedicated workers consume each queue.

Each message carries a unique `eventId`. Workers implement idempotent consumption: check Redis for `processed:{eventId}` before processing, set it with 7-day TTL after success. Failed messages retry up to 3 times before routing to a dead-letter queue for manual investigation.

## 📊 Observability

Key SLIs: search availability (99.9% target), search p95 latency (<200ms), booking p95 confirmation (<1s), and double-booking rate (must be 0%). We track `http_request_duration_seconds`, `bookings_total`, `search_latency_seconds`, and `cache_hit_ratio` via Prometheus histograms and counters.

Distributed tracing (OpenTelemetry) spans each booking request from API Gateway through Booking Service to PostgreSQL and Valkey, with async spans into notification workers. Each span captures operation name, duration, entity IDs, and status.

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

Key next steps: Elasticsearch for full-text search on listing descriptions, ML-based dynamic pricing, multi-region deployment with read replicas and geo-routing, Kafka migration for higher-throughput event streaming, and Stripe/Adyen payment integration with PCI compliance.
