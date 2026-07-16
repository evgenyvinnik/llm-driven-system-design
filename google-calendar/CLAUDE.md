# Google Calendar — Development with Claude

## Project Context

A full-stack calendar: Month / Week / Day views, event CRUD across multiple color-coded calendars, and time-overlap conflict detection. The interesting problems are almost entirely on the two ends — **laying out events in a time grid** (positioning a 2:15–3:40pm event precisely, handling multi-day spans, only fetching the visible date range) on the frontend, and a **correct SQL overlap query** for conflicts on the backend. There is no distributed-systems core here; it's a focused study of calendar UI + time-range querying.

**Learning goals:** responsive time-grid layout math, timezone/date-range handling with date-fns, efficient overlap detection in SQL, complex interactive view state in Zustand, and PostgreSQL-backed session auth.

## Architecture at a Glance (what actually runs)

**One datastore.** PostgreSQL holds everything, including sessions — there is deliberately no Redis on the request path.

| Store / Component | Role | Why this one |
|-------------------|------|--------------|
| **PostgreSQL** (`pg`) | Users, calendars, events (with a `CHECK` for valid time ranges), and the `session` table | Single source of truth; sessions live in the same DB so a signup + session can share one transaction context |
| **Sessions** (`express-session` + `connect-pg-simple`) | Server-side session store in Postgres | One fewer service than Redis; session lookups are once-per-request and cheap relative to event fetching |
| **Valkey** (docker-compose only) | **Not used by the app** | Present in `docker-compose.yml` reserved for future caching; the backend has no Redis client dependency at all |

**Frontend:** React 19 + TanStack Router + Zustand v5 (with `persist`) + date-fns + Tailwind. Month view is a CSS Grid 7×6; Week/Day views position events absolutely by percentage of the day.

## Key Design Decisions

### 1. PostgreSQL sessions (`connect-pg-simple`), not Redis
Sessions are stored in a Postgres `session` table rather than Redis, keeping the stack to a single datastore. This trades ~2ms Postgres session reads for ~0.2ms Redis reads and gives up Redis's automatic TTL eviction (a periodic `DELETE FROM session WHERE expire < NOW()` is needed instead). For a calendar the read-heavy path is *event fetching*, not session checking, so the latency delta is negligible and not worth running a second service. Valkey sits in docker-compose unused as a hook for future caching — the docs should never imply it stores sessions (that was a README bug; fixed).

### 2. One overlap predicate for conflict detection
`conflictService.checkConflicts()` finds clashes with a single condition: `start_time < :newEnd AND end_time > :newStart` (joined to the user's calendars, excluding all-day events and the event being edited via `id != COALESCE(:exclude, 0)`). That one predicate correctly catches all four overlap cases (new-inside-existing, existing-inside-new, and both partial overlaps) without enumerating them. Trade-off given up: it's a range scan per check rather than an interval-tree/GiST index — fine at this scale, but a heavily-booked calendar would want a range index.

### 3. Conflicts warn, they don't block
Creating or updating an event returns any conflicts in the response but still writes the event. Real calendars routinely have intentional overlaps (a tentative hold over a lunch, overlapping "busy" blocks), so hard-blocking would be wrong. Trade-off: the client must surface the warning UI, and "no double-booking" is a soft guarantee, not enforced by the system.

### 4. Percentage-based event positioning, no DOM measurement
Week/Day views compute an event's `top` as `(startMinutes / 1440) * 100%` and `height` from its duration, so layout is pure arithmetic that reflows responsively without measuring the DOM. Multi-day events are shown on each overlapping day via an `eventOverlapsDay` range check, and each view fetches only its visible date range (month view padded to whole weeks). Trade-off: simultaneous events currently stack on top of each other rather than splitting into side-by-side columns — a known layout limitation.

## Current State

**Implemented and working end-to-end:** register/login with Postgres-backed sessions (bcryptjs); Month (7×6 grid), Week, and Day views; event create/edit/delete with a modal; multi-calendar support with per-calendar visibility toggles and colors; non-blocking conflict detection on create/update; view-range-scoped event fetching; Zustand state with `persist`; `db:migrate` + `db:seed` with demo users (alice, bob).

**Intentionally omitted (known limitations):** recurring events (no RRULE parsing/expansion); drag-and-drop to move/resize events; timezone conversion (uses server time / a single timezone); event sharing / invitations (events belong to one user); side-by-side layout for concurrent events (they stack); reminders/notifications (the production design shows a queue, none is built); any use of Valkey.

## Iteration & Repair Log

- **CLAUDE.md restructured (2026-07).** The prior version was already honest (it correctly flagged Valkey-unused and PG sessions) but was organized as challenge/solution code snippets. Reframed to the standard Architecture-at-a-Glance + decisions + Current State structure; all the accurate facts were preserved, code snippets turned to prose.
- **README session-store bug fixed (2026-07).** The README's Tech Stack claimed "Session Store: Valkey (Redis-compatible)" while the very next line said auth uses `connect-pg-simple` — a self-contradiction. Sessions are in PostgreSQL; corrected the README and noted Valkey is unused.
- **architecture.md diagram tidy (2026-07).** The production-ideal diagram's Redis box read "(Sessions, Cache)", contradicting the doc's own Key Design Decision to use Postgres sessions. Changed to "(Cache)" so the diagram matches the stated decision.
- **Schema-apply path.** `db:migrate` (`src/db/migrate.ts`) applies `src/db/init.sql`, then `db:seed` loads demo data — both scripts exist and are documented in the README. Demo users use `password123` (bcryptjs), matching the repo-wide login password.

## Open Questions

1. Recurring events are the biggest missing feature. What's the right expansion strategy — materialize instances, or expand RRULEs virtually within the requested range only (and cache the expansion) so "every weekday for 3 years" doesn't generate thousands of rows per query?
2. Concurrent events stack instead of splitting into columns. What's the cleanest layout algorithm (interval graph coloring) to compute side-by-side lanes without measuring the DOM?
3. The app is single-timezone. Where should timezone live — store events in UTC + per-user tz for display, or per-event tz? How does that interact with recurring rules across DST boundaries?
4. Sessions have no automatic TTL cleanup in Postgres. Is a scheduled `DELETE` job sufficient, or does session volume eventually justify moving sessions to the already-present-but-unused Valkey?

## Resources

- [date-fns](https://date-fns.org/) — the date math powering view ranges and positioning
- [connect-pg-simple](https://github.com/voxpelli/node-connect-pg-simple) — the Postgres session store
- [RFC 5545 (iCalendar / RRULE)](https://datatracker.ietf.org/doc/html/rfc5545) — the recurring-event spec this project does not yet implement
