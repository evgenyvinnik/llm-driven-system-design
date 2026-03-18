# Calendly - Meeting Scheduling Platform - Architecture Design

## System Overview

A meeting scheduling platform that allows users to share their availability and let others book meetings without back-and-forth email coordination. The system handles availability computation across time zones, prevents double-bookings under concurrent access, and delivers reliable notifications for all booking lifecycle events.

## Requirements

### Functional Requirements

1. **Availability Management**
   - Users define working hours and availability (recurring weekly schedules)
   - Support for multiple meeting types (1-on-1, group, round-robin)
   - Buffer time before/after meetings
   - Maximum bookings per day limits

2. **Meeting Booking**
   - Invitees view available time slots and book meetings
   - Real-time availability checking with conflict prevention
   - Instant booking confirmation
   - Reschedule and cancel meetings

3. **Calendar Integration**
   - Sync with Google Calendar, Outlook, iCal
   - Check calendar for existing events during availability calculation
   - Create calendar events on booking
   - Two-way sync for updates/cancellations

4. **Time Zone Handling**
   - Automatic time zone detection for invitees
   - Display times in invitee's local time zone
   - All storage in UTC, conversion at display layer

5. **Notifications**
   - Email confirmations, reminders, cancellation/rescheduling notifications
   - Asynchronous delivery via message queue
   - Dead-letter queue for failed deliveries

6. **Booking Management**
   - Reschedule and cancel meetings
   - Custom booking questions and notes
   - Booking archival for data lifecycle management

### Non-Functional Requirements

- **Low Latency**: Availability checks < 200ms p95
- **High Availability**: 99.9% uptime for booking system
- **Consistency**: No double-bookings (strong consistency required)
- **Scalability**: Handle millions of users with varying booking frequencies
- **Security**: Secure calendar access tokens, prevent unauthorized access

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Daily Active Users (DAU) | 1M |
| Bookings per day | ~430K (3 bookings/user/week) |
| Availability checks per day | ~43M (100 checks per booking) |
| Peak availability RPS | ~5,000 |
| Peak booking RPS | ~50 |

### Storage Requirements (Production)

| Data Type | Estimate |
|-----------|----------|
| User data | 1M users x 10KB = 10GB |
| Meeting types | 1M users x 5 types x 5KB = 25GB |
| Bookings (annual) | 430K/day x 365 x 10KB = ~1.5TB/year |
| Calendar cache | 1M users x 100 events x 5KB = 500GB |

## High-Level Architecture

```
┌───────────────┐   ┌───────────────┐
│   Invitee     │   │   Host        │
│   (Browser)   │   │   (Browser)   │
└───────┬───────┘   └───────┬───────┘
        │                   │
        └─────────┬─────────┘
                  ▼
┌─────────────────────────────────────────────────┐
│               CDN / Edge Cache                  │
│          (Static assets, booking pages)         │
└─────────────────────┬───────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────┐
│             API Gateway / Load Balancer          │
│   (Rate limiting, SSL termination, routing)     │
└─────────────────────┬───────────────────────────┘
                      │
      ┌───────────────┼───────────────┐
      ▼               ▼               ▼
┌───────────┐   ┌───────────┐   ┌───────────┐
│ API       │   │ API       │   │ API       │
│ Server 1  │   │ Server 2  │   │ Server N  │
└─────┬─────┘   └─────┬─────┘   └─────┬─────┘
      │               │               │
      └───────────────┼───────────────┘
                      │
    ┌─────────────────┼─────────────────┐
    │                 │                 │
    ▼                 ▼                 ▼
┌─────────┐    ┌───────────┐    ┌──────────────┐
│PostgreSQL│    │Redis/     │    │  RabbitMQ    │
│ Primary  │    │Valkey     │    │              │
│          │    │           │    │  Queues:     │
│ Users    │    │ Sessions  │    │  - Notifs    │
│ Meetings │    │ Avail.    │    │  - Reminders │
│ Bookings │    │   cache   │    │  - DLQ       │
│ Notifs   │    │ Idempot.  │    └──────┬───────┘
└────┬─────┘    │   keys    │           │
     │          └───────────┘           ▼
     │                          ┌──────────────┐
     │                          │ Notification │
     │                          │   Workers    │
     │                          │ (1..N)       │
     │                          └──────────────┘
     ▼
┌─────────┐
│PostgreSQL│
│ Read     │
│ Replicas │
└──────────┘

┌──────────────────────────────────────────────┐
│         External Calendar APIs               │
│   Google Calendar  │  Microsoft Graph (O365) │
└──────────────────────────────────────────────┘
```

