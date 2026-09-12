# Google Calendar

A calendar learning project built with React, Express, and PostgreSQL. Explore month, week, and day layouts, manage events in personal calendars, and trace owner-scoped date queries and advisory overlap checks. This is a local demonstration inspired by Google Calendar, not a connection to Google's service or a complete scheduling product.

## What you can try

- Sign in, navigate dates, switch views, and toggle existing calendars in the sidebar.
- Create, edit, and delete events with a title, time range, calendar, location, description, and color.
- View timed events in day/week grids and all-day events in the month grid. All-day events currently have no lane in day/week views.
- Use the API to register accounts and create, rename, recolor, or delete non-primary calendars. These management screens are not implemented.

The API permits overlaps and returns matching timed events as advisory information. The editor closes immediately after a successful save, so its conflict banner does not remain visible. Recurring events, invitations, sharing, reminders, drag-and-drop, offline support, and an admin interface are not implemented.

Read [architecture.md](./architecture.md) for the source audit and a separate proposed production design. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers explain proposed designs with whiteboard diagrams and trade-offs.

## Stack and local flow

| Layer | Actual implementation |
|-------|-----------------------|
| Browser | React 19, TypeScript, Vite 6, TanStack Router, Zustand, date-fns 4, Tailwind CSS 3 |
| API | One Express process with auth, calendar, and event routers |
| Persistence | PostgreSQL 16; users, calendars, events, and `session` tables |
| Authentication | bcrypt password hashes and PostgreSQL-backed express-session cookies |
| Optional Compose service | Valkey 8 is declared but has no application client or usage |

```text
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ React browser          │       │ Express API            │       │ PostgreSQL 16          │
│ Views + modal + store  │◀─────▶│ Calendar + event API   │◀─────▶│ Data + session table   │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘

                          Vite proxies /api to Express; Valkey is not used


Read: get range → owner-filtered SQL → replace events array → render

Write: submit modal → SQL write + conflict result → update array → close modal
```

## Setup

Use Node.js 20 or newer and npm. Run commands below from `google-calendar/` unless a block changes directory. PostgreSQL uses port 5432, the API uses 3000, and Vite normally uses 5173; stop conflicting project services first.

### Option A: Docker Compose (recommended)

```bash
docker compose up -d postgres
docker compose exec postgres pg_isready -U calendar_user -d google_calendar
```

The PostgreSQL-only command starts everything this application uses. `docker compose up -d` also starts the unused Valkey service. Compose creates the database and role, but does **not** mount the application schema; run the migration below.

To stop services, run `docker compose down`. `docker compose down -v` also **deletes this project's database and Valkey volumes** and is only appropriate for an intentional reset.

### Option B: Native installation (no Docker)

On macOS with Homebrew, install and start PostgreSQL. The role/database creation commands are for a fresh installation; skip creation if they already exist.

```bash
brew install postgresql@16
brew services start postgresql@16
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -c "CREATE ROLE calendar_user WITH LOGIN PASSWORD 'calendar_pass';"
createdb -O calendar_user google_calendar
PGPASSWORD=calendar_pass psql -h localhost -U calendar_user -d google_calendar -c 'SELECT current_database(), current_user;'
```

Valkey is optional because the application does not use it. To mirror the extra Compose service, run `brew install valkey`, `brew services start valkey`, then `valkey-cli ping` and expect `PONG`.

### Install, migrate, seed, and start the API

In the first terminal:

```bash
cd backend
npm install
export DATABASE_URL='postgresql://calendar_user:calendar_pass@localhost:5432/google_calendar'
export SESSION_SECRET='local-calendar-demo-secret'
npm run db:migrate
npm run db:seed
npm run dev
```

On a fresh database, the seed creates `alice` and `bob`, both with password `password123`. Alice has Personal and Work calendars and seven example events; Bob has a Personal calendar with no events. Examples cover today, tomorrow, an offsite three days ahead, and planning a week ahead.

The seed chooses a date from the Node process's local clock and constructs event times in `America/Los_Angeles`. The browser renders in its own local zone; the saved user timezone preference is not applied. The seed is **not a repair tool**: it skips when both usernames exist and can fail when only one exists. It does not repair missing calendars/events or update existing passwords. Use an empty demo database for the initial seed.

### Start the browser

In a second terminal, again starting from `google-calendar/`:

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and log in with Alice. Vite proxies `/api` requests to port 3000. Clicking a month date opens that day; clicking an hourly slot opens the editor, but its initial time currently resets to 09:00–10:00 rather than the clicked hour.

