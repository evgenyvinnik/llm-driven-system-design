# Hotel Booking - Hotel Reservation and Management System - Architecture Design

## System Overview

A hotel reservation and management system with inventory management, dynamic pricing, and booking capabilities. The system handles search across thousands of hotels, prevents room overselling under concurrent access, and supports both guest and hotel admin workflows.

## Requirements

### Functional Requirements

- Hotel and room inventory management (CRUD for hotels, room types, pricing)
- Search and filtering (location, dates, price, amenities, star rating)
- Booking and reservation system with double-booking prevention
- Dynamic pricing with date-specific overrides
- Payment processing with reservation hold pattern (15-minute expiry)
- Booking modifications and cancellations
- Reviews and ratings for completed stays
- Hotel admin dashboard for managing properties

### Non-Functional Requirements

- **Scalability**: Support 5,000 peak concurrent sessions, 500 RPS search, 10 RPS bookings
- **Availability**: 99.9% uptime (allows ~8.7 hours downtime/year)
- **Latency**: Search p95 < 500ms, Booking p95 < 1s, Page loads p95 < 2s
- **Consistency**: Strong consistency for bookings (no double-booking), eventual consistency acceptable for search (5-minute stale data OK)

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Daily Active Users (DAU) | 100,000 |
| Peak concurrent sessions | 5,000 |
| Searches per second (peak) | 500 RPS |
| Bookings per second (peak) | 10 RPS |
| Hotels in system | 50,000 |
| Room types per hotel (avg) | 5 |
| Bookings per day | 10,000 |

### Storage Requirements (Production)

| Data Type | Size per Unit | Annual Volume | Annual Growth |
|-----------|---------------|---------------|---------------|
| Hotels | 2 KB | 50,000 | 100 MB |
| Room Types | 1 KB | 250,000 | 250 MB |
| Bookings | 500 B | 3.65M | 1.8 GB |
| Reviews | 1 KB | 1M | 1 GB |
| Search Index (ES) | 5 KB/hotel | 50,000 | 250 MB |
| Sessions (Redis) | 200 B | 5,000 peak | Rotating (TTL) |

## High-Level Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│   Guest Browser  │   │  Hotel Admin UI  │   │   Mobile App     │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │                      │                       │
         └──────────────────────┼───────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                    CDN (Static Assets)                        │
└───────────────────────────┬───────────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────────┐
│              API Gateway / Load Balancer                      │
│         (Rate limiting, SSL termination, routing)            │
└───────────────────────────┬───────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ API Server  │     │ API Server  │     │ API Server  │
│    (1)      │     │    (2)      │     │    (N)      │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
┌─────────────┐    ┌─────────────┐    ┌──────────────────┐
│ PostgreSQL  │    │ Redis/      │    │ Elasticsearch    │
│ Primary     │    │ Valkey      │    │                  │
│             │    │             │    │ Hotel search     │
│ Hotels      │    │ Sessions    │    │ Geo queries      │
│ Rooms       │    │ Avail cache │    │ Faceted filters  │
│ Bookings    │    │ Dist. locks │    │                  │
│ Users       │    │ Idempotency │    │                  │
│ Reviews     │    │             │    │                  │
└──────┬──────┘    └─────────────┘    └──────────────────┘
       │
       ▼
┌─────────────┐
│ PostgreSQL  │
│ Read        │
│ Replicas    │
└─────────────┘

                   ┌──────────────────┐
                   │  Background      │
                   │  Worker          │
                   │                  │
                   │ - Reservation    │
                   │   expiry         │
                   │ - ES sync        │
                   │ - Notifications  │
                   └──────────────────┘
