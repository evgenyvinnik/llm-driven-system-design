# System Design Interview: Airbnb - Property Rental Marketplace

## Opening Statement

"Today I'll design a property rental marketplace like Airbnb, which is a two-sided marketplace connecting hosts with guests. The core technical challenges are designing an efficient availability calendar system, building geographic search with PostGIS, preventing double-bookings under concurrent access, and implementing a trust system with two-sided reviews."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **List**: Hosts create property listings with photos, amenities, pricing
2. **Search**: Guests find properties by location, dates, and filters
3. **Book**: Reserve properties with secure payment
4. **Review**: Two-way rating system (host reviews guest, guest reviews host)
5. **Message**: Host-guest communication before and during booking

### Non-Functional Requirements

- **Availability**: 99.9% for search functionality
- **Consistency**: Strong consistency for bookings (absolutely no double-booking)
- **Latency**: < 200ms for search results
- **Scale**: 10 million listings, 1 million bookings per day

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Active Listings | 10M |
| Daily Bookings | 1M |
| Daily Searches | 50M |
| Average Stay | 3 nights |
| Peak Concurrent Users | 200K |

---

## Step 2: High-Level Architecture (7 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Layer                                 │
│        React + Search + Booking + Messaging                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
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
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │           Elasticsearch                       │
│   + PostGIS     │           - Search index                      │
│   - Listings    │           - Geo queries                       │
│   - Bookings    │           - Facets                            │
│   - Calendars   │                                               │
└─────────────────┴───────────────────────────────────────────────┘
```

### Why This Architecture?

**PostGIS for Geographic Data**: PostgreSQL with PostGIS extension provides native spatial indexing and efficient radius queries. It keeps location data alongside listings in one database.

**Search Service Separation**: Complex search with geo + availability + filters benefits from dedicated indexing. Elasticsearch handles this well.

**Single Booking Service**: All booking logic in one place ensures consistency and makes transaction handling simpler.

---

## Step 3: Availability Calendar Deep Dive (12 minutes)

This is one of the trickiest parts. Hosts have complex availability patterns.

### Schema Option Analysis

**Option 1: Day-by-Day Rows**
```sql
CREATE TABLE calendar (
  listing_id INTEGER,
  date DATE,
  available BOOLEAN DEFAULT TRUE,
  price DECIMAL(10, 2),
  PRIMARY KEY (listing_id, date)
);
```

- Pros: Simple queries, easy single-day updates
- Cons: 365 rows per listing per year = 3.65B rows for 10M listings

**Option 2: Date Ranges (Chosen)**
```sql
CREATE TABLE availability_blocks (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20), -- 'available', 'blocked', 'booked'
  price_per_night DECIMAL(10, 2),
  booking_id INTEGER REFERENCES bookings(id),
  CONSTRAINT valid_dates CHECK (end_date > start_date)
);

CREATE INDEX idx_availability_listing_dates
ON availability_blocks(listing_id, start_date, end_date);
```

- Pros: Far fewer rows, efficient range queries
- Cons: Complex overlap handling when updating

### Why Date Ranges?

For 10M listings with ~20 availability blocks each on average:
- Day-by-day: 3.65B rows
- Date ranges: 200M rows

That's an 18x reduction in storage and index size.

### Checking Availability

```sql
-- Check if dates are available (no conflicting blocks)
SELECT COUNT(*) = 0 as is_available
FROM availability_blocks
WHERE listing_id = $1
  AND status != 'available'
  AND (start_date, end_date) OVERLAPS ($2, $3);
```

### Complex Calendar Patterns

Hosts need to handle:
- **Blocked dates**: Personal use, maintenance
- **Custom pricing**: Weekends, holidays, seasons
- **Minimum stay**: 2-night minimum on weekends
- **Gap nights**: Fill 1-night gaps between bookings

```javascript
async function updateCalendar(listingId, changes) {
  // changes = { start: '2024-01-15', end: '2024-01-20', status: 'blocked' }

  await db.transaction(async (trx) => {
    // 1. Find overlapping existing blocks
    const overlaps = await trx('availability_blocks')
      .where('listing_id', listingId)
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)',
                [changes.start, changes.end])

    // 2. Split/merge overlapping blocks
    for (const block of overlaps) {
      if (block.start_date < changes.start) {
        // Keep the part before
        await trx('availability_blocks').insert({
          listing_id: listingId,
          start_date: block.start_date,
          end_date: changes.start,
          status: block.status,
          price_per_night: block.price_per_night
        })
      }
      if (block.end_date > changes.end) {
        // Keep the part after
        await trx('availability_blocks').insert({
          listing_id: listingId,
          start_date: changes.end,
          end_date: block.end_date,
          status: block.status,
          price_per_night: block.price_per_night
        })
      }
      // Delete original
      await trx('availability_blocks').where('id', block.id).delete()
    }

    // 3. Insert new block
    await trx('availability_blocks').insert({
      listing_id: listingId,
      start_date: changes.start,
      end_date: changes.end,
      status: changes.status,
      price_per_night: changes.price
    })
  })
}
```

---

## Step 4: Geographic Search Deep Dive (10 minutes)

### PostGIS Setup

```sql
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  host_id INTEGER REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326), -- Lat/Lng in standard GPS format
  address JSONB,
  property_type VARCHAR(50),
  max_guests INTEGER,
  bedrooms INTEGER,
  bathrooms DECIMAL(2, 1),
  amenities TEXT[],
  price_per_night DECIMAL(10, 2),
  rating DECIMAL(2, 1),
  instant_book BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Spatial index for fast geo queries
