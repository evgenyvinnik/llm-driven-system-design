# Airbnb - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design the backend infrastructure for a property rental marketplace like Airbnb. Key challenges include:
- Geographic search with PostGIS spatial indexing
- Availability calendar with date-range storage
- Double-booking prevention under concurrent access
- Two-sided review system with hidden-until-both-submit semantics
- High-throughput search with caching and async processing

## Requirements Clarification

### Functional Requirements
1. **Listings**: Host creates properties with photos, amenities, pricing
2. **Search**: Geographic + availability + filter search
3. **Booking**: Reserve with double-booking prevention
4. **Reviews**: Two-sided rating system (host and guest)
5. **Messaging**: Host-guest communication

### Non-Functional Requirements
1. **Availability**: 99.9% for search functionality
2. **Consistency**: Strong consistency for bookings (no double-booking)
3. **Latency**: < 200ms for search results
4. **Scale**: 10M listings, 1M bookings/day

### Scale Estimates
- Active Listings: 10M
- Daily Bookings: 1M
- Daily Searches: 50M
- Average Stay: 3 nights
- Peak Concurrent Users: 200K

## High-Level Architecture

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

## Deep Dive: Availability Calendar Storage

### The Storage Problem

10M listings with 365 days/year creates massive storage requirements:
- Day-by-day: 10M x 365 = 3.65 billion rows
- Date ranges: ~20 blocks/listing = 200M rows (18x reduction)

### Date Range Schema (Chosen)

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

### Availability Check Query

```sql
-- Check if dates are available (no conflicting blocks)
SELECT COUNT(*) = 0 as is_available
FROM availability_blocks
WHERE listing_id = $1
  AND status != 'available'
  AND (start_date, end_date) OVERLAPS ($2, $3);
```

### Calendar Update with Overlap Handling

```typescript
async function updateCalendar(listingId: number, changes: CalendarChange): Promise<void> {
  await db.transaction(async (trx) => {
    // 1. Find overlapping existing blocks
    const overlaps = await trx('availability_blocks')
      .where('listing_id', listingId)
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)',
                [changes.start, changes.end]);

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
        });
      }
      if (block.end_date > changes.end) {
        // Keep the part after
        await trx('availability_blocks').insert({
          listing_id: listingId,
          start_date: changes.end,
          end_date: block.end_date,
          status: block.status,
          price_per_night: block.price_per_night
        });
      }
      // Delete original
      await trx('availability_blocks').where('id', block.id).delete();
    }

    // 3. Insert new block
    await trx('availability_blocks').insert({
      listing_id: listingId,
      start_date: changes.start,
      end_date: changes.end,
      status: changes.status,
      price_per_night: changes.price
    });
  });
}
```

## Deep Dive: Geographic Search with PostGIS

### PostGIS Schema

```sql
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  host_id INTEGER REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326), -- Lat/Lng in WGS84
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

### Radius Search Query

```sql
-- Find listings within 25km of a point
SELECT *,
       ST_Distance(location, ST_MakePoint($lon, $lat)::geography) as distance
