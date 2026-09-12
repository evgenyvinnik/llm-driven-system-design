# Google Calendar architecture

## System Overview

This project teaches calendar views, event persistence, ownership checks, and interval overlap queries. The running implementation is a React browser, one Express API, and one PostgreSQL database that also stores sessions. It supports private calendars and nonrecurring events. A Valkey container is declared but unused. It is not integrated with Google Calendar.

The production design below is **proposed**, not a description of deployed infrastructure. Local behavior is explicitly identified in component/API sections, the exact local schema is reproduced separately, and the final Implementation Notes trace source behavior and gaps. Setup belongs in [README.md](./README.md); historical development notes remain in [CLAUDE.md](./CLAUDE.md).

## Requirements

### Proposed production scope

Users manage several private calendars, navigate month/week/day views, create timed or all-day events, and receive advisory warnings about overlaps. Read and write requests enforce ownership. Hiding a calendar changes display, not its contribution to scheduling warnings. The first release allows overlaps; it does not guarantee exclusive room or appointment reservations.

| Requirement | Proposed target or invariant |
|-------------|------------------------------|
| Availability | 99.9% monthly for authenticated calendar reads and writes in the home region |
| Read latency | p95 under 200 ms for an admitted, bounded range request in that region |
| Write latency | p95 under 300 ms for ordinary event edits, excluding user interaction |
| Browser responsiveness | Local navigation feedback under 100 ms; smooth scrolling on an agreed reference device |
| Time semantics | Explicit instants for timed events; exclusive date boundaries for all-day events |
| Durability | A success result means the event and its retry receipt committed |
| Concurrency | Stale edits are rejected with the current version; overlaps remain allowed |
| Privacy | No event or cached response crosses the account boundary |
| Accessibility | Keyboard navigation, accessible event details, and usable save/error announcements |

These targets are design assumptions, not measured results or guarantees of the local application. Sharing, invitations, notifications, external calendar synchronization, recurring series, and indefinite offline editing are extensions rather than prerequisites for this baseline. Recurrence requires an additional temporal model; a text field alone does not implement it.

## Capacity Estimation

Assume 10 million registered users with 200 stored events each: **2 billion events**. At an assumed 1 KB per event including a typical description, event payload alone is about **2 TB**, before indexes, user/calendar rows, replication, backups, and database overhead. This is a planning example, not Google's usage or a benchmark.

With 1 million daily active users, 30 range reads and two mutations per active user give 30 million reads/day and 2 million writes/day: approximately 347 reads/s and 23 writes/s on average. A tenfold peak is roughly 3,470 reads/s and 230 writes/s. A synchronized Monday morning peak can exceed that multiplier, so admission and load testing matter more than a universal requests-per-server estimate.

The query's cost depends on events examined, interval length, number of calendars, and response size. Request only the displayed date window, bound its length, and page dense results. A normal month needs at most six weeks of dates. Treat 500 events per response as an initial payload budget to test, with an explicit continuation indicator rather than silently dropping further events.

### Local Development Scale

The fresh seed contains two users, three calendars, and seven events, all belonging to Alice. One PostgreSQL instance and two Node processes for API/Vite are sufficient for that demonstration. Valkey can be left stopped. No production capacity or memory measurement was made during this documentation review.

## High-Level Architecture

### Proposed production system

Draw the authenticated request path first, then the optional cache path. Static browser assets come from a CDN. The gateway and Calendar service scale across instances; PostgreSQL remains authoritative for each owner's data. The boxes describe responsibilities and can initially share a deployment.

