# Bitly - URL Shortener

A full-stack URL shortening service with analytics tracking, custom short codes, link expiration, and an admin dashboard.

## Features

- **URL Shortening**: Convert long URLs to short, memorable links
- **Custom Short Codes**: Create branded links with custom short codes
- **Analytics Tracking**: Track clicks, referrers, and device types
- **Link Expiration**: Set optional expiration dates for links
- **User Authentication**: Session-based authentication with role support
- **Admin Dashboard**: System stats, URL management, user management, and key pool monitoring

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│  Backend API    │
│  (React/Vite)   │     │  (Express.js)   │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌─────────┐  ┌─────────┐  ┌─────────────┐
              │  Redis  │  │PostgreSQL│  │Key Pool Svc │
              │ (Cache) │  │   (DB)   │  │(Pre-gen IDs)│
              └─────────┘  └─────────┘  └─────────────┘
```

See [architecture.md](./architecture.md) and [system-design-answer.md](./system-design-answer.md) for detailed design documentation.

## Prerequisites

- Node.js 18+ or 20+
- Docker and Docker Compose (recommended) OR:
  - PostgreSQL 16
  - Redis 7

## Quick Start with Docker

The easiest way to get started is using Docker for infrastructure:

```bash
# 1. Start PostgreSQL and Redis
docker-compose up -d

# 2. Install backend dependencies
cd backend
npm install

# 3. Start the backend server
npm run dev

# 4. In a new terminal, install frontend dependencies
cd frontend
npm install

# 5. Start the frontend dev server
npm run dev
```

The application will be available at:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000

## Setup with Homebrew (macOS)

If you prefer native services instead of Docker:

### Install PostgreSQL and Redis

```bash
# Install services
brew install postgresql@16 redis

# Start services
brew services start postgresql@16
brew services start redis
```

### Configure PostgreSQL

```bash
# Create database and user
psql postgres <<EOF
CREATE USER bitly WITH PASSWORD 'bitly_password';
CREATE DATABASE bitly OWNER bitly;
EOF

# Initialize schema
psql -U bitly -d bitly -f backend/init.sql
```

### Run the application

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

## Running Multiple Backend Instances

For testing load balancing and distributed scenarios:

```bash
# Terminal 1: Server on port 3001
cd backend
npm run dev:server1

# Terminal 2: Server on port 3002
npm run dev:server2

# Terminal 3: Server on port 3003
npm run dev:server3
```

## Default Credentials

An admin user is created automatically:

- **Email**: admin@bitly.local
- **Password**: admin123

## API Documentation

### Authentication

#### POST /api/v1/auth/register
Register a new user.

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password123"}'
```

Response:
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "role": "user",
  "created_at": "2024-01-15T10:00:00Z"
}
```

#### POST /api/v1/auth/login
Login and receive a session cookie.

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email": "user@example.com", "password": "password123"}'
```

Response:
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "user"
  },
  "token": "session-token"
}
```

#### POST /api/v1/auth/logout
Logout and invalidate session.

#### GET /api/v1/auth/me
Get current authenticated user.

### URL Operations

#### POST /api/v1/urls
Create a short URL.

```bash
curl -X POST http://localhost:3000/api/v1/urls \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "long_url": "https://example.com/very/long/url",
    "custom_code": "my-link",
    "expires_in": 86400
  }'
```

Request body:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| long_url | string | Yes | The URL to shorten |
| custom_code | string | No | Custom short code (4-20 chars) |
| expires_in | number | No | Expiration time in seconds |

Response:
```json
{
  "short_url": "http://localhost:3000/my-link",
  "short_code": "my-link",
  "long_url": "https://example.com/very/long/url",
  "created_at": "2024-01-15T10:00:00Z",
  "expires_at": "2024-01-16T10:00:00Z",
  "click_count": 0,
  "is_custom": true
}
```

#### GET /api/v1/urls
List user's URLs (requires authentication).

```bash
curl http://localhost:3000/api/v1/urls?limit=50&offset=0 \
  -b cookies.txt
