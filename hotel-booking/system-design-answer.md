# Hotel Booking System - System Design Interview Answer

## Opening Statement

"Today I'll design a hotel booking system like Booking.com or Expedia. The core challenges are handling inventory management with high concurrency, preventing double bookings, implementing dynamic pricing, and providing fast search across millions of properties while maintaining strong consistency for reservations."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Hotel and room inventory** - Hotels list their properties with room types and availability
2. **Search and filtering** - Users search by location, dates, guests, with filters (price, amenities, rating)
3. **Booking system** - Reserve rooms with payment processing
4. **Pricing and availability** - Real-time pricing, dynamic based on demand
5. **Booking management** - View, modify, cancel bookings
6. **Reviews and ratings** - User reviews for hotels
7. **Notifications** - Booking confirmations, reminders

### Non-Functional Requirements

- **Availability**: 99.99% - bookings are revenue-critical
- **Consistency**: Strong consistency for bookings (no double booking)
- **Latency**: Search < 500ms, booking confirmation < 2s
- **Scale**: 1M+ hotels, 100M searches/day, 1M bookings/day

### Out of Scope

- Flight bundling
- Loyalty program deep dive
- Hotel management portal (mention briefly)

---

## Step 2: Scale Estimation (2-3 minutes)

**Inventory:**
- 1 million hotels
- Average 50 room types per hotel = 50M room types
- 365 days of availability = 18B date-room combinations

**Traffic:**
- 100 million searches per day = 1,150 QPS (peak 3x = 3,500 QPS)
- 1 million bookings per day = 12 bookings/second (peak = 50/second)
- Read-heavy: 100:1 search to booking ratio

**Storage:**
- Hotel metadata: 1M * 10KB = 10 GB
- Availability data: 18B * 100 bytes = 1.8 TB
- Booking records: 365M/year * 1KB = 365 GB/year

**Key insight**: Search is the hot path (read-heavy), but bookings require strong consistency and careful concurrency control.

---

## Step 3: High-Level Architecture (10 minutes)

```
                                 ┌───────────────────────────────────┐
                                 │         Mobile/Web Clients        │
                                 └───────────────────┬───────────────┘
                                                     │
                                                     ▼
                                 ┌───────────────────────────────────┐
                                 │            API Gateway            │
                                 │   (Rate limiting, Auth, Routing)  │
                                 └───────────────────┬───────────────┘
                                                     │
                    ┌────────────────────────────────┼────────────────────────────────┐
                    │                                │                                │
          ┌─────────▼─────────┐           ┌─────────▼─────────┐           ┌─────────▼─────────┐
          │   Search Service  │           │  Booking Service  │           │   User Service    │
          │                   │           │                   │           │                   │
          │ - Query parsing   │           │ - Reservation     │           │ - Auth/Profile    │
          │ - Availability    │           │ - Payment         │           │ - History         │
          │ - Ranking         │           │ - Confirmation    │           │ - Preferences     │
          └─────────┬─────────┘           └─────────┬─────────┘           └───────────────────┘
                    │                               │
                    │                               │
    ┌───────────────┴───────────────┐               │
    │               │               │               │
┌───▼────┐    ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
│Elastic │    │  Redis    │   │ PostgreSQL│   │  Payment  │
│search  │    │  Cache    │   │  (Primary)│   │  Gateway  │
│(Search)│    │           │   │           │   │           │
└────────┘    └───────────┘   └───────────┘   └───────────┘
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                   ┌─────▼─────┐         ┌─────▼─────┐
                   │ Inventory │         │  Pricing  │
                   │ Service   │         │  Service  │
                   │           │         │           │
                   │ - Rooms   │         │ - Dynamic │
                   │ - Avail.  │         │ - Deals   │
                   └───────────┘         └───────────┘
                         │
                   ┌─────▼─────┐
                   │   Kafka   │
                   │ (Events)  │
                   └───────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
   ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
   │ Analytics │   │  Notif.   │   │  Search   │
   │ Service   │   │  Service  │   │  Indexer  │
   └───────────┘   └───────────┘   └───────────┘
```

