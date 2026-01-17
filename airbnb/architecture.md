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

## Caching and Edge Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CDN (CloudFront/nginx)                  │
│     Static assets, listing images, search result pages         │
│     TTL: 1 hour for images, 5 min for search pages             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Valkey/Redis Cluster                      │
│     Session cache, listing details, availability snapshots     │
│     TTL: 15 min listing, 1 min availability, 24h sessions      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PostgreSQL + PostGIS                          │
│                 Source of truth for all data                    │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Strategy by Data Type

| Data Type | Strategy | TTL | Invalidation |
|-----------|----------|-----|--------------|
| Listing details | Cache-aside | 15 min | On listing update |
| Listing images | CDN with origin pull | 1 hour | Version in URL |
| Search results | Cache-aside | 5 min | Time-based expiry |
| Availability | Cache-aside | 1 min | On booking/update |
| User sessions | Write-through | 24 hours | On logout/expiry |
| Review aggregates | Cache-aside | 30 min | On new review |

### Cache-Aside Pattern (Read Path)

```javascript
async function getListingDetails(listingId) {
  const cacheKey = `listing:${listingId}`

  // 1. Try cache first
  const cached = await redis.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  // 2. Cache miss - fetch from database
  const listing = await db('listings')
    .where('id', listingId)
    .first()

  // 3. Populate cache with TTL
  await redis.setex(cacheKey, 900, JSON.stringify(listing)) // 15 min

  return listing
}
```

### Write-Through Pattern (Session Management)

```javascript
async function createSession(userId, sessionData) {
  const sessionId = generateSecureId()
  const session = { userId, ...sessionData, createdAt: Date.now() }

  // Write to both cache and database atomically
  await Promise.all([
    redis.setex(`session:${sessionId}`, 86400, JSON.stringify(session)),
    db('sessions').insert({ id: sessionId, user_id: userId, data: session })
  ])

  return sessionId
}
```

### Cache Invalidation Rules

```javascript
// Invalidate on listing update
async function updateListing(listingId, updates) {
  await db('listings').where('id', listingId).update(updates)

  // Invalidate listing cache
  await redis.del(`listing:${listingId}`)

  // Invalidate search cache for affected area (by geo hash)
  const listing = await db('listings').where('id', listingId).first()
  const geoHash = computeGeoHash(listing.location, 4) // 4-char precision
  await redis.del(`search:${geoHash}:*`)
}

// Invalidate availability on booking
async function onBookingCreated(booking) {
  await redis.del(`availability:${booking.listing_id}`)

  // Publish event for downstream caches
  await redis.publish('booking:created', JSON.stringify(booking))
}
```

### Local Development Setup

```yaml
# docker-compose.yml addition for caching
services:
  valkey:
    image: valkey/valkey:8
    ports:
      - "6379:6379"
    command: valkey-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - valkey_data:/data
```

```bash
# Environment variables
REDIS_URL=redis://localhost:6379
CACHE_TTL_LISTING=900
CACHE_TTL_AVAILABILITY=60
CACHE_TTL_SEARCH=300
```

---

## Async Processing and Message Queue

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       API Services                              │
│            Listing / Booking / Search / Review                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                     RabbitMQ Exchange                           │
│                    (Topic Exchange)                             │
├─────────────────┬─────────────────┬─────────────────────────────┤
│ booking.created │ listing.updated │ search.reindex              │
│ booking.cancel  │ review.submitted│ notification.send           │
└─────────────────┴─────────────────┴─────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Notification  │    │ Search Index  │    │  Analytics    │
│   Worker      │    │   Worker      │    │   Worker      │
│               │    │               │    │               │
│ - Email       │    │ - ES update   │    │ - Metrics     │
│ - Push        │    │ - Cache warm  │    │ - Reports     │
│ - SMS         │    │               │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Queue Configuration

| Queue | Purpose | Delivery | DLQ Retention |
|-------|---------|----------|---------------|
| `booking.events` | Booking lifecycle | At-least-once | 7 days |
| `notification.send` | Email/push/SMS | At-least-once | 3 days |
| `search.reindex` | ES/cache updates | At-most-once | 1 day |
| `analytics.events` | Metrics/reporting | At-most-once | 1 day |

