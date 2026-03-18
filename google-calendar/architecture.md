# Google Calendar - Architecture

## System Overview

A calendar and scheduling platform that allows users to manage events across multiple calendars with conflict detection, recurring events, and sharing capabilities. The system supports multiple views (Month, Week, Day) and provides responsive, interactive event management.

**Learning goals:** Calendar UI patterns with complex grid layouts, efficient time-range queries for conflict detection, date/time handling across views, state management for interactive calendar UIs, and session-based authentication.

## Requirements

### Functional Requirements
- Users create and manage multiple named calendars with color coding
- Event CRUD with title, description, location, start/end time, all-day flag
- Three calendar views: Month, Week, and Day
- Conflict detection warns users about overlapping events
- Toggle calendar visibility to show/hide event sets
- Recurring events (daily, weekly, monthly, yearly with RRULE)
- Event invitations and RSVP tracking

### Non-Functional Requirements (Production Scale)
- 99.99% uptime for calendar reads (users check schedules constantly)
- p99 read latency < 100ms for fetching a month's events
- Support 500M users with 50M daily active
- Handle 10B events total across all users
- Event creation/update p99 < 300ms
- Conflict detection within 50ms for any time range query

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| Total users | 500M | Global calendar service |
| DAU | 50M | 10% of total users |
| Events per user (avg) | 20/month | Mix of personal and work calendars |
| Total events | 10B | 500M users x 20 events/month x ~12 months historical |
| Event reads/sec (peak) | 500K | 50M DAU, ~10 views/day, concentrated in work hours |
| Event writes/sec (peak) | 50K | 50M DAU, ~1 event creation/day |
| Calendar data per user | ~5 KB | 20 events x 250 bytes avg |
| Total storage | ~2.5 TB | 10B events x 250 bytes |

## High-Level Architecture

```
┌──────────────┐         ┌──────────────┐         ┌──────────────────────────────────────┐
│              │         │              │         │           Backend Services             │
│   React SPA  │────────▶│  API Gateway │────────▶│                                      │
│  (Vite/TS)   │         │  (nginx/ALB) │         │  ┌────────────┐  ┌────────────┐      │
│              │         │              │         │  │  Calendar  │  │  Conflict  │      │
└──────────────┘         └──────────────┘         │  │  Service   │  │  Service   │      │
                                                  │  └─────┬──────┘  └─────┬──────┘      │
                                                  │        │               │              │
                                                  │  ┌─────┴──────┐  ┌────┴───────┐     │
                                                  │  │ Recurring  │  │ Notification│     │
                                                  │  │ Event      │  │  Service    │     │
                                                  │  │ Expander   │  │  (Reminders)│     │
                                                  │  └────────────┘  └────────────┘      │
                                                  └──────────────────────┬────────────────┘
                                                                        │
                              ┌─────────────┐  ┌─────────────┐  ┌──────┴──────┐
                              │ PostgreSQL   │  │   Redis     │  │  Message    │
                              │ (Events,     │  │  (Sessions, │  │  Queue      │
                              │  Calendars,  │  │   Cache)    │  │ (Reminders) │
                              │  Users)      │  │             │  │             │
                              └─────────────┘  └─────────────┘  └─────────────┘
```

## Core Components

### Calendar Views and Date Range Fetching

The frontend provides three views, each with different data requirements:

- **MonthView**: CSS Grid 7x6 layout displaying days with event pills. Shows up to 3 events per day with a "+N more" overflow indicator. The date range extends beyond the calendar month to include padding days from adjacent months (startOfWeek of the first day to endOfWeek of the last day).
- **WeekView**: 7-column grid with hourly rows (1440px min-height for 60px/hour). Events are positioned absolutely using percentage-based top/height calculations: `top = (startMinutes / 1440) * 100%`, `height = (durationMinutes / 1440) * 100%`.
- **DayView**: Single column with hourly slots and full event details.

