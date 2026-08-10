# Google Calendar

A full-stack calendar application with Month, Week, and Day views, event scheduling with conflict detection, and a clean UI inspired by Google Calendar.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 4,416 |
| Source Files | 54 |
| .md | 1,509 |
| .tsx | 1,416 |
| .ts | 1,191 |
| .json | 154 |
| .sql | 68 |


## Features

- **Multiple Views**: Month, Week, and Day views with smooth navigation
- **Event Management**: Create, edit, and delete calendar events
- **Conflict Detection**: Warns when events overlap (non-blocking)
- **Multiple Calendars**: Support for multiple calendars with visibility toggles
- **All-Day Events**: Support for all-day events
- **Color Coding**: Customizable event colors
- **Session-based Auth**: Simple login/logout with demo accounts

## Screenshots

(Screenshots will be added after initial run)

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- Docker and Docker Compose (recommended)

### Setup

1. Start infrastructure (PostgreSQL + Valkey):
```bash
cd google-calendar
docker-compose up -d
```

2. Install backend dependencies and initialize database:
```bash
cd backend
npm install
npm run db:migrate
npm run db:seed    # Creates demo users (alice, bob)
```

3. Start the backend:
```bash
npm run dev
```

4. In a new terminal, install and start the frontend:
```bash
cd google-calendar/frontend
npm install
npm run dev
```

5. Open http://localhost:5173 and login with:
   - Username: `alice` or `bob`
   - Password: `password123`

## Tech Stack

### Frontend
- **Framework**: React 19 with TypeScript
- **Router**: TanStack Router (file-based routing)
- **State**: Zustand with persist middleware
- **Styling**: Tailwind CSS
- **Date Handling**: date-fns

### Backend
- **Runtime**: Node.js with Express
- **Database**: PostgreSQL 16 (also stores sessions)
- **Session Store**: PostgreSQL via `connect-pg-simple` (Valkey runs in docker-compose but is currently unused — reserved for future caching)
- **Auth**: express-session with connect-pg-simple

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Login user |
| POST | /api/auth/logout | Logout user |
| GET | /api/auth/me | Get current user |
| GET | /api/calendars | List user calendars |
| POST | /api/calendars | Create calendar |
| GET | /api/events?start=&end= | Get events in date range |
| GET | /api/events/:id | Get single event |
| POST | /api/events | Create event (returns conflicts) |
| PUT | /api/events/:id | Update event (returns conflicts) |
| DELETE | /api/events/:id | Delete event |

## Project Structure

```
google-calendar/
├── docker-compose.yml       # PostgreSQL + Valkey
├── backend/
│   ├── package.json
│   ├── src/
│   │   ├── api/
│   │   │   ├── app.ts       # Express app
│   │   │   └── index.ts     # Server entry
│   │   ├── routes/
│   │   │   ├── auth.ts      # Authentication
│   │   │   ├── calendars.ts # Calendar CRUD
│   │   │   └── events.ts    # Event CRUD
│   │   ├── services/
│   │   │   └── conflictService.ts
│   │   ├── shared/
│   │   │   ├── db.ts        # PostgreSQL pool
│   │   │   └── auth.ts      # Auth middleware
│   │   └── db/
│   │       ├── init.sql     # Database schema
│   │       ├── migrate.ts   # Migration runner
│   │       └── seed.ts      # Demo data seeder
│   └── tsconfig.json
└── frontend/
    ├── package.json
    ├── index.html
    ├── src/
    │   ├── main.tsx
    │   ├── routes/
    │   │   ├── __root.tsx   # Root layout
    │   │   ├── index.tsx    # Calendar page
    │   │   └── login.tsx    # Login page
    │   ├── components/
    │   │   ├── calendar/
    │   │   │   ├── MonthView.tsx
    │   │   │   ├── WeekView.tsx
    │   │   │   ├── DayView.tsx
    │   │   │   ├── EventModal.tsx
    │   │   │   ├── EventCard.tsx
    │   │   │   ├── CalendarSidebar.tsx
    │   │   │   ├── MiniCalendar.tsx
    │   │   │   ├── ViewSwitcher.tsx
    │   │   │   └── DateNavigator.tsx
    │   │   └── icons/
    │   ├── stores/
    │   │   ├── calendarStore.ts
    │   │   └── authStore.ts
    │   ├── services/
    │   │   └── api.ts
    │   ├── utils/
    │   │   └── dateUtils.ts
    │   └── types.ts
    └── tailwind.config.js
```

## Development

### Available Scripts

**Backend:**
```bash
npm run dev          # Start server with hot reload
npm run db:migrate   # Run database migrations
npm run db:seed      # Seed demo data
```

**Frontend:**
```bash
npm run dev          # Start Vite dev server
npm run build        # Build for production
npm run type-check   # TypeScript type checking
npm run lint         # ESLint
npm run format       # Prettier
```

## Key Design Decisions

1. **Conflict Detection**: Events are checked for time overlaps when creating/updating. The API returns conflicting events but doesn't block creation - it's informational.

2. **Calendar Visibility**: Users can toggle calendar visibility to filter events in the view without deleting them.

3. **Date Range Queries**: Events are fetched based on the visible date range to minimize data transfer.

4. **Session Auth**: Uses PostgreSQL-backed sessions for simplicity, avoiding JWT complexity.

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  timezone VARCHAR(50) DEFAULT 'UTC'
);

-- Calendars
CREATE TABLE calendars (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#3B82F6',
  is_primary BOOLEAN DEFAULT FALSE
);

-- Events
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  calendar_id INTEGER REFERENCES calendars(id),
  title VARCHAR(255) NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN DEFAULT FALSE,
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);
```