### Core Components

1. **API Gateway / Load Balancer** - Request routing, SSL termination, rate limiting, authentication
2. **Booking Service** - Booking creation with double-booking prevention (pessimistic locking), idempotency, trigger notifications via queue
3. **Availability Service** - Compute available time slots by merging working hours, existing bookings, and external calendar events; cache results
4. **Integration Service** - OAuth flows for calendar providers, sync calendar events, create/update/delete external events
5. **Notification Service** - Async email delivery via RabbitMQ workers, scheduled reminders, dead-letter queue for failures

## Core Components / Request Flows

### 1. Creating a Booking

```
Client                  API Server              PostgreSQL              Redis           RabbitMQ
  │                        │                       │                     │                │
  │──POST /api/bookings───▶│                       │                     │                │
  │   (idempotency_key)    │                       │                     │                │
  │                        │──Check idempotency────▶│                     │                │
  │                        │   key in Redis         │                     │                │
  │                        │◀──────────────────────▶│                     │                │
  │                        │                        │                     │                │
  │                        │──BEGIN TRANSACTION────▶│                     │                │
  │                        │                        │                     │                │
  │                        │──SELECT availability_rules                   │                │
  │                        │   WHERE user_id = ?    │                     │                │
  │                        │◀──────────────────────▶│                     │                │
  │                        │                        │                     │                │
  │                        │──SELECT bookings       │                     │                │
  │                        │   WHERE host_user_id   │                     │                │
  │                        │   AND status='confirmed'│                    │                │
  │                        │   FOR UPDATE           │  (Row-level lock)   │                │
  │                        │◀──────────────────────▶│                     │                │
  │                        │                        │                     │                │
  │                        │──INSERT INTO bookings──▶│                    │                │
  │                        │   (partial unique index prevents duplicates) │                │
  │                        │◀──────────────────────▶│                     │                │
  │                        │                        │                     │                │
  │                        │──COMMIT───────────────▶│                     │                │
  │                        │                        │                     │                │
  │                        │──Cache idempotency result──────────────────▶│                │
  │                        │   (1 hour TTL)         │                     │                │
  │                        │                        │                     │                │
  │                        │──Publish notification──▶│──────────────────▶│──────────────▶│
  │                        │                        │                     │                │
  │◀─────201 Created───────│                        │                     │                │
```

**Double-Booking Prevention (Multi-Layer):**
1. **Optimistic**: Check available slots before attempting insert
2. **Pessimistic**: `SELECT FOR UPDATE` locks conflicting rows during transaction
3. **Database Constraint**: Partial unique index `(host_user_id, start_time) WHERE status = 'confirmed'`
4. **Idempotency**: Same request with same key returns cached result

### 2. Checking Availability

```
Client                  API Server              PostgreSQL              Redis
  │                        │                       │                     │
  │──GET /availability────▶│                       │                     │
  │   ?meeting_type=X      │                       │                     │
  │   &date=2024-01-15     │──Check cache──────────▶│                    │
  │                        │   (availability:X:date)│                    │
  │                        │                        │                     │
  │                        │  (If cache miss)       │                     │
  │                        │──SELECT meeting_types──▶│                    │
  │                        │──SELECT avail_rules───▶│                     │
  │                        │──SELECT bookings──────▶│                     │
  │                        │                        │                     │
  │                        │  [Calculate slots]     │                     │
  │                        │  - Merge busy periods  │                     │
  │                        │  - Apply buffers       │                     │
  │                        │  - Generate slots      │                     │
  │                        │                        │                     │
  │                        │──Cache result (5 min TTL)─────────────────▶│
  │◀─────Available slots───│                        │                     │
```

### 3. Archiving Old Bookings

