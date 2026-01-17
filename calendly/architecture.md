# Calendly - Meeting Scheduling Platform - Architecture Design

## System Overview

A meeting scheduling platform that allows users to share their availability and let others book meetings without back-and-forth email coordination.

## Requirements

### Functional Requirements

1. **Availability Management**
   - Users can define their working hours and availability
   - Support for multiple meeting types (1-on-1, group meetings, round-robin)
   - Support for buffer time between meetings
   - Recurring availability patterns (weekly schedules)

2. **Meeting Booking**
   - Invitees can view available time slots
   - Real-time availability checking
   - Instant booking confirmation
   - Conflict prevention

3. **Calendar Integration**
   - Sync with Google Calendar, Outlook, iCal
   - Check calendar for existing events
   - Create calendar events on booking
   - Two-way sync for updates/cancellations

4. **Time Zone Handling**
   - Automatic time zone detection
   - Display times in invitee's local time zone
   - Support for users in different time zones

5. **Notifications**
   - Email confirmations
   - Email reminders
   - Cancellation/rescheduling notifications
   - SMS notifications (optional)

6. **Booking Management**
   - Reschedule meetings
   - Cancel meetings
   - Add to calendar options
   - Custom booking questions

### Non-Functional Requirements

- **Low Latency**: Availability checks should be < 200ms
- **High Availability**: 99.9% uptime for booking system
- **Consistency**: No double-bookings (strong consistency required)
- **Scalability**: Handle millions of users with varying booking frequencies
- **Security**: Secure calendar access tokens, prevent unauthorized access

## Capacity Estimation

*To be calculated based on expected scale:*

### Traffic Estimates
- **Daily Active Users (DAU)**: 1M users
- **Booking rate**: Average 3 bookings per user per week
- **Availability checks**: ~100 checks per booking (users browsing slots)
- **Peak hours**: 10x normal load during business hours

### Calculations
- **Bookings per day**: 1M users × 3 bookings/week ÷ 7 = ~430K bookings/day
- **Availability checks per day**: 430K × 100 = 43M checks/day
- **Peak RPS for availability**: 43M ÷ 86400 × 10 = ~5,000 RPS
- **Booking RPS**: 430K ÷ 86400 = ~5 RPS (50 RPS peak)

### Storage Requirements
- **User data**: 1M users × 10KB = 10GB
- **Meeting types**: 1M users × 5 types × 5KB = 25GB
- **Bookings**: 430K/day × 365 days × 10KB = ~1.5TB/year
- **Calendar cache**: 1M users × 100 events × 5KB = 500GB

## High-Level Architecture

```
┌─────────────┐
│   Invitee   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────┐
│         Load Balancer (nginx)           │
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│    API Gateway / Application Layer      │
│        (Node.js + Express)              │
└─────────────────────────────────────────┘
       │
       ├─────────────┬──────────────┬──────────────┐
       ▼             ▼              ▼              ▼
┌──────────┐  ┌────────────┐ ┌────────────┐ ┌──────────────┐
│Booking   │  │Availability│ │Integration │ │Notification  │
│Service   │  │Service     │ │Service     │ │Service       │
└──────────┘  └────────────┘ └────────────┘ └──────────────┘
       │             │              │              │
       ▼             ▼              ▼              ▼
┌──────────────────────────────────────────────────────┐
│              PostgreSQL (Primary Database)           │
│  - Users, Meeting Types, Bookings, Availability      │
└──────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│          Valkey/Redis (Caching Layer)                │
│  - Availability cache, Calendar event cache          │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│          Message Queue (RabbitMQ)                    │
│  - Email notifications, Calendar sync jobs           │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│       External Calendar APIs                         │
│  - Google Calendar API, Microsoft Graph API          │
└──────────────────────────────────────────────────────┘
```

### Core Components

1. **API Gateway**
   - Request routing
   - Authentication/Authorization
   - Rate limiting

