# Design Airbnb - Architecture

## System Overview

Airbnb is a two-sided marketplace connecting hosts who have properties with guests looking for accommodation. The core engineering challenges involve availability calendar management, geographic search with real-time filtering, double-booking prevention under concurrency, a trust system with two-sided reviews, and payment orchestration across multiple parties.

**Learning Goals:**
- Design availability calendar systems with efficient date-range storage
- Build geographic search with PostGIS and faceted filtering
- Handle concurrent booking attempts with double-booking prevention
- Implement two-sided marketplace dynamics (host + guest personas)
- Build trust and review systems with mutual-reveal semantics
- Design payment escrow and payout workflows

---

## Requirements

### Functional Requirements

1. **List**: Hosts create property listings with photos, amenities, pricing, and availability calendars
2. **Search**: Guests find properties by location, dates, price range, property type, amenities, and guest count
3. **Book**: Reserve properties with instant-book or request-to-book, preventing double-booking
4. **Pay**: Process payments with escrow model -- hold guest payment, release to host after checkout
5. **Review**: Two-sided review system where reviews are hidden until both parties submit
6. **Message**: Host-guest communication linked to listings and bookings
7. **Calendar**: Hosts manage availability with blocked dates, custom pricing, and minimum-stay rules

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| **Availability** | 99.99% for search, 99.9% for bookings |
| **Consistency** | Strong for bookings (no double-booking), eventual for search index |
| **Search Latency** | p50 < 100ms, p99 < 300ms |
| **Booking Latency** | p50 < 500ms, p99 < 2s (includes payment hold) |
| **Scale** | 10M active listings, 1M bookings/day, 50M searches/day |
| **Durability** | Zero lost bookings or payments |

---

# Layer 1: Production-Ready Architecture

This section describes how Airbnb would work at scale with millions of users, thousands of requests per second, and multi-region deployment.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Client Layer                                        │
│           React SPA / iOS / Android  ──  CDN (CloudFront/Fastly)                │
└──────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           API Gateway / Load Balancer                             │
│               Rate limiting, auth, request routing, TLS termination              │
└──────────────────────────────────────────────────────────────────────────────────┘
         │              │              │              │              │
         ▼              ▼              ▼              ▼              ▼
┌──────────────┐ ┌─────────────┐ ┌──────────────┐ ┌─────────────┐ ┌──────────────┐
│  Listing     │ │  Search     │ │  Booking     │ │  Payment    │ │  Messaging   │
│  Service     │ │  Service    │ │  Service     │ │  Service    │ │  Service     │
│              │ │             │ │              │ │             │ │              │
│ - CRUD       │ │ - Geo query │ │ - Reserve    │ │ - Escrow    │ │ - Threads    │
│ - Calendar   │ │ - Facets    │ │ - Lock/check │ │ - Payout    │ │ - Real-time  │
│ - Photos     │ │ - Ranking   │ │ - Cancel     │ │ - Refund    │ │ - Unread     │
│ - Pricing    │ │ - Suggest   │ │ - Complete   │ │ - Ledger    │ │   count      │
└──────┬───────┘ └──────┬──────┘ └──────┬───────┘ └──────┬──────┘ └──────┬───────┘
       │                │               │                │               │
       ▼                ▼               ▼                ▼               ▼
┌──────────────┐ ┌─────────────┐ ┌──────────────────────────────┐ ┌──────────────┐
│  PostgreSQL  │ │Elasticsearch│ │        PostgreSQL             │ │  PostgreSQL  │
│  + PostGIS   │ │   Cluster   │ │   (Bookings + Payments)      │ │  (Messages)  │
│  (Listings)  │ │             │ │   Strong consistency          │ │              │
└──────────────┘ └─────────────┘ └──────────────────────────────┘ └──────────────┘
       │                ▲               │                │
       │                │               ▼                ▼
       │         ┌──────┴──────┐  ┌──────────┐    ┌──────────┐
       │         │  CDC / Sync │  │  Redis    │    │  Stripe  │
       │         │  Pipeline   │  │  (Cache)  │    │  (Ext.)  │
       │         └─────────────┘  └──────────┘    └──────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Review Service                                │