CREATE INDEX idx_listings_location ON listings USING GIST(location);
```

### Radius Search

```sql
-- Find listings within 25km of a point
SELECT *,
       ST_Distance(location, ST_MakePoint($lon, $lat)::geography) as distance
FROM listings
WHERE ST_DWithin(location, ST_MakePoint($lon, $lat)::geography, 25000)
ORDER BY distance
LIMIT 20;
```

### Combined Search: Location + Availability

This is the complex query that powers Airbnb search:

```javascript
async function searchListings({ location, checkIn, checkOut, guests, priceMax }) {
  // Step 1: Geographic filter (fast, uses spatial index)
  const nearbyListings = await db.raw(`
    SELECT id FROM listings
    WHERE ST_DWithin(location, ST_MakePoint(?, ?)::geography, 25000)
      AND max_guests >= ?
      AND price_per_night <= ?
  `, [location.lon, location.lat, guests, priceMax])

  const nearbyIds = nearbyListings.rows.map(r => r.id)

  if (nearbyIds.length === 0) return []

  // Step 2: Availability filter
  const availableListings = await db.raw(`
    SELECT DISTINCT listing_id
    FROM availability_blocks
    WHERE listing_id = ANY(?)
      AND status = 'available'
      AND start_date <= ? AND end_date >= ?
      AND listing_id NOT IN (
        SELECT listing_id FROM availability_blocks
        WHERE status = 'booked'
          AND (start_date, end_date) OVERLAPS (?, ?)
      )
  `, [nearbyIds, checkIn, checkOut, checkIn, checkOut])

  const availableIds = availableListings.rows.map(r => r.listing_id)

  // Step 3: Fetch full listing details and rank
  return await rankListings(availableIds, { location, checkIn, checkOut })
}
```

### Search Ranking Factors

```javascript
function calculateListingScore(listing, searchParams) {
  let score = 0

  // Distance (closer is better)
  score += 100 - (listing.distance / 1000) * 2 // km penalty

  // Rating (higher is better)
  score += listing.rating * 10

  // Review count (social proof)
  score += Math.log10(listing.review_count + 1) * 5

  // Price match (closer to budget is better)
  const priceDiff = Math.abs(listing.price - searchParams.avgBudget)
  score -= priceDiff * 0.1

  // Host response rate
  score += listing.host_response_rate * 5

  // Instant book bonus
  if (listing.instant_book) score += 10

  return score
}
```

---

## Step 5: Booking Flow - Preventing Double Booking (8 minutes)

This is critical. Double-booking destroys user trust.

### Booking with Database Transaction

```javascript
async function createBooking(listingId, guestId, checkIn, checkOut) {
  return await db.transaction(async (trx) => {
    // 1. Lock the listing row to prevent concurrent bookings
    await trx.raw(
      'SELECT * FROM listings WHERE id = ? FOR UPDATE',
      [listingId]
    )

    // 2. Double-check availability (within transaction)
    const conflicts = await trx('availability_blocks')
      .where('listing_id', listingId)
      .where('status', 'booked')
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)', [checkIn, checkOut])

    if (conflicts.length > 0) {
      throw new Error('Dates no longer available')
    }

    // 3. Create the booking
    const [booking] = await trx('bookings')
      .insert({
        listing_id: listingId,
        guest_id: guestId,
        check_in: checkIn,
        check_out: checkOut,
        status: 'pending'
      })
      .returning('*')

    // 4. Block the dates
    await trx('availability_blocks').insert({
      listing_id: listingId,
      start_date: checkIn,
      end_date: checkOut,
      status: 'booked',
      booking_id: booking.id
    })

    return booking
  })
}
```

### Why FOR UPDATE Lock?

When two users try to book the same dates simultaneously:

1. User A starts transaction, acquires lock
2. User B starts transaction, waits for lock
3. User A completes booking, releases lock
4. User B acquires lock, sees dates are now booked, fails gracefully

Without the lock, both might see "available" and try to insert, causing inconsistency.

### Instant Book vs Request to Book

**Instant Book**: Guest books immediately, host is notified
**Request**: Host must approve within 24 hours

```javascript
async function initiateBooking(listingId, guestId, dates) {
  const listing = await getListing(listingId)

  if (listing.instant_book) {
    // Create confirmed booking immediately
    const booking = await createBooking(listingId, guestId, dates)
    await processPayment(booking)
    await notifyHost(listing.host_id, booking)
    return { status: 'confirmed', booking }
  } else {
    // Create pending request
    const request = await createBookingRequest(listingId, guestId, dates)
    await notifyHost(listing.host_id, request)
    // Host has 24 hours to respond
    await scheduleExpiry(request.id, 24 * 60 * 60)
    return { status: 'pending', request }
  }
}
```

---

## Step 6: Two-Sided Reviews (5 minutes)

### The Hidden Review Pattern

Reviews are hidden until both parties submit, preventing retaliation.

```sql
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  author_id INTEGER REFERENCES users(id),
  author_type VARCHAR(10), -- 'host' or 'guest'
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  content TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(booking_id, author_type)
);
```

```javascript
async function getReviews(bookingId) {
  const reviews = await db('reviews').where({ booking_id: bookingId })

  const hostReview = reviews.find(r => r.author_type === 'host')
  const guestReview = reviews.find(r => r.author_type === 'guest')

  // Only reveal if both submitted
  if (hostReview && guestReview) {
    return { hostReview, guestReview, visible: true }
  }

  // Otherwise, show pending state
  return {
    hostSubmitted: !!hostReview,
    guestSubmitted: !!guestReview,
    visible: false,
    message: 'Reviews will be visible after both parties submit'
  }
}
```

### Why Hidden Until Both Submit?

- Prevents retaliation (guest gives 1-star, host sees it, gives 1-star back)
- Encourages honest feedback
- Industry best practice for two-sided marketplaces

---

## Step 7: Database Schema Summary (2 minutes)

```sql
-- Listings (with PostGIS)
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  host_id INTEGER REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  location GEOGRAPHY(POINT, 4326),
  address JSONB,
  property_type VARCHAR(50),
  max_guests INTEGER,
  bedrooms INTEGER,
  amenities TEXT[],
  price_per_night DECIMAL(10, 2),
  cleaning_fee DECIMAL(10, 2),
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  instant_book BOOLEAN DEFAULT FALSE
);