Each view fetches only the events within its visible date range. The `getViewDateRange()` function returns appropriate bounds so the backend query is scoped to the minimum necessary window, keeping queries efficient as the event count grows.

### Conflict Detection

The conflict service checks for overlapping events using a time range overlap query:

```sql
SELECT e.id, e.title, e.start_time, e.end_time, c.name as calendar_name
FROM events e
JOIN calendars c ON e.calendar_id = c.id
WHERE c.user_id = $1
  AND e.id != COALESCE($4, 0)
  AND e.start_time < $3
  AND e.end_time > $2
  AND e.all_day = false
ORDER BY e.start_time
```

The condition `start_time < newEnd AND end_time > newStart` catches all four overlap cases: partial overlap on either end, complete containment in either direction. This is a standard interval overlap predicate.

Design decision: conflicts are shown as **warnings**, not blockers. Real-world calendars allow overlapping events (two meetings at the same time happen frequently). The API returns the list of conflicting events alongside the created event, and the frontend displays a warning banner. This respects user agency while providing helpful information.

### Recurring Events

At production scale, recurring events use the RRULE specification (RFC 5545). A recurring event stores the recurrence rule as a string (e.g., `FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231`). The **Recurring Event Expander** service materializes instances within a requested date range at query time rather than pre-generating all instances. This avoids storing millions of rows for a "every weekday forever" rule. Exception instances (single occurrence modifications or deletions) are stored separately and override the generated instances.

### Notification and Reminder System

At production scale, a notification service processes event reminders. When an event is created with a reminder (e.g., "15 minutes before"), a message is enqueued with a delivery timestamp. A scheduled worker polls the queue for due reminders and dispatches push notifications, emails, or in-app alerts.

## Database Schema