```

### Core Components

| Component | Responsibility |
|-----------|---------------|
| API Gateway/LB | Route requests, SSL termination, rate limiting |
| API Server | Business logic, authentication, request handling (Node.js + Express) |
| PostgreSQL | Source of truth for hotels, rooms, bookings, users (ACID) |
| Redis/Valkey | Session storage, availability caching, distributed locks, idempotency |
| Elasticsearch | Full-text search, geo-distance queries, faceted filtering |
| Background Worker | Expire stale reservations, sync ES index, send notifications |

## Core Components / Request Flows

### Search Flow (Read-Heavy, Eventually Consistent)

```
1. User submits search (location: "NYC", dates: Jan 15-17, guests: 2)
2. Load balancer routes to API Server (round-robin)
3. API Server queries Elasticsearch for matching hotels
   - Geo-distance filter (50km from city center)
   - Amenity filters, price range, star rating
   - Returns hotel IDs + metadata
4. For each hotel, check Redis availability cache
   - Cache key: availability:{hotel_id}:{YYYY-MM}
   - If cache miss, query PostgreSQL and populate cache (TTL: 5 min)
5. Filter to hotels with available rooms for the date range
6. Return ranked results to user
```

### Booking Flow (Write, Strongly Consistent)

```
1. User selects hotel, room type, dates (Jan 15-17)
2. Generate idempotency key from: userId + hotelId + roomTypeId + checkIn + checkOut
3. Check Redis for existing booking with this idempotency key
4. Acquire distributed lock: lock:room:{hotelId}:{roomTypeId}:{checkIn}:{checkOut}
5. Begin PostgreSQL transaction
   a. SELECT ... FOR UPDATE on room_types row (pessimistic lock)
   b. Check availability: count overlapping confirmed/reserved bookings vs total_rooms
   c. If available: INSERT booking with status='reserved', reserved_until=NOW()+15min
   d. COMMIT
6. Invalidate Redis availability cache for affected dates
7. Return reservation to user (15-minute payment window)
8. On payment: UPDATE booking status='confirmed', clear reserved_until
9. Release distributed lock
```

### Reservation Expiry Flow (Background)

```
Every 60 seconds:
1. SELECT * FROM bookings WHERE status='reserved' AND reserved_until < NOW()
2. For each expired reservation:
   a. UPDATE status='expired'
   b. Invalidate availability cache
   c. Increment bookings_expired_total metric