-- Availability blocks (date ranges)
CREATE TABLE availability_blocks (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20),
  price_per_night DECIMAL(10, 2),
  booking_id INTEGER REFERENCES bookings(id)
);

-- Bookings
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id),
  guest_id INTEGER REFERENCES users(id),
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  guests INTEGER,
  total_price DECIMAL(10, 2),
  status VARCHAR(20) DEFAULT 'pending'
);
```

---

## Step 8: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Calendar | Date ranges | Day-by-day | 18x storage reduction |
| Geo search | PostGIS | Elasticsearch | Keep data in single DB |
| Double-booking prevention | Transaction + row lock | Distributed lock | Simpler, PostgreSQL handles it |
| Reviews | Hidden until both | Immediate visibility | Fairness, prevents retaliation |

### PostGIS vs Elasticsearch for Geo

**Chose PostGIS because:**
- Listing data lives in PostgreSQL anyway
- Avoids syncing between two systems
- PostGIS is very efficient for radius queries
- Would use Elasticsearch if we needed complex full-text search on listing descriptions

---

## Closing Summary

I've designed a property rental marketplace with three core systems:

1. **Availability Calendar**: Date range-based storage with overlap handling, supporting complex patterns like custom pricing and minimum stays

2. **Geographic Search**: PostGIS-powered radius queries combined with availability filtering, ranked by distance, rating, and booking velocity

3. **Booking System**: Transaction-based double-booking prevention with row-level locking, supporting both instant book and request flows

**Key trade-offs:**
- Date ranges over day-by-day (efficiency vs. query complexity)
- PostGIS over dedicated geo database (simplicity vs. specialized features)
- Hidden reviews (fairness vs. faster feedback loop)

**What would I add with more time?**
- Dynamic pricing based on demand
- Smart pricing suggestions for hosts
- Fraud detection for suspicious bookings