### Publishing Events

```javascript
const amqp = require('amqplib')

let channel

async function initQueue() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL)
  channel = await connection.createChannel()

  // Declare exchanges
  await channel.assertExchange('airbnb.events', 'topic', { durable: true })

  // Declare queues with dead-letter exchange
  await channel.assertQueue('booking.events', {
    durable: true,
    deadLetterExchange: 'airbnb.dlx',
    messageTtl: 86400000 // 24 hours
  })

  await channel.bindQueue('booking.events', 'airbnb.events', 'booking.*')
}

async function publishBookingEvent(eventType, booking) {
  const message = {
    eventId: generateUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    data: booking
  }

  channel.publish(
    'airbnb.events',
    `booking.${eventType}`,
    Buffer.from(JSON.stringify(message)),
    {
      persistent: true,
      messageId: message.eventId,
      contentType: 'application/json'
    }
  )
}
```

### Consumer with Idempotency

```javascript
async function startNotificationWorker() {
  await channel.prefetch(10) // Process 10 messages concurrently

  channel.consume('notification.send', async (msg) => {
    const event = JSON.parse(msg.content.toString())

    try {
      // Idempotency check
      const processed = await redis.get(`processed:${event.eventId}`)
      if (processed) {
        channel.ack(msg)
        return
      }

      // Process notification
      await sendNotification(event.data)

      // Mark as processed (TTL 7 days)
      await redis.setex(`processed:${event.eventId}`, 604800, '1')

      channel.ack(msg)
    } catch (error) {
      console.error('Notification failed:', error)

      // Retry up to 3 times, then dead-letter
      const retries = (msg.properties.headers?.['x-retry-count'] || 0) + 1
      if (retries < 3) {
        channel.nack(msg, false, false) // Requeue with delay
        await publishWithDelay(msg, retries)
      } else {
        channel.nack(msg, false, false) // Send to DLQ
      }
    }
  })
}
```

### Backpressure Handling

```javascript
// Producer-side rate limiting
const Bottleneck = require('bottleneck')

const limiter = new Bottleneck({
  maxConcurrent: 100,
  minTime: 10 // 100 messages per second max
})

async function publishWithBackpressure(exchange, routingKey, message) {
  return limiter.schedule(() =>
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)))
  )
}

// Consumer-side prefetch control
async function startWorkerWithBackpressure() {
  // Only fetch 5 messages at a time
  await channel.prefetch(5)

  // Monitor queue depth
  const queueInfo = await channel.checkQueue('booking.events')
  if (queueInfo.messageCount > 10000) {
    console.warn('Queue backlog detected, scaling consumers')
    metrics.gauge('queue.booking.depth', queueInfo.messageCount)
  }
}
```

### Background Jobs

| Job | Trigger | Frequency | Purpose |
|-----|---------|-----------|---------|
| `cleanup-expired-bookings` | Cron | Every 15 min | Cancel unpaid pending bookings |
| `aggregate-daily-stats` | Cron | Daily 3 AM | Roll up booking/revenue stats |
| `warm-search-cache` | Queue | On listing update | Pre-populate popular searches |
| `send-review-reminder` | Queue | 24h after checkout | Prompt guests to leave reviews |
| `sync-elasticsearch` | Queue | On data change | Keep search index current |

### Local Development Setup

```yaml
# docker-compose.yml addition for RabbitMQ
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"   # AMQP
      - "15672:15672" # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: airbnb
      RABBITMQ_DEFAULT_PASS: airbnb_dev
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
```

```bash
# Environment variables
RABBITMQ_URL=amqp://airbnb:airbnb_dev@localhost:5672
QUEUE_PREFETCH=10
QUEUE_RETRY_DELAY_MS=5000
```

---

## Observability