```sql
-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  timezone VARCHAR(50) DEFAULT 'UTC',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Calendars (users can have multiple calendars)
CREATE TABLE IF NOT EXISTS calendars (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#3B82F6',
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Events
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  location VARCHAR(255),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN DEFAULT FALSE,
  color VARCHAR(7),
  recurrence_rule TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- Efficient event range queries by calendar
CREATE INDEX idx_events_calendar_time ON events(calendar_id, start_time, end_time);

-- GiST index for range overlap queries (used by conflict detection)
CREATE INDEX idx_events_time_range ON events USING gist (
  tstzrange(start_time, end_time, '[)')
);

-- Session table for connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_calendars_updated_at
  BEFORE UPDATE ON calendars FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_events_updated_at
  BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

Key schema design decisions:

- **GiST index with `tstzrange`** enables PostgreSQL to use the range overlap operator for conflict detection, which is significantly faster than B-tree scans for interval queries at scale
- **CHECK constraint** (`end_time > start_time`) enforces valid time ranges at the database level, preventing corrupt data regardless of application bugs
- **Composite index** `(calendar_id, start_time, end_time)` supports the primary query pattern: fetch events for a specific calendar within a date range
- **SERIAL primary keys** are sufficient here since calendar data is not distributed -- a single PostgreSQL instance handles the write path. At production scale, UUIDs would be used for multi-region writes.
- **Trigger-based `updated_at`** ensures timestamps are always accurate, even for direct SQL updates

## API Design

### Authentication
```
POST /api/auth/register    → Create account (username, email, password)
POST /api/auth/login       → Login, create session
POST /api/auth/logout      → Destroy session
GET  /api/auth/me          → Current user info
```

### Calendars
```
GET  /api/calendars              → List user's calendars
POST /api/calendars              → Create calendar (name, color)
PUT  /api/calendars/:id          → Update calendar
DELETE /api/calendars/:id        → Delete calendar and all events
```

### Events
```
GET  /api/events?calendarIds=1,2&start=...&end=...  → Events in date range
POST /api/events                 → Create event (returns conflicts if any)
PUT  /api/events/:id             → Update event (returns conflicts if any)
DELETE /api/events/:id           → Delete event
```

## Key Design Decisions

### Conflict Detection: Warn, Don't Block

Conflicts are returned as warnings, not errors. The event is created successfully, and the response includes a `conflicts` array listing overlapping events. This matches how real calendars work -- users routinely have overlapping obligations and need to see them.

The trade-off is that naive users might not notice the warning. We mitigate this with prominent UI highlighting: conflicting events show a yellow warning banner in the event modal, and overlapping events in the week/day views are visually stacked with reduced opacity on the conflict.

### PostgreSQL Sessions vs Redis Sessions

We chose PostgreSQL-backed sessions (`connect-pg-simple`) instead of Redis. This simplifies infrastructure by requiring one fewer service -- sessions are transactional with user data (creating a user and establishing a session can share the same transaction context). The trade-off is higher session lookup latency (~2ms for PG vs ~0.2ms for Redis) and no built-in TTL cleanup (requires a periodic `DELETE FROM session WHERE expire < NOW()`). For a calendar application where session lookups happen once per request and the read-heavy pattern is event fetching (not session checking), this latency difference is negligible.

### View-Scoped Date Range Fetching

Rather than fetching all events and filtering client-side, each view calculates its visible date range and requests only those events. Month view includes padding days from adjacent months. This keeps query result sets small (typically 20-100 events per view) regardless of total event count. The trade-off is additional API calls when switching views, but each call is fast due to the composite index on `(calendar_id, start_time, end_time)`.

### Percentage-Based Event Positioning

Events in week/day views use CSS percentage positioning: `top = (startMinutes / 1440) * 100%`. This is pure computation with no DOM measurement, works with CSS percentage-based layouts, and is responsive to container size changes. The trade-off is that overlapping events at the same time render on top of each other rather than side-by-side -- a known limitation in the current implementation.

## Consistency and Idempotency

- **Event creation** is idempotent by content: duplicate submissions within a short window with the same title, time, and calendar are detected client-side before sending
- **Calendar deletion** cascades to all events via `ON DELETE CASCADE` -- a single DELETE statement atomically removes the calendar and all its events
- **Session cleanup** uses PostgreSQL's `expire` column; a periodic cleanup query removes stale sessions
- **Conflict detection** is read-only and naturally idempotent -- querying for overlaps produces the same result regardless of how many times it runs

## Security and Auth

- Session-based authentication with PostgreSQL-backed store
- Password hashing with bcryptjs
- HTTP-only, SameSite=lax cookies prevent CSRF
- CORS restricted to frontend origin
- At production scale: OAuth2 for Google/Microsoft account federation, RBAC for shared calendars (owner, editor, viewer), rate limiting on event creation

## Observability

- **Health check**: `GET /api/health` returns service status
- At production scale: Prometheus metrics for event query latency, conflict detection rate, cache hit ratio; structured logging with request correlation; distributed tracing for multi-service flows

## Failure Handling

- **Database connection pool**: Connection pooling via `pg.Pool` with idle timeout for resource cleanup
- **Session store resilience**: `connect-pg-simple` retries failed session writes
- **Input validation**: CHECK constraint at the database level prevents invalid time ranges even if application validation is bypassed
- At production scale: circuit breakers on notification service, retry queues for failed reminder deliveries, graceful degradation (serve cached calendar data if primary DB is unreachable)

## Scalability Considerations

**What breaks first at scale:**

1. **Event queries for power users** -- A user with 10 calendars and thousands of events per month. The composite index handles this efficiently up to ~100K events per calendar. Beyond that, partition events by `calendar_id` and time range.

2. **Recurring event expansion** -- A "every weekday" rule spanning years generates thousands of virtual instances per query. Solution: expand only within the requested date range (never materialize all instances), cache expanded results in Redis with a short TTL.

3. **Conflict detection on busy calendars** -- Checking conflicts across 10 calendars with hundreds of events in the same week. The GiST index with `tstzrange` keeps this efficient, but at extreme scale (1000+ events/week), pre-compute a conflict bitmap per time slot.

**Scaling path:**
- Read replicas for calendar/event queries (strong consistency needed only for writes)
- Redis caching for frequently viewed date ranges (invalidate on event create/update/delete)
- Separate service for recurring event expansion with its own cache
- CDN for static assets
- Event-driven notification system with message queue for reminders

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict handling | Warn, don't block | Block overlapping events | Real calendars allow overlaps; user decides |
| Session storage | PostgreSQL | Redis | One fewer service; latency difference negligible for calendar |
| Event fetching | View-scoped date range | Fetch all, filter client-side | Small result sets, efficient queries |
| Event positioning | CSS percentages | DOM measurement | Pure computation, responsive, no layout thrashing |
| Recurring events | Query-time expansion | Pre-materialized instances | Avoids storing millions of rows |
| Primary keys | SERIAL (local) | UUID (distributed) | Single-writer DB; switch to UUID for multi-region |

## Implementation Notes

### Local Setup Diagram

```
┌─────────────────┐         ┌──────────────────────────────────────┐
│   React SPA     │         │        Express Server                │
│  localhost:5173  │────────▶│        localhost:3000                │
│  (Vite + TS)    │         │                                      │
│                 │         │  Routes: auth, calendars, events     │
│  Components:    │         │  Services: conflictService           │
│  MonthView      │         │  Sessions: connect-pg-simple         │
│  WeekView       │         │                                      │
│  DayView        │         └──────────┬───────────────────────────┘
│  EventModal     │                    │
│  CalendarSidebar│             ┌──────┴──────┐    ┌──────────┐
│                 │             │ PostgreSQL  │    │  Valkey   │
│  Store: Zustand │             │   :5432     │    │  :6379    │
│  (calendarStore)│             │google_calendar│   │(available,│
└─────────────────┘             │             │    │ not used) │
                                └─────────────┘    └──────────┘
