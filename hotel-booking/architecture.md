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

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (RootLayout)
├── Header (navigation, auth status, admin link)
├── <Outlet /> (route-specific content)
│   ├── index.tsx (HomePage)
│   │   └── SearchBar (variant="hero")
│   ├── search.tsx (SearchResultsPage)
│   │   ├── SearchBar (variant="compact")
│   │   └── HotelCard[] (search results grid)
│   ├── hotels.$hotelId.tsx (HotelDetailPage)
│   │   ├── AvailabilityCalendar
│   │   └── RoomTypeCard[] (room types with pricing)
│   ├── booking.tsx (BookingPage)
│   ├── bookings.index.tsx (MyBookingsPage)
│   │   └── BookingCard[] (booking history)
│   ├── bookings.$bookingId.tsx (BookingDetailPage)
│   ├── login.tsx / register.tsx (AuthPages)
│   ├── admin.index.tsx (AdminDashboard)
│   │   ├── HotelSelector
│   │   ├── StatsGrid
│   │   ├── CreateHotelModal
│   │   ├── DashboardHotelCard[]
│   │   └── BookingsTable
│   └── admin.hotels.$hotelId.tsx (AdminHotelPage)
│       ├── HotelHeader
│       ├── AdminRoomTypeCard[]
│       ├── RoomTypeModal
│       └── PricingModal
└── Footer (static footer content)
```

### Zustand Stores

**`authStore`** -- Manages user authentication state with persistence. Stores the JWT token in localStorage via Zustand's `persist` middleware, but only persists the token itself (not the full user object). On app startup, `checkAuth()` validates the stored token by calling `GET /api/v1/auth/me` and restores the user session if the token is still valid. Supports three roles: `user`, `hotel_admin`, and `admin`. The store also synchronizes the token with the API service singleton so all subsequent fetch calls include the `Authorization` header.

**`searchStore`** -- Maintains search parameters (city, dates, guests, rooms, sort order, pagination) as a single object with merge-based updates. The `setParams` action performs shallow merge, allowing individual fields to be updated without resetting others. Used by the `SearchBar` component to persist search criteria across navigation (e.g., user clicks into a hotel detail page and navigates back to search results without losing filters). Does not persist to localStorage -- search state resets on page refresh.

### Routing

TanStack Router with file-based routing. Routes are organized into two groups:

- **Guest routes**: `/` (home), `/search` (results), `/hotels/$hotelId` (detail), `/booking` (checkout), `/bookings` (history), `/bookings/$bookingId` (detail), `/login`, `/register`
- **Admin routes**: `/admin` (dashboard), `/admin/hotels/$hotelId` (hotel management with room types and pricing)

The root layout (`__root.tsx`) renders the `Header` and `Footer` around an `<Outlet />`. There is no route-level authentication guard; instead, individual pages check `useAuthStore().isAuthenticated` and redirect to `/login` when needed.

### Data Fetching

All API communication flows through a centralized `ApiService` class (`services/api.ts`) that wraps `fetch` with automatic JSON parsing, error handling, and auth header injection. The service is a singleton instance exported as `api`. There is no React Query or SWR -- data fetching happens in `useEffect` hooks within route components, storing results in local `useState`. This means there is no automatic cache invalidation, background refetching, or stale-while-revalidate behavior. The search results page calls `api.searchHotels()` on mount and when search params change. The hotel detail page calls `api.getHotel()` with optional date parameters to include availability data.

### Key UI Patterns

- **Availability Calendar**: The `AvailabilityCalendar` component fetches per-day availability and pricing data for a room type and month. It renders a calendar grid where each day cell shows the available room count and nightly price. Days with no availability are grayed out. Clicking a date sets check-in or check-out in the search store, enabling a visual date-selection flow.
- **Dynamic Pricing Display**: Room type cards show per-night prices that may differ from the base price when date-specific overrides are in effect. The `PricingModal` in the admin dashboard lets hotel admins set individual date overrides.
- **Booking Status Lifecycle**: The `BookingCard` component renders different action buttons based on booking status. A `reserved` booking shows "Confirm" and "Cancel" buttons with the remaining hold time. A `confirmed` booking shows the cancellation policy. A `completed` booking shows a review submission form.
- **Admin Dashboard**: The admin section uses a hotel selector dropdown for multi-property admins, a stats grid showing key metrics (total bookings, revenue, occupancy), and a bookings table with status filtering.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in the project. Each explanation covers what the pattern is, why it exists, how it works in this project, and what would go wrong without it.

### RBAC (Role-Based Access Control)

**What it is**: RBAC is an authorization model where permissions are assigned to roles, and users are assigned to roles. Instead of checking "can user X do action Y?" for every user individually, the system checks "does user X have a role that includes permission Y?" This creates a layer of indirection that simplifies permission management.

**Why it exists**: Without RBAC, you would need to maintain a per-user permission list. If you have 10,000 hotel admins and want to add a new permission (e.g., "export booking reports"), you would need to update 10,000 records. With RBAC, you update the `hotel_admin` role once. RBAC also prevents privilege escalation -- a regular user cannot access admin endpoints because the middleware rejects their role before the request reaches business logic.

**How it works here**: The `users` table has a `role` column with values `user`, `hotel_admin`, or `admin`. The auth middleware reads the session, attaches the user object (including role) to the request, and route-level middleware checks `req.user.role`. For example, `POST /api/v1/admin/hotels` requires `hotel_admin` or `admin`. Hotel admins can only manage their own hotels (the query filters by `owner_id = req.user.id`), so RBAC is combined with resource-level ownership checks.

**What goes wrong without it**: Any authenticated user could create hotels, modify pricing, or view other users' bookings. A malicious user could set room prices to $0 or cancel other guests' reservations.

### Redis Cache-Aside

**What it is**: Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache miss, the application queries the database, stores the result in the cache with a TTL (time-to-live), and returns it. On a cache hit, the application returns the cached value without touching the database at all. The cache is "aside" from the main data path -- the database does not know the cache exists.

**Why it exists**: Database queries for availability checking involve complex SQL with `generate_series` and aggregate functions across date ranges. At 500 search requests per second, every search triggering these queries per hotel would overwhelm the database. Cache-aside reduces database load by serving repeated queries from Redis (sub-millisecond response) instead of PostgreSQL (5-20ms per query). The TTL ensures stale data eventually refreshes without manual invalidation for every read.

**How it works here**: Availability data is cached with keys like `availability:{hotel_id}:{room_type_id}:{checkIn}:{checkOut}` and a 5-minute TTL. When a user searches for hotels, the system checks Redis first for each hotel's availability. On a miss, it runs the PostgreSQL availability query and stores the result. When a booking is created, cancelled, or expires, the system explicitly invalidates the affected cache keys so the next request sees fresh data. Hotel detail pages and search result caches have their own TTLs (10 minutes and 2 minutes respectively).

**What goes wrong without it**: At 500 RPS, every search triggers availability queries for 20+ hotels. Each availability query joins bookings with a date range cross-product. The database would see 10,000+ complex queries per second, causing connection pool exhaustion and p95 latency spikes above 2 seconds.

### Circuit Breaker

**What it is**: A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing external service. It works like an electrical circuit breaker: when the failure rate exceeds a threshold, the breaker "opens" and immediately rejects subsequent requests without attempting the call. After a cooldown period, the breaker enters a "half-open" state where it allows a limited number of test requests. If those succeed, the breaker "closes" and normal traffic resumes. If they fail, the breaker opens again.

**Why it exists**: Without a circuit breaker, when an external service (like Elasticsearch or a payment gateway) goes down, every incoming request still attempts to call it. Each attempt waits for the full timeout (e.g., 10 seconds) before failing. Under load, this causes thread/connection pool exhaustion, cascading timeouts, and eventually takes down the entire application. The circuit breaker short-circuits these requests, returning a failure in milliseconds instead of seconds, and provides a fallback path.

**How it works here**: The project uses the Opossum library to wrap calls to three external dependencies. The Elasticsearch circuit breaker opens after 50% of the last 10 requests fail, with a 20-second reset timeout. Its fallback is PostgreSQL full-text search (slower but functional). The payment circuit breaker opens at 30% failure rate with a 60-second reset. Its fallback queues the booking for later processing. The availability API breaker returns "unavailable" as a fallback. Each breaker exposes Prometheus metrics (`circuit_breaker_state`, `circuit_breaker_failures_total`) so operators can see breaker status on dashboards.

**What goes wrong without it**: If Elasticsearch goes down and search receives 500 RPS, all 500 requests per second wait 5 seconds for the ES timeout, consuming 2,500 concurrent connections. The API server's connection pool and event loop become saturated, causing booking and admin endpoints (which do not use Elasticsearch) to also become unresponsive. A single dependency failure takes down the entire service.

### Structured Logging

**What it is**: Structured logging means emitting log entries as machine-parseable data structures (typically JSON) rather than free-form text strings. Each log entry is a JSON object with consistent fields like `timestamp`, `level`, `message`, `requestId`, `userId`, `service`, and `duration`. This allows log aggregation systems (ELK stack, Datadog, Splunk) to index, search, and alert on specific fields rather than parsing arbitrary text with regex.

**Why it exists**: Unstructured logs like `"User 123 booked hotel 456 at 2024-01-15"` are human-readable but machine-hostile. You cannot easily count bookings per hotel, filter by user, or correlate a failed booking with the search that preceded it. Structured logging enables queries like "show all log entries where `event=booking_created` and `hotelId=456` and `duration > 1000ms`" -- questions that are unanswerable with grep on text logs.

**How it works here**: The project uses Pino, a high-performance JSON logger for Node.js. Each request gets a unique `requestId` (from the `X-Request-ID` header or auto-generated) that propagates through all log entries for that request. Business events are logged with domain-specific context: `booking_created` includes `bookingId`, `hotelId`, `roomTypeId`, `totalPrice`, and `duration`. The logger is configured at `backend/src/shared/logger.ts` and injected into route handlers via middleware.

**What goes wrong without it**: When a customer reports "my booking failed," the support team greps server logs for their email. They find 50 log lines that mention the email across search, availability, booking, and payment operations. Without structured fields, they cannot determine which booking attempt failed, why it failed, or how long the failure took. Debugging takes hours instead of seconds.

### Prometheus Metrics

**What it is**: Prometheus is a time-series monitoring system that scrapes metrics from application endpoints at regular intervals (typically every 15-30 seconds). The application exposes a `/metrics` endpoint that returns all current metric values in Prometheus text format. Metrics come in four types: counters (monotonically increasing values like total requests), gauges (point-in-time values like active connections), histograms (distributions of values like request latency), and summaries (pre-calculated quantiles).

**Why it exists**: Logs tell you what happened to individual requests. Metrics tell you what is happening to the system overall. "How many bookings per minute are we processing?" "What is the p95 latency for search?" "Is the cache hit rate dropping?" These questions require aggregated numerical data over time, not individual log entries. Metrics also power alerting: "page the on-call engineer when the booking failure rate exceeds 5% for 5 minutes."

**How it works here**: The project uses the `prom-client` library and exposes 16+ metrics at `GET /metrics`. Business metrics include `bookings_created_total` (counter by status), `booking_creation_duration_seconds` (histogram), `search_duration_seconds` (histogram), and `availability_cache_hits_total` / `availability_cache_misses_total` (counters). Infrastructure metrics include `http_requests_total` (counter by method/path/status), `http_request_duration_seconds` (histogram), `db_pool_active` (gauge), and `distributed_lock_acquisitions_total` (counter by success/failure). These metrics feed the alerting thresholds defined in the Observability section.

**What goes wrong without it**: The team discovers the booking system is slow only when customers complain on social media. They have no historical data to determine when the slowdown started, no ability to correlate it with a deployment or traffic spike, and no alerting to catch the problem before customers notice.

### Rate Limiting

**What it is**: Rate limiting restricts how many requests a client can make to an endpoint within a time window. When a client exceeds the limit, subsequent requests receive a `429 Too Many Requests` response until the window resets. Rate limits are typically tracked per user, per IP address, or per API key using counters stored in Redis with expiration.

**Why it exists**: Without rate limiting, a single misbehaving client (whether a bug, a bot, or a malicious actor) can consume disproportionate server resources. A script that calls the search endpoint 10,000 times per second would starve legitimate users of capacity. Rate limiting also prevents credential stuffing attacks (testing thousands of stolen passwords against the login endpoint) and mitigates accidental DDoS from buggy client applications that retry in tight loops.

**How it works here**: Four rate limit tiers are defined. Login is limited to 5 requests per minute per IP (prevents brute force). Search is limited to 30 per minute per user (prevents scraping). Booking creation is limited to 10 per minute per user (prevents inventory abuse). All other endpoints default to 100 per minute. Each limit is tracked in Redis with sliding window counters. When a limit is exceeded, the response includes a `Retry-After` header telling the client when to try again.

**What goes wrong without it**: A competitor's bot scrapes hotel pricing by calling the search endpoint 1,000 times per second with different parameters. The Elasticsearch cluster is overwhelmed, search latency for real users exceeds 5 seconds, and the database connection pool is exhausted by cache misses. The attack costs nothing to the attacker and degrades the experience for all legitimate users.

### Idempotency

**What it is**: Idempotency means that performing the same operation multiple times produces the same result as performing it once. In the context of HTTP APIs, an idempotent endpoint returns the same response whether called once or ten times with the same parameters. This is achieved by generating a deterministic key from the request parameters, checking whether that key has been seen before, and returning the cached result if it has.

**Why it exists**: Network unreliability makes duplicate requests inevitable. A user clicks "Book Now," the request succeeds on the server, but the response is lost due to a network timeout. The user's browser shows an error and they click again. Without idempotency, the second click creates a second booking and the user is charged twice. Load balancers also retry requests when upstream servers timeout, potentially creating duplicates that the user never initiated.

**How it works here**: The booking endpoint generates an idempotency key from `SHA-256(userId + hotelId + roomTypeId + checkIn + checkOut + roomCount)`. Before processing a new booking, the system checks Redis for a cached result with this key. If found, it returns the existing booking. If not found, it also checks the `idempotency_key` column in the bookings table (which has a unique constraint) as a durable fallback. After successfully creating a booking, the result is cached in Redis with a 24-hour TTL and stored in the database. This two-layer approach (Redis for speed, PostgreSQL for durability) handles the case where Redis restarts between the first and second request.

**What goes wrong without it**: Double-bookings from network retries. The user sees two charges on their credit card. Hotel inventory shows fewer available rooms than reality because the same booking was counted twice. Customer support is overwhelmed with "I was charged twice" tickets.

### Health Checks

**What it is**: Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They return a structured response indicating the status of each component (database, cache, external services) along with latency measurements. Health checks are consumed by load balancers (to route traffic away from unhealthy instances), container orchestrators (to restart failing containers), and monitoring dashboards (to visualize system health).

**Why it exists**: An API server might be running (process alive, accepting TCP connections) but unable to serve requests because its database connection pool is exhausted, Redis is unreachable, or Elasticsearch is not responding. Without health checks, the load balancer continues sending traffic to this unhealthy instance, and every request fails. Health checks allow the infrastructure to detect these partial failures and take corrective action automatically.

**How it works here**: The health check endpoint at `GET /health` tests three components: PostgreSQL (executes `SELECT 1` and measures latency), Redis (executes `PING` and measures latency), and Elasticsearch (checks cluster health). Each component is reported as `ok` or `error` with its latency in milliseconds. The overall status is `ok` only if all components are healthy. The response includes uptime and environment information. This endpoint supports both Kubernetes-style liveness/readiness probes and human-readable status dashboards.

**What goes wrong without it**: A server's PostgreSQL connection pool fills up (100/100 connections in use). The server keeps accepting new HTTP connections from the load balancer but every database query hangs, eventually timing out after 30 seconds. Users see spinning loaders. The load balancer does not know the instance is unhealthy because TCP connections succeed. Other healthy instances exist but receive no additional traffic because the load balancer distributes evenly across all instances including the broken one.

---

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