### Core Components

1. **Search Service**
   - Parses search queries (location, dates, guests)
   - Queries Elasticsearch for matching hotels
   - Enriches with real-time availability and pricing
   - Ranks and returns results

2. **Booking Service**
   - Handles reservation workflow
   - Manages inventory locking
   - Orchestrates payment processing
   - Handles modifications and cancellations

3. **Inventory Service**
   - Manages room availability
   - Handles concurrent booking attempts
   - Source of truth for what's bookable

4. **Pricing Service**
   - Dynamic pricing based on demand, seasonality
   - Promotional pricing and deals
   - Rate plans and policies

5. **Supporting Services**
   - User Service: Authentication, profiles, preferences
   - Notification Service: Email, SMS, push notifications
   - Analytics Service: Business intelligence, demand forecasting

---

## Step 4: Deep Dive - Inventory and Availability (10 minutes)

This is the core challenge: how to track room availability efficiently and prevent double bookings.

### Data Model for Availability

**Option 1: Date-based slots**
```sql
CREATE TABLE room_availability (
  hotel_id UUID,
  room_type_id UUID,
  date DATE,
  total_rooms INTEGER,
  booked_rooms INTEGER,
  available_rooms AS (total_rooms - booked_rooms),
  base_price DECIMAL(10,2),
  PRIMARY KEY (hotel_id, room_type_id, date)
);
```

**Option 2: Booking ranges (chosen)**
```sql
CREATE TABLE room_inventory (
  hotel_id UUID,
  room_type_id UUID,
  total_count INTEGER,  -- Total rooms of this type
  PRIMARY KEY (hotel_id, room_type_id)
);

CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  hotel_id UUID,
  room_type_id UUID,
  check_in DATE,
  check_out DATE,
  room_count INTEGER,
  status VARCHAR(20),  -- 'confirmed', 'cancelled', 'completed'
  user_id UUID,
  created_at TIMESTAMP
);
```

**Why ranges over slots:**
- More flexible for date changes
- Less storage (one row per booking vs. row per date)
- Easier to query booking history

### Checking Availability

```sql
-- Count rooms booked for each date in range
SELECT date, SUM(room_count) as booked
FROM bookings
WHERE hotel_id = $1
  AND room_type_id = $2
  AND status = 'confirmed'
  AND check_in <= date
  AND check_out > date
  AND date BETWEEN $3 AND $4  -- Requested date range
GROUP BY date;

-- Compare against total_count to get availability
```

### Preventing Double Bookings

**The Problem:**
```
User A: Check availability (2 rooms available)
User B: Check availability (2 rooms available)
User A: Book 2 rooms → Success
User B: Book 2 rooms → Should fail, but may succeed!
```

**Solution: Pessimistic Locking with SELECT FOR UPDATE**

```sql
BEGIN;

-- Lock the room inventory row
SELECT * FROM room_inventory
WHERE hotel_id = $1 AND room_type_id = $2
FOR UPDATE;

-- Check availability
SELECT COALESCE(SUM(room_count), 0) as booked
FROM bookings
WHERE hotel_id = $1
  AND room_type_id = $2
  AND status = 'confirmed'
  AND check_in < $check_out
  AND check_out > $check_in;

-- If available, create booking
INSERT INTO bookings (...) VALUES (...);

COMMIT;
```

**Alternative: Optimistic Locking with Versioning**

```sql
-- Add version column
ALTER TABLE room_inventory ADD COLUMN version INTEGER DEFAULT 0;

-- Update with version check
UPDATE room_inventory
SET version = version + 1
WHERE hotel_id = $1
  AND room_type_id = $2
  AND version = $expected_version;

-- If 0 rows updated, retry with fresh data
```

### Caching Strategy

For search (high read, eventual consistency OK):
```
Redis Cache:
- Key: availability:{hotel_id}:{room_type_id}:{date}
- Value: {available: 5, price: 150.00}
- TTL: 5 minutes

Cache invalidation:
- On booking: delete affected date keys
- Or use cache-aside pattern with short TTL
```