│  - Two-sided reviews, trust scoring, rating aggregation         │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Queue (Kafka)                         │
│  booking.created │ booking.confirmed │ availability.changed     │
│  review.submitted │ payment.completed │ host.alert              │
└─────────────────────────────────────────────────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌──────────────┐ ┌─────────────┐ ┌──────────────┐
│ Notification │ │  Analytics  │ │  Search      │
│ Worker       │ │  Worker     │ │  Indexer     │
│ (email/push) │ │ (ClickHouse)│ │  (ES sync)   │
└──────────────┘ └─────────────┘ └──────────────┘
```

## Core Components

### 1. Search Service (Elasticsearch + PostGIS)

At production scale, search cannot rely solely on PostgreSQL. Elasticsearch provides the combination of geo queries, full-text search, faceted filtering, and sub-100ms latency that a marketplace search requires.

**Search Pipeline:**
1. Client sends search query with location, dates, guests, price range, amenities, property type
2. API Gateway routes to Search Service
3. Search Service queries Elasticsearch with a compound query combining:
   - **Geo filter**: `geo_distance` query within the map viewport or radius
   - **Date availability filter**: Check against an availability bitmap or inverted index
   - **Faceted filters**: Price range, property type, room type, amenities (terms aggregation)
   - **Full-text**: Match against listing title and description for keyword searches
   - **Scoring**: Custom function_score combining distance, rating, review count, response rate, and recency

**Availability in Search:**
The hardest part of Airbnb search is filtering by date availability. Two approaches:

| Approach | Pros | Cons |
|----------|------|------|
| **Query-time join** (ES query + PG availability check) | Always fresh | Slow at scale -- two hops per search |
| **Pre-computed availability bitmap in ES** | Fast single-hop query | Requires real-time sync; stale by seconds |

At production scale, use the bitmap approach: each listing document in Elasticsearch contains a 365-day availability bitmap updated via CDC (Change Data Capture) from PostgreSQL. When a booking is created or cancelled, the booking service publishes an `availability.changed` event, and the Search Indexer worker updates the ES document within seconds.

**Ranking Algorithm:**
Listings are scored using a weighted combination:
- Distance to search center (inverse, weight 0.3)
- Rating and review count (Bayesian average to avoid new-listing disadvantage, weight 0.25)
- Price competitiveness within the area (weight 0.15)
- Host response rate and superhost status (weight 0.15)
- Recency boost for new listings (weight 0.1)
- Conversion rate from search impressions (weight 0.05)

### 2. Booking Service (Distributed Transaction)

The booking flow is the most consistency-critical path in the system. A double-booking means two guests show up to the same property -- a trust-destroying event.

**Booking Flow (Instant Book):**

```
Guest clicks "Reserve"
        │
        ▼
┌───────────────────┐
│ 1. Availability   │  SELECT ... FOR UPDATE on listing row
│    Check + Lock   │  Check availability_blocks for conflicts
└────────┬──────────┘
         │ available
         ▼
┌───────────────────┐
│ 2. Payment Hold   │  Stripe PaymentIntent with capture_method=manual
│    (Authorize)    │  Hold the full amount on guest's card
└────────┬──────────┘
         │ authorized
         ▼
┌───────────────────┐
│ 3. Create Booking │  INSERT booking + availability_block
│    + Block Dates  │  within same DB transaction
└────────┬──────────┘
         │ committed
         ▼
┌───────────────────┐
│ 4. Confirm Hold   │  Update PaymentIntent status
│    + Notify       │  Publish booking.created event
└───────────────────┘
```

**Double-Booking Prevention:**
The system uses pessimistic locking via `SELECT ... FOR UPDATE` on the listing row. This serializes concurrent booking attempts for the same listing. Within the transaction:
1. Lock the listing row (prevents other transactions from proceeding)
2. Check `availability_blocks` for date conflicts using PostgreSQL `OVERLAPS` operator
3. If available, insert the booking and the corresponding `booked` availability block
4. Commit the transaction (releases the lock)

If two guests try to book overlapping dates simultaneously, the second transaction waits for the first to commit, then finds the dates are no longer available and returns an error.

**Why pessimistic over optimistic locking:** For high-demand listings (flash sales, popular destinations during holidays), optimistic locking would cause high retry rates. With pessimistic locking, the second request waits briefly (typically < 100ms) rather than doing all the work only to fail at commit time. The trade-off is reduced throughput for the same listing, but bookings for different listings proceed in parallel, and a single listing rarely receives more than a few concurrent booking attempts.

**Request-to-Book Flow:**
For non-instant-book listings, the flow differs: step 2 (payment hold) is deferred until the host confirms. The booking is created in `pending` status, and the host has 24 hours to confirm or decline. If declined, the blocked dates are released.

### 3. Calendar / Availability System

**Storage Strategy -- Date Ranges vs Day-by-Day:**

| Approach | Row Count (10M listings) | Pros | Cons |
|----------|--------------------------|------|------|
| Day-by-day | 3.65B rows (365 x 10M) | Simple queries | Massive table, slow updates |
| Date ranges | ~200M rows | 18x fewer rows, efficient range queries | Complex overlap/split logic |

The date-range approach stores availability as `(listing_id, start_date, end_date, status)` tuples. When a host blocks specific dates within an existing range, the system splits the range: delete the overlapping block, insert up to three new blocks (before, blocked, after).

**Pricing Rules:**
The `availability_blocks` table supports custom `price_per_night` that overrides the listing default. This enables:
- **Seasonal pricing**: Higher rates during holidays, events, peak season
- **Weekend pricing**: Different rates for Friday-Sunday
- **Length-of-stay discounts**: Calculated at booking time from listing rules
- **Smart pricing** (production): ML model that adjusts prices based on demand, comparable listings, events, and seasonality

**Minimum/Maximum Stay:**
Enforced at booking time. The listing stores `minimum_nights` and `maximum_nights`. The booking service validates the requested stay duration before proceeding.

### 4. Payment Service (Escrow Model)

Airbnb operates as an escrow intermediary -- the guest pays Airbnb, and Airbnb pays the host after checkout. This protects both parties.

**Payment Lifecycle:**

```
Guest books  ──▶  Payment authorized (hold on card)
                          │
                  Host confirms (or instant)
                          │
                          ▼
              Payment captured (Airbnb holds funds)
                          │
                  Guest checks out
                          │
                          ▼
              Payout to host (minus service fee)
              ┌─────────────────────────────┐
              │ Host receives:              │
              │   subtotal + cleaning_fee   │
              │   - host_service_fee (3%)   │
              │                             │
              │ Airbnb retains:             │
              │   guest_service_fee (~14%)  │
              │   + host_service_fee (3%)   │
              └─────────────────────────────┘
