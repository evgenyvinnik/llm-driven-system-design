# Hotel Booking System - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"Today I'll design a hotel booking system like Booking.com or Expedia. The core backend challenges are preventing double bookings through pessimistic locking, building a two-phase search combining Elasticsearch with real-time PostgreSQL availability checks, implementing dynamic pricing with date-specific overrides, and ensuring idempotency for payment retries. I'll focus on the database schema, concurrency control, and distributed locking patterns."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Hotel and room inventory** - Hotels list properties with room types and availability counts
2. **Search with availability** - Two-phase search: Elasticsearch for filtering, PostgreSQL for real-time availability
3. **Booking with reservation holds** - Create reserved booking, confirm after payment, expire if abandoned
4. **Dynamic pricing** - Base price with date-specific overrides for seasonality/demand
5. **Review system** - Post-stay reviews linked to confirmed bookings

### Non-Functional Requirements

- **Availability**: 99.99% uptime for booking-critical paths
- **Consistency**: Strong consistency for bookings - zero double-booking tolerance
- **Latency**: Search p95 < 500ms, booking confirmation p95 < 1s
- **Scale**: 100M searches/day, 1M bookings/day, 1M hotels

### Backend Focus Areas

- PostgreSQL schema design with proper locking strategies
- Distributed locking for concurrent booking prevention
- Idempotency for payment retry safety
- Availability caching with intelligent invalidation
- Background workers for reservation expiry

---

## Step 2: Scale Estimation (2-3 minutes)

**Traffic Analysis:**
- 100M searches/day = 1,150 QPS (peak 3x = 3,500 QPS)
- 1M bookings/day = 12 bookings/second (peak = 50/second)
- Read:Write ratio = 100:1 (search-heavy)

**Storage Calculations:**
- Hotels: 1M * 2KB = 2 GB
- Room types: 50M * 1KB = 50 GB
- Bookings: 365M/year * 500B = 180 GB/year
- Availability cache: 1M hotels * 365 days * 100B = 36 GB Redis

**Key Insight:** Search is the hot path requiring aggressive caching, but bookings require strong consistency with pessimistic locking. The 100:1 ratio means lock contention is rare.

---

## Step 3: High-Level Architecture (8 minutes)

```
                                 ┌───────────────────────────────────┐
                                 │            API Gateway            │
                                 │   (Rate limiting, Auth, Routing)  │
                                 └───────────────────┬───────────────┘
                                                     │
                    ┌────────────────────────────────┼────────────────────────────────┐
                    │                                │                                │
          ┌─────────▼─────────┐           ┌─────────▼─────────┐           ┌─────────▼─────────┐
          │   Search Service  │           │  Booking Service  │           │  Pricing Service  │
          │                   │           │                   │           │                   │
          │ - ES Query Build  │           │ - Pessimistic Lock│           │ - Base + Override │
          │ - Avail. Filter   │           │ - Idempotency     │           │ - Demand Scoring  │
          │ - Price Enrich    │           │ - Payment Coord.  │           │ - Seasonal Factor │
          └─────────┬─────────┘           └─────────┬─────────┘           └───────────────────┘
                    │                               │
    ┌───────────────┴───────────────┐               │
    │               │               │               │
┌───▼────┐    ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
│Elastic │    │   Redis   │   │ PostgreSQL│   │  RabbitMQ │
│search  │    │  (Cache + │   │ (Primary) │   │  (Jobs)   │
│        │    │   Locks)  │   │           │   │           │
└────────┘    └───────────┘   └───────────┘   └───────────┘
                                    │
                              ┌─────▼─────┐
                              │ Background│
                              │  Workers  │
                              │           │
                              │- Expiry   │
                              │- ES Sync  │
                              │- Cleanup  │
                              └───────────┘
```

---

## Step 4: Database Schema Deep Dive (10 minutes)

### Core Tables