### Handling High Concurrency

For flash sales or popular hotels:

1. **Booking Queue**: Put reservation requests in queue
2. **Rate Limiting**: Limit concurrent bookings per hotel
3. **Distributed Locks**: Redis-based locks for hot inventory

```python
# Redis distributed lock
def book_with_lock(hotel_id, room_type_id, dates):
    lock_key = f"lock:booking:{hotel_id}:{room_type_id}"

    with redis.lock(lock_key, timeout=10):
        # Check availability
        available = check_availability(hotel_id, room_type_id, dates)
        if available:
            create_booking(...)
            return True
    return False
```

---

## Step 5: Deep Dive - Search System (8 minutes)

### Search Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Search     │     │   Elastic    │     │   Avail.     │     │   Pricing    │
│   Request    │────▶│   search     │────▶│   Filter     │────▶│   Enrichment │
│              │     │   (Hotels)   │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### Elasticsearch Document

```json
{
  "hotel_id": "uuid",
  "name": "Grand Hotel",
  "location": {
    "lat": 40.7128,
    "lon": -74.0060,
    "city": "New York",
    "country": "US"
  },
  "star_rating": 4,
  "user_rating": 4.5,
  "review_count": 1250,
  "amenities": ["wifi", "pool", "gym", "spa"],
  "property_type": "hotel",
  "room_types": [
    {
      "id": "uuid",
      "name": "Standard King",
      "capacity": 2,
      "base_price": 150
    }
  ],
  "images": ["url1", "url2"],
  "popularity_score": 0.85
}
```

### Search Query Flow

```typescript
async function searchHotels(params: SearchParams) {
  // 1. Build Elasticsearch query
  const esQuery = {
    bool: {
      must: [
        { geo_distance: { distance: "10km", location: params.location } },
        { range: { "room_types.capacity": { gte: params.guests } } }
      ],
      filter: [
        { terms: { amenities: params.amenities } },
        { range: { star_rating: { gte: params.minStars } } }
      ]
    }
  };

  // 2. Get matching hotels from ES
  const hotels = await elasticsearch.search(esQuery);

  // 3. Filter by availability (parallel calls)
  const hotelIds = hotels.map(h => h.hotel_id);
  const availability = await inventoryService.checkBulkAvailability(
    hotelIds, params.checkIn, params.checkOut, params.rooms
  );

  const availableHotels = hotels.filter(h => availability[h.hotel_id]);

  // 4. Get real-time prices
  const prices = await pricingService.getPrices(
    availableHotels, params.checkIn, params.checkOut
  );

  // 5. Rank and return
  return rankHotels(availableHotels, prices, params);
}
```

### Ranking Factors

```typescript
function calculateScore(hotel, userPrefs) {
  return (
    0.3 * hotel.user_rating / 5 +
    0.2 * hotel.popularity_score +
    0.2 * priceCompetitiveness(hotel.price, averagePrice) +
    0.15 * amenityMatch(hotel.amenities, userPrefs.amenities) +
    0.1 * recencyBoost(hotel.last_booked) +
    0.05 * photoQuality(hotel.images)
  );
}
```

### Search Optimization

1. **Geo-sharding**: Partition hotels by region for faster geo queries
2. **Availability pre-computation**: Nightly job to compute available hotels per date
3. **Price caching**: Cache computed prices with 15-minute TTL
4. **Query caching**: Cache popular searches (NYC next weekend)

---

## Step 6: Deep Dive - Booking Flow (7 minutes)

### Booking State Machine

```
┌───────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐
│  PENDING  │────▶│ RESERVED  │────▶│ CONFIRMED │────▶│ COMPLETED │
└───────────┘     └───────────┘     └───────────┘     └───────────┘
                        │                 │
                        │                 │
                        ▼                 ▼
                  ┌───────────┐     ┌───────────┐
                  │  EXPIRED  │     │ CANCELLED │
                  └───────────┘     └───────────┘
```

### Booking Flow

