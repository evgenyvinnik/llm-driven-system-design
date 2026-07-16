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
                              │ (Events,     │  │   (Cache)   │  │  Queue      │
                              │  Calendars,  │  │             │  │ (Reminders) │
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

## Frontend Architecture

### Component Hierarchy

```
App (TanStack Router)
├── __root.tsx (RootLayout)
│   ├── Header: logo, user email, logout button
│   └── <Outlet /> ──▶ routes
│
├── /login (LoginPage)
│   └── Login form (username + password)
│
└── / (CalendarPage)
    ├── CalendarSidebar
    │   ├── Create Event button
    │   ├── MiniCalendar (date picker)
    │   └── Calendar list with visibility toggles
    │
    ├── Toolbar
    │   ├── DateNavigator (prev/next/today + current date label)
    │   └── ViewSwitcher (month/week/day toggle)
    │
    ├── Calendar View (conditional rendering)
    │   ├── MonthView (7-column CSS Grid, 6 rows)
    │   │   └── EventCard (compact pill per event)
    │   ├── WeekView (7-column time grid, 1440px height)
    │   │   └── EventCard (absolute-positioned block)
    │   └── DayView (single-column time grid)
    │       └── EventCard (absolute-positioned block)
    │
    └── EventModal (create/edit form overlay)
        ├── Title, date/time pickers, calendar selector
        ├── Color picker (8 colors)
        ├── Conflict warning banner (amber)
        └── Delete button (edit mode only)
```

### Zustand Stores

The frontend uses two Zustand stores that separate concerns cleanly:

**`authStore`** -- Manages user session state. Uses Zustand's `persist` middleware to survive page reloads by storing the `user` object in `localStorage`. The store holds `user`, `isLoading`, and provides `setUser`, `setLoading`, and `logout` actions. The `partialize` option ensures only the user object is persisted, not the loading state.

**`calendarStore`** -- The central state hub for the calendar UI. This is a non-persisted store holding:

- **View state**: `currentDate` (the anchor date for the current view), `view` (month/week/day), and navigation actions (`goToToday`, `goToPrevious`, `goToNext`) that compute the next date using `date-fns` helpers (`addMonths`, `subWeeks`, etc.)
- **Events array**: Flat list of `CalendarEvent` objects with `setEvents`, `addEvent`, `updateEvent`, `removeEvent` mutators
- **Calendar visibility**: `calendars` array and `visibleCalendarIds` Set that controls which calendars' events are rendered. `toggleCalendarVisibility` adds or removes IDs from the Set
- **Modal state**: `isModalOpen`, `modalMode` (create/edit), `selectedEvent`, `modalDate` -- controlled by `openCreateModal`, `openEditModal`, `closeModal` actions
- **Computed helper**: `getViewDateRange()` returns the `{start, end}` date bounds for the current view. Month view extends from the start-of-week of the first day of the month to the end-of-week of the last day, capturing the "padding days" visible in the grid

### Routing

Uses TanStack Router with file-based routing. Two routes:
- `/login` -- Login form, redirects to `/` on success
- `/` (index) -- Main calendar view, redirects to `/login` if not authenticated

The root layout (`__root.tsx`) checks authentication on mount by calling `GET /api/auth/me`. If the session is valid, the user object is stored in `authStore`; otherwise the user is cleared and the login redirect triggers.

### Data Fetching

All API calls go through `services/api.ts`, which provides typed async functions wrapping `fetch` with `credentials: 'include'` for cookie-based session auth. The Vite dev server proxies `/api` requests to the Express backend at port 3000.

**Event loading lifecycle**: When the `CalendarPage` mounts, it loads calendars once. Then, whenever `currentDate`, `view`, or `calendars` change, a `useEffect` calls `getViewDateRange()` to compute the visible window and fetches only events within that range via `GET /api/events?start=...&end=...`. This keeps payloads small -- typically 20-100 events per view regardless of total event count.

**Client-side filtering**: After events are fetched, a `useMemo` filters them by `visibleCalendarIds`. Toggling a calendar's visibility does not trigger a new API call -- it only re-filters the already-fetched events.

### Key UI Patterns

**Calendar grid layout (MonthView)**: A CSS Grid with `grid-cols-7 grid-rows-6` creates the familiar 7x6 month layout. `getMonthDays()` returns 42 dates starting from the start-of-week of the first day of the month, including padding days from adjacent months. Padding days are visually dimmed with `bg-gray-50` and lighter text. Today's date gets a blue circular highlight. Each day cell shows up to 3 `EventCard` pills with a "+N more" overflow indicator.

**Time grid positioning (WeekView/DayView)**: The time grid uses a fixed `min-h-[1440px]` container (60px per hour x 24 hours). Events are positioned absolutely within each day column using percentage calculations: `top = (startMinutes / 1440) * 100%` and `height = (durationMinutes / 1440) * 100%`. This is a pure computation approach -- no DOM measurements, no layout thrashing, naturally responsive to container size. The `getEventPosition` utility in `utils/dateUtils.ts` handles clamping events that start before or end after the visible day.

**Conflict warning display**: The `EventModal` calls `createEvent` or `updateEvent`, which return a `conflicts` array alongside the saved event. If conflicts exist, an amber banner renders inside the modal listing each overlapping event with its time range. The event is still created -- conflicts are warnings, not blockers.

**Calendar visibility toggles**: The sidebar renders each calendar with a colored checkbox. Clicking toggles the calendar's ID in the `visibleCalendarIds` Set, which triggers the `useMemo` filter and instantly hides/shows events without re-fetching. The checkbox background color matches the calendar's color for visual consistency.

## Production-Grade Pattern Deep Dives

This section explains each production-grade pattern referenced in the architecture, written for readers encountering these concepts for the first time.

### Health Checks

A health check is an HTTP endpoint (typically `GET /health`) that reports whether the service is alive and capable of handling requests. Load balancers, container orchestrators (Kubernetes), and monitoring systems poll this endpoint at regular intervals (e.g., every 10 seconds). If the health check fails, the infrastructure stops routing traffic to that instance and may restart it.

A basic health check just returns HTTP 200 to prove the process is running. A more useful health check tests downstream dependencies -- can the service reach the database? Is Redis responding? This prevents a "zombie" scenario where the process is running but cannot actually serve requests because its database connection died.

**How it works in this project**: The Express server exposes `GET /api/health` that returns service status. A load balancer or container orchestrator can use this endpoint to determine whether to route traffic to this instance.

**Why it matters at production scale**: With dozens of service instances behind a load balancer, a single instance with a broken database connection would cause a fraction of requests to fail silently. Health checks detect this and remove the broken instance from the rotation within seconds, maintaining the 99.99% uptime target.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without it, a single misbehaving client (or an attacker) can overwhelm the server with requests, degrading performance for everyone.

**How it works**: The server tracks request counts per client (usually identified by user ID or IP address). When a request arrives, the server checks whether the client has exceeded their allowance. If they have, the server returns HTTP 429 (Too Many Requests) with a `Retry-After` header. If not, the request proceeds and the counter increments.

Common implementations use Redis for the counters because: (1) Redis is fast enough to check on every request without adding meaningful latency, (2) counters are shared across all server instances (a user hitting server A and server B still accumulates against the same counter), and (3) Redis TTL handles automatic counter expiry.

**Why it matters for a calendar service**: Event creation at production scale could be abused -- a script creating millions of events would bloat the database and trigger excessive conflict checks. Rate limiting event creation to 100/minute per user prevents this while being invisible to normal users who create maybe 5 events per day.

### RBAC (Role-Based Access Control)

RBAC is a method of restricting system access based on the roles assigned to users, rather than checking permissions for each user individually. Instead of maintaining a per-user permission list ("Alice can edit Calendar X, Bob can view Calendar X"), you define roles ("owner", "editor", "viewer") with associated permissions, and assign users to roles.

**How it works**: Each resource (e.g., a shared calendar) has an access control list mapping users to roles. When a user requests an action (e.g., "edit event in Calendar X"), the system looks up their role for that resource and checks whether the role permits the action. An "owner" can do everything, an "editor" can create/modify events, a "viewer" can only read.

**Why this matters for calendar sharing**: Google Calendar supports sharing calendars with different permission levels. Without RBAC, you would need to check permissions with custom logic for every API endpoint. RBAC centralizes this: add one middleware that looks up the user's role for the requested calendar, then allow or deny based on a simple role-to-permissions mapping. This is mentioned in the architecture as a production-scale feature (not implemented locally because the local version is single-user).

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "hit"), it is returned immediately. If not (a "miss"), the application queries the database, stores the result in the cache with a TTL (time-to-live), and returns it.