```sql
-- Room types with inventory count
CREATE TABLE room_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID REFERENCES hotels(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    base_price DECIMAL(10, 2) NOT NULL,
    max_guests INTEGER NOT NULL,
    total_rooms INTEGER NOT NULL,  -- Inventory count
    amenities JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Bookings with range-based dates and reservation hold
CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    hotel_id UUID REFERENCES hotels(id),
    room_type_id UUID REFERENCES room_types(id),
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    room_count INTEGER NOT NULL DEFAULT 1,
    total_price DECIMAL(10, 2) NOT NULL,
    status VARCHAR(50) DEFAULT 'reserved',  -- reserved, confirmed, cancelled, expired
    guest_name VARCHAR(255) NOT NULL,
    guest_email VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP,  -- For reserved bookings (15-min hold)
    idempotency_key VARCHAR(255) UNIQUE,  -- Prevent duplicate bookings
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT valid_dates CHECK (check_out > check_in)
);

-- Dynamic pricing overrides
CREATE TABLE price_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type_id UUID REFERENCES room_types(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    reason VARCHAR(100),  -- 'weekend', 'holiday', 'high_demand', 'promotion'
    UNIQUE(room_type_id, date)
);

-- Critical indexes for performance
CREATE INDEX idx_bookings_availability
    ON bookings(room_type_id, check_in, check_out)
    WHERE status IN ('reserved', 'confirmed');

CREATE INDEX idx_bookings_expires
    ON bookings(expires_at)
    WHERE status = 'reserved';

CREATE INDEX idx_price_overrides_lookup
    ON price_overrides(room_type_id, date);
```

### Availability Query with generate_series

```sql
-- Get maximum rooms booked on any single night in the range
-- This handles the case where different nights have different occupancy
SELECT rt.total_rooms - COALESCE(max_booked.count, 0) AS available_rooms
FROM room_types rt
LEFT JOIN (
    SELECT room_type_id, MAX(nightly_bookings) AS count
    FROM (
        SELECT
            b.room_type_id,
            d::date AS night,
            SUM(b.room_count) AS nightly_bookings
        FROM bookings b
        CROSS JOIN generate_series(
            b.check_in,
            b.check_out - INTERVAL '1 day',
            '1 day'
        ) AS d
        WHERE b.room_type_id = $1
          AND b.status IN ('reserved', 'confirmed')
          AND d::date >= $2  -- check_in
          AND d::date < $3   -- check_out
        GROUP BY b.room_type_id, d::date
    ) nightly
    GROUP BY room_type_id
) max_booked ON rt.id = max_booked.room_type_id
WHERE rt.id = $1;
```

---

## Step 5: Pessimistic Locking for Bookings (8 minutes)

### The Double-Booking Problem

```
Time T0: Server A receives booking for Room 101, Jan 15
Time T0: Server B receives booking for Room 101, Jan 15
Time T1: Server A checks availability → 1 room available
Time T1: Server B checks availability → 1 room available
Time T2: Server A creates booking (success)
Time T2: Server B creates booking (success - OVERSOLD!)
```

### Solution: SELECT FOR UPDATE with Transaction

```typescript
class BookingService {
  async createBooking(bookingData: CreateBookingInput, userId: string) {
    const { hotelId, roomTypeId, checkIn, checkOut, roomCount } = bookingData;

    return await db.transaction(async (tx) => {
      // 1. Lock the room_type row to serialize concurrent bookings
      const [roomType] = await tx.query(`
        SELECT id, total_rooms, base_price
        FROM room_types
        WHERE id = $1
        FOR UPDATE
      `, [roomTypeId]);

      if (!roomType) {
        throw new Error('Room type not found');
      }

      // 2. Check availability within the lock
      const availability = await this.checkAvailabilityInTransaction(
        tx, roomTypeId, checkIn, checkOut
      );

      if (availability.availableRooms < roomCount) {
        throw new Error(`Only ${availability.availableRooms} rooms available`);
      }

      // 3. Calculate price for the stay
      const totalPrice = await this.calculateTotalPrice(
        tx, roomTypeId, checkIn, checkOut, roomCount
      );

      // 4. Generate idempotency key
      const idempotencyKey = this.generateIdempotencyKey(
        userId, hotelId, roomTypeId, checkIn, checkOut, roomCount
      );

      // 5. Check for existing booking with same idempotency key
      const [existing] = await tx.query(`
        SELECT * FROM bookings WHERE idempotency_key = $1
      `, [idempotencyKey]);

      if (existing) {
        return { booking: existing, deduplicated: true };
      }

      // 6. Create the reservation with 15-minute hold
      const [booking] = await tx.query(`
        INSERT INTO bookings (
          user_id, hotel_id, room_type_id, check_in, check_out,
          room_count, total_price, status, guest_name, guest_email,
          expires_at, idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9,
                  NOW() + INTERVAL '15 minutes', $10)
        RETURNING *
      `, [userId, hotelId, roomTypeId, checkIn, checkOut, roomCount,
          totalPrice, bookingData.guestName, bookingData.guestEmail,
          idempotencyKey]);

      // 7. Invalidate availability cache
      await this.invalidateAvailabilityCache(hotelId, roomTypeId, checkIn, checkOut);

      return { booking, deduplicated: false };
    });
  }

  private generateIdempotencyKey(
    userId: string, hotelId: string, roomTypeId: string,
    checkIn: string, checkOut: string, roomCount: number
  ): string {
    const data = `${userId}:${hotelId}:${roomTypeId}:${checkIn}:${checkOut}:${roomCount}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}
