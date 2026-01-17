# Design Airbnb - Architecture

## System Overview

Airbnb is a two-sided marketplace connecting hosts with guests. Core challenges involve availability management, geographic search, and trust systems.

**Learning Goals:**
- Design availability calendar systems
- Build geographic search with PostGIS
- Handle two-sided marketplace dynamics
- Implement trust and review systems

---

## Requirements

### Functional Requirements

1. **List**: Hosts create property listings
2. **Search**: Guests find properties by location/dates
3. **Book**: Reserve properties with payment
4. **Review**: Two-way rating system
5. **Message**: Host-guest communication

### Non-Functional Requirements

- **Availability**: 99.9% for search
- **Consistency**: Strong for bookings (no double-booking)
- **Latency**: < 200ms for search results
- **Scale**: 10M listings, 1M bookings/day

---

## High-Level Architecture

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

---

## Core Components

### 1. Availability Calendar

**Schema Options:**

**Option 1: Day-by-Day Rows**
```sql
CREATE TABLE calendar (
  listing_id INTEGER REFERENCES listings(id),
  date DATE,
  available BOOLEAN DEFAULT TRUE,
  price DECIMAL(10, 2),
  PRIMARY KEY (listing_id, date)
);
```
- Pros: Simple queries, easy updates
- Cons: Many rows (365 × listings)

**Option 2: Date Ranges (Chosen)**
```sql
CREATE TABLE availability_blocks (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20), -- 'available', 'blocked', 'booked'
  price_per_night DECIMAL(10, 2),
  booking_id INTEGER REFERENCES bookings(id)
);

CREATE INDEX idx_availability_listing_dates
ON availability_blocks(listing_id, start_date, end_date);
```
- Pros: Fewer rows, efficient range queries
- Cons: Complex overlap handling

**Checking Availability:**
```sql
-- Check if dates are available
SELECT COUNT(*) = 0 as is_available
FROM availability_blocks
WHERE listing_id = $1
  AND status != 'available'
  AND (start_date, end_date) OVERLAPS ($2, $3);
```

### 2. Geographic Search

**PostGIS for Location:**
```sql
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200),
  description TEXT,
  location GEOGRAPHY(POINT, 4326),
  price_per_night DECIMAL(10, 2),
  ...
);

CREATE INDEX idx_listings_location ON listings USING GIST(location);

-- Search within radius
SELECT *, ST_Distance(location, ST_MakePoint($lon, $lat)::geography) as distance
FROM listings
WHERE ST_DWithin(location, ST_MakePoint($lon, $lat)::geography, $radius_meters)
ORDER BY distance
LIMIT 20;
```

**Combined Search with Availability:**
```javascript
async function searchListings({ location, checkIn, checkOut, guests, priceMax }) {
  // Step 1: Geographic filter
  const nearbyIds = await db.raw(`
    SELECT id FROM listings
    WHERE ST_DWithin(location, ST_MakePoint(?, ?)::geography, 25000)
      AND max_guests >= ?
      AND price_per_night <= ?
  `, [location.lon, location.lat, guests, priceMax])

  // Step 2: Availability filter
  const availableIds = await db.raw(`
    SELECT listing_id FROM (
      SELECT listing_id
      FROM availability_blocks
      WHERE listing_id = ANY(?)
        AND status = 'available'
        AND start_date <= ? AND end_date >= ?
    ) available
    WHERE listing_id NOT IN (
      SELECT listing_id FROM availability_blocks
      WHERE status = 'booked'
        AND (start_date, end_date) OVERLAPS (?, ?)
    )
  `, [nearbyIds, checkIn, checkOut, checkIn, checkOut])

  // Step 3: Fetch and rank
  return rankListings(availableIds)
}
```

### 3. Booking Flow

**Preventing Double-Booking:**
```javascript
async function createBooking(listingId, guestId, checkIn, checkOut) {
  return await db.transaction(async (trx) => {
    // Lock the listing row
    await trx.raw('SELECT * FROM listings WHERE id = ? FOR UPDATE', [listingId])

    // Check availability again (within transaction)
    const conflicts = await trx('availability_blocks')
      .where('listing_id', listingId)
      .where('status', 'booked')
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)', [checkIn, checkOut])

    if (conflicts.length > 0) {
      throw new Error('Dates no longer available')
    }

    // Create booking
    const [booking] = await trx('bookings')
      .insert({ listing_id: listingId, guest_id: guestId, check_in: checkIn, check_out: checkOut })
      .returning('*')

    // Block the dates
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

### 4. Two-Sided Reviews

**Review Visibility Rules:**
```javascript
// Reviews hidden until both parties submit
async function getReviews(bookingId) {
  const reviews = await db('reviews').where({ booking_id: bookingId })

  const hostReview = reviews.find(r => r.author_type === 'host')
  const guestReview = reviews.find(r => r.author_type === 'guest')

  // Only show if both submitted
  if (hostReview && guestReview) {
    return { hostReview, guestReview }
  }

  // Otherwise, show nothing or placeholder
  return { pending: true }
}
```

---

## Database Schema

```sql
-- Listings
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  host_id INTEGER REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326),
  address JSONB,
  property_type VARCHAR(50),
  max_guests INTEGER,
  bedrooms INTEGER,
  beds INTEGER,
  bathrooms DECIMAL(2, 1),
  amenities TEXT[],
  price_per_night DECIMAL(10, 2),
  cleaning_fee DECIMAL(10, 2),
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  instant_book BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
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
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews (two-sided)
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  author_id INTEGER REFERENCES users(id),
  author_type VARCHAR(10), -- 'host' or 'guest'
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  content TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Date Ranges vs Day-by-Day

**Decision**: Store availability as date ranges

**Rationale**:
- Fewer rows in database
- Efficient overlap queries
- Easier to bulk update (block entire month)

### 2. PostGIS for Geographic Queries

**Decision**: Use PostgreSQL with PostGIS extension

**Rationale**:
- Native spatial indexing
- Efficient radius queries
- Keep data in single database

### 3. Optimistic Locking for Bookings

**Decision**: Use database transaction with row-level lock

**Rationale**:
- Prevents double-booking
- Simple implementation
- Acceptable contention at typical scale

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Calendar | Date ranges | Day-by-day | Storage efficiency |
| Geo search | PostGIS | Elasticsearch geo | Simplicity |
| Double-booking | Transaction lock | Distributed lock | Single DB is simpler |
| Reviews | Hidden until both submit | Immediate | Fairness |