```typescript
async function createBooking(bookingRequest: BookingRequest) {
  // 1. Create pending booking
  const booking = await db.transaction(async (tx) => {
    // Lock and check availability
    const available = await checkAvailabilityWithLock(tx, bookingRequest);
    if (!available) {
      throw new Error('Room no longer available');
    }

    // Create booking in RESERVED state (holds inventory)
    return await tx.insert('bookings', {
      ...bookingRequest,
      status: 'RESERVED',
      reserved_until: now() + 15_MINUTES
    });
  });

  // 2. Process payment (async, with timeout)
  try {
    const payment = await paymentGateway.charge({
      amount: booking.total_price,
      booking_id: booking.id,
      idempotency_key: booking.id
    });

    // 3. Confirm booking
    await db.update('bookings', booking.id, {
      status: 'CONFIRMED',
      payment_id: payment.id
    });

    // 4. Send confirmation
    await notificationService.sendBookingConfirmation(booking);

    return booking;

  } catch (paymentError) {
    // Payment failed, release inventory
    await db.update('bookings', booking.id, { status: 'EXPIRED' });
    throw new Error('Payment failed');
  }
}
```

### Reservation Expiry

Background job to expire stale reservations:

```typescript
// Run every minute
async function expireStaleReservations() {
  await db.query(`
    UPDATE bookings
    SET status = 'EXPIRED'
    WHERE status = 'RESERVED'
      AND reserved_until < NOW()
  `);
}
```

### Idempotency

Prevent duplicate bookings from retries:

```typescript
// Use booking request hash as idempotency key
const idempotencyKey = hash(userId + hotelId + roomTypeId + checkIn + checkOut);

const existing = await db.query(
  'SELECT * FROM bookings WHERE idempotency_key = $1',
  [idempotencyKey]
);

if (existing) {
  return existing;  // Return existing booking
}
```

---

## Step 7: Deep Dive - Dynamic Pricing (5 minutes)

### Pricing Factors

1. **Base rate**: Set by hotel for each room type
2. **Demand multiplier**: Based on booking velocity
3. **Seasonality**: Holidays, events, weekends
4. **Lead time**: Last-minute vs. advance bookings
5. **Inventory level**: Higher prices as rooms fill up

### Pricing Algorithm

```typescript
function calculatePrice(roomType, checkIn, checkOut) {
  const baseRate = roomType.base_price;

  // Demand multiplier (based on recent bookings)
  const demandScore = getDemandScore(roomType.hotel_id, checkIn);
  const demandMultiplier = 1 + (demandScore * 0.3);  // Up to 30% increase

  // Seasonality
  const seasonMultiplier = getSeasonalFactor(checkIn);  // 0.8 to 1.5

  // Inventory scarcity
  const availablePercent = getAvailabilityPercent(roomType, checkIn);
  const scarcityMultiplier = availablePercent < 0.2 ? 1.2 : 1.0;

  // Lead time (last minute premium or early bird discount)
  const daysAhead = daysBetween(now(), checkIn);
  const leadTimeMultiplier = daysAhead < 3 ? 1.15 : daysAhead > 60 ? 0.9 : 1.0;

  return baseRate * demandMultiplier * seasonMultiplier *
         scarcityMultiplier * leadTimeMultiplier;
}
```

### Price Caching

- Compute prices nightly for next 365 days
- Store in Redis with 1-hour TTL
- Real-time adjustments for flash changes

---

## Step 8: Data Model (3 minutes)

### PostgreSQL Schema