```

### Distributed Locking for High-Contention Scenarios

For flash sales or extremely popular hotels, add Redis distributed lock:

```typescript
import Redlock from 'redlock';

class DistributedLockService {
  private redlock: Redlock;

  constructor(redisClient: Redis) {
    this.redlock = new Redlock([redisClient], {
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 100,
    });
  }

  async withRoomLock<T>(
    hotelId: string,
    roomTypeId: string,
    checkIn: string,
    checkOut: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const lockKey = `lock:room:${hotelId}:${roomTypeId}:${checkIn}:${checkOut}`;

    const lock = await this.redlock.acquire([lockKey], 30000); // 30s TTL

    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }
}

// Usage in booking service
async createBookingWithDistributedLock(bookingData, userId) {
  return await this.lockService.withRoomLock(
    bookingData.hotelId,
    bookingData.roomTypeId,
    bookingData.checkIn,
    bookingData.checkOut,
    async () => {
      return await this.createBooking(bookingData, userId);
    }
  );
}
```

---

## Step 6: Dynamic Pricing Service (5 minutes)

```typescript
class PricingService {
  async calculateTotalPrice(
    roomTypeId: string,
    checkIn: Date,
    checkOut: Date,
    roomCount: number
  ): Promise<number> {
    // Get base price
    const roomType = await db.query(`
      SELECT base_price FROM room_types WHERE id = $1
    `, [roomTypeId]);

    const basePrice = parseFloat(roomType.rows[0].base_price);

    // Get price overrides for the date range
    const overrides = await db.query(`
      SELECT date, price
      FROM price_overrides
      WHERE room_type_id = $1
        AND date >= $2
        AND date < $3
    `, [roomTypeId, checkIn, checkOut]);

    // Create override lookup map
    const overrideMap = new Map(
      overrides.rows.map(r => [r.date.toISOString().split('T')[0], parseFloat(r.price)])
    );

    // Calculate total for each night
    let total = 0;
    const currentDate = new Date(checkIn);
    const endDate = new Date(checkOut);

    while (currentDate < endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      const nightlyPrice = overrideMap.get(dateKey) || basePrice;
      total += nightlyPrice * roomCount;
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return total;
  }

  // Advanced pricing with demand factors
  async getDynamicPrice(roomTypeId: string, date: Date): Promise<number> {
    const roomType = await this.getRoomType(roomTypeId);
    const basePrice = roomType.base_price;

    // 1. Check for manual override
    const override = await this.getPriceOverride(roomTypeId, date);
    if (override) return override.price;

    // 2. Apply demand multiplier (booking velocity)
    const demandScore = await this.getDemandScore(roomType.hotel_id, date);
    const demandMultiplier = 1 + (demandScore * 0.3); // Up to 30% increase

    // 3. Apply seasonality factor
    const seasonMultiplier = this.getSeasonalFactor(date); // 0.8 to 1.5

    // 4. Apply scarcity multiplier
    const availability = await this.getAvailabilityPercent(roomTypeId, date);
    const scarcityMultiplier = availability < 0.2 ? 1.2 : 1.0;

    return basePrice * demandMultiplier * seasonMultiplier * scarcityMultiplier;
  }

  private getSeasonalFactor(date: Date): number {
    const month = date.getMonth();
    const dayOfWeek = date.getDay();

    // Weekend premium
    const weekendFactor = (dayOfWeek === 5 || dayOfWeek === 6) ? 1.15 : 1.0;

    // Holiday seasons (simplified)
    const seasonFactors: Record<number, number> = {
      0: 1.0,   // January
      6: 1.3,   // July (summer)
      7: 1.3,   // August
      11: 1.4,  // December (holidays)
    };

    return (seasonFactors[month] || 1.0) * weekendFactor;
  }
}
```

---

## Step 7: Background Worker for Reservation Expiry (4 minutes)

```typescript
class ReservationExpiryWorker {
  private readonly POLL_INTERVAL = 60_000; // 60 seconds