```

**Refund Handling:**
Refund amount depends on `cancellation_policy`:
- **Flexible**: Full refund if cancelled 24h+ before check-in
- **Moderate**: Full refund if cancelled 5 days+ before check-in; 50% after
- **Strict**: 50% refund if cancelled 7 days+ before check-in; none after

**Idempotency:**
Every payment operation uses an idempotency key (booking ID + operation type) to prevent duplicate charges. If a network failure occurs mid-payment, the client retries with the same key and Stripe returns the existing PaymentIntent.

**Ledger:**
A double-entry ledger tracks every money movement. Each booking creates entries:
- Guest account: debit (payment captured)
- Airbnb escrow: credit (funds held)
- Host account: credit (payout released)
- Airbnb revenue: credit (service fees retained)

### 5. Review Service (Two-Sided with Mutual Reveal)

**Review Window:**
After checkout, both host and guest have 14 days to submit reviews. After 14 days, any submitted review becomes public even if the other party hasn't responded.

**Mutual Reveal:**
Reviews are hidden (`is_public = FALSE`) until both parties submit. This prevents retaliation -- neither party can read the other's review before writing their own. Once both submit, a database trigger sets `is_public = TRUE` on both reviews simultaneously.

**Trust Scoring:**
At production scale, reviews feed into a trust score that affects:
- Search ranking (higher-rated listings rank higher)
- Superhost eligibility (4.8+ rating, 90%+ response rate, 10+ stays/year)
- Guest trust (hosts see guest review history before accepting requests)

**Rating Aggregation:**
Listing ratings are denormalized onto the `listings` table for fast reads. A PostgreSQL trigger recalculates the average rating and review count whenever a guest review becomes public. Sub-ratings (cleanliness, communication, location, value) are aggregated separately for the listing detail page.

### 6. Media Pipeline (Photo Upload + CDN)

**Upload Flow:**
1. Client requests a pre-signed S3 upload URL from the Listing Service
2. Client uploads directly to S3 (bypasses API server bandwidth)
3. S3 triggers a Lambda/worker to:
   - Validate image (format, size, content moderation)
   - Generate thumbnails (150px, 300px, 600px, 1200px)
   - Convert to WebP for modern browsers
   - Store metadata in PostgreSQL (`listing_photos` table)
4. CDN serves optimized images with cache headers

**At production scale:**
- CloudFront/Fastly CDN with edge caching
- Responsive images with `srcset` for different screen sizes
- Lazy loading for below-fold images
- BlurHash placeholders during load

### 7. Messaging Service

**Host-Guest Communication:**
Conversations are linked to listings and optionally to bookings. Messages support:
- Pre-booking inquiries (guest asks host questions before booking)
- Booking-linked threads (created automatically when a booking is made)
- Unread count tracking per user

**At production scale:**
- WebSocket connections for real-time message delivery
- Redis Pub/Sub for multi-instance message broadcasting
- Push notifications for mobile (APNs/FCM)
- Message persistence in PostgreSQL with read receipts
- Rate limiting to prevent spam (10 messages/minute per user)

### 8. Smart Pricing (Production Feature)

At scale, Airbnb offers hosts a "Smart Pricing" feature that automatically adjusts nightly rates based on:
- Local demand (search volume for the area + dates)
- Comparable listings (similar properties, their pricing and occupancy)
- Seasonality and day-of-week patterns
- Local events (conferences, concerts, sports)
- Listing-specific conversion data (views to bookings ratio)

The pricing model runs as a batch ML pipeline, updating suggested prices daily. Hosts can set a minimum and maximum bound, and the system adjusts within that range.

---

## Database Schema

### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                        AIRBNB DATABASE ER DIAGRAM                                               │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────────┐
                                    │     users       │
                                    ├─────────────────┤
                                    │ PK id           │
                                    │    email        │
                                    │    password_hash│
                                    │    name         │
                                    │    is_host      │
                                    │    is_verified  │
                                    │    role         │
                                    │    response_rate│
                                    └────────┬────────┘
                                             │
             ┌───────────────────────────────┼───────────────────────────────┐
             │                               │                               │
             │ host_id                       │ guest_id                      │ user_id
             ▼                               ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐             ┌─────────────────┐
    │    listings     │             │   bookings      │             │   sessions      │
    ├─────────────────┤             ├─────────────────┤             ├─────────────────┤
    │ PK id           │◄────────────│ FK listing_id   │             │ PK id           │
    │ FK host_id      │             │ FK guest_id     │             │ FK user_id      │
    │    title        │             │    check_in     │             │    data (JSONB) │
    │    location     │             │    check_out    │             │    expires_at   │
    │    property_type│             │    total_price  │             └─────────────────┘
    │    room_type    │             │    status       │
    │    price/night  │             │    nights       │
    │    rating       │             └────────┬────────┘
    │    review_count │                      │
    └────────┬────────┘                      │
             │                               │
    ┌────────┼────────┐                      │
    │        │        │                      │
    ▼        ▼        ▼                      ▼
┌──────────┐ ┌────────────────────┐    ┌─────────────────┐
│listing_  │ │availability_blocks │    │    reviews      │
│photos    │ ├────────────────────┤    ├─────────────────┤
├──────────┤ │ PK id              │    │ PK id           │
│ PK id    │ │ FK listing_id      │    │ FK booking_id   │
│ FK list_ │ │ FK booking_id ─────┼────│ FK author_id    │
│   ing_id │ │    start_date      │    │    author_type  │
│    url   │ │    end_date        │    │    rating       │
│    order │ │    status          │    │    is_public    │
└──────────┘ │    price/night     │    └─────────────────┘
             └────────────────────┘

                    ┌─────────────────┐
                    │  conversations  │
                    ├─────────────────┤
                    │ PK id           │
                    │ FK listing_id   │────▶ listings
                    │ FK booking_id   │────▶ bookings
                    │ FK host_id      │────▶ users (host)
                    │ FK guest_id     │────▶ users (guest)
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    messages     │
                    ├─────────────────┤
                    │ PK id           │
                    │ FK conversation_│
                    │    id           │
                    │ FK sender_id    │────▶ users
                    │    content      │
                    │    is_read      │
                    └─────────────────┘

                    ┌─────────────────┐
                    │   audit_logs    │
                    ├─────────────────┤
                    │ PK id           │
                    │ FK user_id      │────▶ users (optional)
                    │    event_type   │
                    │    resource_type│
                    │    resource_id  │
                    │    action       │
                    │    before_state │
                    │    after_state  │
                    └─────────────────┘
```