```text
┌────────────────────────┐ HTTP   ┌────────────────────────┐      ┌────────────────────────┐
│ Browser / clients      │        │ API gateway            │      │ Session store          │
│ Date range or command  │◀──────▶│ Auth + request limits  │◀────▶│ Shared, revocable      │
└────────────────────────┘        └────────────────────────┘      └────────────────────────┘
                                              ▲
                                              │
                                              │  authorized request / result
                                              │
                                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Calendar service (replicated, logically separate query and command paths)                │
│ Range queries | event commands | advisory overlap checks                                 │
│ Validate ownership, explicit time type, expected version, and operation ID               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                   ▲                                     ▲
                                                   │                                     │
                                                   │                                     │
  canonical reads / atomic writes                  │           optional range cache      │
                                                   │                                     │
                                                   │                                     │
                                                   ▼                                     ▼
┌──────────────────────────────────────────────────────┐       ┌───────────────────────────┐
│ PostgreSQL primary / owner partition                 │       │ Private range cache       │
│ Users, calendars, events, range indexes              │       │ Owner + range + zone      │
│ Event versions + operation receipts + outbox         │       │ Bounded TTL, disposable   │
└──────────────────────────────────────────────────────┘       └───────────────────────────┘
                                                   │                          ▲
                                                   │                          │
                                                   │                          │
  committed outbox records                         │                          │
                                                   │                          │
                                                   │       evict ranges       │
                                                   ▼                          │
┌──────────────────────────────────────────────────────┐                      │
│ Outbox worker (if caching is added)                  │──────────────────────▶
│ Retry changed-range invalidation after commit        │
└──────────────────────────────────────────────────────┘
```

1. The browser sends a bounded date range or an identified mutation. The gateway validates the session and applies request limits.
2. The Calendar service authorizes the owner and calendar, then either reads a range or validates and commits an event mutation. The overlap check is advisory; it never reserves the interval.
3. PostgreSQL commits the event, its version, an operation receipt, and an outbox entry when downstream work is needed. The canonical result returns through the service and updates the browser's event model.
4. If profiling justifies range caching, cache entries contain a snapshot revision. An outbox worker invalidates affected old and new ranges after writes. A writer's minimum revision forces a current read when a cached snapshot is too old.

The cache and outbox worker are optional scaling additions. They do not appear in the local application. A session store may initially use PostgreSQL, with its workload measured separately; adding another database is not justified by a user-count threshold alone.

### Implemented local topology

```text
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ React browser          │       │ Express API            │       │ PostgreSQL 16          │
│ Views + modal + store  │◀─────▶│ Calendar + event API   │◀─────▶│ Data + session table   │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘

                          Vite proxies /api to Express; Valkey is not used


Read: get range → owner-filtered SQL → replace events array → render

Write: submit modal → SQL write + conflict result → update array → close modal
```

The routers and conflict service run in the same Express process. There is no gateway, cache, replica routing, outbox, background worker, WebSocket channel, or read/write service split. Both calendar data and sessions depend on the shared PostgreSQL pool.

## Core Components / Request Flows

### Proposed browser responsibilities

The view layer renders month cells, day segments, overlap lanes, and an all-day lane. A calendar model owns server event entities and range load state; a separate editor draft owns unsubmitted text and selected time fields. Navigation owns date, view, display zone, and visible calendars. A data-access coordinator handles request identity, cancellation, errors, and canonical save results.

The high-level browser diagram and walkthrough are in the [frontend answer](./system-design-answer-frontend.md). Server reads are keyed by account, calendar set, exclusive interval, and display zone where it affects interpretation. A mutation invalidates every loaded range that intersects either the old or new event interval. Hidden calendars remain available to the server's warning query.

### Proposed read flow

Convert the visible civil dates in the chosen zone into exact interval boundaries. Authorize the requested calendars. Query overlapping events using a half-open interval, then return stable ordering, a continuation cursor, and a snapshot revision. All-day date ranges use their own civil-date semantics instead of being shifted through UTC as if they were meetings.

For paginated range reads, continuation must refer to a consistent revision. A simple initial protocol rejects a continuation if the owner's calendar revision changed and asks for a fresh range. Bound these restarts and offer a narrower day/agenda request for a very busy account. Do not append pages from unrelated snapshots and call the resulting calendar complete.

**Local:** [the event router](./backend/src/routes/events.ts) joins events to calendars, filters by the session owner, and uses `start_time < requested_end AND end_time > requested_start`. It optionally filters one `calendarId`, orders only by start time, and has no pagination, stable tie-breaker, interval length limit, or revision. The browser fetches all owned calendars for the view and filters visibility locally.

### Proposed create and edit flow