```

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'hotel_admin', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Hotels table
CREATE TABLE hotels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  address TEXT NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100),
  country VARCHAR(50) NOT NULL,
  postal_code VARCHAR(20),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  star_rating INTEGER CHECK (star_rating BETWEEN 1 AND 5),
  amenities TEXT[] DEFAULT '{}',
  check_in_time TIME DEFAULT '15:00',
  check_out_time TIME DEFAULT '11:00',
  cancellation_policy TEXT DEFAULT 'Free cancellation up to 24 hours before check-in',
  images TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_hotels_city ON hotels(city);
CREATE INDEX idx_hotels_country ON hotels(country);
CREATE INDEX idx_hotels_location ON hotels(latitude, longitude);
CREATE INDEX idx_hotels_active ON hotels(is_active) WHERE is_active = true;

-- Room types table
CREATE TABLE room_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id UUID REFERENCES hotels(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  bed_type VARCHAR(50),
  total_count INTEGER NOT NULL CHECK (total_count > 0),
  base_price DECIMAL(10, 2) NOT NULL CHECK (base_price > 0),
  amenities TEXT[] DEFAULT '{}',
  images TEXT[] DEFAULT '{}',
  size_sqm INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_room_types_hotel ON room_types(hotel_id);
CREATE INDEX idx_room_types_active ON room_types(is_active) WHERE is_active = true;

-- Pricing overrides table (for dynamic pricing)
CREATE TABLE pricing_overrides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_type_id UUID REFERENCES room_types(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  price DECIMAL(10, 2) NOT NULL CHECK (price > 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_type_id, date)
);
CREATE INDEX idx_pricing_overrides_room_date ON pricing_overrides(room_type_id, date);

-- Bookings table
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  hotel_id UUID REFERENCES hotels(id),
  room_type_id UUID REFERENCES room_types(id),
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  room_count INTEGER NOT NULL CHECK (room_count > 0),
  guest_count INTEGER NOT NULL CHECK (guest_count > 0),
  total_price DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'reserved', 'confirmed', 'cancelled', 'completed', 'expired')),
  payment_id VARCHAR(100),
  idempotency_key VARCHAR(64) UNIQUE,
  reserved_until TIMESTAMP WITH TIME ZONE,
  guest_first_name VARCHAR(100) NOT NULL,
  guest_last_name VARCHAR(100) NOT NULL,
  guest_email VARCHAR(255) NOT NULL,
  guest_phone VARCHAR(20),
  special_requests TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_dates CHECK (check_out > check_in)
);
CREATE INDEX idx_bookings_hotel_dates ON bookings(hotel_id, room_type_id, check_in, check_out);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_reserved_until ON bookings(reserved_until) WHERE status = 'reserved';

-- Reviews table
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID REFERENCES bookings(id) UNIQUE,
  user_id UUID REFERENCES users(id),
  hotel_id UUID REFERENCES hotels(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title VARCHAR(200),
  content TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_reviews_hotel ON reviews(hotel_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);

-- Sessions table
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

### Availability Query

Uses `generate_series` to check each night in the date range and find the peak concurrent bookings:

```sql
SELECT rt.total_count - COALESCE(booked.count, 0) AS available_rooms
FROM room_types rt
LEFT JOIN (
    SELECT room_type_id, MAX(nightly_bookings) AS count
    FROM (
        SELECT room_type_id, d::date, COUNT(*) AS nightly_bookings
        FROM bookings b
        CROSS JOIN generate_series(b.check_in, b.check_out - INTERVAL '1 day', '1 day') AS d
        WHERE b.room_type_id = $1
          AND b.status IN ('reserved', 'confirmed')
          AND d::date >= $2 AND d::date < $3
        GROUP BY room_type_id, d::date
    ) nightly
    GROUP BY room_type_id
) booked ON rt.id = booked.room_type_id
WHERE rt.id = $1;
```

### Caching Strategy

| Cache Key Pattern | TTL | Invalidation Trigger |
|------------------|-----|---------------------|
| `session:{session_id}` | 24 hours | Logout, password change |
| `availability:{hotel_id}:{room_type_id}:{checkIn}:{checkOut}` | 5 minutes | Booking create/cancel/expire |
| `hotel:{hotel_id}` | 10 minutes | Hotel update |
| `search:{query_hash}` | 2 minutes | None (short TTL only) |

Cache-aside pattern: check Redis first, on miss query PostgreSQL, store with TTL, return.

## API Design

### Core Endpoints

```
Authentication
  POST   /api/v1/auth/register          Create user account
  POST   /api/v1/auth/login             Create session
  POST   /api/v1/auth/logout            Destroy session
  GET    /api/v1/auth/me                Get current user

Hotels (Public)
  GET    /api/v1/hotels                 List hotels with filters
  GET    /api/v1/hotels/:id             Get hotel details
  GET    /api/v1/hotels/:id/rooms       Get room types and availability
  GET    /api/v1/hotels/:id/reviews     Get hotel reviews

Search
  POST   /api/v1/hotels/search          Search hotels (ES + availability)

Bookings
  POST   /api/v1/bookings               Create reservation (idempotent)
  GET    /api/v1/bookings               List user's bookings
  GET    /api/v1/bookings/:id           Get booking details
  POST   /api/v1/bookings/:id/confirm   Confirm after payment
  POST   /api/v1/bookings/:id/cancel    Cancel booking
  POST   /api/v1/bookings/:id/review    Submit review for completed stay

Admin
  GET    /api/v1/admin/hotels           List admin's hotels
  POST   /api/v1/admin/hotels           Create hotel
  PUT    /api/v1/admin/hotels/:id       Update hotel
  GET    /api/v1/admin/hotels/:id/bookings   List hotel bookings
  POST   /api/v1/admin/rooms            Create room type
  PUT    /api/v1/admin/rooms/:id        Update room type
  PUT    /api/v1/admin/rooms/:id/pricing    Set price overrides