### Full SQL Schema

The complete schema is located at `backend/src/db/init.sql`. Key tables:

```sql
-- PostGIS extension for geographic queries
CREATE EXTENSION IF NOT EXISTS postgis;

-- Users (both guests and hosts in a single table)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  phone VARCHAR(20),
  is_host BOOLEAN DEFAULT FALSE,
  is_verified BOOLEAN DEFAULT FALSE,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  response_rate DECIMAL(3, 2) DEFAULT 1.00,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Listings with PostGIS geography for spatial queries
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  host_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326),
  address_line1 VARCHAR(255),
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100),
  property_type VARCHAR(50) CHECK (property_type IN (
    'apartment', 'house', 'room', 'studio', 'villa', 'cabin', 'cottage', 'loft'
  )),
  room_type VARCHAR(50) CHECK (room_type IN (
    'entire_place', 'private_room', 'shared_room'
  )),
  max_guests INTEGER NOT NULL DEFAULT 1,
  bedrooms INTEGER DEFAULT 0,
  beds INTEGER DEFAULT 0,
  bathrooms DECIMAL(2, 1) DEFAULT 1,
  amenities TEXT[] DEFAULT '{}',
  price_per_night DECIMAL(10, 2) NOT NULL,
  cleaning_fee DECIMAL(10, 2) DEFAULT 0,
  service_fee_percent DECIMAL(4, 2) DEFAULT 10.00,
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  instant_book BOOLEAN DEFAULT FALSE,
  minimum_nights INTEGER DEFAULT 1,
  maximum_nights INTEGER DEFAULT 365,
  cancellation_policy VARCHAR(50) DEFAULT 'flexible'
    CHECK (cancellation_policy IN ('flexible', 'moderate', 'strict')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Spatial index for geographic queries
CREATE INDEX idx_listings_location ON listings USING GIST(location);
CREATE INDEX idx_listings_host ON listings(host_id);
CREATE INDEX idx_listings_price ON listings(price_per_night);

-- Date-range availability (18x fewer rows than day-by-day)
CREATE TABLE availability_blocks (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('available', 'blocked', 'booked')),
  price_per_night DECIMAL(10, 2),
  booking_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_dates CHECK (end_date > start_date)
);

CREATE INDEX idx_availability_listing_dates
  ON availability_blocks(listing_id, start_date, end_date);

-- Bookings with full price capture
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  guest_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  guests INTEGER NOT NULL DEFAULT 1,
  nights INTEGER NOT NULL,
  price_per_night DECIMAL(10, 2) NOT NULL,
  cleaning_fee DECIMAL(10, 2) DEFAULT 0,
  service_fee DECIMAL(10, 2) DEFAULT 0,
  total_price DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
    'pending', 'confirmed', 'cancelled', 'completed', 'declined'
  )),
  guest_message TEXT,
  host_response TEXT,
  cancelled_by VARCHAR(10) CHECK (cancelled_by IN ('guest', 'host', NULL)),
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_booking_dates CHECK (check_out > check_in)
);

-- Two-sided reviews with mutual-reveal trigger
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_type VARCHAR(10) NOT NULL CHECK (author_type IN ('host', 'guest')),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  cleanliness_rating INTEGER CHECK (cleanliness_rating >= 1 AND cleanliness_rating <= 5),
  communication_rating INTEGER CHECK (communication_rating >= 1 AND communication_rating <= 5),
  location_rating INTEGER CHECK (location_rating >= 1 AND location_rating <= 5),
  value_rating INTEGER CHECK (value_rating >= 1 AND value_rating <= 5),
  content TEXT,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(booking_id, author_type)
);

-- Conversations and messages
CREATE TABLE conversations (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  host_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  guest_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit trail for compliance and dispute resolution
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id INTEGER,
  action VARCHAR(50) NOT NULL,
  outcome VARCHAR(20) NOT NULL DEFAULT 'success',
  ip_address VARCHAR(45),
  user_agent TEXT,
  session_id VARCHAR(255),
  request_id VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Key Triggers:**
- `check_and_publish_reviews()` -- Sets `is_public = TRUE` on both reviews when both host and guest have submitted for a booking
- `update_listing_rating()` -- Recalculates listing `rating` and `review_count` when a guest review becomes public
- `update_updated_at_column()` -- Auto-updates `updated_at` on row modification for users, listings, bookings, conversations

---

## API Design

### Listing Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/listings` | Create a new listing (host only) |
| GET | `/api/listings` | List active listings (paginated) |
| GET | `/api/listings/:id` | Get listing detail with photos and reviews |
| PUT | `/api/listings/:id` | Update listing (host owner only) |
| DELETE | `/api/listings/:id` | Delete listing (host owner only) |
| POST | `/api/listings/:id/photos` | Upload photos (up to 10, multipart) |
| DELETE | `/api/listings/:id/photos/:photoId` | Delete a photo |
| GET | `/api/listings/:id/availability` | Get availability calendar |
| PUT | `/api/listings/:id/availability` | Block/unblock dates with split logic |
| GET | `/api/listings/host/my-listings` | Get authenticated host's listings |