Freeze the submitted editor revision. The API validates its temporal type, title, calendar ownership, operation ID, and expected event version for an edit. Within a database transaction, it claims or reads the operation receipt, performs the conditional mutation, advances the owner's change revision, and records the result. A duplicate request with the same payload returns the earlier result; reuse of the operation ID with different content is rejected.

Obtain an advisory overlap snapshot using normalized times. If the warning subsystem is unavailable, return the committed event with an explicit warning-unavailable status; do not turn a committed edit into an ordinary failed-save response. The browser reconciles the canonical result, reports “Saved,” and leaves any overlap warning visible outside a closing modal or inside a deliberate saved-result state.

**Local:** create checks overlaps **before** insertion; update persists the row **before** checking overlaps. Neither wraps the whole flow in a transaction. A failed update warning query can therefore return HTTP 500 after a successful update. Both responses carry a raw event row and optional conflicts; the browser only changes its events array after the response and then closes the modal.

### Proposed rendering flow

Split each timed event into the civil days it intersects, excluding an end exactly at the next day's boundary. Clip each segment before calculating its visual height. Assign horizontal lanes within connected groups of overlapping segments. Keep true times separate from minimum visual hit areas, and provide an agenda alternative when a grid becomes too dense.

Use a zone-aware mapping from instants to displayed wall-clock positions. A DST transition can remove or repeat an hour; mark the gap or repeated offset explicitly, or provide an agenda presentation for that interval. A fixed denominator of 1,440 elapsed minutes with ordinary 24-hour wall-clock labels is not sufficient on those dates.

**Local:** [dateUtils.ts](./frontend/src/utils/dateUtils.ts) uses browser-local date-fns operations. Month dates span whole Sunday-starting weeks and total 28, 35, or 42 cells. Day/week components use 24 fixed hourly slots, shared full-width event positioning, and no overlap lanes. Their all-day events are filtered out entirely.

## Database Schema

### Proposed production additions

The following model extends the local tables; it is not present in migrations.

| Entity | Important fields | Constraint / purpose |
|--------|------------------|----------------------|
| Calendar owner | Account, home partition, change revision | Route private calendars together; scope range freshness |
| Calendar | ID, owner, name, color | Ownership must match every associated event |
| Timed event | ID, calendar, start/end instants, authored zone, version | End after start; explicit temporal type |
| All-day event | ID, calendar, inclusive start date, exclusive end date, version | Whole civil dates; no synthetic 23:59:59 endpoint |
| Operation receipt | Owner, operation ID, payload fingerprint, outcome, retention | Same identified request has one retained result |
| Change/outbox record | Owner revision, event ID, old/new interval, event version | Invalidate both sides of moves and recover downstream work |
| Session | Opaque ID, account, expiry | Shared session validation and revocation |

For owner sharding, store the owner on event records and enforce consistency with the calendar's owner, such as a composite relationship. Ordinary foreign keys do not automatically create every lookup index. Add an owner lookup for calendars and select an event index based on measured overlap queries.