**How it works step by step**: (1) Application receives a request for data. (2) Check Redis: `GET cache:key`. (3) If found, return the cached value -- this is typically 10-50x faster than a database query. (4) If not found, query PostgreSQL. (5) Store the result in Redis: `SET cache:key value EX 300` (5-minute TTL). (6) Return the result.

**Cache invalidation**: When data changes (event created, updated, or deleted), the application deletes the relevant cache keys so the next read fetches fresh data from the database. The TTL provides a safety net -- even if invalidation is missed, the cache self-corrects within the TTL window.

**Why it matters for calendar reads**: The architecture targets 500K event reads/second at peak. PostgreSQL can handle maybe 10K-50K queries/second depending on complexity. Redis cache absorbs the remaining load, serving cached event lists for frequently viewed date ranges. A user checking their calendar 10 times in a minute hits the database once and Redis 9 times.

### Structured Logging

Structured logging means emitting log entries as machine-readable JSON objects instead of free-form text strings. Instead of `"User 123 created event 456 in 15ms"`, the log entry is `{"level":"info","userId":123,"eventId":456,"durationMs":15,"action":"event_created","timestamp":"2026-03-18T10:00:00Z"}`.

**Why JSON instead of text**: Free-form text logs require regex patterns to search and analyze. JSON logs can be indexed by any field -- you can query "show me all log entries where durationMs > 1000 and action = event_created" in a log aggregation system (Elasticsearch, Datadog, CloudWatch). This is the difference between spending 30 minutes grepping logs and getting an answer in 5 seconds.