```
Cron Job (daily)        PostgreSQL
  │                        │
  │──BEGIN TRANSACTION────▶│
  │──INSERT INTO bookings_archive
  │   SELECT * FROM bookings
  │   WHERE status IN ('completed','cancelled')
  │   AND end_time < NOW() - 90 days
  │──DELETE FROM bookings (same filter)
  │──COMMIT
```

## Database Schema

All times are stored in UTC.

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Meeting Types table
CREATE TABLE meeting_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_day INTEGER,
  color VARCHAR(7) DEFAULT '#3B82F6',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, slug)
);

-- Availability Rules table (weekly schedule)
CREATE TABLE availability_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);
CREATE INDEX idx_availability_user_day ON availability_rules(user_id, day_of_week, is_active);

-- Bookings table
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_type_id UUID NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  idempotency_key VARCHAR(255),
  CONSTRAINT valid_booking_time CHECK (end_time > start_time)
);

-- UNIQUE partial index prevents double-booking
CREATE UNIQUE INDEX idx_bookings_no_double ON bookings(host_user_id, start_time)
  WHERE status = 'confirmed';
CREATE INDEX idx_bookings_host_time ON bookings(host_user_id, start_time, end_time);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_meeting_type ON bookings(meeting_type_id);
CREATE UNIQUE INDEX idx_bookings_idempotency_key
  ON bookings(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Bookings archive table (completed/cancelled bookings older than 90 days)
CREATE TABLE bookings_archive (
  id UUID PRIMARY KEY,
  meeting_type_id UUID NOT NULL,
  host_user_id UUID NOT NULL,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  version INTEGER DEFAULT 1,
  idempotency_key VARCHAR(255),
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_bookings_archive_host_time ON bookings_archive(host_user_id, start_time);
CREATE INDEX idx_bookings_archive_archived_at ON bookings_archive(archived_at);

-- Email notifications log
CREATE TABLE email_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  recipient_email VARCHAR(255) NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'sent'
);
CREATE INDEX idx_email_booking ON email_notifications(booking_id);

-- Sessions table (fallback for when Redis is unavailable)
CREATE TABLE sessions (
  sid VARCHAR(255) PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX idx_sessions_expire ON sessions(expire);
```

### Key Design Rationale

- **`time_zone` on users**: Stored as IANA identifier for accurate DST handling
- **`slug` on meeting_types**: Enables clean booking URLs (`/user/demo/30-min-call`)
- **Buffer times on meeting_types**: Prevents back-to-back meetings, allows travel/prep
- **Partial unique index on bookings**: Only confirmed bookings participate in uniqueness, cancelled bookings may share the same slot
- **Archive table has no foreign keys**: Allows parent record deletion without affecting historical data
- **`version` on bookings**: Enables optimistic locking for concurrent modifications
- **`idempotency_key` on bookings**: Prevents duplicate bookings from network retries

## API Design

### Public Booking URL Pattern

```
/john-doe/30min-x7k2m9
```

Combines human-readable prefix with security token suffix to prevent URL enumeration while keeping URLs shareable.

### Core Endpoints

```
Authentication
  POST   /api/auth/register        Create user account
  POST   /api/auth/login           Login (creates session)
  POST   /api/auth/logout          Logout (destroys session)
  GET    /api/auth/me              Get current user

Meeting Types
  POST   /api/meeting-types        Create meeting type
  GET    /api/meeting-types        List user's meeting types
  GET    /api/meeting-types/:id    Get meeting type details
  PUT    /api/meeting-types/:id    Update meeting type
  DELETE /api/meeting-types/:id    Delete meeting type

Availability
  POST   /api/availability/rules   Set availability rules
  GET    /api/availability/rules   Get user's availability rules
  GET    /api/availability/slots   Get available slots (with caching)

Bookings
  POST   /api/bookings             Create booking (idempotent)
  GET    /api/bookings             List user's bookings
  GET    /api/bookings/:id         Get booking details
  PUT    /api/bookings/:id/reschedule   Reschedule booking
  DELETE /api/bookings/:id         Cancel booking

Admin
  GET    /api/admin/stats          Platform statistics
  GET    /api/admin/bookings       List all bookings
  GET    /api/admin/users          List all users

Calendar Integration (future)
  GET    /api/integrations/google/oauth      Initiate Google OAuth
  GET    /api/integrations/google/callback   Handle OAuth callback
  POST   /api/integrations/:id/sync          Trigger calendar sync
```

### Availability API Response Format

Returns UTC timestamps only, enabling instant timezone switching without re-fetching:

```json
{
  "slots": {
    "2025-01-15": [
      { "start_time": "2025-01-15T19:00:00Z", "end_time": "2025-01-15T19:30:00Z" }
    ]
  }
}
```

## Key Design Decisions

### 1. Preventing Double Bookings

**Chose**: Multi-layered prevention (unique index + row-level locking + idempotency)

**Why this works**: A scheduling platform cannot tolerate overlapping meetings. A single layer is insufficient because database unique indexes catch static conflicts but not time-range overlaps, while application-level checks are vulnerable to race conditions. The combination of `SELECT FOR UPDATE` (serializes concurrent writes) with a partial unique index (catches anything the application misses) provides defense in depth.

**Alternative**: Optimistic locking with version fields and retry loops. Rejected because retry storms during popular slot contention would degrade user experience, and the booking-to-search ratio (1:100) means lock contention is rare enough that pessimistic locking latency is acceptable.

**Trade-off**: Slightly higher booking latency (~10-20ms for lock acquisition) in exchange for guaranteed consistency.

### 2. Availability Calculation Algorithm

**Chose**: Compute slots on-demand with 5-minute caching in Redis

The algorithm:
1. Fetch user's availability rules for the requested date
2. Fetch existing confirmed bookings from database
3. Fetch cached calendar events from external providers
4. Merge all "busy" periods into a sorted interval list
5. Generate available slots from gaps between busy periods
6. Apply buffer times and meeting duration constraints
7. Cache result in Redis (5-minute TTL)

**Alternative**: Pre-compute availability nightly for all users. Rejected because availability changes frequently (new bookings, calendar updates) and pre-computation wastes resources for users who rarely receive bookings.

**Trade-off**: 5-minute cache means a small window where a slot may appear available after being booked. Mitigated by server-side verification before booking creation and 409 Conflict response with alternative suggestions.

### 3. Time Zone Handling

**Chose**: Store all times in UTC, convert at display layer

- Database stores UTC timestamps (TIMESTAMP WITH TIME ZONE)
- User's IANA time zone stored in profile for host-side display
- Invitee's time zone detected client-side and sent with booking
- API returns UTC; client converts using `date-fns-tz`

**Alternative**: Store times in the host's local time zone. Rejected because it makes cross-timezone queries error-prone and DST transitions can create invalid stored times.

### 4. Notification Architecture

**Chose**: Asynchronous delivery via RabbitMQ with dedicated workers

Booking creation publishes a notification message to the queue. Separate worker processes consume messages and send emails. Failed deliveries go to a dead-letter queue for investigation and replay.

**Why not synchronous**: If the email provider is slow or down, booking creation would block. Users care about the booking confirmation, not whether the email was sent instantly. Async delivery also enables scheduled reminders by setting message TTL.

**Alternative**: Direct email sending in the request handler. Rejected because a 3-second email provider timeout would make booking creation feel unresponsive.

### 5. Calendar Sync Strategy

**Chose**: 10-minute polling + webhooks where supported

- Pull-based sync: Background job syncs calendars every 10 minutes
- Push-based sync: Google Calendar push notifications for near-real-time
- On-demand sync: When user requests availability, trigger sync if stale
- Caching: Calendar events cached for 10 minutes in Redis

**Trade-off**: Up to 10 minutes of staleness vs. API quota management. Acceptable because calendar events rarely change minute-to-minute, and the booking creation flow re-checks availability server-side.

## Consistency and Idempotency

### Idempotency for Booking Creation

Every booking request includes an idempotency key, either client-provided (`X-Idempotency-Key` header) or auto-generated from `meeting_type_id + start_time + invitee_email`.

**Flow:**
1. Check Redis for existing result with this key (fast path)
2. Acquire distributed lock for this key (prevents concurrent processing)
3. If no prior result, process booking and store result in Redis (1-hour TTL)
4. Store idempotency key in database column for audit durability
5. Return cached result for duplicate requests

This prevents double-bookings from network retries, double-clicks, and load balancer retries.

### Optimistic Locking for Updates

Bookings include a `version` field. Reschedule and cancel operations use `UPDATE ... WHERE version = $current_version`. If the version has changed (concurrent modification), the operation fails with 409 Conflict.

## Security / Auth

### Authentication

Session-based authentication with Redis-backed session store. Sessions are prefixed with `calendly:session:` in Redis with 24-hour TTL. HTTP-only, secure cookies prevent XSS token theft.

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| `user` | Manage own meeting types, availability, bookings |
| `admin` | All user permissions + platform statistics, user management |

### Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/auth/*` | 10 requests | 1 minute |
| `/api/availability/*` | 30 requests | 1 minute |
| `/api/bookings` (POST) | 10 requests | 1 minute |
| All other endpoints | 100 requests | 1 minute |

### Data Protection

- Passwords hashed with bcrypt (cost factor 10)
- Calendar access tokens encrypted at rest
- SQL injection prevented via parameterized queries
- No PII in logs (emails masked)

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `calendly_booking_operations_total{operation,status}` | Counter | Track create/cancel/reschedule |
| `calendly_booking_creation_duration_seconds{status}` | Histogram | Booking latency (p50/p95/p99) |
| `calendly_double_booking_prevented_total` | Counter | Should remain zero |
| `calendly_availability_checks_total{cache_hit}` | Counter | Cache effectiveness |
| `calendly_availability_calculation_duration_seconds` | Histogram | Calculation time |
| `calendly_cache_operations_total{operation,cache_type}` | Counter | Hit/miss/set/delete |
| `calendly_http_request_duration_seconds{method,route,status_code}` | Histogram | RED metrics |
| `calendly_email_notifications_total{type,status}` | Counter | Notification delivery |
| `calendly_db_pool_connections{state}` | Gauge | Connection pool health |

### Structured Logging

JSON-formatted logs with Pino, including correlation IDs, user context, and operation metadata. Custom log levels by response status (error for 5xx, warn for 4xx).

### Health Checks

| Endpoint | Purpose | Components Checked |
|----------|---------|-------------------|
| `GET /health` | Load balancer | Database, Redis, RabbitMQ (quick) |
| `GET /health/detailed` | Debugging | All components with latency, pool sizes, memory |
| `GET /health/live` | K8s liveness | Process running |
| `GET /health/ready` | K8s readiness | Ready to accept traffic |

**Health Status Levels**: healthy / degraded / unhealthy. RabbitMQ is optional (degraded if unavailable, not unhealthy), since notifications can be retried.

### Alerting Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| Booking latency high | p95 > 500ms | Warning |
| Cache hit rate low | < 70% | Warning |
| Notification queue backup | > 100 messages | Warning |
| Notification queue critical | > 500 messages | Critical |
| Dead-letter queue growing | > 10 messages | Warning |
| Database pool exhausted | waiting > 0 | Warning |

## Failure Handling

### Circuit Breaker (Calendar API)

Calendar API calls are wrapped in a circuit breaker pattern. After 3 consecutive failures, the circuit opens and calendar sync falls back to cached data. After 30 seconds, half-open state allows a test request. Two consecutive successes close the circuit.

### RabbitMQ Reconnection

The queue service implements automatic reconnection with exponential backoff (5s, 10s, 20s... up to 10 attempts). Messages are published with `persistent: true` for durability. Dead-letter exchange routes failed messages to a DLQ for investigation.

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|------------------|
| Redis down | Sessions fall back to PostgreSQL table, skip availability cache |
| RabbitMQ down | Notifications queued in-memory, retried on reconnection |
| Calendar API down | Use cached calendar events, warn user of potential conflicts |
| Database read replica down | All reads go to primary |

## Scalability Considerations

### Database Scaling Path

1. **Current**: Single PostgreSQL instance
2. **Next**: Read replicas for availability queries (read-heavy path)
3. **Future**: Partition bookings table by date range (monthly partitions), archive to cold storage

### Application Scaling

- **Horizontal scaling**: Stateless API servers behind load balancer
- **Service isolation**: Notification workers scale independently from API servers
- **Caching**: Aggressive caching of availability (5 min), calendar events (10 min), meeting types (10 min)

### Performance Optimizations

- Composite indexes on hot query paths (`user_id, day_of_week`, `host_user_id, start_time`)
- Connection pooling with `pg` Pool
- Batch calendar event fetches to minimize API calls

## Data Lifecycle

| Data Type | Retention | Storage | Notes |
|-----------|-----------|---------|-------|
| Active bookings | Until completed/cancelled | PostgreSQL | Primary working set |
| Completed bookings | 90 days in active table | PostgreSQL | For rescheduling reference |
| Archived bookings | 2 years | PostgreSQL archive table | Legal/audit requirements |
| Availability cache | 5 minutes | Redis | Invalidated on booking |
| Session data | 24 hours | Redis | Auto-expire with TTL |
| Notification queue | 7 days | RabbitMQ | DLQ for failures |
| Idempotency keys | 1 hour | Redis | Auto-expire with TTL |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Primary database | PostgreSQL | MongoDB/Cassandra | ACID transactions critical for double-booking prevention |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Booking concurrency | Pessimistic locking | Optimistic locking | Higher success rate, acceptable throughput |
| Notification delivery | RabbitMQ (async) | Synchronous email | Non-blocking booking creation |
| Calendar sync | Polling + webhooks | Real-time only | API quota management |
| Availability caching | 5-min Redis TTL | No cache / pre-compute | Balance between freshness and DB load |
| Time storage | UTC everywhere | Host local time | Avoids DST bugs, simpler cross-TZ queries |
| Booking archival | 90-day active + 2-year archive | Keep all in one table | Keeps active table fast |

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
┌──────┐ ┌──────┐ ┌──────────┐
│Pg    │ │Redis/│ │RabbitMQ  │
│:5432 │ │Valkey│ │:5672     │
│      │ │:6379 │ │:15672    │
│      │ │      │ │(mgmt)   │
└──────┘ └──────┘ └──────────┘
```

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| **Idempotency** | `backend/src/shared/idempotency.ts` | Redis-backed idempotency keys with distributed locks; prevents duplicate bookings from retries |
| **Structured Logging** | `backend/src/shared/logger.ts` | Pino JSON logging with request correlation IDs and custom log levels |
| **Prometheus Metrics** | `backend/src/shared/metrics.ts` | 15+ business and infrastructure metrics exposed at `/metrics` |
| **Health Checks** | `backend/src/shared/health.ts` | Multi-level health checks (basic, detailed, liveness, readiness) checking DB, Redis, RabbitMQ |
| **Message Queue** | `backend/src/shared/queue.ts` | RabbitMQ integration with dead-letter exchange, durable queues, prefetch=1 |
| **Notification Workers** | `backend/src/workers/notification-worker.ts` | Separate process consuming from RabbitMQ queues |
| **Booking Archival** | `backend/src/services/archivalService.ts` | Data lifecycle management with configurable retention |
| **Session Auth** | `backend/src/index.ts` | Redis-backed sessions via connect-redis |
| **Availability Calculation** | `backend/src/services/availabilityService.ts` | Slot computation with buffer times and cache |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Reason |
|-------------------|------------------|--------|
| CDN for static assets | Vite dev server serves directly | No CDN needed for local dev |
| API Gateway (Kong/Envoy) | Express handles routing directly | Single process is sufficient |
| Multiple API instances + nginx LB | Single instance (or 3 via `dev:server1/2/3`) | Can demo load balancing manually |
| Google Calendar OAuth integration | Simulated email notifications | No external API keys needed |
| Encrypted calendar token storage | No calendar tokens stored | Calendar integration not implemented |
| Rate limiting middleware | Not implemented | Low traffic in dev |
| bcrypt cost factor 12 | bcrypt cost factor 10 | Faster login in dev |

### What Was Omitted

- **CDN / Edge caching** - No static asset distribution
- **Multi-region deployment** - Single-machine setup
- **Kubernetes orchestration** - Docker Compose only
- **Real calendar API integration** - No Google/Outlook OAuth flows
- **SMS notifications** - Email only (simulated)
- **Bot detection / CAPTCHA** - Not needed for local dev
- **Database read replicas** - Single PostgreSQL instance
- **Redis Sentinel / Cluster** - Single Redis instance
- **Automated schema migrations** - Uses init.sql loaded at container start
- **Real email delivery** - Notifications logged to database, not sent via SMTP