```

## Key Design Decisions

### 1. Concurrency Control: Pessimistic Locking + Distributed Lock

**Chose**: `SELECT ... FOR UPDATE` inside a Redis distributed lock

**Why this works**: Hotel booking has a critical invariant: the number of confirmed+reserved bookings for a room type on any given night must not exceed `total_count`. With multiple API servers, a database-level lock alone is insufficient because two servers can both read "1 room available" before either commits. The Redis distributed lock ensures only one server processes a booking for the same room type and date range at a time.

**Alternative**: Optimistic locking with version fields. Rejected because booking success rate matters more than throughput. At a 1:100 booking-to-search ratio, lock contention is rare, and a failed optimistic lock retry creates a poor user experience ("Sorry, try again").

**Trade-off**: ~30ms additional latency for lock acquisition. Acceptable given the 1-second p95 booking target.

### 2. Two-Phase Search: Elasticsearch + PostgreSQL

**Chose**: Elasticsearch for matching/filtering, PostgreSQL for real-time availability

**Why this works**: Full-text search, geo-distance queries, and faceted filtering are Elasticsearch strengths. But availability data changes with every booking and must be accurate. Combining both gives fast search (~50ms for ES) with accurate availability (~10ms per hotel from Redis cache or PostgreSQL).

**Alternative**: PostgreSQL-only search with `tsvector` and PostGIS. Would work but lacks faceted filtering, relevance scoring, and scales poorly for geo queries across 50,000 hotels.

**Trade-off**: Additional infrastructure (Elasticsearch cluster). Justified because search is the primary user interaction and must be fast.

### 3. Reservation Hold Pattern (15-Minute Expiry)

**Chose**: Bookings start as "reserved" with 15-minute payment window, then "confirmed" after payment

**Why this works**: Prevents cart abandonment from blocking inventory indefinitely. Users get time to enter payment details without losing their room. Background worker expires stale reservations and releases inventory.

**Alternative**: No reservation phase (instant confirm-or-reject). Rejected because payment processing takes 5-30 seconds, and without a hold, another user could book the last room while the first user's payment is processing.

**Trade-off**: Some inventory is temporarily locked in abandoned carts. Mitigated by 15-minute expiry (shorter than Booking.com's 30-minute hold).

### 4. Dynamic Pricing with Override Table

**Chose**: Base price per room type with date-specific overrides in `pricing_overrides` table

**Why this works**: Hotels set a base price (e.g., $150/night for Standard) and override specific dates (New Year's Eve: $300, slow Tuesday: $99). Simple to implement, easy for hotel admins to manage.

**Alternative**: Algorithmic pricing based on demand signals. Deferred to future phase because it requires historical booking data and ML infrastructure.

## Consistency and Idempotency

### Idempotency for Booking Creation

Every booking request generates a deterministic idempotency key from `SHA-256(userId + hotelId + roomTypeId + checkIn + checkOut + roomCount)`. The system checks Redis cache first, then the `idempotency_key` column (unique constraint) in the bookings table.

Duplicate requests return the existing booking instead of creating a new one. This prevents double-charging from network retries, double-clicks, and load balancer retries.

### Distributed Lock for Room Selection

Redis SETNX with unique lock IDs and 30-second TTL. Lua script for atomic check-and-delete on release. Exponential backoff with jitter for retry. Lock key format: `lock:room:{hotelId}:{roomTypeId}:{checkIn}:{checkOut}`.

## Security / Auth

### Authentication

Session-based with Redis-backed storage. Sessions stored with 24-hour TTL, HTTP-only secure cookies.

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| `user` | Search, book, view own bookings, submit reviews |
| `hotel_admin` | Manage own hotels, view hotel bookings, set pricing |
| `admin` | All operations, user management, system config |

### Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/v1/auth/login` | 5 requests | 1 minute |
| `/api/v1/hotels/search` | 30 requests | 1 minute |
| `/api/v1/bookings` (POST) | 10 requests | 1 minute |
| Default | 100 requests | 1 minute |

### Data Protection

