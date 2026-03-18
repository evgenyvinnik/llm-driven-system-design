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

---

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (Navbar + <Outlet>)
├── / ─── LandingPage (unauthenticated welcome)
├── /login ─── LoginPage
├── /register ─── RegisterPage
├── /dashboard ─── DashboardPage (auth-guarded)
│   ├── Stats grid (upcoming, this week, this month, event types)
│   ├── Upcoming bookings list
│   └── Quick actions (links to meeting types, availability, bookings)
├── /meeting-types ─── MeetingTypesPage (auth-guarded)
│   ├── MeetingTypeCard[] (with edit/delete/activate/deactivate)
│   ├── MeetingTypeModal (create/edit form)
│   └── MeetingTypesEmptyState
├── /availability ─── AvailabilityPage (auth-guarded)
│   └── Day-of-week schedule editor (checkboxes + time selects)
├── /bookings ─── BookingsPage (auth-guarded)
│   └── Booking list with status filtering
├── /bookings/$bookingId ─── BookingDetailPage (auth-guarded)
│   └── Reschedule/cancel actions
├── /book/$meetingTypeId ─── BookingPage (public, no auth required)
│   ├── Meeting type info sidebar (name, duration, timezone selector)
│   ├── CalendarPicker (month navigation, available date highlighting)
│   ├── TimeSlotPicker (scrollable time slot buttons)
│   └── Booking confirmation form (name, email, notes)
└── /admin ─── AdminPage (auth-guarded, admin role)
    └── Platform statistics + user/booking management