```sql
-- Hotels
CREATE TABLE hotels (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  description TEXT,
  address TEXT,
  city VARCHAR(100),
  country VARCHAR(50),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  star_rating INTEGER,
  amenities TEXT[],
  check_in_time TIME,
  check_out_time TIME,
  cancellation_policy TEXT,
  created_at TIMESTAMP
);

-- Room types
CREATE TABLE room_types (
  id UUID PRIMARY KEY,
  hotel_id UUID REFERENCES hotels(id),
  name VARCHAR(100),
  description TEXT,
  capacity INTEGER,
  total_count INTEGER,
  base_price DECIMAL(10, 2),
  amenities TEXT[]
);

-- Bookings
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  hotel_id UUID REFERENCES hotels(id),
  room_type_id UUID REFERENCES room_types(id),
  check_in DATE,
  check_out DATE,
  room_count INTEGER,
  total_price DECIMAL(10, 2),
  status VARCHAR(20),
  payment_id VARCHAR(100),
  idempotency_key VARCHAR(64) UNIQUE,
  reserved_until TIMESTAMP,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Reviews
CREATE TABLE reviews (
  id UUID PRIMARY KEY,
  booking_id UUID REFERENCES bookings(id),
  user_id UUID REFERENCES users(id),
  hotel_id UUID REFERENCES hotels(id),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  title VARCHAR(200),
  content TEXT,
  created_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_bookings_hotel_dates ON bookings(hotel_id, room_type_id, check_in, check_out);
CREATE INDEX idx_hotels_location ON hotels USING GIST (point(latitude, longitude));
```

---

## Step 9: API Design (2 minutes)

### REST API

```
# Search
GET /api/v1/search?location=NYC&check_in=2024-03-01&check_out=2024-03-03&guests=2
Response: { hotels: [...], filters: {...}, pagination: {...} }

# Hotel details
GET /api/v1/hotels/{hotel_id}
GET /api/v1/hotels/{hotel_id}/rooms?check_in=...&check_out=...

# Booking
POST /api/v1/bookings
Body: { hotel_id, room_type_id, check_in, check_out, guest_info, payment_info }
Response: { booking_id, status, confirmation_number }

GET /api/v1/bookings/{booking_id}
PUT /api/v1/bookings/{booking_id}/cancel

# Reviews
GET /api/v1/hotels/{hotel_id}/reviews
POST /api/v1/bookings/{booking_id}/review
```

---

## Step 10: Scalability and Reliability (3 minutes)

### Database Scaling

- **Read replicas**: For search and availability reads
- **Sharding**: By hotel_id for horizontal scale
- **Connection pooling**: PgBouncer for connection management

### Caching Layers

1. **CDN**: Static content, hotel images
2. **Redis**: Availability cache, session data, rate limiting
3. **Application cache**: Hot hotel metadata

### High Availability

- **Multi-AZ deployment**: Database and services
- **Circuit breakers**: Isolate payment failures
- **Graceful degradation**: Show cached results if search slow

### Handling Traffic Spikes

- Black Friday, flash sales:
  - Pre-warm caches
  - Queue booking requests
  - Rate limit by user/IP

---

## Step 11: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Range-based bookings | Flexible dates, but complex availability queries |
| Pessimistic locking | Strong consistency, but lower throughput |
| 15-min reservation hold | Better UX, but inventory locked |
| Eventual consistency for search | Faster search, but may show unavailable rooms |

### Alternatives Considered

1. **Optimistic locking for bookings**
   - Higher throughput
   - More retry logic needed
   - Chose pessimistic for correctness

2. **Pre-computed availability tables**
   - Faster queries
   - More storage, complex updates
   - Use for search, not booking

3. **NoSQL for bookings**
   - Better scale
   - ACID guarantees harder
   - Chose PostgreSQL for transactions

---

## Closing Summary

"I've designed a hotel booking system with:

1. **Inventory management** using pessimistic locking to prevent double bookings
2. **Two-phase search** combining Elasticsearch for matching and real-time availability filtering
3. **Dynamic pricing** based on demand, seasonality, and inventory levels
4. **Reservation holds** giving users time to complete payment

The key insight is separating the read-heavy search path (eventual consistency) from the write-critical booking path (strong consistency). Happy to dive deeper into any aspect."

---

## Potential Follow-up Questions

1. **How would you handle overbooking?**
   - Hotels intentionally overbook 5-10%
   - Track "soft" and "hard" limits
   - Automatic rebooking workflow for overbooked guests

2. **How would you implement price alerts?**
   - User sets price threshold
   - Async job checks prices daily
   - Push notification when price drops

3. **How would you handle hotel onboarding?**
   - Self-service portal for hotels
   - Bulk import for property management systems
   - Verification workflow before going live