- Passwords hashed with bcryptjs
- Parameterized queries prevent SQL injection
- No PII in logs

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_requests_total{method,path,status}` | Counter | Request volume and error rates |
| `http_request_duration_seconds{method,path}` | Histogram | Latency distribution |
| `bookings_created_total{status}` | Counter | Booking creation by outcome |
| `bookings_confirmed_total{hotel_id}` | Counter | Successful confirmations |
| `bookings_cancelled_total{hotel_id,reason}` | Counter | Cancellation tracking |
| `bookings_expired_total` | Counter | Stale reservation expiry |
| `booking_creation_duration_seconds` | Histogram | End-to-end booking latency |
| `search_duration_seconds` | Histogram | Search latency |
| `availability_cache_hits_total` | Counter | Cache effectiveness |
| `availability_cache_misses_total` | Counter | Cache misses |
| `distributed_lock_acquisitions_total{resource,success}` | Counter | Lock contention |
| `distributed_lock_wait_seconds{resource}` | Histogram | Lock wait time |
| `circuit_breaker_state{service}` | Gauge | Circuit breaker status |
| `circuit_breaker_failures_total{service}` | Counter | CB failure count |
| `idempotent_requests_total{deduplicated}` | Counter | Duplicate detection |
| `db_pool_active` | Gauge | Connection pool health |

### Structured Logging

Pino JSON logging with trace IDs propagated from load balancer (`X-Request-ID`). Business events (booking created, payment confirmed, reservation expired) logged with structured context.

### Health Checks

Multi-level health endpoints checking PostgreSQL, Redis, Elasticsearch. Returns component status with latencies. Supports liveness and readiness probes.

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| API p95 latency | > 500ms | > 2s |
| Error rate (5xx) | > 1% | > 5% |
| Database connections | > 80% pool | > 95% pool |
| Redis memory | > 70% | > 90% |
| Booking failure rate | > 5% | > 10% |

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Elasticsearch query | 3 | Exponential | Safe (read-only) |
| Redis cache | 1 | None | Safe (cache-aside) |
| Booking creation | 0 | None | Idempotency key required |
| Payment confirmation | 3 | Exponential | Idempotency key required |

### Circuit Breaker Pattern

Uses Opossum library for circuit breakers on external service calls:

| Service | Failure Threshold | Reset Timeout | Call Timeout |
|---------|------------------|---------------|-------------|
| Payment | 30% failures | 60s | 10s |
| Availability API | 50% failures | 30s | 3s |
| Elasticsearch | 50% failures | 20s | 5s |

Each circuit breaker has a fallback: payment queues for later, availability returns "unavailable", Elasticsearch falls back to PostgreSQL search.

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|------------------|
| Elasticsearch down | Search falls back to PostgreSQL (slower, limited filtering) |
| Redis down | Sessions fail (force re-login), skip availability cache, use DB locks only |
| Payment gateway down | Queue booking, notify user of delay via circuit breaker fallback |

## Scalability Considerations

### Horizontal Scaling

| Component | Strategy |
|-----------|----------|
| API Servers | Add instances behind LB (stateless) |
| PostgreSQL | Read replicas for search/availability reads |
| Redis | Redis Cluster for cache, Sentinel for HA |
| Elasticsearch | Add nodes to cluster |

### Database Scaling Path

1. **Current**: Single PostgreSQL instance
2. **Next**: Read replicas for search and availability queries
3. **Future**: Shard bookings by `hotel_id` hash (Citus or application-level)

### When to Add Components

| Trigger | Action |
|---------|--------|
| p95 latency > 500ms | Add API server instance |
| Cache hit rate < 80% | Increase Redis memory or TTL |
| DB CPU > 70% sustained | Add read replica |
| Search latency > 200ms | Add ES node |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Primary database | PostgreSQL | MongoDB | ACID transactions for inventory, relational integrity |
| Session storage | Redis sessions | JWT | Simpler revocation, no token rotation |
| Booking concurrency | Pessimistic locking | Optimistic locking | Higher success rate, rare contention |
| Search engine | Elasticsearch | PostgreSQL full-text | Better geo queries, faceted search |
| Message queue | None (background jobs) | RabbitMQ/Kafka | Simpler for current scale, add when needed |
| Reservation hold | 15-minute expiry | Instant confirm/reject | Payment processing needs time window |
| Pricing model | Base + date overrides | Algorithmic pricing | Simple to implement, easy for hotel admins |

## Implementation Notes

This section documents the actual local implementation: what production patterns are implemented, what was simplified, and what was omitted.

### Local Setup Diagram

```
┌──────────────────┐
│  React Frontend  │
│  localhost:5173   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Express API     │
│  localhost:3000   │
│  (or 3001-3003)  │
└──┬─────┬─────┬───┘
   │     │     │
   ▼     ▼     ▼