FROM listings
WHERE ST_DWithin(location, ST_MakePoint($lon, $lat)::geography, 25000)
ORDER BY distance
LIMIT 20;
```

### Combined Search: Location + Availability + Filters

```typescript
async function searchListings(params: SearchParams): Promise<Listing[]> {
  const { location, checkIn, checkOut, guests, priceMax } = params;

  // Step 1: Geographic filter (fast, uses spatial index)
  const nearbyListings = await db.raw(`
    SELECT id FROM listings
    WHERE ST_DWithin(location, ST_MakePoint(?, ?)::geography, 25000)
      AND max_guests >= ?
      AND price_per_night <= ?
      AND is_active = TRUE
  `, [location.lon, location.lat, guests, priceMax]);

  const nearbyIds = nearbyListings.rows.map(r => r.id);
  if (nearbyIds.length === 0) return [];

  // Step 2: Availability filter (exclude booked dates)
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
  `, [nearbyIds, checkIn, checkOut, checkIn, checkOut]);

  const availableIds = availableListings.rows.map(r => r.listing_id);

  // Step 3: Fetch full details and rank
  return await rankListings(availableIds, params);
}
```

### Search Ranking Algorithm

```typescript
function calculateListingScore(listing: Listing, params: SearchParams): number {
  let score = 0;

  // Distance penalty (closer is better)
  score += 100 - (listing.distance / 1000) * 2; // km penalty

  // Rating bonus
  score += listing.rating * 10;

  // Review count (social proof)
  score += Math.log10(listing.review_count + 1) * 5;

  // Price match (closer to budget is better)
  const priceDiff = Math.abs(listing.price - params.avgBudget);
  score -= priceDiff * 0.1;

  // Host response rate
  score += listing.host_response_rate * 5;

  // Instant book bonus
  if (listing.instant_book) score += 10;

  return score;
}
```

## Deep Dive: Double-Booking Prevention

### Transaction with Row-Level Lock

```typescript
async function createBooking(
  listingId: number,
  guestId: number,
  checkIn: Date,
  checkOut: Date
): Promise<Booking> {
  return await db.transaction(async (trx) => {
    // 1. Lock the listing row to prevent concurrent bookings
    await trx.raw(
      'SELECT * FROM listings WHERE id = ? FOR UPDATE',
      [listingId]
    );

    // 2. Double-check availability (within transaction)
    const conflicts = await trx('availability_blocks')
      .where('listing_id', listingId)
      .where('status', 'booked')
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)', [checkIn, checkOut]);

    if (conflicts.length > 0) {
      throw new Error('Dates no longer available');
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
      .returning('*');

    // 4. Block the dates
    await trx('availability_blocks').insert({
      listing_id: listingId,
      start_date: checkIn,
      end_date: checkOut,
      status: 'booked',
      booking_id: booking.id
    });

    return booking;
  });
}
```

### Why FOR UPDATE Lock?

When two users try to book the same dates simultaneously:

1. User A starts transaction, acquires lock
2. User B starts transaction, waits for lock
3. User A completes booking, releases lock
4. User B acquires lock, sees dates are now booked, fails gracefully

Without the lock, both might see "available" and try to insert, causing data inconsistency.

### Instant Book vs Request to Book

```typescript
async function initiateBooking(listingId: number, guestId: number, dates: DateRange): Promise<BookingResult> {
  const listing = await getListing(listingId);

  if (listing.instant_book) {
    // Create confirmed booking immediately
    const booking = await createBooking(listingId, guestId, dates.checkIn, dates.checkOut);
    await processPayment(booking);
    await publishEvent('booking.created', booking);
    return { status: 'confirmed', booking };
  } else {
    // Create pending request
    const request = await createBookingRequest(listingId, guestId, dates);
    await publishEvent('booking.requested', request);
    // Host has 24 hours to respond
    await scheduleExpiry(request.id, 24 * 60 * 60);
    return { status: 'pending', request };
  }
}
```

## Deep Dive: Two-Sided Review System

### Schema Design

```sql
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  author_id INTEGER REFERENCES users(id),
  author_type VARCHAR(10), -- 'host' or 'guest'
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  cleanliness_rating INTEGER CHECK (cleanliness_rating >= 1 AND cleanliness_rating <= 5),
  communication_rating INTEGER CHECK (communication_rating >= 1 AND communication_rating <= 5),
  location_rating INTEGER CHECK (location_rating >= 1 AND location_rating <= 5),
  value_rating INTEGER CHECK (value_rating >= 1 AND value_rating <= 5),
  content TEXT,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(booking_id, author_type)
);
```

### Hidden Until Both Submit Logic

```typescript
async function getReviews(bookingId: number): Promise<ReviewResult> {
  const reviews = await db('reviews').where({ booking_id: bookingId });

  const hostReview = reviews.find(r => r.author_type === 'host');
  const guestReview = reviews.find(r => r.author_type === 'guest');

  // Only reveal if both submitted
  if (hostReview && guestReview) {
    return { hostReview, guestReview, visible: true };
  }

  // Otherwise, show pending state
  return {
    hostSubmitted: !!hostReview,
    guestSubmitted: !!guestReview,
    visible: false,
    message: 'Reviews will be visible after both parties submit'
  };
}
```

### Database Trigger for Auto-Publish

```sql
-- Trigger to publish reviews when both parties have submitted
CREATE OR REPLACE FUNCTION check_and_publish_reviews()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if both parties have reviewed this booking
  IF (
    SELECT COUNT(DISTINCT author_type) = 2
    FROM reviews
    WHERE booking_id = NEW.booking_id
  ) THEN
    -- Mark both reviews as public
    UPDATE reviews
    SET is_public = TRUE
    WHERE booking_id = NEW.booking_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_publish_reviews_trigger
AFTER INSERT ON reviews
FOR EACH ROW
EXECUTE FUNCTION check_and_publish_reviews();
```

### Rating Aggregation Trigger

```sql
-- Trigger to update listing rating when guest review is published
CREATE OR REPLACE FUNCTION update_listing_rating()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_public = TRUE AND NEW.author_type = 'guest' THEN
    UPDATE listings
    SET
      rating = (
        SELECT AVG(rating)::DECIMAL(2,1)
        FROM reviews r
        JOIN bookings b ON r.booking_id = b.id
        WHERE b.listing_id = (SELECT listing_id FROM bookings WHERE id = NEW.booking_id)
          AND r.author_type = 'guest'
          AND r.is_public = TRUE
      ),
      review_count = (
        SELECT COUNT(*)
        FROM reviews r
        JOIN bookings b ON r.booking_id = b.id
        WHERE b.listing_id = (SELECT listing_id FROM bookings WHERE id = NEW.booking_id)
          AND r.author_type = 'guest'
          AND r.is_public = TRUE
      )
    WHERE id = (SELECT listing_id FROM bookings WHERE id = NEW.booking_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_listing_rating_trigger
AFTER UPDATE OF is_public ON reviews
FOR EACH ROW
EXECUTE FUNCTION update_listing_rating();
```

## Deep Dive: Caching Strategy

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

```typescript
async function getListingDetails(listingId: number): Promise<Listing> {
  const cacheKey = `listing:${listingId}`;

  // 1. Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // 2. Cache miss - fetch from database
  const listing = await db('listings')
    .where('id', listingId)
    .first();

  // 3. Populate cache with TTL
  await redis.setex(cacheKey, 900, JSON.stringify(listing)); // 15 min

  return listing;
}
```

### Cache Invalidation

```typescript
async function updateListing(listingId: number, updates: Partial<Listing>): Promise<void> {
  await db('listings').where('id', listingId).update(updates);

  // Invalidate listing cache
  await redis.del(`listing:${listingId}`);

  // Invalidate search cache for affected area (by geo hash)
  const listing = await db('listings').where('id', listingId).first();
  const geoHash = computeGeoHash(listing.location, 4); // 4-char precision
  const searchKeys = await redis.keys(`search:${geoHash}:*`);
  if (searchKeys.length > 0) {
    await redis.del(...searchKeys);
  }
}

async function onBookingCreated(booking: Booking): Promise<void> {
  await redis.del(`availability:${booking.listing_id}`);
  await redis.publish('booking:created', JSON.stringify(booking));
}
```

### TTL Strategy by Data Type

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Listing details | 15 min | Property details change infrequently |
| Availability | 1 min | Must be fresh to prevent conflicts |
| Search results | 5 min | Slightly stale is acceptable |
| User sessions | 24 hours | Long-lived auth |
| Rate counters | 1 min | Fraud detection windows |

## Deep Dive: Async Processing with RabbitMQ

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

### Event Publishing

```typescript
import amqp from 'amqplib';

let channel: amqp.Channel;

async function initQueue(): Promise<void> {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();

  await channel.assertExchange('airbnb.events', 'topic', { durable: true });

  await channel.assertQueue('booking.events', {
    durable: true,
    deadLetterExchange: 'airbnb.dlx',
    messageTtl: 86400000 // 24 hours
  });

  await channel.bindQueue('booking.events', 'airbnb.events', 'booking.*');
}

async function publishBookingEvent(eventType: string, booking: Booking): Promise<void> {
  const message = {
    eventId: generateUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    data: booking
  };

  channel.publish(
    'airbnb.events',
    `booking.${eventType}`,
    Buffer.from(JSON.stringify(message)),
    {
      persistent: true,
      messageId: message.eventId,
      contentType: 'application/json'
    }
  );
}
```

### Idempotent Consumer

```typescript
async function startNotificationWorker(): Promise<void> {
  await channel.prefetch(10);

  channel.consume('notification.send', async (msg) => {
    if (!msg) return;

    const event = JSON.parse(msg.content.toString());

    try {
      // Idempotency check
      const processed = await redis.get(`processed:${event.eventId}`);
      if (processed) {
        channel.ack(msg);
        return;
      }

      // Process notification
      await sendNotification(event.data);

      // Mark as processed (TTL 7 days)
      await redis.setex(`processed:${event.eventId}`, 604800, '1');

      channel.ack(msg);
    } catch (error) {
      console.error('Notification failed:', error);

      const retries = (msg.properties.headers?.['x-retry-count'] || 0) + 1;
      if (retries < 3) {
        channel.nack(msg, false, false);
        await publishWithDelay(msg, retries);
      } else {
        channel.nack(msg, false, false); // Send to DLQ
      }
    }
  });
}
```

## Deep Dive: Observability

### Key Metrics

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

// Enable default metrics
promClient.collectDefaultMetrics({ prefix: 'airbnb_' });

const httpRequestDuration = new Histogram({
  name: 'airbnb_http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

const bookingCounter = new Counter({
  name: 'airbnb_bookings_total',
  help: 'Total number of bookings',
  labelNames: ['status', 'instant_book']
});

const searchLatency = new Histogram({
  name: 'airbnb_search_latency_seconds',
  help: 'Search request latency',
  labelNames: ['has_dates', 'has_guests'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1]
});

const cacheHitRatio = new Gauge({
  name: 'airbnb_cache_hit_ratio',
  help: 'Cache hit ratio by cache type',
  labelNames: ['cache_type']
});
```

### SLI Definitions

| SLI | Definition | Target | Alert Threshold |
|-----|------------|--------|-----------------|
| Availability | Successful requests / Total | 99.9% | < 99.5% for 5 min |
| Search Latency | p95 response time | < 200ms | > 500ms for 5 min |
| Booking Latency | p95 confirmation time | < 1s | > 2s for 5 min |
| Double-Booking Rate | Conflicting bookings / Total | 0% | > 0 in 1 hour |
| Cache Hit Rate | Cache hits / Total requests | > 80% | < 60% for 15 min |

### Distributed Tracing

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

const sdk = new NodeSDK({
  serviceName: 'airbnb-api',
  traceExporter: new JaegerExporter({
    endpoint: 'http://localhost:14268/api/traces'
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new PgInstrumentation()
  ]
});

sdk.start();

// Manual span for business logic
async function createBookingWithTracing(
  listingId: number,
  guestId: number,
  dates: DateRange
): Promise<Booking> {
  const tracer = trace.getTracer('booking-service');

  return tracer.startActiveSpan('createBooking', async (span) => {
    try {
      span.setAttributes({
        'booking.listing_id': listingId,
        'booking.guest_id': guestId,
        'booking.check_in': dates.checkIn.toISOString(),
        'booking.check_out': dates.checkOut.toISOString()
      });

      const booking = await createBooking(listingId, guestId, dates.checkIn, dates.checkOut);

      span.setAttributes({ 'booking.id': booking.id });
      return booking;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: 2, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### Audit Logging

```typescript
async function logAuditEvent(event: AuditEvent): Promise<void> {
  await db('audit_logs').insert({
    event_type: event.type,
    user_id: event.userId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    action: event.action,
    outcome: event.outcome,
    ip_address: event.ip,
    user_agent: event.userAgent,
    session_id: event.sessionId,
    request_id: event.requestId,
    metadata: JSON.stringify(event.metadata),
    before_state: event.beforeState ? JSON.stringify(event.beforeState) : null,
    after_state: event.afterState ? JSON.stringify(event.afterState) : null,
    created_at: new Date()
  });
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Calendar storage | Date ranges | Day-by-day rows | 18x storage reduction |
| Geo search | PostGIS | Elasticsearch geo | Single database, no sync |
| Double-booking | Transaction + row lock | Distributed lock | Simpler with single DB |
| Review visibility | Hidden until both | Immediate | Prevents retaliation |
| Cache strategy | Cache-aside | Write-through | Simpler invalidation |
| Message queue | RabbitMQ | Kafka | Simpler for booking scale |
| Tracing | OpenTelemetry + Jaeger | Zipkin | Vendor-neutral, better ecosystem |

## Future Backend Enhancements

1. **Elasticsearch Integration**: Full-text search on listing descriptions
2. **Dynamic Pricing**: ML-based price suggestions based on demand
3. **Multi-Region Deployment**: Read replicas per region with geo-routing
4. **Kafka for Events**: Higher throughput event streaming
5. **Payment Integration**: Stripe/Adyen with PCI compliance
6. **Fraud Detection**: ML model for suspicious booking patterns