### Environment variables

| Variable | Default | Used by |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://calendar_user:calendar_pass@localhost:5432/google_calendar` | API, migration, seed, and session store |
| `PORT` | `3000` | API listener |
| `FRONTEND_URL` | `http://localhost:5173` | Credentialed CORS origin |
| `SESSION_SECRET` | `dev-secret-change-in-production` | Session signing; override outside disposable development |
| `NODE_ENV` | Unset | Enables Secure cookies when exactly `production` |

There is no dotenv loader. Export overrides into each relevant process; writing a `.env` file alone does not load them. The frontend proxy target is fixed in [vite.config.ts](./frontend/vite.config.ts); changing `PORT` requires matching that target. Production TLS termination also needs suitable proxy trust and cookie configuration, which this demo does not supply.

## API reference

All calendar and event routes require a session. Registration and login create one; `/api/auth/me` checks it. Request field names use camelCase, while database-backed response rows use snake_case.

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/auth/register` | Create user and default Personal calendar; no registration UI |
| POST | `/api/auth/login` | Authenticate with username and password |
| POST | `/api/auth/logout` | Destroy session and clear cookie |
| GET | `/api/auth/me` | Return current user |
| GET / POST | `/api/calendars` | List own calendars / create a calendar |
| PUT / DELETE | `/api/calendars/:id` | Rename or recolor / delete an owned non-primary calendar and its events |
| GET | `/api/events?start=...&end=...` | Events overlapping the interval; optional singular `calendarId` |
| GET | `/api/events/:id` | Owned event with calendar name and effective color |
| POST / PUT | `/api/events` / `/api/events/:id` | Create / update; return event and optional advisory conflicts |
| DELETE | `/api/events/:id` | Delete owned event |
| GET | `/api/events/:id/conflicts` | Conflicts for an existing owned event; no unsaved-event preview endpoint |
| GET | `/api/health` | Static process response; no explicit database readiness probe |

For direct timed-event API calls, send explicit offsets or UTC timestamps. Event creation requires `calendarId`, `title`, `startTime`, and `endTime`. The database enforces end after start, but broader input/range limits are incomplete. `recurrence_rule` is an unused schema field; the API does not create or expand recurrence rules.

## Verification commands

From `google-calendar/`, after installing dependencies:

```bash
(cd backend && npm run build)
(cd frontend && npm run build)
(cd frontend && npx tsc --noEmit -p tsconfig.app.json)
(cd frontend && npx tsc --noEmit -p tsconfig.node.json)
curl http://localhost:3000/api/health
```

The backend also declares `test` and `test:watch`, but has no checked-in backend test files. The frontend's `type-check` script targets the empty root references file rather than checking the referenced applications; use the explicit commands above or its build. Its `lint` script exists, but no project ESLint configuration is checked in. Neither package has a format script.

The repository's [smoke tests](./tests/smoke.spec.ts) check login and a basic calendar page. They do not establish time-zone, editing, conflict, or layout correctness. With the database, seeded API, and browser server already running, execute from the **repository root**:

```bash
npm run test:smoke google-calendar
npm run screenshots google-calendar
```

The [screenshot configuration](../scripts/screenshot-configs/google-calendar.json) targets login, month, week, and day views. This documentation review used source inspection and isolated checks with mocked dependencies; it did not start the stack, run builds, or capture browser screenshots.

## Known limitations

- **Time handling:** form submissions omit the offset, so the browser, Node process, and PostgreSQL can interpret the same input differently. All-day data is stored as timestamps. Midnight inclusion, overnight clipping, and daylight-saving positioning need correction.
- **Rendering:** timed overlaps occupy the same horizontal space; all-day items are omitted from day/week views. The month date list has 28, 35, or 42 cells while the CSS always declares six rows.
- **Saving:** updates have no version check and creates have no idempotency key. An update can commit before its conflict lookup fails, returning an error despite a saved change. Clearing description/location in the form does not clear them in storage.
- **Client lifecycle:** range requests can arrive out of order, fetch errors are console-only, and calendar/editor state is not reset at logout. In-flight saves can close a newly opened editor; logout does not check HTTP error status.
- **Interaction:** modal focus management, a keyboard-operable date/time grid, a mobile layout, calendar management screens, and persistent conflict feedback remain unfinished.

See [Implementation Notes](./architecture.md#implementation-notes) for evidence, exact behavior, and the boundary between this demo and the proposed design.