### Search Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search` | Search with geo, dates, price, amenities, property type |
| GET | `/api/search/suggest` | Location autocomplete (city/state/country ILIKE) |
| GET | `/api/search/popular-destinations` | Top 10 destinations by listing count |

### Booking Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bookings/check-availability` | Check dates + return pricing |
| POST | `/api/bookings` | Create booking (with double-booking prevention) |
| GET | `/api/bookings/:id` | Get booking detail |
| GET | `/api/bookings/my-trips` | Guest's bookings |
| GET | `/api/bookings/host-reservations` | Host's incoming reservations |
| PUT | `/api/bookings/:id/respond` | Host confirm/decline pending booking |
| PUT | `/api/bookings/:id/cancel` | Cancel booking (guest or host) |
| PUT | `/api/bookings/:id/complete` | Mark booking as completed (host, after checkout) |

### Review Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/reviews` | Submit review for completed booking |
| GET | `/api/reviews/listing/:listingId` | Get listing reviews with rating stats |
| GET | `/api/reviews/user/:userId` | Get reviews about a user |
| GET | `/api/reviews/booking/:bookingId/status` | Check who has reviewed |

### Messaging Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/messages/start` | Create or get existing conversation |
| GET | `/api/messages` | List user's conversations with last message |
| GET | `/api/messages/unread/count` | Get unread message count |
| GET | `/api/messages/:id` | Get conversation with messages (marks as read) |
| POST | `/api/messages/:id/messages` | Send a message |

### Auth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login (returns session cookie) |
| POST | `/api/auth/logout` | Logout (clears session) |
| GET | `/api/auth/me` | Get current user |
| PUT | `/api/auth/become-host` | Upgrade user to host status |

---

## Key Design Decisions

### 1. Date Ranges vs Day-by-Day Availability

**Chosen: Date Ranges**

With 10M listings and 365 days, day-by-day storage creates 3.65 billion rows. Date-range storage reduces this to approximately 200M rows (an 18x reduction). PostgreSQL's `OVERLAPS` operator handles range queries efficiently, and the composite index on `(listing_id, start_date, end_date)` makes lookups fast.

The trade-off is complexity: when a host blocks days 5-8 within an existing available range of days 1-15, the system must split the range into three blocks (1-5 available, 5-8 blocked, 8-15 available). This split/merge logic runs within a transaction to maintain consistency. The complexity is manageable and the storage/query savings justify it.

### 2. PostGIS vs Elasticsearch for Primary Geo Search

**Chosen for production: Elasticsearch (with PostGIS as source of truth)**

PostGIS is excellent for precise geographic queries, but at 50M searches/day with faceted filtering (price + amenities + dates + location), a single PostgreSQL instance cannot sustain the query load without extensive read replicas. Elasticsearch handles this workload natively with its inverted index, geo_distance queries, and aggregation framework.

PostGIS remains the source of truth for listing location data. A CDC pipeline syncs listing changes to Elasticsearch. For the local implementation, PostGIS handles everything in a single database, which is a reasonable simplification.

### 3. Pessimistic vs Optimistic Locking for Bookings

**Chosen: Pessimistic Locking (SELECT ... FOR UPDATE)**

For bookings, correctness is more important than throughput. A double-booking is a catastrophic failure that damages trust. Pessimistic locking serializes concurrent booking attempts for the same listing, which is acceptable because:
- A single listing rarely gets more than 2-3 concurrent booking attempts
- The lock is held only during the transaction (typically < 100ms)
- Different listings are locked independently (no global bottleneck)

Optimistic locking (version numbers) would let all attempts proceed in parallel but fail at commit time. For a booking that involves a payment hold, failing after the payment is authorized creates complexity around voiding the authorization. Pessimistic locking fails before any external calls.

### 4. Mutual-Reveal Reviews vs Immediate Publication

**Chosen: Mutual Reveal**

Reviews are hidden until both parties submit. This prevents retaliation: if a guest knows the host gave them 2 stars, they might leave a retaliatory 1-star review. The mutual-reveal pattern encourages honest feedback because neither party can condition their review on what the other wrote.

