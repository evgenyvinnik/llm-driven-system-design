# Design APNs - Apple Push Notification Service

## Overview

A simplified APNs-like platform demonstrating push notification delivery, device token management, and guaranteed delivery at scale. This educational project focuses on building a reliable notification system for millions of devices.

## Features

### Core Functionality
- **Device Token Registration**: Register and manage device tokens with app bundle ID associations
- **Push Notifications**: Send notifications with priority levels (high, medium, low)
- **Topic Subscriptions**: Subscribe devices to topics for targeted notifications
- **Delivery Tracking**: Track notification status (pending, queued, delivered, failed, expired)
- **Store-and-Forward**: Queue notifications for offline devices
- **Feedback Service**: Report invalid/unregistered tokens to providers

### Admin Dashboard
- Real-time statistics (devices, notifications, topics)
- Device management interface
- Notification history with filtering
- Send notifications to devices, topics, or broadcast
- Session-based authentication

## Tech Stack

- **Backend**: Node.js + Express + TypeScript
- **Frontend**: React 19 + Vite + Tanstack Router + Zustand + Tailwind CSS
- **Database**: PostgreSQL 16
- **Cache**: Redis 7
- **WebSocket**: Real-time device connections

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Option 1: Using Docker (Recommended)

1. **Start infrastructure services**:
   ```bash
   docker-compose up -d
   ```

2. **Install backend dependencies**:
   ```bash
   cd backend
   cp .env.example .env
   npm install
   ```

3. **Start the backend**:
   ```bash
   npm run dev
   ```

4. **Install frontend dependencies** (in a new terminal):
   ```bash
   cd frontend
   npm install
   ```

5. **Start the frontend**:
   ```bash
   npm run dev
   ```

6. **Access the application**:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3000
   - Health check: http://localhost:3000/health

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

#### macOS (Homebrew)

```bash
# Install PostgreSQL
brew install postgresql@16
brew services start postgresql@16

# Create database
createdb apns
psql -d apns -f backend/src/db/init.sql

# Install Redis
brew install redis
brew services start redis
```

#### Ubuntu/Debian

```bash
# Install PostgreSQL
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo -u postgres createdb apns
sudo -u postgres psql -d apns -f backend/src/db/init.sql

# Install Redis
sudo apt install redis-server
sudo systemctl start redis-server
```

#### Environment Configuration

Update `backend/.env`:
```
DATABASE_URL=postgres://your_user:your_password@localhost:5432/apns
REDIS_URL=redis://localhost:6379
PORT=3000
NODE_ENV=development
```

### Running Multiple Server Instances

For distributed testing:

```bash
# Terminal 1 - Server on port 3001
cd backend
npm run dev:server1

# Terminal 2 - Server on port 3002
npm run dev:server2

# Terminal 3 - Server on port 3003
npm run dev:server3
```

## API Reference

### Device Registration

```bash
# Register a device token
curl -X POST http://localhost:3000/api/v1/devices/register \
  -H "Content-Type: application/json" \
  -d '{
    "token": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "app_bundle_id": "com.example.myapp",
    "device_info": {
      "platform": "iOS",
      "os_version": "17.0",
      "device_model": "iPhone 15"
    }
  }'
```

### Send Notification

```bash
# Send to device by token
curl -X POST http://localhost:3000/api/v1/notifications/device/a1b2c3d4... \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "aps": {
        "alert": {
          "title": "Hello",
          "body": "World"
        },
        "badge": 1,
        "sound": "default"
      }
    },
    "priority": 10
  }'

# Send to topic
curl -X POST http://localhost:3000/api/v1/notifications/topic/news.sports \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "aps": {
        "alert": "Breaking news!"
      }
    }
  }'
```

### Topic Subscription

```bash
# Subscribe to topic
curl -X POST http://localhost:3000/api/v1/devices/topics/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "device_token": "a1b2c3d4...",
    "topic": "news.sports"
  }'
```

### APNs-Compatible Endpoint

```bash
# APNs-style endpoint
curl -X POST http://localhost:3000/3/device/a1b2c3d4... \
  -H "Content-Type: application/json" \
  -H "apns-priority: 10" \
  -H "apns-topic: com.example.myapp" \
  -d '{
    "aps": {
      "alert": "Hello from APNs-style endpoint!"
    }
  }'
```

## WebSocket Connection

Devices can maintain persistent connections for real-time notification delivery:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

ws.onopen = () => {
  // Register device connection
  ws.send(JSON.stringify({
    type: 'connect',
    device_id: 'your-device-uuid'
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'notification') {
    console.log('Received notification:', message.payload);

    // Acknowledge delivery
    ws.send(JSON.stringify({
      type: 'ack',
      notification_id: message.id
    }));
  }
};
```

## Admin Dashboard

### Default Credentials

- Username: `admin`
- Password: `admin123`

### Creating Additional Admin Users

```bash
curl -X POST http://localhost:3000/api/v1/admin/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "username": "newadmin",
    "password": "securepassword",
    "role": "admin"
  }'
```

## Project Structure

```
apns/
├── docker-compose.yml       # PostgreSQL + Redis
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts         # Express app + WebSocket server
│       ├── db/
│       │   ├── index.ts     # PostgreSQL connection
│       │   ├── redis.ts     # Redis connection
│       │   └── init.sql     # Database schema
│       ├── routes/
│       │   ├── devices.ts   # Device registration
│       │   ├── notifications.ts
│       │   ├── feedback.ts
│       │   └── admin.ts     # Admin dashboard API
│       ├── services/
│       │   ├── tokenRegistry.ts
│       │   ├── pushService.ts
│       │   └── feedbackService.ts
│       ├── types/
│       │   └── index.ts
│       └── utils/
│           └── index.ts
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── src/
│       ├── main.tsx
│       ├── routes/
│       │   ├── __root.tsx
│       │   ├── index.tsx    # Dashboard
│       │   ├── login.tsx
│       │   ├── devices.tsx
│       │   ├── notifications.tsx
│       │   └── send.tsx     # Send notification form
│       ├── stores/
│       │   ├── authStore.ts
│       │   └── dashboardStore.ts
│       ├── services/
│       │   └── api.ts
│       └── types/
│           └── index.ts
├── README.md
├── architecture.md
└── claude.md
```

## Implementation Status

- [x] Docker Compose setup (PostgreSQL, Redis)
- [x] Device token management
- [x] Provider API (HTTP REST)
- [x] Push delivery pipeline
- [x] Store-and-forward for offline devices
- [x] Feedback service
- [x] Topic subscriptions
- [x] WebSocket device connections
- [x] Admin dashboard
- [ ] HTTP/2 support
- [ ] JWT authentication for providers
- [ ] Geographic routing
- [ ] Load testing

## Key Technical Challenges

1. **Scale**: Designed for billions of notifications per day
2. **Latency**: Sub-second delivery worldwide
3. **Reliability**: Guaranteed delivery to online devices
4. **Efficiency**: Persistent connections at massive scale
5. **Battery**: Minimize device wake-ups with priority levels

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