```

### Production-Grade Patterns Implemented

1. **Conflict detection service** -- Server-side overlap detection using the standard interval overlap predicate. Checks across all user calendars in a single query. Returns warnings alongside the created event. See `src/services/conflictService.ts`.

2. **GiST range index** -- PostgreSQL GiST index with `tstzrange` for efficient interval queries, matching production-grade calendar systems. See `src/db/init.sql`.

3. **CHECK constraints** -- Database-level enforcement of `end_time > start_time`. Prevents invalid data regardless of application-layer validation. See `src/db/init.sql`.

4. **Trigger-based timestamps** -- `update_updated_at_column()` trigger ensures `updated_at` is always accurate. See `src/db/init.sql`.

5. **Health check endpoint** -- `GET /api/health` for load balancer integration. See `src/api/app.ts`.

6. **View-scoped data fetching** -- Frontend calculates exact date range needed per view, minimizing data transfer. See `stores/calendarStore.ts` (`getViewDateRange`).

### Simplifications vs Production

| Component | Local Implementation | Production Equivalent |
|-----------|---------------------|----------------------|
| Database | Single PostgreSQL instance | Primary + read replicas, partitioned by time |
| Sessions | PostgreSQL-backed (connect-pg-simple) | Redis Cluster with session replication |
| Auth | Username/password with bcrypt | OAuth2 (Google, Microsoft SSO) |
| Caching | No caching layer | Redis cache for event queries, recurring event expansion |
| Recurring events | `recurrence_rule` column stored but not expanded | RRULE parser + query-time expansion service |
| Notifications | Not implemented | Message queue + push/email notification service |
| Event sharing | Not implemented | RBAC with owner/editor/viewer permissions |
| Timezone handling | Server time only | Per-user timezone with UTC storage, client conversion |

### Omitted from Local Implementation
- CDN for static assets
- Multi-region deployment
- Kubernetes orchestration
- Recurring event expansion (RRULE parsing)
- Event invitations and RSVP
- Drag-and-drop event moving/resizing
- Calendar sharing with permissions
- Push notifications and email reminders
- Timezone conversion (uses server time)
- Rate limiting
- Prometheus metrics and structured logging
- Overlapping event side-by-side layout in week/day views