2. **Booking Service**
   - Handle booking creation
   - Validate time slots
   - Prevent double-bookings (pessimistic locking)
   - Trigger notifications

3. **Availability Service**
   - Calculate available time slots
   - Merge user's working hours with calendar events
   - Apply buffer times and constraints
   - Cache computed availability

4. **Integration Service**
   - OAuth flow for calendar providers
   - Sync calendar events
   - Create/update/delete events in external calendars
   - Webhook handling for calendar changes

5. **Notification Service**
   - Send confirmation emails
   - Send reminders (scheduled jobs)
   - Handle cancellation/rescheduling notifications

## Data Model

### Database Schema

**Users Table**
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Meeting Types Table**
```sql
CREATE TABLE meeting_types (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  buffer_before_minutes INTEGER DEFAULT 0,
  buffer_after_minutes INTEGER DEFAULT 0,
  max_bookings_per_day INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Availability Rules Table**
```sql
CREATE TABLE availability_rules (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  day_of_week INTEGER NOT NULL, -- 0-6 (Sunday-Saturday)
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Bookings Table**
```sql
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  meeting_type_id UUID REFERENCES meeting_types(id),
  host_user_id UUID REFERENCES users(id),
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  time_zone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL, -- confirmed, cancelled, rescheduled
  cancellation_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(host_user_id, start_time) -- Prevent double bookings
);

CREATE INDEX idx_bookings_host_time ON bookings(host_user_id, start_time);
CREATE INDEX idx_bookings_status ON bookings(status);
```

**Calendar Integrations Table**
```sql
CREATE TABLE calendar_integrations (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  provider VARCHAR(50) NOT NULL, -- google, outlook, etc.
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMP NOT NULL,
  calendar_id VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Calendar Events Cache Table**
```sql
CREATE TABLE calendar_events_cache (
  id UUID PRIMARY KEY,
  calendar_integration_id UUID REFERENCES calendar_integrations(id),
  external_event_id VARCHAR(255) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  summary TEXT,
  cached_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_calendar_cache_integration_time ON calendar_events_cache(calendar_integration_id, start_time, end_time);
```

### Storage Strategy

- **PostgreSQL**: Primary data store for all structured data
  - ACID compliance for preventing double bookings
  - Relational data (users, bookings, meeting types)
  - Use row-level locking for booking creation

- **Valkey/Redis**: Caching layer
  - Cache computed availability slots (TTL: 5 minutes)
  - Cache calendar events fetched from external APIs (TTL: 10 minutes)
  - Rate limiting counters

## API Design

### Core Endpoints

**User & Meeting Type Management**
- `POST /api/users` - Create user account
- `GET /api/users/:id` - Get user profile
- `POST /api/meeting-types` - Create meeting type
- `GET /api/meeting-types/:id` - Get meeting type details
- `PUT /api/meeting-types/:id` - Update meeting type
- `DELETE /api/meeting-types/:id` - Delete meeting type

**Availability Management**
- `POST /api/availability/rules` - Set availability rules
- `GET /api/availability/rules` - Get user's availability rules
- `GET /api/availability/slots?meeting_type_id=:id&date=:date&timezone=:tz` - Get available slots

**Booking Management**
- `POST /api/bookings` - Create a booking
- `GET /api/bookings/:id` - Get booking details
- `PUT /api/bookings/:id/reschedule` - Reschedule booking
- `DELETE /api/bookings/:id` - Cancel booking
- `GET /api/users/:id/bookings` - List user's bookings

**Calendar Integration**
- `GET /api/integrations/google/oauth` - Initiate Google OAuth
- `GET /api/integrations/google/callback` - Handle OAuth callback
- `POST /api/integrations/:id/sync` - Trigger calendar sync
- `DELETE /api/integrations/:id` - Remove calendar integration

## Key Design Decisions

### 1. Preventing Double Bookings

**Challenge**: Ensuring no two bookings overlap for the same user.

**Solution**: Multi-layered approach
1. **Database constraint**: Unique index on `(host_user_id, start_time)`
2. **Row-level locking**: Use `SELECT FOR UPDATE` when checking availability
3. **Optimistic locking**: Version field to detect concurrent modifications
4. **Transaction isolation**: `SERIALIZABLE` isolation level for booking creation

**Trade-off**: Slightly higher latency for booking creation vs. data consistency

### 2. Availability Calculation Algorithm

**Challenge**: Efficiently compute available time slots considering:
- User's availability rules (working hours)
- Existing bookings
- Calendar events from integrations
- Buffer times
- Meeting duration

**Approach**:
```
1. Fetch user's availability rules for requested date range
2. Fetch existing bookings from database
3. Fetch calendar events from cache (or external API if cache miss)
4. Merge all "busy" periods into a sorted list
5. Generate available slots from gaps between busy periods
6. Apply buffer times and constraints
7. Return slots in invitee's time zone
```

**Optimization**: Cache computed slots for 5 minutes in Valkey

### 3. Time Zone Handling

**Challenge**: Users and invitees in different time zones.

**Solution**:
- Store all times in database as UTC timestamps
- Store user's time zone preference separately
- API accepts time zone parameter for display
- Availability calculation happens in UTC, then converts for display
- Booking confirmation shows time in both host's and invitee's time zones

### 4. Calendar Sync Strategy

**Challenge**: Keep calendar events up-to-date without excessive API calls.

**Approach**:
- **Pull-based sync**: Background job syncs calendars every 10 minutes
- **Push-based sync**: Use webhooks when supported (Google Calendar push notifications)
- **On-demand sync**: Sync calendar when user requests availability
- **Caching**: Cache calendar events for 10 minutes
- **Rate limiting**: Respect calendar provider API rate limits

**Trade-off**: Slight staleness (up to 10 minutes) vs. API quota management

### 5. Notification System

**Architecture**:
- **Asynchronous**: Use RabbitMQ for email queue
- **Retry logic**: Exponential backoff for failed deliveries
- **Scheduled reminders**: Cron job checks for upcoming meetings and enqueues reminders
- **Email templates**: Precompiled templates for different notification types

## Technology Stack

Following the repository's preferred open-source stack:

- **Application Layer**: Node.js + Express + TypeScript
- **Data Layer**: PostgreSQL (primary database)
- **Caching Layer**: Valkey or Redis
- **Message Queue**: RabbitMQ
- **Email Service**: Nodemailer (SMTP)
- **Job Scheduler**: node-cron or Bull (Redis-backed)
- **Frontend**: TypeScript + Vite + Tanstack React

**External APIs**:
- Google Calendar API
- Microsoft Graph API (Outlook)

## Scalability Considerations

### Database Scaling
- **Read replicas**: Offload availability queries to read replicas
- **Partitioning**: Partition bookings table by date range (monthly partitions)
- **Archiving**: Archive old bookings (> 1 year) to cold storage

### Application Scaling
- **Horizontal scaling**: Stateless API servers behind load balancer
- **Service isolation**: Separate services can scale independently
- **Caching**: Aggressive caching of availability and calendar events

### Performance Optimizations
- **Database indexing**: Indexes on frequently queried fields
- **Connection pooling**: PostgreSQL connection pool (pg-pool)
- **Query optimization**: Avoid N+1 queries, use batching
- **API rate limiting**: Prevent abuse and ensure fair usage

## Trade-offs and Alternatives

### PostgreSQL vs. NoSQL
**Decision**: PostgreSQL
**Rationale**:
- Strong consistency required for preventing double bookings
- Relational data model fits naturally
- ACID transactions critical
- Complex queries for availability calculation

**Alternative**: Could use Cassandra for bookings history, but would need additional layer for consistency

### Caching Strategy
**Decision**: Cache computed availability slots
**Trade-off**: Freshness vs. performance
**Mitigation**: Short TTL (5 minutes), invalidate on booking creation

### Calendar Sync Frequency
**Decision**: 10-minute polling + webhooks
**Trade-off**: API quota usage vs. real-time accuracy
**Mitigation**: On-demand sync when user requests availability

## Monitoring and Observability

**Metrics** (using Prometheus + Grafana):
- Booking creation latency (p50, p95, p99)
- Availability query latency
- Calendar API response times
- Double-booking prevention failures (should be zero)
- Cache hit ratio
- Queue depth for notifications

**Logging**:
- Structured logging (JSON format)
- Log all booking events (create, cancel, reschedule)
- Log calendar API errors
- Log authentication failures

**Alerts**:
- High error rates on booking creation
- Calendar API failures
- Queue backlog exceeding threshold
- Database connection pool exhaustion

## Security Considerations

1. **Authentication**:
   - JWT-based authentication
   - OAuth 2.0 for calendar integrations
   - Secure token storage (encrypted)

2. **Authorization**:
   - Users can only modify their own data
   - Invitees can only book, not modify meeting types
   - Rate limiting per user and per IP

3. **Data Protection**:
   - Encrypt calendar access tokens at rest
   - HTTPS for all API communication
   - Validate and sanitize all user inputs
   - Prevent calendar token leakage in logs

4. **Privacy**:
   - Don't expose calendar event details to invitees
   - Allow users to delete their data (GDPR compliance)
   - Anonymize booking data for analytics

## Data Lifecycle Policies

### Retention and TTL

| Data Type | Retention Period | Storage Location | Notes |
|-----------|-----------------|------------------|-------|
| Active bookings | Indefinite (until completed/cancelled) | PostgreSQL | Primary working set |
| Completed bookings | 90 days | PostgreSQL | For rescheduling reference and analytics |
| Archived bookings | 2 years | PostgreSQL archive table | Legal/audit requirements |
| Calendar event cache | 24 hours | PostgreSQL + Valkey | Refreshed on sync |
| Availability cache | 5 minutes | Valkey | Invalidated on booking |
| OAuth tokens | Until revoked | PostgreSQL (encrypted) | Rotate refresh tokens monthly |
| Notification queue messages | 7 days | RabbitMQ | Dead-letter queue for failures |
| Rate limiting counters | 1 hour sliding window | Valkey | Auto-expire with TTL |

### Archival Strategy

**Bookings Archival (Local Development)**:
```sql
-- Run monthly via cron job or manual script
-- Move completed bookings older than 90 days to archive table

CREATE TABLE bookings_archive (LIKE bookings INCLUDING ALL);

-- Archive script (run with: npm run db:archive-bookings)
INSERT INTO bookings_archive
SELECT * FROM bookings
WHERE status IN ('completed', 'cancelled')
  AND end_time < NOW() - INTERVAL '90 days';

DELETE FROM bookings
WHERE status IN ('completed', 'cancelled')
  AND end_time < NOW() - INTERVAL '90 days';
```

**Calendar Cache Cleanup**:
```sql
-- Clean up expired calendar event cache entries daily
DELETE FROM calendar_events_cache
WHERE expires_at < NOW();
```

### Backfill and Replay Procedures

**Calendar Sync Backfill**:
When calendar integration is newly connected or after extended downtime:
```bash
# Trigger full calendar sync for a user
npm run calendar:backfill -- --user-id=<uuid> --days-back=30

# Bulk backfill for all users (use sparingly due to API limits)
npm run calendar:backfill-all -- --days-back=7 --rate-limit=10
```

**Notification Replay**:
For failed notifications stored in dead-letter queue:
```bash
# View failed notifications
npm run queue:dlq-inspect -- --queue=notifications

# Replay specific notification
npm run queue:dlq-replay -- --message-id=<id>

# Replay all failed notifications from last 24 hours
npm run queue:dlq-replay-all -- --since="24 hours"
```

**Booking Data Restoration**:
```bash
# Restore archived bookings for a user (for support cases)
npm run db:restore-bookings -- --user-id=<uuid> --from-date=2024-01-01

# Verify booking integrity after restore
npm run db:verify-bookings -- --user-id=<uuid>
```

---

## Deployment and Operations

### Rollout Strategy

**Local Development Rollout (2-3 service instances)**:

1. **Blue-Green Deployment (Recommended for Learning)**:
   ```bash
   # Terminal 1: Blue instance (current production)
   PORT=3001 npm run dev:server1

   # Terminal 2: Green instance (new version)
   PORT=3002 npm run dev:server2

   # Terminal 3: Load balancer pointing to blue (port 3001)
   npm run dev:lb

   # After testing green instance manually:
   # Update load balancer config to point to green (port 3002)
   # Verify all endpoints work
   # Terminate blue instance
   ```

2. **Canary Deployment (Advanced)**:
   ```bash
   # Configure nginx to split traffic
   # 90% to stable (port 3001), 10% to canary (port 3002)
   # Monitor error rates for 15 minutes before full rollout
   ```

**Deployment Checklist**:
- [ ] Run `npm run type-check` (TypeScript validation)
- [ ] Run `npm run test` (all tests pass)
- [ ] Run `npm run lint` (no linting errors)
- [ ] Run `npm run db:migrate` (apply pending migrations)
- [ ] Verify RabbitMQ connection
- [ ] Verify Valkey/Redis connection
- [ ] Test booking creation end-to-end
- [ ] Test availability calculation
- [ ] Monitor logs for errors for 5 minutes

### Schema Migrations

**Migration Workflow**:
```bash
# Create new migration
npm run db:migrate:create -- --name=add_booking_reminder_sent

# This creates: backend/src/db/migrations/003_add_booking_reminder_sent.sql
```

**Migration File Template**:
```sql
-- Migration: 003_add_booking_reminder_sent
-- Created: 2024-01-15
-- Description: Add flag to track reminder email status

-- UP
ALTER TABLE bookings ADD COLUMN reminder_sent BOOLEAN DEFAULT false;
CREATE INDEX idx_bookings_reminder ON bookings(reminder_sent) WHERE reminder_sent = false;

-- DOWN (for rollback)
-- DROP INDEX idx_bookings_reminder;
-- ALTER TABLE bookings DROP COLUMN reminder_sent;
```

**Running Migrations**:
```bash
# Apply all pending migrations
npm run db:migrate

# Check migration status
npm run db:migrate:status

# Rollback last migration (manual - requires editing migration file)
npm run db:migrate:rollback -- --steps=1
```

**Migration Safety Rules**:
1. Never drop columns in the same release as code changes - use two-phase approach
2. Add new columns as nullable or with defaults
3. Create indexes concurrently when possible: `CREATE INDEX CONCURRENTLY`
4. Test migrations on a copy of production data before applying
5. Keep migrations small and focused (one change per migration)

### Rollback Runbooks

**Scenario 1: Bad Code Deployment (No Database Changes)**
```bash
# 1. Identify the issue in logs
npm run logs:tail

# 2. Stop the new instance
# Ctrl+C on the new server process

# 3. Restart with previous code version
git checkout <previous-commit>
npm run dev:server1

# 4. Verify functionality
curl http://localhost:3001/health
```

**Scenario 2: Failed Database Migration**
```bash
# 1. Stop all application servers to prevent data corruption

# 2. Check migration status
npm run db:migrate:status

# 3. Manual rollback (execute DOWN section of migration)
psql $DATABASE_URL -f backend/src/db/rollback/003_rollback.sql

# 4. Update migration tracking
psql $DATABASE_URL -c "DELETE FROM schema_migrations WHERE version = '003';"

# 5. Restart application with previous code version
git checkout <previous-commit>
npm run dev
```

**Scenario 3: RabbitMQ Queue Backup**
```bash
# 1. Check queue depth
npm run queue:status

# 2. Pause consumers (let messages accumulate)
npm run queue:pause -- --queue=notifications

# 3. Investigate and fix the issue

# 4. Resume consumers
npm run queue:resume -- --queue=notifications

# 5. Monitor queue draining
watch 'npm run queue:status'
```

**Scenario 4: Cache Corruption (Valkey/Redis)**
```bash
# 1. Flush specific cache prefix
npm run cache:flush -- --prefix=availability:*

# 2. Or flush all caches (nuclear option)
npm run cache:flush-all

# 3. Application will rebuild cache on next request
# Monitor cache hit rates
```

---

## Capacity and Cost Guardrails

### Alert Thresholds

**RabbitMQ Queue Monitoring**:
| Queue | Warning Threshold | Critical Threshold | Action |
|-------|------------------|-------------------|--------|
| notifications | 100 messages | 500 messages | Scale consumers or check email service |
| calendar-sync | 50 messages | 200 messages | Check calendar API rate limits |
| dead-letter | 10 messages | 50 messages | Investigate failed messages |

**Prometheus Alert Rules** (for local Grafana setup):
```yaml
# prometheus/alerts.yml
groups:
  - name: calendly_alerts
    rules:
      - alert: QueueLagHigh
        expr: rabbitmq_queue_messages{queue="notifications"} > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Notification queue lag exceeds 100 messages"

      - alert: QueueLagCritical
        expr: rabbitmq_queue_messages{queue="notifications"} > 500
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Notification queue lag critical - check email service"

      - alert: CacheHitRateLow
        expr: rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m])) < 0.7
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 70% - review cache strategy"

      - alert: BookingLatencyHigh
        expr: histogram_quantile(0.95, rate(booking_create_duration_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Booking creation p95 latency exceeds 500ms"
```

### Storage Growth Monitoring

**PostgreSQL Table Sizes** (check weekly):
```sql
-- Run to monitor table growth
SELECT
  schemaname || '.' || tablename AS table_name,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
  pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS table_size,
  pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) AS index_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;
```

**Storage Thresholds** (Local Development):
| Resource | Warning | Critical | Action |
|----------|---------|----------|--------|
| PostgreSQL total | 5 GB | 10 GB | Run archival scripts |
| bookings table | 2 GB | 5 GB | Archive old bookings |
| calendar_events_cache | 500 MB | 1 GB | Reduce cache TTL or clean up |
| Valkey memory | 256 MB | 512 MB | Review cache eviction policy |
| RabbitMQ disk | 1 GB | 2 GB | Purge old messages |

### Cache Hit Rate Targets

| Cache Type | Target Hit Rate | Minimum Acceptable | Improvement Actions |
|------------|-----------------|-------------------|---------------------|
| Availability slots | 80% | 70% | Increase TTL to 10 min, pre-warm popular users |
| Calendar events | 85% | 75% | Batch calendar fetches, use webhook updates |
| User profiles | 95% | 90% | Increase TTL, cache is stable data |
| Meeting types | 95% | 90% | Invalidate only on explicit update |

**Cache Monitoring Script**:
```bash
# Add to package.json scripts
# "cache:stats": "node scripts/cache-stats.js"

# scripts/cache-stats.js outputs:
# - Total keys by prefix
# - Memory usage
# - Hit/miss rates (from application metrics)
# - TTL distribution
```

### Cost Optimization (Local Development Context)

**Resource Limits for Docker Compose**:
```yaml
# docker-compose.yml resource limits
services:
  postgres:
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M

  valkey:
    deploy:
      resources:
        limits:
          memory: 128M

  rabbitmq:
    deploy:
      resources:
        limits:
          memory: 256M
```

**Development vs. "Production-like" Configuration**:
| Setting | Development | Production-like |
|---------|-------------|-----------------|
| PostgreSQL connections | 5 | 20 |
| Valkey max memory | 64 MB | 256 MB |
| RabbitMQ prefetch | 1 | 10 |
| Calendar sync interval | 30 min | 10 min |
| Availability cache TTL | 1 min | 5 min |
| Log level | debug | info |

---

## Future Optimizations

1. **Intelligent Availability Prediction**
   - Use ML to predict user's preferred meeting times
   - Suggest optimal meeting times based on historical data

2. **Group Meeting Optimization**
   - Find common availability across multiple participants
   - Round-robin assignment across team members

3. **Advanced Scheduling Rules**
   - "Office hours" with first-come-first-served booking
   - Conditional availability (only if previous meeting type booked)
   - Dynamic pricing or prioritization

4. **Webhook Support**
   - Allow external systems to receive booking notifications
   - Enable custom integrations

5. **Mobile Apps**
   - Native iOS/Android apps for on-the-go scheduling

---

## Implementation Notes

This section documents the reasoning behind key implementation decisions in the codebase.

### Why Idempotency Prevents Double-Bookings

**The Problem:**
When a client submits a booking request, network issues or timeouts may cause them to retry the same request. Without idempotency handling, this can result in duplicate bookings:

1. First request succeeds and creates booking A
2. Client doesn't receive response (network timeout)
3. Client retries with identical data
4. Second request creates duplicate booking B
5. Host now has two overlapping meetings

**The Solution:**
The booking creation endpoint (`POST /api/bookings`) implements idempotency at two levels:

1. **Client-Provided Keys:** Clients can include an `X-Idempotency-Key` header. The system stores the result in Redis with this key. Subsequent requests with the same key return the cached result.

2. **Automatic Key Generation:** Even without a header, the system generates a deterministic key from `meeting_type_id + start_time + invitee_email`. This prevents accidental duplicates when the same invitee books the same slot.

**Implementation Details:**
- Keys are stored in Redis with a 1-hour TTL (`IDEMPOTENCY_CONFIG.KEY_TTL_SECONDS`)
- A distributed lock prevents race conditions during concurrent retries
- The idempotency key is also stored in the database for audit purposes

**Files:**
- `/backend/src/shared/idempotency.ts` - Idempotency service
- `/backend/src/services/bookingService.ts` - Integration in `createBooking()`
- `/backend/src/routes/bookings.ts` - Header extraction

### Why Meeting Archival Balances History vs Storage Costs

**The Problem:**
Scheduling systems accumulate booking data rapidly. A system with 1M users averaging 3 bookings/week generates ~157M bookings/year. Without data lifecycle management:
- Database tables grow unbounded, slowing queries
- Index maintenance becomes expensive
- Backup and restore times increase
- Storage costs escalate

**The Solution:**
A tiered retention strategy that balances operational needs with cost:

| Data State | Location | Retention | Purpose |
|------------|----------|-----------|---------|
| Active bookings | `bookings` table | Indefinite | Fast queries for scheduling |
| Completed (recent) | `bookings` table | 90 days | Rescheduling reference, analytics |
| Archived | `bookings_archive` table | 2 years | Legal/audit compliance |
| Expired | Deleted | - | Free storage |

**Why These Retention Periods?**
- **90 days in active table:** Covers most rescheduling scenarios and monthly reporting needs while keeping the working set small enough for fast queries.
- **2 years in archive:** Meets typical legal requirements for business records and provides sufficient history for analytics.

**Implementation Details:**
- Archival is triggered by `npm run db:archive-bookings` (run as a cron job)
- The `archived_at` timestamp tracks when data was moved
- Archive table has the same schema plus `archived_at` column
- Restoration is possible via `archivalService.restoreArchivedBookings()`

**Files:**
- `/backend/src/services/archivalService.ts` - Archival logic
- `/backend/src/shared/config.ts` - Retention configuration (`RETENTION_CONFIG`)
- `/backend/src/db/migrations/001_add_bookings_archive.sql` - Archive table schema

### Why Metrics Enable Availability Optimization

**The Problem:**
Availability calculation is the hottest path in a scheduling system (100 availability checks per booking). Without visibility into this operation:
- You can't identify performance bottlenecks
- Cache effectiveness is unknown
- You can't proactively optimize before users complain

**The Solution:**
Prometheus metrics at `/metrics` provide real-time observability:

**Booking Metrics:**
- `calendly_booking_operations_total{operation, status}` - Count of create/cancel/reschedule operations
- `calendly_booking_creation_duration_seconds{status}` - Latency histogram with p50/p95/p99
- `calendly_double_booking_prevented_total` - Should remain at zero in normal operation

**Availability Metrics:**
- `calendly_availability_checks_total{cache_hit}` - Cache effectiveness tracking
- `calendly_availability_calculation_duration_seconds{cache_hit}` - Calculation time by cache status

**Cache Metrics:**
- `calendly_cache_operations_total{operation, cache_type}` - Hit/miss/set/delete counts
- Target: 80% cache hit rate (minimum 70%)

**How This Enables Optimization:**
1. **Low cache hit rate?** Increase TTL or pre-warm cache for popular users
2. **High calculation latency?** Add indexes or simplify availability rules
3. **Many double-booking preventions?** Potential race condition in frontend
4. **Queue lag growing?** Scale notification workers

**Alert Thresholds:**
Configured in `ALERT_THRESHOLDS` in `/backend/src/shared/config.ts`:
- Booking p95 latency warning: 500ms
- Cache hit rate minimum: 70%
- Queue depth warnings at 100/500 messages

**Files:**
- `/backend/src/shared/metrics.ts` - Prometheus metric definitions
- `/backend/src/index.ts` - `/metrics` endpoint
- `/backend/src/shared/config.ts` - Alert thresholds

### Why Health Checks Enable Calendar Sync Reliability

**The Problem:**
External calendar APIs (Google, Outlook) are third-party dependencies. If they become unavailable:
- New bookings might conflict with external events
- Calendar events might not be created
- Users lose trust in the system

**The Solution:**
Multi-level health checks that detect and communicate failures:

**Health Check Endpoints:**
| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /health` | Load balancer check | Quick database + Redis ping |
| `GET /health/detailed` | Debugging | Component status with latencies |
| `GET /health/live` | K8s liveness | Process is running |
| `GET /health/ready` | K8s readiness | Ready to accept traffic |

**Health Status Levels:**
- `healthy` - All systems operational
- `degraded` - Some issues but functional (e.g., elevated latency)
- `unhealthy` - Critical failure, should not receive traffic

**Calendar Sync Reliability:**
The health check system supports calendar sync reliability by:
1. **Detecting Redis failures** - If Redis is down, calendar cache is stale
2. **Monitoring database connectivity** - Calendar events are persisted here
3. **Tracking sync lag** - `calendly_calendar_sync_lag_seconds` metric
4. **Alert thresholds** - Warning at 30 min lag, critical at 1 hour

**Graceful Degradation:**
When calendar sync is unavailable:
- Availability calculation uses cached data
- Booking still succeeds (with warning)
- Calendar event creation is queued for retry
- User is notified of potential conflicts

**Files:**
- `/backend/src/shared/health.ts` - Health check logic
- `/backend/src/index.ts` - Health endpoints
- `/backend/src/shared/config.ts` - `ALERT_THRESHOLDS.CALENDAR_SYNC`

---

*This architecture is designed for educational purposes to demonstrate key concepts in building a scheduling platform. Production systems would require additional considerations around disaster recovery, multi-region deployment, and advanced security measures.*