### Metrics, Logs, and Traces Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                      Grafana Dashboard                          │
│     SLI visualization, alerts, service health                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Prometheus   │    │    Loki       │    │   Jaeger      │
│   (Metrics)   │    │   (Logs)      │    │  (Traces)     │
│               │    │               │    │               │
│ - Counters    │    │ - Structured  │    │ - Spans       │
│ - Gauges      │    │   JSON logs   │    │ - Service map │
│ - Histograms  │    │ - Labels      │    │ - Latency     │
└───────────────┘    └───────────────┘    └───────────────┘
        ▲                     ▲                     ▲
        │                     │                     │
┌─────────────────────────────────────────────────────────────────┐
│                    Application Services                         │
│           prom-client + winston + opentelemetry                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Metrics

```javascript
const promClient = require('prom-client')

// Enable default metrics (CPU, memory, event loop)
promClient.collectDefaultMetrics({ prefix: 'airbnb_' })

// Custom business metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'airbnb_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
})

const bookingCounter = new promClient.Counter({
  name: 'airbnb_bookings_total',
  help: 'Total number of bookings',
  labelNames: ['status', 'instant_book']
})

const searchLatency = new promClient.Histogram({
  name: 'airbnb_search_latency_seconds',
  help: 'Search request latency',
  labelNames: ['has_dates', 'has_guests'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1]
})

const cacheHitRatio = new promClient.Gauge({
  name: 'airbnb_cache_hit_ratio',
  help: 'Cache hit ratio by cache type',
  labelNames: ['cache_type']
})

const queueDepth = new promClient.Gauge({
  name: 'airbnb_queue_depth',
  help: 'Number of messages in queue',
  labelNames: ['queue_name']
})
```

### SLI Definitions and Targets

| SLI | Definition | Target | Alert Threshold |
|-----|------------|--------|-----------------|
| Availability | Successful requests / Total requests | 99.9% | < 99.5% for 5 min |
| Search Latency | p95 of search response time | < 200ms | > 500ms for 5 min |
| Booking Latency | p95 of booking confirmation time | < 1s | > 2s for 5 min |
| Double-Booking Rate | Conflicting bookings / Total bookings | 0% | > 0 in 1 hour |
| Cache Hit Rate | Cache hits / Total cache requests | > 80% | < 60% for 15 min |
| Queue Lag | Time from publish to consume | < 30s | > 60s for 10 min |

### Structured Logging

```javascript
const winston = require('winston')

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'airbnb-api' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/app.log' })
  ]
})

// Request logging middleware
function requestLogger(req, res, next) {
  const start = Date.now()
  const requestId = req.headers['x-request-id'] || generateUUID()

  req.requestId = requestId
  res.setHeader('x-request-id', requestId)

  res.on('finish', () => {
    const duration = Date.now() - start
    logger.info('HTTP request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      userId: req.user?.id,
      userAgent: req.headers['user-agent']
    })

    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(duration / 1000)
  })

  next()
}
```

### Distributed Tracing

```javascript
const { NodeSDK } = require('@opentelemetry/sdk-node')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg')

const sdk = new NodeSDK({
  serviceName: 'airbnb-api',
  traceExporter: new JaegerExporter({
    endpoint: 'http://localhost:14268/api/traces'
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new PgInstrumentation()
  ]
})

sdk.start()

// Manual span for business logic
const { trace } = require('@opentelemetry/api')

async function createBooking(listingId, guestId, dates) {
  const tracer = trace.getTracer('booking-service')

  return tracer.startActiveSpan('createBooking', async (span) => {
    try {
      span.setAttributes({
        'booking.listing_id': listingId,
        'booking.guest_id': guestId,
        'booking.check_in': dates.checkIn,
        'booking.check_out': dates.checkOut
      })

      const booking = await executeBookingTransaction(listingId, guestId, dates)

      span.setAttributes({ 'booking.id': booking.id })
      return booking
    } catch (error) {
      span.recordException(error)
      span.setStatus({ code: 2, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}
```

### Audit Logging