A B-tree beginning with calendar ID and start time is a useful starting point for ordinary calendars. Very long events and large histories can make an overlap query examine many candidates. A matching range expression with the overlap operator can use a GiST range index; it is not enough simply to declare such an index while querying unrelated scalar predicates. See [PostgreSQL range indexing](https://www.postgresql.org/docs/16/rangetypes.html#RANGETYPES-INDEXING). Compare actual query plans before adding redundant indexes.

### Exact local schema

The following is [backend/src/db/init.sql](./backend/src/db/init.sql), executed by `npm run db:migrate`. It contains four tables, three explicit secondary indexes, one trigger function, and three update triggers. This is a consolidated schema initializer, not a migration history that upgrades arbitrary older table shapes.

```sql
-- Google Calendar Schema

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

  -- Ensure end time is after start time
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- Index for efficient time range queries
CREATE INDEX IF NOT EXISTS idx_events_calendar_time ON events(calendar_id, start_time, end_time);

-- Index for fetching events within a date range
CREATE INDEX IF NOT EXISTS idx_events_time_range ON events USING gist (
  tstzrange(start_time, end_time, '[)')
);

-- Session table for connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_calendars_updated_at
  BEFORE UPDATE ON calendars
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

`recurrence_rule` is stored but unused by the API and UI. User `timezone` is returned but not applied to rendering or save conversion. There is no uniqueness constraint for one primary calendar per owner, no event version, and no operation receipt. The `updated_at` triggers do not provide conditional concurrency control.

The GiST expression index exists, but both implemented overlap queries use scalar inequalities instead of the indexed `tstzrange` expression and a range operator. Do not claim this index accelerates those statements without changing the query and examining a plan. No live `EXPLAIN` was run in this review.

## API Design

### Implemented API

Authentication routes are in [auth.ts](./backend/src/routes/auth.ts); protected calendar routes are in [calendars.ts](./backend/src/routes/calendars.ts), and events in [events.ts](./backend/src/routes/events.ts).

| Method | Path | Request / response behavior |
|--------|------|-----------------------------|
| POST | `/api/auth/register` | Username, email, password, optional timezone; returns user and establishes session |
| POST | `/api/auth/login` | Username/password; returns user and establishes session |
| POST | `/api/auth/logout` | Destroys session; success response or 500 |
| GET | `/api/auth/me` | Current user; 401 without a valid account/session |
| GET | `/api/calendars` | Own calendars, primary first then name |
| POST | `/api/calendars` | Name and optional color; non-primary calendar |
| PUT | `/api/calendars/:id` | Name/color only; owner-scoped |
| DELETE | `/api/calendars/:id` | Rejects primary calendar; cascade removes its events |
| GET | `/api/events` | Required `start`, `end`; optional singular `calendarId`; overlapping event rows |
| GET | `/api/events/:id` | Owner-scoped event with calendar name and effective color |
| POST | `/api/events` | Required calendarId/title/startTime/endTime; optional description/location/allDay/color |
| PUT | `/api/events/:id` | Partial event fields; no expected version |
| DELETE | `/api/events/:id` | Deletes through owner-scoped calendar subquery |
| GET | `/api/events/:id/conflicts` | Rechecks an existing event against owned, non-all-day events |
| GET | `/api/health` | Static `{ "status": "ok" }`; session middleware runs before it |

Example **direct API** timed-event creation, with a session cookie:

```json
{
  "calendarId": 1,
  "title": "Project review",
  "startTime": "2026-09-10T14:00:00-07:00",
  "endTime": "2026-09-10T15:00:00-07:00",
  "allDay": false
}
```

The success response contains `event` and, only when nonempty, `conflicts`. The event row uses `calendar_id`, `start_time`, and other SQL column names. Read routes coalesce an absent event color to its calendar's color and add `calendar_name`; create/update return raw rows without that normalization. Consumers cannot assume identical metadata on every response.

The existing editor sends timezone-less values instead of the offset-qualified example. Also, blank description/location become omitted fields and the update's `COALESCE` retains the old value. Conversely, `color` is assigned directly, so omission clears an event color override. Invalid date syntax and many other validation failures become generic 500 responses; only a detected `valid_time_range` violation gets the specific end-after-start 400.

### Proposed contract extensions

Keep read intervals exclusive at the end and require a temporal type for saves. Add runtime validation, range/payload bounds, stable continuation, event versions, and operation receipts. Define omitted, null, and empty text separately so clients can intentionally clear fields. A canonical save response should include the same display metadata as reads, plus the owner's revision and advisory status.

Use a dedicated preview endpoint only if live unsaved-event warnings are required. The local `/api/events/:id/conflicts` checks a stored event and cannot preview an arbitrary editor draft. Preview results need their own draft/request identity and remain advisory because another device can write afterwards.

## Key Design Decisions

### Preserve temporal meaning across the boundary

A timed meeting is an interval of instants; an all-day holiday is a range of dates. Sending an explicit offset solves instant ambiguity for an individual event, while an IANA zone preserves the authored location for future editing. PostgreSQL normalizes `timestamptz` values and does not retain the originally supplied zone; timezone-less inputs use the session `TimeZone`. See [PostgreSQL timestamp semantics](https://www.postgresql.org/docs/16/datatype-datetime.html#DATATYPE-DATETIME-INPUT-TIMESTAMPS).

The local path has three potentially different interpretations: the form uses browser wall time, the conflict check constructs Node `Date` values, and SQL consumes the original timezone-less strings. The schema type alone cannot reconcile those choices. Standardize the boundary before optimizing reads.

For all-day data, use an exclusive end date: a one-day event on September 10 ends at September 11. That avoids precision hacks and accidental inclusion on the following day. This follows the event/date boundary model in [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.6.1).

If recurring series are added, persist the local recurrence rule and named zone, with exceptions keyed by the original occurrence identity. Bound expansion to the requested window. A weekly 09:00 meeting is not generated by adding fixed UTC durations forever. Explicitly document DST gap/fold behavior and use a tested standards-aware expansion library; the current text column supplies none of this.

### Warn about overlaps without promising exclusive reservations

Two positive-duration intervals overlap when each starts before the other ends. Adjacent meetings can touch without conflicting. A personal calendar should allow tentative and competing events; rejecting all overlaps would prevent normal usage. The trade-off is that a warning describes a snapshot, and concurrent writes can introduce additional overlaps after the check.

A room reservation is a different invariant. A preflight query followed by insertion, even inside an ordinary transaction, does not by itself exclude concurrent reservations. That extension needs a database-enforced non-overlap constraint or equivalent correctly serialized resource allocation. Do not burden every personal event with that stronger restriction.

The local conflict service excludes existing all-day events but still runs for a newly submitted all-day event, creating an asymmetric rule. The proposed baseline treats all-day entries as informational and checks timed busy events consistently; a future explicit busy/free property can make the policy configurable.

### Bound range work before introducing a cache

Querying the visible interval limits network and rendering work, but not necessarily the number of database candidates. Measure long-lived events, many calendars, and dense imported history. An index must match the access pattern; blindly adding replicas will not repair an inefficient query.

A private range cache can reduce repeated reads, but moves affect both old and new ranges, and delayed fills can race invalidation. Keep entries tied to their source revision, enforce TTLs, and bypass insufficient revisions for the writer. Other devices may see bounded stale data under this optional policy. Atomic database commits remain the source of truth, so cache failures must not convert successful writes into ambiguous failures.

Caching every month indefinitely gives cheap repeat navigation but expands invalidation and memory costs. The first release can read PostgreSQL directly and retain only a few bounded browser ranges. Introduce shared caching after evidence shows repeat work is the limiting factor.

## Consistency and Idempotency

**Proposed:** the write transaction combines the conditional event mutation and an owner-scoped operation receipt. Concurrent uses of the same operation ID must meet a uniqueness constraint. Validate that repeated IDs have identical content; retain results for a declared retry period. If the response is lost, retry the same frozen operation or query its result. After receipt expiry, reconcile the event rather than silently treating an old operation as a new create.

An event version prevents one editor from overwriting another. On a stale version, return the current event while the client preserves its draft. These versions detect concurrent edits; they do not prevent time overlaps. A read-after-write token also prevents the writer's next range read from regressing behind an acknowledged mutation.

**Local:** single SQL inserts, updates, and cascading deletes are atomic database statements, but multi-step routes do not provide the proposed transaction. Creates can duplicate on retry, updates are last-writer-wins, registration can leave a user without a default calendar, and post-update conflict lookup can fail after persistence. There is no outbox, operation status, conditional version, or canonical range revision.

## Security / Auth

**Implemented:** [app.ts](./backend/src/api/app.ts) configures credentialed CORS, JSON parsing, and `connect-pg-simple` on the shared pool with table `session`. Cookies use the default `connect.sid` name, a 30-day max age, HttpOnly, SameSite=Lax, and Secure only under `NODE_ENV=production`. [requireAuth](./backend/src/shared/auth.ts) checks the session user ID. Routes use parameterized queries and owner predicates/checks; login compares bcrypt hashes and registration hashes with cost 10.

The installed session library rejects expired sessions during lookup and schedules automatic cleanup around a randomized 15-minute interval. There is no application-level session query retry wrapper. Login/registration assign the user to the existing session rather than explicitly regenerating its ID. Registration's user and default-calendar inserts are separate statements.

**Needed for production:** session rotation on authentication, a managed signing secret, correct HTTPS/proxy configuration, origin/CSRF defenses appropriate to cookie-authenticated writes, bounded field validation, and login/request rate limits. HttpOnly and SameSite reduce specific risks but are not a complete XSS/CSRF strategy. Calendar visibility toggles are display preferences, never authorization controls.

Clear private browser state and retire in-flight callbacks when the account changes. The local auth profile is persisted under `auth-storage` and rechecked through `/me`, but the separate calendar store is not cleared on logout. A pending response or editor state can survive an account transition. Protect the client boundary as well as the SQL owner predicates.

## Observability

**Local:** errors are written through `console.error`; there is no structured request logging, tracing, Prometheus endpoint, or dashboard. `/api/health` returns a constant body and does not explicitly probe PostgreSQL. Because session middleware runs first, a request carrying a session can still depend on a session lookup before reaching it.

**Proposed:** measure range latency together with range size, candidate/returned row counts, calendar count, and cache source revision. Track write outcomes separately as committed, rejected, conflicted, or unknown to the caller. Record advisory warning failures independently of save failures. Add database pool saturation, session errors, replication lag if replicas are introduced, and outbox backlog.

Browser telemetry should cover stale-response drops, missing/failed ranges, save uncertainty, editor conflict recovery, layout cost, and all-day/DST fixtures. Avoid event titles, descriptions, raw cookies, or other private contents in logs. Define readiness around required dependencies and keep a separate lightweight liveness check.

## Failure Handling

| Failure | Proposed response | Current behavior |
|---------|-------------------|------------------|
| PostgreSQL unavailable | Fail authenticated reads/writes explicitly; preserve draft | Generic errors; range errors only logged in browser |
| Save response lost | Resolve operation receipt before retrying as new intent | No receipt; duplicate creates or uncertain updates possible |
| Warning lookup fails | Return committed result with warning status unavailable | Update can return 500 after its SQL write |
| Old range response arrives | Reject wrong account/range/request generation | Unconditionally replaces the events array |
| Another device edits | Return version conflict and retain both versions | Unconditional update can overwrite newer fields |
| Optional cache unavailable | Read primary within capacity limits | No application cache exists |
| User closes editor during save | Keep completion scoped to that editor generation | Late completion can close a newly opened editor |
| Session expires / logout fails | Reauthenticate; clear private state only with explicit outcome | Logout wrapper ignores HTTP error status |

Retries need bounded backoff and should apply only where the operation has safe semantics. A successful database update cannot be rolled back by changing a browser array after the response is lost. The UI must describe uncertainty accurately.

## Scalability Considerations

Scale stateless API instances with bounded database pools; their aggregate connection count matters. Profile range queries and owner skew first. Add read replicas only for requests that permit lag, or route using a minimum revision to a source that can satisfy it. Replicas do not provide automatic read-after-write consistency.

If event volume outgrows one database, partition private calendars by owner so ordinary range reads and mutations stay local. Maintain a directory for owner placement and plan migration/cutover with a single active writer. A large organization with shared calendars changes that partitioning problem and requires a separate access/fan-out design; it is outside this baseline.

For browser scale, bound cached ranges, prefetch only adjacent views, memoize day grouping, and limit visible pills with a reachable agenda expansion. Virtualization can help a long agenda, but a seven-column week does not automatically need a virtualized grid. Profile layout and interaction latency on dense and DST-transition fixtures.

Do not claim fixed throughput multipliers for partitioning, replicas, Valkey, or a Node process. Query shape, contention, event size, and deployment hardware determine useful capacity. The repository supplies no such benchmark.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Event time | Explicit instants and separate date ranges | Timezone-less timestamps for everything | Preserve meeting and all-day meaning |
| Overlap policy | Advisory warnings | Reject every overlap | Personal calendars permit competing commitments |
| Save correctness | Conditional versions and retained receipts | Unconditional retries | Detect stale edits and resolve uncertain outcomes |
| Range reads | Bounded owner-scoped queries first | Unbounded histories or immediate cache complexity | Limit payload and establish measured bottlenecks |
| Rendering | Day clipping, overlap lanes, agenda escape | Full-width overlapping blocks | Keep events discoverable under density |
| Session storage | Shared PostgreSQL initially | Separate Valkey immediately | Reuse infrastructure until measured contention justifies a move |

## Implementation Notes

### Patterns actually implemented

The strongest reusable patterns are simple owner checks, parameterized SQL, database constraints/cascades, and a shared session store. They matter because every calendar/event operation carries private data and because session identity must survive API process restarts. They are a foundation, not evidence that every production invariant is enforced.

For example, [event listing](./backend/src/routes/events.ts) scopes the overlap query through the owning calendar:

```sql
WHERE c.user_id = $1
  AND e.start_time < $3
  AND e.end_time > $2
```

The [conflict service](./backend/src/services/conflictService.ts) adds self-exclusion and removes existing all-day events. [shared/db.ts](./backend/src/shared/db.ts) creates one pool from `DATABASE_URL`; [shared/auth.ts](./backend/src/shared/auth.ts) supplies the session guard. The database check prevents nonpositive event duration, and deleting a calendar cascades atomically to its event rows.

There are no wired circuit breakers, idempotency helpers, rate limiters, Pino logging, or Prometheus metrics to demonstrate. No unused package or intended future pattern should be described as implemented middleware.

### Simplifications and observable gaps

| Area | Source-grounded behavior |
|------|--------------------------|
| Navigation | [calendarStore.ts](./frontend/src/stores/calendarStore.ts) owns date/view, events, calendars, visibility, and modal selection; the day-range helper mutates its stored Date object |
| Loading | [index.tsx](./frontend/src/routes/index.tsx) replaces one events array after every response; no account/range generation check, abort, range cache, or visible read error |
| Month layout | [MonthView.tsx](./frontend/src/components/calendar/MonthView.tsx) displays up to three pills per date; the date list varies while CSS declares six rows |
| Day/week layout | [WeekView.tsx](./frontend/src/components/calendar/WeekView.tsx) and [DayView.tsx](./frontend/src/components/calendar/DayView.tsx) hide all-day entries and give timed events the same horizontal position |
| Date boundaries | `eventOverlapsDay` includes an event ending exactly at day start; `getEventPosition` clips top but uses the original duration, overstating an overnight segment |
| DST geometry | Elapsed minutes since midnight are divided by 1,440 against fixed hourly labels; a spring-transition 09:00 event can be positioned at the 08:00 row |
| Editor defaults | [EventModal.tsx](./frontend/src/components/calendar/EventModal.tsx) resets creates to 09:00–10:00 even for an hourly slot click; new event color defaults to blue |
| Editor save | Time strings have no offset; all-day end uses 23:59:59; conflict state is set and the modal immediately closes; form changes can continue during the request |
| Edit reconciliation | Raw mutation rows replace display-enriched reads; blank description/location remain unchanged; omitted API color clears the override |
| Lifecycle | Calendar refetch resets visibility; the mini-calendar month does not follow all external date navigation; logout leaves calendar/editor state in memory |
| Accessibility | Native buttons/inputs cover some controls, but date/time cells lack keyboard interaction and the modal lacks focus trapping/restoration, Escape handling, and dialog semantics |
| Infrastructure | [docker-compose.yml](./docker-compose.yml) starts PostgreSQL and optional unused Valkey; schema migration is manual; no dotenv loading |
| Seed | [seed.ts](./backend/src/db/seed.ts) assumes both demo users are newly inserted, uses Los Angeles event times, skips existing usernames, and is not transactional repair |

### Omitted production capabilities

The implementation has no recurring expansion, calendar sharing/ACLs, invitation delivery, reminder scheduler, external synchronization, change feed, offline queue, admin UI, CDN, multi-region routing, database sharding, cache invalidation, operation receipts, or event version conflicts. Each would require its own behavior and failure contract.

### Review verification

All five documents were checked against routes, schema, seed, session configuration and installed store behavior, frontend views/stores/API, build scripts, Compose, project history, and smoke/screenshot configuration. Six isolated checks with mocked dependencies reproduced month size/day mutation, boundary and DST geometry, editor submission/closing, post-update warning failure, partial seed assumptions, and automatic session pruning. No application code was changed. Builds, live database queries, browser rendering, and full-stack smoke tests were not run for this documentation-only review.