**How Pino works**: Pino is a high-performance Node.js logging library that outputs JSON by default. It supports log levels (trace, debug, info, warn, error, fatal), child loggers (adding persistent context like `service: "calendar"`), and pretty-printing for local development. In production, the JSON output is piped to a log aggregation system.

**Why it matters at scale**: When 50 service instances are running and a user reports "my events didn't load," you need to find the specific request across all instances. Structured logs with a request correlation ID let you filter to that exact request flow. With text logs, this investigation takes hours; with structured logs, minutes.

### Prometheus Metrics

Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose metrics at a `/metrics` HTTP endpoint in a specific text format. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the time-series data for querying and alerting.

**Three metric types that matter**:
- **Counter**: A number that only goes up. Example: `events_created_total`. You query the *rate* of change to get "events created per second."
- **Gauge**: A number that goes up and down. Example: `active_websocket_connections`. Shows current state.
- **Histogram**: Tracks the distribution of values in configurable buckets. Example: `event_query_duration_seconds` with buckets at 0.01, 0.05, 0.1, 0.25, 0.5, 1.0 seconds. Lets you compute percentiles (p50, p95, p99) to understand latency distribution.

**How prom-client works**: The `prom-client` npm package creates a Prometheus metrics registry in the Node.js process. You define metrics (counters, gauges, histograms), instrument your code to update them, and expose the registry at `GET /metrics`. Prometheus scrapes this endpoint and stores the data.

**Why it matters for a calendar service**: The architecture targets p99 read latency < 100ms. Without metrics, you have no way to know if you are meeting this target. Prometheus histograms on event query duration give you exact p99 values, and you can set alerts when p99 exceeds 100ms for 5 consecutive minutes.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing downstream service. It works like an electrical circuit breaker: when failures exceed a threshold, the "circuit opens" and subsequent calls fail immediately without attempting the request. After a cooldown period, the circuit allows one test request through ("half-open"). If the test succeeds, the circuit closes and normal operation resumes. If it fails, the circuit stays open for another cooldown period.

**The three states**:
1. **Closed** (normal): Requests pass through. Failures are counted. If failures exceed the threshold (e.g., 50% of the last 10 requests), the circuit opens.
2. **Open** (failing): All requests are immediately rejected or routed to a fallback. No calls are made to the downstream service. This prevents cascading failures.
3. **Half-open** (testing): After the reset timeout, one request is allowed through. If it succeeds, the circuit closes. If it fails, the circuit reopens.

**Why this matters**: Without a circuit breaker, if Redis goes down, every request would wait for the Redis timeout (e.g., 3 seconds) before failing. With 1000 requests/second, that is 3000 requests stacked up waiting, consuming memory and threads, potentially crashing the application server. A circuit breaker detects the failure after a few requests and starts returning fallback responses immediately, keeping the application responsive.

**Opossum**: The Node.js circuit breaker library used in this repository. It wraps async functions and monitors their success/failure rate. Configuration includes error threshold percentage, timeout per request, and reset timeout. It emits events on state changes, which can drive Prometheus metrics and Pino log entries.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In the context of API design, an idempotent endpoint can safely handle duplicate requests -- if a network timeout causes the client to retry, the server does not create a duplicate resource.

**How idempotency keys work**: The client generates a unique key (typically a UUID) for each operation and sends it as a header (`X-Idempotency-Key`). The server checks Redis for this key before processing: (1) If found, return the cached result from the first execution. (2) If not found, process the request, store the result in Redis with a 24-hour TTL, and return it.

**Why this matters for event creation**: Without idempotency, a network timeout during event creation could cause the client to retry, creating a duplicate event. The user sees two identical meetings at the same time. With idempotency keys, the retry hits the cached result and returns the already-created event. The client cannot distinguish between "the first request succeeded" and "the retry returned the cached result," which is exactly the desired behavior.

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
