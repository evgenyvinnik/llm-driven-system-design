# Design Notification System - High-Traffic Push Notifications

## Overview

A scalable notification system capable of delivering millions of push notifications, emails, and in-app messages with high reliability and low latency. This educational project focuses on building a multi-channel notification platform with prioritization, rate limiting, and delivery tracking.

## Key Features

### 1. Multi-Channel Delivery
- Push notifications (simulated APNs, FCM)
- Email notifications (simulated SMTP)
- SMS notifications (simulated)
- Priority-based queue processing

### 2. Message Management
- Priority queues (critical, high, normal, low)
- Message deduplication
- Template system with variable interpolation
- Scheduled notifications

### 3. Reliability
- At-least-once delivery
- Retry with exponential backoff
- Dead letter queues
- Delivery status tracking

### 4. User Preferences
- Per-channel opt-in/out
- Quiet hours configuration
- Category preferences
- Rate limit awareness

### 5. Admin Dashboard
- Campaign management
- Template creation
- User management
- Real-time statistics

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Cache:** Redis
- **Message Queue:** RabbitMQ
- **Containerization:** Docker Compose

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Option 1: Using Docker (Recommended)

1. **Start infrastructure services:**

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- RabbitMQ on ports 5672 (AMQP) and 15672 (Management UI)

2. **Install dependencies and start backend:**

```bash
cd backend
npm install
npm run dev
```

3. **Start the worker (in a separate terminal):**

```bash
cd backend
npm run dev:worker
```

4. **Install dependencies and start frontend:**

```bash
cd frontend
npm install
npm run dev
```

5. **Access the application:**

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- RabbitMQ Management: http://localhost:15672 (user: notification_user, password: notification_password)

### Option 2: Native Services

If you prefer running services natively:

1. **Install and start PostgreSQL:**

```bash
# macOS
brew install postgresql@16
brew services start postgresql@16

# Create database
createdb notification_db
createuser -s notification_user
psql -d notification_db -c "ALTER USER notification_user WITH PASSWORD 'notification_password';"
psql -d notification_db -f backend/init.sql
```

2. **Install and start Redis:**

```bash
# macOS
brew install redis
brew services start redis
```

3. **Install and start RabbitMQ:**

```bash
# macOS
brew install rabbitmq
brew services start rabbitmq

# Create user and permissions
rabbitmqctl add_user notification_user notification_password
rabbitmqctl set_permissions -p / notification_user ".*" ".*" ".*"
rabbitmqctl set_user_tags notification_user administrator
```

4. **Start the application as described above.**

## Running Multiple Server Instances

For testing load balancing and distributed processing:

```bash
# Terminal 1: Server on port 3001
cd backend && npm run dev:server1

# Terminal 2: Server on port 3002
cd backend && npm run dev:server2

# Terminal 3: Server on port 3003
cd backend && npm run dev:server3

# Terminal 4: Worker process
cd backend && npm run dev:worker
```

## Demo Accounts

The system comes with pre-seeded demo accounts:

| Email | Role | Description |
|-------|------|-------------|
| admin@example.com | Admin | Full admin access |
| john@example.com | User | Regular user with all channels enabled |
| jane@example.com | User | Regular user with push and email only |
| bob@example.com | User | Regular user with email only |

**Note:** In demo mode, any password works for existing users.

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Notifications
- `POST /api/v1/notifications` - Send notification
- `GET /api/v1/notifications` - Get user's notifications
- `GET /api/v1/notifications/:id` - Get notification by ID
- `DELETE /api/v1/notifications/:id` - Cancel notification
- `GET /api/v1/notifications/rate-limit/usage` - Get rate limit usage
- `POST /api/v1/notifications/:id/events` - Track notification event

### Preferences
- `GET /api/v1/preferences` - Get user preferences
- `PATCH /api/v1/preferences` - Update preferences
- `PUT /api/v1/preferences/quiet-hours` - Set quiet hours

### Templates (Admin)
- `GET /api/v1/templates` - List all templates
- `POST /api/v1/templates` - Create template
- `PATCH /api/v1/templates/:id` - Update template
- `DELETE /api/v1/templates/:id` - Delete template
- `POST /api/v1/templates/:id/preview` - Preview template

### Campaigns (Admin)
- `GET /api/v1/campaigns` - List campaigns
- `POST /api/v1/campaigns` - Create campaign
- `POST /api/v1/campaigns/:id/start` - Start campaign
- `POST /api/v1/campaigns/:id/cancel` - Cancel campaign

### Admin
- `GET /api/v1/admin/stats` - Dashboard statistics
- `GET /api/v1/admin/users` - List users
- `PATCH /api/v1/admin/users/:id/role` - Update user role
- `POST /api/v1/admin/users/:id/reset-rate-limit` - Reset rate limits

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Implementation Status

- [x] Docker Compose setup (PostgreSQL, Redis, RabbitMQ)
- [x] Database schema and initialization
- [x] Authentication (session-based)
- [x] Notification service with multi-channel support
- [x] Priority queue system
- [x] User preferences management
- [x] Rate limiting (per-user and global)
- [x] Deduplication
- [x] Template system
- [x] Worker for processing notifications
- [x] Retry logic with exponential backoff
- [x] Admin dashboard
- [x] Campaign management
- [x] Frontend user interface

## Key Technical Challenges

1. **Scale**: Handle millions of notifications per second
2. **Latency**: Deliver time-sensitive notifications quickly
3. **Reliability**: Ensure messages aren't lost or duplicated
4. **Rate Limiting**: Respect platform and user limits
5. **Preferences**: Honor complex user notification settings

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