The trade-off is that some reviews never become public (if one party doesn't submit). The 14-day window with automatic publication after expiry mitigates this -- at least the review that was submitted becomes visible.

---

## Consistency and Idempotency

### Booking Idempotency

The booking creation endpoint uses the combination of `(listing_id, guest_id, check_in, check_out)` as a natural idempotency key. The `availability_blocks` table with a `booking_id` foreign key ensures that each booking corresponds to exactly one blocked date range.

At production scale with payment integration, each booking attempt would carry an explicit idempotency key (UUID generated client-side). The payment service uses this key for the Stripe PaymentIntent, ensuring that network retries don't create duplicate charges.

### Availability Consistency

Availability changes propagate through multiple systems:
1. **Database**: Source of truth, updated within the booking transaction
2. **Cache**: Redis cache invalidated immediately after booking
3. **Search Index**: Updated asynchronously via message queue (eventual consistency, typically < 5 seconds)

This means a search might show a listing as available for a few seconds after it's been booked. The availability check at booking time catches this -- the guest sees "dates no longer available" if they try to book. This is an acceptable trade-off for search performance.

---

## Security / Auth

**Authentication:** Session-based with Redis-backed session store. Session IDs stored in HTTP-only cookies. PostgreSQL `sessions` table provides persistent backup.

**Authorization Layers:**
- `authenticate` middleware: Validates session cookie, attaches user to request
- `optionalAuth` middleware: Attaches user if session exists, continues regardless
- `requireHost` middleware: Requires `is_host = TRUE` for listing management
- `requireAdmin` middleware: Requires `role = 'admin'` for admin operations

**Sensitive Field Redaction:** Pino logger redacts `password`, `token`, `authorization`, and `cookie` fields from log output.

**At production scale:**
- Rate limiting per IP and per user (express-rate-limit or API Gateway)
- CSRF protection for state-changing endpoints
- Input validation and SQL injection prevention (parameterized queries throughout)
- Content Security Policy headers
- OAuth2 integration for social login (Google, Facebook, Apple)

---

## Observability

### Metrics (Prometheus via prom-client)

The system exposes a `/metrics` endpoint with these metric families:

**HTTP Metrics:**
- `airbnb_http_request_duration_seconds` -- Histogram by method, route, status
- `airbnb_http_requests_total` -- Counter by method, route, status

**Business Metrics:**
- `airbnb_search_latency_seconds` -- Histogram with labels: has_dates, has_location, result_count_bucket
- `airbnb_searches_total` -- Counter with labels: has_dates, has_location
- `airbnb_bookings_total` -- Counter by status, instant_book
- `airbnb_booking_latency_seconds` -- Histogram by instant_book
- `airbnb_booking_revenue_total` -- Counter in cents by property_type, city
- `airbnb_booking_nights_total` -- Counter by property_type
- `airbnb_availability_checks_total` -- Counter by available (true/false)
- `airbnb_availability_check_latency_seconds` -- Histogram

**Infrastructure Metrics:**
- `airbnb_cache_hits_total` / `airbnb_cache_misses_total` -- Counter by cache_type
- `airbnb_cache_hit_ratio` -- Gauge by cache_type
- `airbnb_queue_depth` -- Gauge by queue_name
- `airbnb_queue_messages_published_total` / `airbnb_queue_messages_consumed_total` -- Counter
- `airbnb_circuit_breaker_state` -- Gauge (0=closed, 1=open, 2=half-open) by service
- `airbnb_db_query_duration_seconds` -- Histogram by operation, table

### Structured Logging (Pino)

All logs are structured JSON with:
- Request correlation IDs (`x-request-id` header, propagated through all log entries)
- Module-scoped child loggers (`createModuleLogger('bookings')`)
- Sensitive field redaction (passwords, tokens, cookies)
- Performance warnings for slow operations (> 1 second)
- Business event logging and security event logging

### Health Checks

- `GET /health` -- Comprehensive check of PostgreSQL, Redis, RabbitMQ, and circuit breakers
- `GET /ready` -- Kubernetes readiness probe (database connectivity)
- `GET /live` -- Kubernetes liveness probe (process alive)
- `GET /debug/circuit-breakers` -- Circuit breaker state inspection

---

## Failure Handling

### Circuit Breakers (Opossum)

The system uses circuit breakers to prevent cascading failures:

| Circuit Breaker | Timeout | Error Threshold | Reset Timeout | Fallback |
|-----------------|---------|-----------------|---------------|----------|
| **Search** | 5s | 60% | 20s | Return empty results |
| **Availability** | 3s | 40% | 15s | Assume unavailable (safe default) |
| **Database** | 10s | 50% | 30s | No fallback (fail) |
| **Notification** | 15s | 70% | 60s | Queue for later |

The search circuit breaker is the most tolerant because search can gracefully degrade -- showing fewer results is better than showing an error page. The availability circuit breaker is stricter because falsely showing availability could lead to booking failures.

### Queue Resilience (RabbitMQ)

- **Dead-letter queues**: Messages that fail processing 3 times are routed to DLQ for manual inspection
- **Idempotent consumers**: Each message has a unique `eventId`, and consumers track processed IDs in Redis (7-day TTL) to prevent duplicate processing
- **Exponential backoff**: Failed message processing retries with delay: 5s, 10s, 20s (capped at 60s)
- **Non-blocking publishing**: Booking creation succeeds even if queue publishing fails (logged as warning)

### Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` by:
1. Stopping acceptance of new connections
2. Closing RabbitMQ connection
3. Closing Redis connection
4. Exiting process

---

## Scalability Considerations

### What Breaks First

| Component | Bottleneck | Solution |
|-----------|-----------|----------|
| **Search** | Single PostgreSQL can't handle 50M queries/day | Elasticsearch cluster with read replicas |
| **Booking writes** | Hot listings under high demand | Pessimistic locking limits throughput per listing; acceptable since bookings are per-listing |
| **Photo storage** | Disk space and bandwidth | S3 + CDN; direct upload bypasses API servers |
| **Availability sync** | Stale search results after booking | CDC pipeline with < 5s latency |
| **Message volume** | Large conversation tables | Partition messages by conversation_id; archive old messages |

### Horizontal Scaling Path

1. **API servers**: Stateless, scale horizontally behind load balancer (already supports running on ports 3001-3003)
2. **PostgreSQL**: Read replicas for search/listing reads, primary for writes. Consider partitioning listings by region at extreme scale
3. **Redis**: Redis Cluster for session distribution across instances
4. **Elasticsearch**: Multi-shard index with replicas per availability zone
5. **Workers**: Scale consumer count per queue independently

### Database Sharding Strategy (Extreme Scale)

At 100M+ listings, shard by geographic region:
- **Listings**: Shard by country/region (searches are always geo-scoped)
- **Bookings**: Shard by listing_id (co-locate with listing data)
- **Users**: Keep in a single database or shard by user_id hash
- **Messages**: Shard by conversation_id

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Availability storage | Date ranges | Day-by-day rows | 18x fewer rows; overlap queries efficient with OVERLAPS |
| Search engine | Elasticsearch (prod) / PostGIS (local) | PostGIS only | ES handles faceted geo search at scale; PostGIS sufficient locally |
| Booking concurrency | Pessimistic locking (FOR UPDATE) | Optimistic locking (version) | Correctness over throughput; prevents payment hold on doomed bookings |
| Review visibility | Mutual reveal | Immediate publish | Prevents retaliation; encourages honest reviews |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler token management |
| Message queue | Kafka (prod) / RabbitMQ (local) | Direct calls | Decouples services; enables retry and dead-letter handling |
| Photo upload | Pre-signed S3 URL (prod) / multer disk (local) | Proxy through API | Avoids API server bandwidth bottleneck |
| Calendar pricing | Override per date range | Separate pricing table | Fewer joins; price_per_night on availability_blocks is simple |
| Auth | Session-based | OAuth2/JWT | Simpler for learning; easy revocation via Redis |

---

# Layer 2: Pocket-Size Architecture (What We Actually Built)

This section documents the actual local implementation -- what runs on `localhost` with Docker Compose.

## Local Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│           Frontend (React + Vite + TanStack Router)  │
│                  localhost:5173                       │
│                                                       │
│  Routes: / (home), /search, /listing/:id,            │
│  /booking/:id, /trips, /messages, /login, /register, │
│  /host/listings, /host/reservations, /become-host,   │
│  /host/listings/new                                   │
└───────────────────────┬──────────────────────────────┘
                        │ HTTP (fetch)
                        ▼
┌──────────────────────────────────────────────────────┐
│        Backend (Express, single monolith)             │
│              localhost:3000                            │
│                                                       │
│  Routes: /api/auth, /api/listings, /api/search,      │
│          /api/bookings, /api/reviews, /api/messages   │
│  Shared: cache, metrics, logger, queue, audit,       │
│          circuitBreaker                               │
│  Workers: booking, notification, analytics            │
│  Endpoints: /health, /ready, /live, /metrics          │
└──┬──────────────┬────────────────┬───────────────────┘
   │              │                │
   ▼              ▼                ▼
┌──────────┐ ┌──────────┐  ┌─────────────┐
│PostgreSQL│ │  Valkey   │  │  RabbitMQ   │
│+ PostGIS │ │  (Redis)  │  │             │
│ :5432    │ │  :6379    │  │ :5672/:15672│
└──────────┘ └──────────┘  └─────────────┘
```

## What Actually Exists

### Backend (Node.js + Express + TypeScript)

A single Express monolith with route-based separation (not separate microservices):

- **Auth routes** (`src/routes/auth.ts`): Register, login, logout, session management with Redis-backed sessions and PostgreSQL backup
- **Listing routes** (`src/routes/listings.ts`): Full CRUD, photo upload via multer to local disk, availability calendar with overlap-aware split/merge logic, cache-aside pattern for listing detail
- **Search routes** (`src/routes/search.ts`): PostGIS `ST_DWithin` geo queries with faceted filtering (price, property type, room type, amenities, guest count, bedrooms, beds, bathrooms), availability date filtering via OVERLAPS, sort by relevance/price/rating/distance, circuit breaker wrapping, search result caching
- **Booking routes** (`src/routes/bookings.ts`): Double-booking prevention via `SELECT ... FOR UPDATE` + availability OVERLAPS check within transaction, instant-book vs request-to-book, host confirm/decline, cancellation with date release, booking completion
- **Review routes** (`src/routes/reviews.ts`): Two-sided review creation for completed bookings, review status checking, listing and user review queries
- **Message routes** (`src/routes/messages.ts`): Conversation creation/retrieval, message sending, unread count, automatic read marking

**Shared modules** (`src/shared/`):
- `cache.ts` -- Redis cache-aside pattern with TTL-based invalidation for listings (15m), availability (1m), search (5m)
- `metrics.ts` -- Full Prometheus metric suite (HTTP, business, cache, queue, circuit breaker, database metrics)
- `logger.ts` -- Pino structured JSON logging with request IDs, module scoping, field redaction
- `circuitBreaker.ts` -- Opossum circuit breakers for search, availability, database, notifications
- `queue.ts` -- RabbitMQ with topic exchange, dead-letter queues, idempotent consumers
- `audit.ts` -- Comprehensive audit logging to PostgreSQL with before/after state capture

**Workers** (`src/workers/`):
- `booking-worker.ts` -- Processes booking lifecycle events (created, confirmed, cancelled, completed)
- `notification-worker.ts` -- Handles notification delivery
- `analytics-worker.ts` -- Processes analytics events

### Frontend (React + TypeScript + Vite + TanStack Router + Tailwind CSS)

- **Home page** (`routes/index.tsx`): Featured listings grid
- **Search page** (`routes/search.tsx`): Search with filter bar (location, dates, guests, price, amenities)
- **Listing detail** (`routes/listing.$id.tsx`): Photo gallery, booking widget, reviews, host info
- **Booking detail** (`routes/booking.$id.tsx`): Booking confirmation/status page
- **Guest trips** (`routes/trips.tsx`): Guest's booking history
- **Messaging** (`routes/messages.tsx`): Conversation list and message thread
- **Host dashboard** (`routes/host/listings.tsx`, `routes/host/reservations.tsx`): Manage listings and incoming reservations
- **Create listing** (`routes/host/listings.new.tsx`): Multi-step listing creation form with progress indicator
- **Become host** (`routes/become-host.tsx`): Host onboarding page
- **Auth** (`routes/login.tsx`, `routes/register.tsx`): Login and registration forms

**State management**: Zustand for auth state (`stores/authStore.ts`) and search state (`stores/searchStore.ts`)

### Infrastructure (Docker Compose)

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| PostgreSQL | `postgis/postgis:16-3.4` | 5432 | Primary database with PostGIS extension |
| Valkey | `valkey/valkey:7-alpine` | 6379 | Session cache, listing/search cache, idempotency tracking |
| RabbitMQ | `rabbitmq:3-management` | 5672/15672 | Event queue with management UI |

## Production-Grade Patterns Actually Implemented

1. **Double-booking prevention** -- `SELECT ... FOR UPDATE` pessimistic locking within a PostgreSQL transaction, followed by OVERLAPS conflict check and atomic booking + availability block insertion. This is the same pattern used in production. See `src/routes/bookings.ts`.

2. **Cache-aside with targeted invalidation** -- Listings, availability, and search results are cached in Redis with TTL. When a booking is created, both the availability cache for that listing and all search result caches are invalidated. See `src/shared/cache.ts`.

3. **Circuit breakers (Opossum)** -- Search queries are wrapped in a circuit breaker that returns empty results when the database is overloaded. Availability checks fail-safe (assume unavailable). Each breaker tracks state via Prometheus metrics. See `src/shared/circuitBreaker.ts`.

4. **Prometheus metrics (prom-client)** -- Full metric suite covering HTTP latency, search performance, booking counts/revenue, cache hit ratios, queue depths, and circuit breaker states. Scrapeable at `/metrics`. See `src/shared/metrics.ts`.

5. **Structured logging (Pino)** -- JSON logs with request correlation IDs, module-scoped loggers, automatic sensitive field redaction, performance warnings for slow queries. See `src/shared/logger.ts`.

6. **Async event processing (RabbitMQ)** -- Booking events are published to a topic exchange and consumed by background workers for analytics, notifications, and search reindexing. Dead-letter queues capture failed messages. Idempotent consumers prevent duplicate processing via Redis-tracked event IDs. See `src/shared/queue.ts` and `src/workers/`.

7. **Audit trail** -- Every booking and listing operation is logged to the `audit_logs` table with before/after state, IP address, user agent, and request ID for distributed tracing correlation. See `src/shared/audit.ts`.

8. **Health checks** -- Three-tier health checking: `/health` (comprehensive with PostgreSQL + Redis + RabbitMQ + circuit breakers), `/ready` (database connectivity for Kubernetes readiness), `/live` (process liveness). See `src/index.ts`.

9. **Graceful shutdown** -- Signal handlers for SIGTERM/SIGINT that close RabbitMQ and Redis connections before exiting. See `src/index.ts`.

10. **Availability split/merge logic** -- When a host blocks dates that overlap existing availability blocks, the system correctly splits ranges (handles before/after portions) within a transaction. See `src/routes/listings.ts`.

## What Was Simplified or Substituted

| Production | Local Implementation |
|------------|---------------------|
| Elasticsearch for search | PostGIS queries directly on PostgreSQL |
| S3 + CDN for photos | multer disk storage at `./uploads/listings/` |
| Stripe payment integration | No payment processing; price calculated but not charged |
| OAuth2 / social login | Session-based auth with bcrypt passwords |
| WebSocket messaging | HTTP polling (no real-time push) |
| Multi-service architecture | Single Express monolith with route separation |
| Kafka for event streaming | RabbitMQ (simpler setup, sufficient for local) |
| Pre-signed upload URLs | Direct multipart upload through API server |
| Image optimization pipeline | Raw image storage, no thumbnails or format conversion |

## What Was Omitted

- **CDN**: No content delivery network; static files served directly from Vite dev server and Express
- **Multi-region deployment**: Single instance, no geo-routing or cross-region replication
- **Kubernetes**: No container orchestration; runs directly with `tsx watch`
- **Database sharding**: Single PostgreSQL instance handles everything
- **Smart pricing ML pipeline**: No dynamic pricing; hosts set flat rates with optional per-range overrides
- **Full-text search**: Location search uses `ILIKE` pattern matching, not full-text indexing
- **Content moderation**: No image or text moderation pipeline
- **Push notifications**: No mobile push; workers log events but don't send real notifications
- **Rate limiting**: No request rate limiting middleware
- **Review window expiration**: No 14-day auto-publish for single-sided reviews
- **Payment ledger**: No double-entry bookkeeping or financial reconciliation
- **Admin dashboard**: Auth middleware exists (`requireAdmin`) but no admin UI
