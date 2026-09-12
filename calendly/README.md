# Calendly: meeting scheduling

A local learning project for publishing weekly availability, sharing a booking page, and managing one-to-one meetings. Hosts use a React dashboard; guests choose a date and time without creating an account. The backend demonstrates host-scoped database locking, interval calculations, cached availability, and simulated notifications.

This is an independent implementation, not Calendly's private architecture. It has important scheduling and recovery gaps: rescheduled meetings stop blocking time, some generated slots fall outside working hours, and timezone handling depends on the server's local zone. See [Implementation Notes](./architecture.md#implementation-notes) before treating its results as a reliable calendar.

## Supported flows

- Register a host, select a timezone, and sign in through a Redis-backed session.
- Create, edit, activate, deactivate, or delete event types with a duration, buffers, description, and color. Daily caps exist in the API and seed, but the event-type modal has no cap control.
- Set one weekly working interval per day through the UI. The API supports multiple rules, but the editor collapses them to one interval per day when loaded and saved.
- Share `/book/<meeting-type UUID>` using Copy Link or Preview Booking Page. The editable slug is metadata; it is not used in the public route.
- Let guests select a slot, enter name/email/notes, and see a confirmation screen. Host lists and public booking details support cancellation. Rescheduling is API-only.
- Use an administrator account to view platform totals, users, and simulated email logs. User deletion and global booking queries exist in the API; the admin page has no controls for them.

There is no Google/Outlook integration, external-calendar conflict check, SMTP delivery, calendar export, group capacity, round-robin assignment, or recurring-booking workflow. The landing page's calendar-integration claim and the confirmation screen's “email sent” message exceed the implementation.

## Stack and documentation

| Layer | Implementation |
|-------|----------------|
| Browser | React 19, TypeScript, Vite 5, TanStack Router, Zustand 4, Tailwind CSS |
| API | Node.js 20+, Express 4, TypeScript/tsx, ESM, Zod |
| Persistence | PostgreSQL 16 for accounts, rules, bookings, archives, and simulated email logs |
| Cache/auth | Valkey 7 via ioredis; connect-redis and express-session |
| Notifications | RabbitMQ 3 and a separate Node worker; SQL/console simulation |
| Operations | Pino, prom-client, health endpoints, manual archival commands |

[architecture.md](./architecture.md) separates the production proposal from the local implementation. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers are spoken, timed interview designs. [CLAUDE.md](./CLAUDE.md) contains historical development notes; source takes precedence where its claims differ.

## Infrastructure

Start in the repository root. Choose one option, then keep subsequent setup terminals in `calendly` unless another directory is specified. Stop other projects using the same infrastructure ports.

### Option A: Docker Compose (recommended)

```bash
cd calendly
docker compose up -d
docker compose ps
```

| Service | Connection | Development credentials |
|---------|------------|-------------------------|
| PostgreSQL | localhost:5432, database calendly | calendly / calendly_password |
| Valkey | localhost:6379 | No authentication |
| RabbitMQ | localhost:5672 | guest / guest |
| Broker management | [localhost:15672](http://localhost:15672) | guest / guest |

PostgreSQL applies [init.sql](./backend/src/db/init.sql) on a fresh data volume. It creates seven tables and indexes, **without users or demo meetings**. There is no migration command, and this schema is not safely rerunnable because table creation lacks `IF NOT EXISTS`.

PostgreSQL and Valkey have named volumes. Valkey does not explicitly enable AOF. RabbitMQ has no persistent volume, so ordinary container replacement does not preserve queued notifications.

```bash
docker compose down
# Also remove PostgreSQL and Valkey data when deliberately resetting the demo:
docker compose down -v
```

### Option B: Native installation on macOS

```bash
cd calendly
brew install postgresql@16 valkey rabbitmq
brew services start postgresql@16
brew services start valkey
brew services start rabbitmq
export PATH="$(brew --prefix postgresql@16)/bin:$(brew --prefix rabbitmq)/sbin:$PATH"
psql postgres -c "CREATE USER calendly WITH PASSWORD 'calendly_password';"
createdb -O calendly calendly
PGPASSWORD=calendly_password psql -h localhost -U calendly -d calendly -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
pg_isready -h localhost -p 5432
valkey-cli ping
rabbitmq-diagnostics -q ping
```

These commands assume the current macOS account can administer the Homebrew PostgreSQL instance. Skip role/database creation if they already exist, and apply the schema only to an empty database. The current [Homebrew RabbitMQ formula](https://formulae.brew.sh/formula/rabbitmq) installs a newer major version than Compose. Local guest credentials work over loopback; the application declares its queues when a connection is established.

## Start the application

Use separate terminals for these commands, each initially in `calendly`.

API:

```bash
cd backend
npm install
npm run dev
```

Notification worker:

```bash
cd backend
npm run dev:worker
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). The default API port is **3000**, and Vite proxies `/api` there. The backend can listen after failed database/cache checks; a listening process does not mean booking and authentication are ready.

The worker requires PostgreSQL, Valkey, and RabbitMQ on startup. Direct notification simulation also runs in the API, so normal operation with a worker can produce duplicate email-log records. No actual email is sent.

### Configuration

Export variables in the relevant API/worker terminal before starting it. There is no `.env` loader. Defaults match Compose:

```bash
export DB_HOST=localhost DB_PORT=5432 DB_NAME=calendly
export DB_USER=calendly DB_PASSWORD=calendly_password
export REDIS_HOST=localhost REDIS_PORT=6379
export RABBITMQ_HOST=localhost RABBITMQ_PORT=5672
export RABBITMQ_USER=guest RABBITMQ_PASSWORD=guest
export PORT=3000 FRONTEND_URL=http://localhost:5173
export SESSION_SECRET=calendly-secret-key-change-in-production
export NODE_ENV=development
```

RabbitMQ uses these separate variables; `RABBITMQ_URL` is not read. `NODE_ENV=production` makes cookies secure and requires HTTPS for browser sessions. Availability caching defaults to five minutes via `AVAILABILITY_CACHE_TTL_MINUTES`; idempotency results default to one hour via `IDEMPOTENCY_KEY_TTL`. [shared/config.ts](./backend/src/shared/config.ts) contains retention and alert settings, including several settings whose corresponding features are unused. The active pool uses fixed values of 20 connections and a two-second connection timeout in [db/index.ts](./backend/src/db/index.ts).

To compare API instances, run `dev:server1`, `dev:server2`, and `dev:server3` in separate backend terminals. They listen on 3001–3003 and share data. No load balancer is provided, and Vite still targets 3000. Worker variants `dev:worker1` and `dev:worker2` run the same worker; the supplied `WORKER_ID` values are not read by its code.

## Create a usable demo

The simplest path is to register a host through the UI, choose the intended host timezone, set weekly availability, and create an event type. Copy or preview that event type's link. Use a separate guest browser context to book, then return to the host's Bookings page to inspect the resulting record.

The landing page's built-in demo link and `demo@example.com / demo123` hint refer to records that initialization no longer creates. Do not use them as a setup check.

### Optional sample hosts

The checked-in [seed.sql](./backend/db-seed/seed.sql) is broken as a complete fixture: booking IDs beginning with `bk` and archive IDs beginning with `ar` are invalid UUIDs, and some rows reference absent demo users/types. It is not a successful one-command seed.

For a fresh database, you can import only its valid host/type/availability prefix. This creates four ordinary users, eight event types, and twenty weekly rules, without sample bookings or email logs:

```bash
awk '/-- SAMPLE BOOKINGS/ {exit} {print}' backend/db-seed/seed.sql > /tmp/calendly-host-fixture.sql
```

Docker:

```bash
docker compose exec -T postgres psql -U calendly -d calendly -v ON_ERROR_STOP=1 < /tmp/calendly-host-fixture.sql
```

Native:

```bash
PGPASSWORD=calendly_password psql -h localhost -U calendly -d calendly -v ON_ERROR_STOP=1 -f /tmp/calendly-host-fixture.sql
```

Use this prefix once, before creating accounts with the same emails. Rerunning it duplicates availability rules; existing emails with different IDs can break its foreign-key references. The source fixture itself remains unchanged.

| Host | Email | Password | Host timezone |
|------|-------|----------|---------------|
| Alice | alice@example.com | password123 | America/Los_Angeles |
| Bob | bob@example.com | password123 | America/Chicago |
| Charlie | charlie@example.com | password123 | Europe/London |
| Diana | diana@example.com | password123 | Asia/Tokyo |

The shared sample hash was checked with bcrypt: `password123` matches; `demo123` and `admin123` do not. Diana has weekly rules but no seeded event type. Alice's Quick Call is at [localhost:5173/book/4611eebc-9c0b-4ef8-bb6d-6bb9bd380a11](http://localhost:5173/book/4611eebc-9c0b-4ef8-bb6d-6bb9bd380a11).

### Optional administrator

There is no seeded administrator. After importing the sample hosts, promote Alice explicitly for this local demo:

```bash
# Docker:
docker compose exec -T postgres psql -U calendly -d calendly -c "UPDATE users SET role = 'admin' WHERE email = 'alice@example.com';"
# Native alternative:
PGPASSWORD=calendly_password psql -h localhost -U calendly -d calendly -c "UPDATE users SET role = 'admin' WHERE email = 'alice@example.com';"
```

Use only the command for your infrastructure. Log out and log in again because the role is copied into the session. If you created your own host instead, substitute that registered email. No administrator password is created by this update.

## Checks and maintenance

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
curl -s http://localhost:3000/health/detailed
curl -s http://localhost:3000/metrics
```

The API connects to RabbitMQ lazily during notification publication, so its health can initially report degraded broker connectivity even if the separate worker is connected. Readiness permits degraded status; it does not prove notification delivery or worker progress.

Backend and frontend offer `npm run build`, `npm run type-check`, and `npm run lint`. There is no backend unit-test script. From the repository root, `npm run test:smoke calendly` runs eight page checks against the running stack and Alice account. Most only assert `main`; the detail test uses an invalid UUID and can pass on an error page. These tests do not establish successful booking, timezone correctness, or concurrency safety.

Manual backend commands include `db:archive-bookings`, `db:maintenance`, and `db:storage-stats`. Archival removes old completed/cancelled rows from the live table and cascades their email logs; it is a data mutation, not a preview. No scheduler invokes it. `db:maintenance` also queries a nonexistent `calendar_events_cache` table and can partially perform other work before failing. These scripts catch errors and exit without a nonzero status, so inspect their output. Storage statistics represent an inaccessible/missing calendar table as zero.

## Known behavior to account for

- Rescheduling changes status to `rescheduled`; conflict, availability, daily-cap, and reminder paths count only `confirmed` bookings. The moved meeting no longer reserves time. The unique index prevents identical confirmed starts, not arbitrary interval overlap.
- Create/reschedule do not fully validate that the requested time belongs to working hours, is in the future, or satisfies the displayed slot policy. Buffer and daily-cap rules differ between calculation and writes.
- Date selection mixes host, invitee, and process-local day boundaries. The interval helper does not clip busy intervals to the working window. Cached slots can remain stale across other meeting types and policy edits.
- Booking details and anonymous cancel/reschedule APIs rely on possession of the booking UUID. There is no separate scoped guest token. Login currently returns the password hash because the code removes the wrong property name; this should not be deployed as private account management.
- Notifications have no transactional outbox or duplicate guard. Direct and queued paths both run; reconnect does not restore consumers, and rescheduling does not schedule replacement reminders.
- Guest confirmation uses the selected draft rather than the complete returned booking, and does not expose a management link. A timezone change in the details step clears the selected slot without returning to time selection. Load failures can look like no availability, while an empty date set enables all future dates in the picker.

The documentation review inspected source/configuration and ran isolated password, date, interval, and object-shape checks. It did not start this application, execute its SQL fixture, run browser tests, or benchmark production behavior. Detailed evidence is in [architecture.md](./architecture.md#implementation-notes).