  async start() {
    setInterval(() => this.expireStaleReservations(), this.POLL_INTERVAL);
    logger.info('Reservation expiry worker started');
  }

  async expireStaleReservations() {
    const startTime = Date.now();

    try {
      // Find and expire reservations in a single atomic update
      const result = await db.query(`
        UPDATE bookings
        SET status = 'expired',
            updated_at = NOW()
        WHERE status = 'reserved'
          AND expires_at < NOW()
        RETURNING id, hotel_id, room_type_id, check_in, check_out
      `);

      const expiredCount = result.rowCount;

      if (expiredCount > 0) {
        // Invalidate availability cache for affected bookings
        for (const booking of result.rows) {
          await this.invalidateAvailabilityCache(
            booking.hotel_id,
            booking.room_type_id,
            booking.check_in,
            booking.check_out
          );
        }

        // Track metrics
        metrics.bookingsExpiredTotal.inc(expiredCount);

        logger.info({
          expiredCount,
          durationMs: Date.now() - startTime,
        }, 'Expired stale reservations');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to expire reservations');
      metrics.workerErrorsTotal.inc({ worker: 'reservation_expiry' });
    }
  }

  private async invalidateAvailabilityCache(
    hotelId: string,
    roomTypeId: string,
    checkIn: Date,
    checkOut: Date
  ) {
    // Delete all potentially affected cache keys
    const pattern = `availability:${hotelId}:${roomTypeId}:*`;
    const keys = await redis.keys(pattern);

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}
```

---

## Step 8: Availability Caching Strategy (4 minutes)

```typescript
class AvailabilityCache {
  private readonly TTL = 300; // 5 minutes

  async getAvailability(
    hotelId: string,
    roomTypeId: string,
    checkIn: string,
    checkOut: string
  ): Promise<AvailabilityResult | null> {
    const cacheKey = this.buildCacheKey(hotelId, roomTypeId, checkIn, checkOut);

    const cached = await redis.get(cacheKey);
    if (cached) {
      metrics.availabilityCacheHitsTotal.inc();
      return JSON.parse(cached);
    }

    metrics.availabilityCacheMissesTotal.inc();
    return null;
  }

  async setAvailability(
    hotelId: string,
    roomTypeId: string,
    checkIn: string,
    checkOut: string,
    availability: AvailabilityResult
  ): Promise<void> {
    const cacheKey = this.buildCacheKey(hotelId, roomTypeId, checkIn, checkOut);
    await redis.setex(cacheKey, this.TTL, JSON.stringify(availability));
  }

  async invalidate(
    hotelId: string,
    roomTypeId: string,
    checkIn: string,
    checkOut: string
  ): Promise<void> {
    // Invalidate all overlapping date ranges
    // Using pattern matching for simplicity - in production, use Redis Sets
    const yearMonth = checkIn.substring(0, 7); // YYYY-MM
    const pattern = `availability:${hotelId}:${roomTypeId}:${yearMonth}*`;

    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug({ keysDeleted: keys.length }, 'Invalidated availability cache');
    }
  }

  private buildCacheKey(
    hotelId: string,
    roomTypeId: string,
    checkIn: string,
    checkOut: string
  ): string {
    return `availability:${hotelId}:${roomTypeId}:${checkIn}:${checkOut}`;
  }
}
```

---

## Step 9: Search Service with Two-Phase Query (4 minutes)

```typescript
class SearchService {
  async searchHotels(params: SearchParams): Promise<SearchResult> {
    // Phase 1: Elasticsearch for filtering and geo queries
    const esQuery = this.buildElasticsearchQuery(params);
    const esResults = await elasticsearch.search({
      index: 'hotels',
      body: esQuery,
      size: 100, // Get candidate hotels
    });

    const candidateHotels = esResults.hits.hits.map(h => h._source);

    if (candidateHotels.length === 0) {
      return { hotels: [], total: 0 };
    }

    // Phase 2: Real-time availability check (parallelized)
    const hotelIds = candidateHotels.map(h => h.id);
    const availabilityResults = await Promise.all(
      hotelIds.map(hotelId =>
        this.checkHotelAvailability(hotelId, params.checkIn, params.checkOut, params.rooms)
      )
    );

    // Filter to available hotels and enrich with prices
    const availableHotels = candidateHotels
      .filter((_, index) => availabilityResults[index].hasAvailability)
      .map((hotel, index) => ({
        ...hotel,
        lowestPrice: availabilityResults[index].lowestPrice,
        availableRoomTypes: availabilityResults[index].roomTypes,
      }));

    // Rank results
    const rankedHotels = this.rankHotels(availableHotels, params);

    return {
      hotels: rankedHotels.slice(0, params.limit || 20),
      total: rankedHotels.length,
    };
  }