```javascript
// Audit log for sensitive operations
const auditLogger = winston.createLogger({
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'logs/audit.log' })
  ]
})

async function logAuditEvent(event) {
  const auditEntry = {
    timestamp: new Date().toISOString(),
    eventType: event.type,
    actor: {
      userId: event.userId,
      ip: event.ip,
      userAgent: event.userAgent
    },
    resource: {
      type: event.resourceType,
      id: event.resourceId
    },
    action: event.action,
    outcome: event.outcome,
    metadata: event.metadata
  }

  auditLogger.info('audit', auditEntry)

  // Also persist to database for querying
  await db('audit_logs').insert({
    event_type: event.type,
    user_id: event.userId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    action: event.action,
    outcome: event.outcome,
    metadata: JSON.stringify(event.metadata),
    ip_address: event.ip,
    created_at: new Date()
  })
}

// Usage in booking flow
async function createBookingWithAudit(req, listingId, guestId, dates) {
  try {
    const booking = await createBooking(listingId, guestId, dates)

    await logAuditEvent({
      type: 'booking.created',
      userId: guestId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      resourceType: 'booking',
      resourceId: booking.id,
      action: 'create',
      outcome: 'success',
      metadata: { listingId, checkIn: dates.checkIn, checkOut: dates.checkOut }
    })

    return booking
  } catch (error) {
    await logAuditEvent({
      type: 'booking.failed',
      userId: guestId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      resourceType: 'listing',
      resourceId: listingId,
      action: 'create',
      outcome: 'failure',
      metadata: { error: error.message }
    })

    throw error
  }
}
```

### Alert Rules (Prometheus)

```yaml
# prometheus/alerts.yml
groups:
  - name: airbnb-slis
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(airbnb_http_request_duration_seconds_count{status=~"5.."}[5m]))
          / sum(rate(airbnb_http_request_duration_seconds_count[5m])) > 0.005
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Error rate above 0.5% for 5 minutes

      - alert: SearchLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(airbnb_search_latency_seconds_bucket[5m])) by (le)
          ) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: Search p95 latency above 500ms

      - alert: BookingLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(airbnb_http_request_duration_seconds_bucket{route="/api/bookings"}[5m])) by (le)
          ) > 2
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Booking p95 latency above 2s

      - alert: CacheHitRateLow
        expr: airbnb_cache_hit_ratio{cache_type="listing"} < 0.6
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: Cache hit rate below 60%

      - alert: QueueBacklogHigh
        expr: airbnb_queue_depth{queue_name="booking.events"} > 10000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: Queue depth exceeds 10k messages
```

### Local Development Setup

```yaml
# docker-compose.yml addition for observability
services:
  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus:/etc/prometheus
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./grafana/datasources:/etc/grafana/provisioning/datasources

  loki:
    image: grafana/loki:2.8.0
    ports:
      - "3100:3100"
    volumes:
      - loki_data:/loki

  jaeger:
    image: jaegertracing/all-in-one:1.47
    ports:
      - "16686:16686" # UI
      - "14268:14268" # Collector

volumes:
  prometheus_data:
  grafana_data:
  loki_data:
```

```bash
# Environment variables
PROMETHEUS_METRICS_PORT=9091
JAEGER_ENDPOINT=http://localhost:14268/api/traces
LOKI_URL=http://localhost:3100
LOG_LEVEL=info
ENABLE_AUDIT_LOGGING=true
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Calendar | Date ranges | Day-by-day | Storage efficiency |
| Geo search | PostGIS | Elasticsearch geo | Simplicity |
| Double-booking | Transaction lock | Distributed lock | Single DB is simpler |
| Reviews | Hidden until both submit | Immediate | Fairness |
| Caching | Cache-aside + write-through | Write-behind | Simpler invalidation, acceptable latency |
| Cache store | Valkey/Redis | Memcached | Richer data types, pub/sub for invalidation |
| Message queue | RabbitMQ | Kafka | Simpler setup, sufficient for booking throughput |
| Delivery semantics | At-least-once + idempotency | Exactly-once | Simpler, reliable with dedup |
| Tracing | OpenTelemetry + Jaeger | Zipkin | Vendor-neutral, better ecosystem |
| Logging | Structured JSON | Plain text | Query-friendly, Loki/ELK compatible |