```

The root layout (`__root.tsx`) renders a `Navbar` and `<Outlet>` without any auth logic -- unlike the other projects, auth guards are applied per-route using TanStack Router's `beforeLoad` hook. The booking page (`/book/$meetingTypeId`) is intentionally public -- invitees do not need an account to book a meeting.

### Routing (TanStack Router, File-Based)

Two dynamic route segments exist: `/book/$meetingTypeId` (public booking flow) and `/bookings/$bookingId` (booking detail for authenticated hosts). Auth guards use an async `beforeLoad` hook that calls `checkAuth()` if the user is not yet authenticated, then redirects to `/login` if the check fails. This pattern handles both direct navigation (typing a URL) and page refreshes (where the Zustand store has not yet been hydrated from the session cookie).

### Zustand Store: `useAuthStore`

A single Zustand store (`frontend/src/stores/authStore.ts`) manages authentication state: `user`, `isAuthenticated`, and `isLoading`. Unlike the other projects in this repository, this store does not use Zustand's `persist` middleware -- session state relies entirely on the server-side session cookie (set with `credentials: 'include'` on fetch requests). The `checkAuth` action calls `GET /api/auth/me` and populates the user object if the session is valid. This means a page refresh triggers a round-trip to the server to validate the session, which is more secure (no client-side token storage) but slightly slower.

The store provides `login`, `register`, `logout`, and `checkAuth` actions. All auth API calls return an `ApiResponse<T>` wrapper with `success` and `data` fields, so the store checks `response.success` before updating state.

### Data Fetching Pattern

API calls are organized into domain-specific objects in `frontend/src/services/api.ts`: `authApi`, `meetingTypesApi`, `availabilityApi`, `bookingsApi`, and `adminApi`. A generic `fetchApi<T>()` wrapper includes `credentials: 'include'` on every request (required for session cookies to be sent cross-origin during development with Vite's proxy), sets the `Content-Type: application/json` header, and returns the parsed JSON response.

All API responses are wrapped in an `ApiResponse<T>` type with `success: boolean`, `data?: T`, and `error?: string`. This differs from the other projects which throw on errors -- here, the caller checks `response.success` and handles failures explicitly. This pattern makes error handling more predictable at the cost of more boilerplate in each caller.

Data fetching uses local component state (`useState` + `useEffect`) rather than Zustand stores. Only auth state is global. This is appropriate because Calendly's pages are largely independent -- the availability page does not need the bookings list, and the booking flow does not need the meeting types list. Each page fetches its own data on mount.

### Key UI Patterns

**Multi-Step Booking Wizard (BookingPage):** The public booking page (`/book/$meetingTypeId`) is the most complex UI in the project, implementing a three-step wizard: (1) select date and time, (2) enter contact details, (3) confirmation. State is tracked via a `step` discriminated union (`'select-time' | 'enter-details' | 'confirmed'`). The page is split into a sidebar (meeting type info + timezone selector) and a main area (wizard steps).

**Calendar Picker Component:** A custom calendar widget (`frontend/src/components/CalendarPicker.tsx`) built entirely with `date-fns`. It renders a month grid with day buttons, supports month navigation (previous/next arrows), highlights today with a border, marks the selected date with a filled primary color, and disables past dates. When `availableDates` is provided, only those dates are clickable -- other dates are greyed out and disabled. This is critical for the booking flow because it prevents invitees from selecting dates with no available slots.

**Time Slot Picker:** After selecting a date, the `TimeSlotPicker` component renders a scrollable list of available time slots as buttons. Each slot shows the start time formatted in the invitee's selected timezone. Selecting a slot highlights it and enables the "Continue" button. Slots are fetched from the API when the selected date changes, with a loading spinner during the fetch.

**Timezone Handling in the UI:** The booking page includes a timezone selector dropdown populated with common IANA timezone names (via a `commonTimezones` array in `frontend/src/utils/time.ts`). The selected timezone is auto-detected from the browser on first load (`getLocalTimezone()` wraps `Intl.DateTimeFormat().resolvedOptions().timeZone`). Changing the timezone re-fetches available dates and slots, and all displayed times update to the new timezone. The `formatInTimezone` utility uses `date-fns-tz` for timezone-aware formatting.

**Availability Schedule Editor (AvailabilityPage):** A weekly schedule editor showing 7 day rows (Sunday through Saturday). Each row has a checkbox to enable/disable the day, and two time select dropdowns (start and end) with 30-minute granularity (48 options from 00:00 to 23:30, displayed in 12-hour format via `formatTime12Hour`). Enabled days are highlighted with a background color. The save button sends all enabled rules to the backend in a single POST. An info box at the bottom shows the user's detected timezone and tips about buffer times.

**Dashboard (DashboardPage):** A summary page with a stats grid (4 cards: upcoming bookings, this week, this month, event types) and two content panels: upcoming bookings list (clickable, navigates to booking detail) and quick actions (links to meeting types, availability, and bookings pages). Data is loaded in parallel via `Promise.all` on mount.

**Meeting Type Management (MeetingTypesPage):** A card-based layout where each meeting type is rendered as a `MeetingTypeCard` with a colored left border, name, duration, slug, and action buttons (edit, delete, activate/deactivate). A modal (`MeetingTypeModal`) handles both creation and editing, with fields for name, slug, description, duration, buffer times, max bookings per day, and color picker. An empty state component encourages users to create their first meeting type.

### Type Safety

Domain types are defined in `frontend/src/types/index.ts`: `User` (with `time_zone`), `MeetingType` (with `user_name` for display), `Booking` (with `meeting_type_name`, `invitee_timezone`), `AvailabilityRule`, `TimeSlot` (with UTC `start` and `end`), `DashboardStats`, and the generic `ApiResponse<T>` wrapper. The `TimeSlot` type is particularly important -- it carries UTC timestamps that are converted to the display timezone only at render time, maintaining the "store UTC, display local" principle throughout the stack.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in this project. Each explanation assumes no prior knowledge of the pattern.

### Idempotency

**What it is:** Idempotency is a property of an operation where performing it multiple times produces the same result as performing it once. For a scheduling platform, it means that if an invitee clicks "Schedule Event" and the network drops, retrying the request will not create a duplicate booking for the same time slot.

**Why it matters for booking creation:** Without idempotency, a network retry could create two confirmed bookings for the same time slot with the same invitee -- an embarrassing double-booking that requires manual cleanup and damages the host's professional image. Even worse, the partial unique index (`idx_bookings_no_double`) would prevent the second insert, but without proper idempotency handling, the second request would return an error rather than the original booking confirmation, leaving the invitee confused about whether they are actually booked.

**How it works here:** Every booking request includes an idempotency key, either explicitly provided via the `X-Idempotency-Key` header or auto-generated from `meeting_type_id + start_time + invitee_email`. The server first checks Redis for an existing result with this key. If found, the cached response is returned immediately. If not found, a distributed lock is acquired for the key (preventing concurrent processing of the same request), the booking is created, the result is cached in Redis with a 1-hour TTL, and the idempotency key is also stored in the `bookings` table for audit durability. The implementation is in `backend/src/shared/idempotency.ts`.

### Redis Cache-Aside (Availability Cache)

**What it is:** Cache-aside is a caching strategy where the application checks the cache before performing an expensive computation or database query. On a cache miss, the computation runs, the result is stored in the cache, and then returned. On a cache hit, the cached result is returned instantly.

**Why it matters:** Availability calculation is the most expensive operation in the system. For each request, the server must: (1) fetch the user's availability rules, (2) fetch all confirmed bookings for the date range, (3) optionally fetch cached external calendar events, (4) merge all busy periods into a sorted interval list, (5) generate available slots from the gaps, and (6) apply buffer times and meeting duration constraints. This involves 2-3 database queries and an O(n log n) interval merge algorithm. At production scale with 5,000 availability checks per second, running this computation for every request would overwhelm the database.

**How it works here:** After computing available slots, the result is cached in Redis with a 5-minute TTL (keyed by `availability:{meetingTypeId}:{date}`). Subsequent requests for the same meeting type and date return the cached slots in < 1ms. The cache is invalidated when a new booking is created (since that booking reduces available slots) by deleting relevant cache keys. The 5-minute TTL means a newly created booking might still appear as an available slot for up to 5 minutes -- but this is mitigated by server-side verification during booking creation, which returns 409 Conflict if the slot is no longer available. The `calendly_availability_checks_total{cache_hit}` Prometheus counter tracks the hit rate -- the alerting threshold triggers a warning below 70%.

### Circuit Breaker

**What it is:** A circuit breaker stops an application from repeatedly calling a service that is failing. It has three states: CLOSED (requests pass through), OPEN (requests fail immediately), and HALF_OPEN (a single test request is allowed after a timeout period to check if the service has recovered). This prevents cascading failures where a slow or down dependency drags down the entire application.

**Why it matters:** Calendly integrates with external calendar APIs (Google Calendar, Microsoft Graph) for availability checking and event creation. These APIs can be slow (rate limited), temporarily unavailable (maintenance windows), or permanently unreachable (expired OAuth tokens). Without a circuit breaker, every availability check that involves a calendar sync would wait for the API timeout (potentially 10-30 seconds) before falling back to cached data. With 5,000 availability checks per second, this would exhaust the server's connection pool in under a second.

**How it works here:** Calendar API calls are wrapped in a circuit breaker pattern. After 3 consecutive failures, the circuit opens. All subsequent calendar sync requests fail immediately and fall back to cached calendar events (which are refreshed every 10 minutes during normal operation). After 30 seconds, the circuit enters the half-open state and allows a single test request. Two consecutive successes close the circuit and resume normal calendar syncing. The circuit breaker state is logged for operational visibility.

### Structured Logging

**What it is:** Structured logging produces log entries as JSON objects with consistent fields (timestamp, level, service, requestId, userId, etc.) rather than free-form text strings. This makes logs machine-parseable, enabling automated querying, filtering, and alerting via log aggregation platforms.

**Why it matters:** When a user reports "I tried to book a meeting and it said the slot was unavailable, but I can see it on the calendar", the support engineer needs to trace the exact sequence of events: Was the availability cache stale? Did a concurrent booking take the slot? Did the calendar sync fail? Structured logs with a consistent `requestId` field allow correlating all log entries for that specific booking attempt across the availability service, booking service, and notification service.

**How it works here:** Pino is configured (`backend/src/shared/logger.ts`) with JSON output and correlation IDs. Each incoming request is assigned a unique request ID, and all log entries within that request carry the ID. Custom log levels are mapped by response status: 5xx responses log at `error` level, 4xx at `warn`, and 2xx at `info`. User context (user ID, email) is attached to log entries for authenticated requests, but emails are masked in log output for privacy compliance.

### Prometheus Metrics

**What it is:** Prometheus is a monitoring system that collects numeric metrics from applications by scraping an HTTP endpoint at regular intervals. Metrics quantify system behavior over time: how many bookings were created, how fast availability was calculated, how many cache hits versus misses occurred. Prometheus stores these as time-series data and enables dashboard visualization (Grafana) and threshold-based alerting.

**Why it matters:** For a scheduling platform, the most important question is "are bookings working?" -- but this decomposes into sub-questions that only metrics can answer: "How many double-booking attempts were prevented?" (should be zero under normal operation, and the `calendly_double_booking_prevented_total` counter tracks this). "Is availability calculation getting slower as the user base grows?" (the `calendly_availability_calculation_duration_seconds` histogram reveals the latency distribution). "Are notifications being delivered?" (the `calendly_email_notifications_total` counter by status tracks delivery vs. failure).

**How it works here:** The implementation uses `prom-client` (`backend/src/shared/metrics.ts`) with 15+ metrics. Booking metrics include `calendly_booking_operations_total{operation,status}` (counter for create/cancel/reschedule), `calendly_booking_creation_duration_seconds{status}` (histogram for booking latency), and `calendly_double_booking_prevented_total`. Availability metrics include `calendly_availability_checks_total{cache_hit}` and `calendly_availability_calculation_duration_seconds`. Infrastructure metrics include `calendly_http_request_duration_seconds{method,route,status_code}` (RED metrics), `calendly_cache_operations_total{operation,cache_type}`, `calendly_email_notifications_total{type,status}`, and `calendly_db_pool_connections{state}`.

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make to an API within a time window. When the limit is exceeded, the server responds with HTTP 429 (Too Many Requests). Limits are typically tracked per IP address or per authenticated user using a sliding window algorithm.

**Why it matters:** The booking page (`/book/$meetingTypeId`) is public -- anyone with the URL can access it without authentication. Without rate limiting, an attacker could flood the availability endpoint with thousands of requests per second, overwhelming the database and preventing legitimate invitees from booking. Rate limiting also prevents brute-force attacks on the login endpoint (trying thousands of password combinations) and abuse of the booking creation endpoint (creating hundreds of fake bookings to exhaust a host's available slots).

**How it works here:** Rate limits are specified per endpoint category: authentication endpoints (10 requests/minute -- strict to prevent brute force), availability checks (30 requests/minute -- generous because legitimate booking flows involve multiple checks), booking creation (10 requests/minute -- prevents slot exhaustion attacks), and all other endpoints (100 requests/minute). In the local implementation, rate limiting is not yet wired in, but the architecture specifies Redis-based sliding window counters for production deployment.

### RBAC (Role-Based Access Control)

**What it is:** RBAC assigns permissions based on user roles rather than individual user identities. Each user has a role (e.g., "user" or "admin"), and each role has a predefined set of permissions. The system checks the user's role when authorizing access to resources or actions.

**Why it matters:** A scheduling platform has two distinct user types: regular users (hosts who manage their availability and meeting types) and administrators (platform operators who view system-wide statistics, manage user accounts, and investigate issues). Without RBAC, either every user would have admin access (security risk) or admin functionality would require a separate application (operational overhead). RBAC enables a single application with role-appropriate access.

**How it works here:** Users have a `role` column with values `user` or `admin`. The user role can manage their own meeting types, availability rules, and bookings. The admin role has all user permissions plus access to `/api/admin/*` endpoints: platform statistics (total users, bookings, emails sent), user listing and deletion, booking listing across all users, and email notification logs. Admin endpoints check the role in middleware and return 403 Forbidden for non-admin users.

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether an application and its dependencies are operational. Load balancers use them to route traffic to healthy instances. Orchestrators use them to restart unhealthy containers.

**Why it matters:** A Calendly instance that cannot reach PostgreSQL cannot create bookings, but it might still serve cached availability from Redis. An instance that cannot reach RabbitMQ cannot send notification emails, but it can still create bookings. Health checks report the status of each dependency independently, allowing infrastructure to make nuanced routing and restart decisions.

**How it works here:** Four health endpoints are implemented (`backend/src/shared/health.ts`). `/health` performs a quick check of database, Redis, and RabbitMQ connectivity -- suitable for load balancer polling at 5-second intervals. `/health/detailed` runs deeper checks with latency measurements, pool sizes, and memory usage -- used for debugging and capacity planning. `/health/live` returns 200 if the process is running (Kubernetes liveness probe). `/health/ready` returns 200 only if all critical dependencies are reachable (Kubernetes readiness probe -- prevents routing traffic to an instance that started but has not yet connected to its dependencies). RabbitMQ is treated as optional: if it is unreachable, the health status is "degraded" (notifications are delayed) rather than "unhealthy" (booking creation still works).