┌──────┐ ┌──────┐ ┌───────────────┐
│Pg    │ │Redis/│ │Elasticsearch  │
│:5432 │ │Valkey│ │:9200          │
│      │ │:6379 │ │               │
└──────┘ └──────┘ └───────────────┘
```

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| **Distributed Locking** | `backend/src/shared/distributedLock.ts` | Redis SETNX with unique lock IDs, Lua script release, exponential backoff, `withLock` helper |
| **Idempotency** | `backend/src/shared/idempotency.ts` | SHA-256 key generation, Redis cache + DB check, middleware for `X-Idempotency-Key` header |
| **Circuit Breaker** | `backend/src/shared/circuitBreaker.ts` | Opossum-based breakers for payment, availability, Elasticsearch with fallbacks |
| **Prometheus Metrics** | `backend/src/shared/metrics.ts` | Business metrics (bookings, search, cache), infrastructure metrics, exposed at `/metrics` |
| **Health Checks** | `backend/src/shared/healthCheck.ts` | Multi-component health with latency tracking |
| **Structured Logging** | `backend/src/shared/logger.ts` | Pino JSON logging with request context |
| **Reservation Expiry** | `backend/src/index.ts` | Background interval (60s) expiring stale reservations |
| **Two-Phase Search** | `backend/src/services/searchService.ts` | Elasticsearch matching + PostgreSQL availability verification |
| **Dynamic Pricing** | `backend/src/services/roomService.ts` | Base price with date-specific overrides from `pricing_overrides` table |
| **Availability Caching** | `backend/src/services/booking/` | Redis cache-aside with invalidation on booking state changes |
| **Pessimistic Locking** | `backend/src/services/booking/` | `SELECT ... FOR UPDATE` inside distributed lock for booking creation |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Reason |
|-------------------|------------------|--------|
| CDN for static assets | Vite dev server serves directly | No CDN needed for local dev |
| API Gateway (Kong/Envoy) | Express handles routing directly | Single process sufficient |
| Multiple API instances + nginx LB | Single instance (or 3 via `dev:server1/2/3`) | Can demo load balancing manually |
| Payment gateway (Stripe) | Simulated payment processing | No real payment integration |
| Redis Cluster/Sentinel | Single Redis instance | Sufficient for dev workloads |
| ES cluster (3+ nodes) | Single Elasticsearch node | 512MB heap, single-node mode |
| RabbitMQ for async jobs | In-process `setInterval` background jobs | Simpler for dev |
| Real email notifications | Not implemented | No SMTP service configured |
| PostgreSQL read replicas | Single PostgreSQL instance | Sufficient for dev |

### What Was Omitted

- **CDN / Edge caching** - No static asset distribution
- **Multi-region deployment** - Single-machine setup
- **Kubernetes orchestration** - Docker Compose only
- **Real payment gateway** - Simulated payments
- **Email/SMS notifications** - No notification delivery
- **Image upload to object storage** - Hotel images stored as URL references
- **Database read replicas** - Single PostgreSQL instance
- **Redis Sentinel/Cluster** - Single Redis instance
- **Automated schema migrations** - Uses init.sql loaded at container start
- **Mobile app API** - Web-only
- **Loyalty program** - Not implemented
- **Overbooking strategy** - Strict inventory limits only
- **ML-based dynamic pricing** - Manual date overrides only