  private buildElasticsearchQuery(params: SearchParams) {
    return {
      query: {
        bool: {
          must: [
            params.location && {
              geo_distance: {
                distance: '50km',
                location: params.location,
              },
            },
            params.city && {
              match: { city: params.city },
            },
          ].filter(Boolean),
          filter: [
            params.amenities?.length && {
              terms: { amenities: params.amenities },
            },
            params.minStars && {
              range: { star_rating: { gte: params.minStars } },
            },
            params.maxPrice && {
              range: { min_price: { lte: params.maxPrice } },
            },
          ].filter(Boolean),
        },
      },
    };
  }
}
```

---

## Step 10: Trade-offs Discussion (3 minutes)

### Backend Trade-offs Table

| Decision | Approach | Trade-off | Rationale |
|----------|----------|-----------|-----------|
| Booking consistency | Pessimistic locking | Lower throughput vs. correctness | Double-booking has severe financial/trust impact |
| Availability storage | Range-based bookings | Complex queries vs. flexibility | One row per booking, easy date modifications |
| Reservation hold | 15-minute expiry | Blocked inventory vs. conversion | Gives users time to pay without permanent blocks |
| Availability cache | 5-min TTL + invalidation | Stale reads vs. DB load | Search tolerates staleness; booking checks fresh |
| Idempotency | SHA-256 of booking params | Storage overhead vs. safety | Prevents double-charges from retries |
| Distributed locks | Redis Redlock | Added complexity vs. safety | Only for flash sales/high-contention scenarios |

### Why Pessimistic Over Optimistic Locking

Optimistic locking (version columns with retry) would provide higher throughput but:
1. Requires complex retry logic with exponential backoff
2. May frustrate users with "room no longer available" after filling forms
3. At 100:1 read:write ratio, lock contention is already rare

Pessimistic locking is simpler and provides better UX for a booking system.

---

## Closing Summary

"I've designed a hotel booking backend with:

1. **PostgreSQL schema** using range-based bookings with generate_series for availability
2. **Pessimistic locking** via SELECT FOR UPDATE to prevent double bookings
3. **Distributed locks** using Redis Redlock for high-contention flash sales
4. **Idempotency keys** generated from booking parameters to prevent duplicate charges
5. **Two-phase search** combining Elasticsearch speed with PostgreSQL accuracy
6. **Background workers** for reservation expiry and cache invalidation

The key insight is separating the eventually-consistent search path from the strongly-consistent booking path, with intelligent caching bridging the performance gap. Happy to dive deeper into any component."

---

## Potential Follow-up Questions

1. **How would you handle payment gateway failures?**
   - Use circuit breaker pattern with Opossum library
   - Queue failed payments for retry with exponential backoff
   - Keep booking in 'reserved' state with extended expiry

2. **How would you implement overbooking?**
   - Add `soft_limit` column to room_types (typically 105% of total_rooms)
   - Use soft_limit for booking creation, total_rooms for hard stop
   - Automatic rebooking workflow when oversold

3. **How would you handle database failover?**
   - PostgreSQL streaming replication with automatic failover
   - PgBouncer for connection pooling and routing
   - Application retries with exponential backoff on connection errors
