# Calendly - Meeting Scheduling Platform

A full-stack meeting scheduling platform that allows users to share their availability and let others book meetings without back-and-forth email coordination.

## Features

- **Event Types**: Create customizable meeting types with different durations, buffer times, and descriptions
- **Availability Management**: Set weekly working hours when you're available for meetings
- **Booking Page**: Public booking page with calendar view and timezone support
- **Double-Booking Prevention**: Database-level constraints ensure no overlapping bookings
- **Timezone Handling**: All times stored in UTC, displayed in user's local timezone
- **Email Notifications**: Simulated email notifications logged to the database and console
- **Dashboard**: View upcoming bookings and statistics
- **Admin Panel**: System-wide statistics and user management

## Tech Stack

- **Frontend**: TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL 16
- **Cache**: Redis 7
- **Authentication**: Session-based with Redis store

## Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose (for PostgreSQL and Redis)

## Getting Started

### 1. Start Infrastructure with Docker

```bash
cd calendly

# Start PostgreSQL and Redis
docker-compose up -d

# Verify containers are running
docker-compose ps
```

This will:
- Start PostgreSQL on port 5432 with the `calendly` database
- Start Redis on port 6379
- Run the database initialization script to create tables and seed demo data

### 2. Start the Backend

```bash
cd backend

# Install dependencies
npm install

# Start the development server
npm run dev
```

The API server will be available at http://localhost:3001

To verify the backend is running:
```bash
curl http://localhost:3001/health
```

### 3. Start the Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

The frontend will be available at http://localhost:5173

## Demo Credentials

Two demo users are created on first startup:

| User | Email | Password | Role |
|------|-------|----------|------|
| Demo User | demo@example.com | demo123 | user |
| Admin | admin@example.com | admin123 | admin |

Note: The demo password hash in the database is a placeholder. For first-time login, you may need to register a new account or update the password hash.

## Project Structure

```
calendly/
├── docker-compose.yml          # PostgreSQL and Redis services
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # Express server entry point
│       ├── db/
│       │   ├── index.ts        # Database and Redis connections
│       │   └── init.sql        # Database schema and seed data
│       ├── routes/
│       │   ├── auth.ts         # Authentication routes
│       │   ├── meetingTypes.ts # Event type management
│       │   ├── availability.ts # Availability rules and slots
│       │   ├── bookings.ts     # Booking CRUD operations
│       │   └── admin.ts        # Admin-only routes
│       ├── services/
│       │   ├── userService.ts
│       │   ├── meetingTypeService.ts
│       │   ├── availabilityService.ts
│       │   ├── bookingService.ts
│       │   └── emailService.ts # Simulated email notifications
│       ├── middleware/
│       │   └── auth.ts         # Authentication middleware
│       ├── types/
│       │   └── index.ts        # TypeScript type definitions
│       └── utils/
│           └── time.ts         # Timezone utilities
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx            # React entry point
        ├── routes/             # File-based routing with Tanstack Router
        │   ├── __root.tsx
        │   ├── index.tsx       # Home page
        │   ├── login.tsx
        │   ├── register.tsx
        │   ├── dashboard.tsx
        │   ├── meeting-types.tsx
        │   ├── availability.tsx
        │   ├── bookings.tsx
        │   ├── bookings.$bookingId.tsx
        │   ├── book.$meetingTypeId.tsx  # Public booking page
        │   └── admin.tsx
        ├── components/
        │   ├── Navbar.tsx
        │   ├── CalendarPicker.tsx
        │   ├── TimeSlotPicker.tsx
        │   └── LoadingSpinner.tsx
        ├── stores/
        │   └── authStore.ts    # Zustand auth state
        ├── services/
        │   └── api.ts          # API client
        ├── types/
        │   └── index.ts
        └── utils/
            └── time.ts         # Timezone utilities
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Meeting Types
- `GET /api/meeting-types` - List user's meeting types
- `GET /api/meeting-types/:id` - Get meeting type details
- `POST /api/meeting-types` - Create meeting type
- `PUT /api/meeting-types/:id` - Update meeting type
- `DELETE /api/meeting-types/:id` - Delete meeting type

### Availability
- `GET /api/availability/rules` - Get user's availability rules
- `POST /api/availability/rules` - Set availability rules (bulk)
- `GET /api/availability/slots` - Get available time slots
- `GET /api/availability/dates` - Get dates with available slots

### Bookings
- `GET /api/bookings` - List user's bookings
- `GET /api/bookings/stats` - Get dashboard statistics
- `GET /api/bookings/:id` - Get booking details
- `POST /api/bookings` - Create a booking
- `PUT /api/bookings/:id/reschedule` - Reschedule a booking
- `DELETE /api/bookings/:id` - Cancel a booking

### Admin (requires admin role)
- `GET /api/admin/stats` - System-wide statistics
- `GET /api/admin/users` - List all users
- `GET /api/admin/bookings` - List all bookings
- `GET /api/admin/emails` - Email notification logs
- `DELETE /api/admin/users/:id` - Delete a user

## Key Implementation Details

### Double-Booking Prevention

The system uses multiple layers to prevent double bookings:

1. **Database Constraint**: Unique index on `(host_user_id, start_time)` for confirmed bookings
2. **Row-Level Locking**: `SELECT FOR UPDATE` on the host user during booking creation
3. **Conflict Check**: Query for overlapping bookings before insertion
4. **Optimistic Locking**: Version field for concurrent modifications

### Availability Calculation

Available time slots are calculated by:
1. Fetching the user's weekly availability rules
2. Fetching existing confirmed bookings
3. Merging busy periods and applying buffer times
4. Finding gaps that fit the meeting duration
5. Filtering out past slots

Results are cached in Redis for 5 minutes.

### Timezone Handling

- All times are stored in PostgreSQL as `TIMESTAMP WITH TIME ZONE` (UTC)
- User's timezone preference is stored separately
- API accepts timezone parameter for displaying availability
- Frontend detects user's local timezone automatically
- Booking confirmations show time in both host's and invitee's timezones

### Email Notifications

Emails are simulated by:
1. Logging the full email content to the console
2. Storing email records in the `email_notifications` table
3. Can be viewed in the Admin panel

In production, integrate with SendGrid, Mailgun, or SMTP.

## Running Multiple Instances

For testing distributed scenarios:

```bash
# Terminal 1 - Server on port 3001
cd backend && npm run dev:server1

# Terminal 2 - Server on port 3002
cd backend && npm run dev:server2

# Terminal 3 - Server on port 3003
cd backend && npm run dev:server3
```

## Stopping Services

```bash
# Stop Docker containers
docker-compose down

# To also remove volumes (data)
docker-compose down -v
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.