```

#### GET /api/v1/urls/:shortCode
Get URL details.

#### PATCH /api/v1/urls/:shortCode
Update URL (deactivate or change expiration).

```bash
curl -X PATCH http://localhost:3000/api/v1/urls/my-link \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"is_active": false}'
```

#### DELETE /api/v1/urls/:shortCode
Delete (deactivate) a URL.

### Redirect

#### GET /:shortCode
Redirect to the original URL.

```bash
curl -L http://localhost:3000/my-link
# Redirects to https://example.com/very/long/url
```

### Analytics

#### GET /api/v1/analytics/:shortCode
Get analytics for a URL (requires authentication).

Response:
```json
{
  "short_code": "my-link",
  "total_clicks": 150,
  "clicks_by_day": [
    {"date": "2024-01-15", "count": 50},
    {"date": "2024-01-14", "count": 100}
  ],
  "top_referrers": [
    {"referrer": "https://twitter.com", "count": 80},
    {"referrer": "Direct", "count": 70}
  ],
  "devices": [
    {"device": "desktop", "count": 100},
    {"device": "mobile", "count": 50}
  ]
}
```

### Admin Endpoints

All admin endpoints require admin role authentication.

#### GET /api/v1/admin/stats
Get system statistics.

#### GET /api/v1/admin/analytics
Get global analytics.

#### GET /api/v1/admin/urls
List all URLs with filtering.

Query parameters:
- `limit`: Number of results (default: 50)
- `offset`: Pagination offset
- `is_active`: Filter by active status
- `is_custom`: Filter by custom codes
- `search`: Search in short_code or long_url

#### POST /api/v1/admin/urls/:shortCode/deactivate
Deactivate a URL.

#### POST /api/v1/admin/urls/:shortCode/reactivate
Reactivate a URL.

#### GET /api/v1/admin/users
List all users.

#### PATCH /api/v1/admin/users/:userId/role
Update user role.

```bash
curl -X PATCH http://localhost:3000/api/v1/admin/users/user-id/role \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"role": "admin"}'
```

#### GET /api/v1/admin/key-pool
Get key pool statistics.

#### POST /api/v1/admin/key-pool/repopulate
Add more keys to the pool.

## Project Structure

```
bitly/
├── docker-compose.yml      # PostgreSQL and Redis containers
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── init.sql            # Database schema and seed data
│   └── src/
│       ├── index.ts        # Express app entry point
│       ├── config.ts       # Configuration settings
│       ├── routes/         # API route handlers
│       │   ├── auth.ts
│       │   ├── urls.ts
│       │   ├── analytics.ts
│       │   ├── admin.ts
│       │   └── redirect.ts
│       ├── services/       # Business logic
│       │   ├── authService.ts
│       │   ├── urlService.ts
│       │   ├── keyService.ts
│       │   ├── analyticsService.ts
│       │   └── adminService.ts
│       ├── middleware/     # Express middleware
│       │   ├── auth.ts
│       │   └── errorHandler.ts
│       ├── utils/          # Utilities
│       │   ├── database.ts
│       │   └── cache.ts
│       └── models/         # Type definitions
│           └── types.ts
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── routes/         # TanStack Router routes
        │   ├── __root.tsx
        │   ├── index.tsx
        │   ├── login.tsx
        │   ├── dashboard.tsx
        │   └── admin.tsx
        ├── components/     # React components
        │   ├── Header.tsx
        │   ├── UrlShortener.tsx
        │   ├── UrlList.tsx
        │   ├── AuthForms.tsx
        │   └── AdminDashboard.tsx
        ├── stores/         # Zustand state stores
        │   ├── authStore.ts
        │   └── urlStore.ts
        ├── services/       # API client
        │   └── api.ts
        └── types/          # TypeScript types
            └── index.ts
```

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| HOST | 0.0.0.0 | Server host |
| BASE_URL | http://localhost:3000 | Base URL for short links |
| CORS_ORIGIN | http://localhost:5173 | Allowed CORS origin |
| DB_HOST | localhost | PostgreSQL host |
| DB_PORT | 5432 | PostgreSQL port |
| DB_NAME | bitly | Database name |
| DB_USER | bitly | Database user |
| DB_PASSWORD | bitly_password | Database password |
| REDIS_HOST | localhost | Redis host |
| REDIS_PORT | 6379 | Redis port |
| SERVER_ID | server-{pid} | Unique server identifier |

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Testing the API

```bash
# Create a short URL (unauthenticated)
curl -X POST http://localhost:3000/api/v1/urls \
  -H "Content-Type: application/json" \
  -d '{"long_url": "https://github.com"}'

# Test redirect
curl -L http://localhost:3000/<short_code>

# Login as admin
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email": "admin@bitly.local", "password": "admin123"}'

# Get system stats
curl http://localhost:3000/api/v1/admin/stats -b cookies.txt
```

## Implementation Status

- [x] URL shortening with pre-generated key pool
- [x] Custom short codes
- [x] Link expiration
- [x] Click analytics
- [x] User authentication (session-based)
- [x] Admin dashboard
- [x] Redis caching for redirects
- [x] Rate limiting
- [x] Docker support
