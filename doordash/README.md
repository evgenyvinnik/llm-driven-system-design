# Design DoorDash - Food Delivery Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,563 |
| Source Files | 48 |
| .tsx | 1,848 |
| .js | 1,532 |
| .md | 1,022 |
| .ts | 814 |
| .sql | 187 |

## Overview

A simplified DoorDash-like platform demonstrating real-time order tracking, restaurant aggregation, delivery optimization, and three-sided marketplace dynamics. This educational project focuses on building a food delivery system with real-time logistics.

## Features

### Customer Features
- Browse restaurants with filtering by cuisine
- View restaurant menus and add items to cart
- Place orders with delivery address and tip
- Real-time order tracking with status updates
- View order history

### Restaurant Features
- Restaurant dashboard to manage incoming orders
- Update order status (confirm, preparing, ready)
- Toggle restaurant open/closed status
- View active orders in real-time

### Driver Features
- Driver dashboard with online/offline toggle
- Receive order assignments automatically
- Real-time location tracking (GPS)
- Pickup and delivery confirmation
- View earnings and delivery stats

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket
- **Database:** PostgreSQL (orders, users, restaurants) + Redis (geo commands, sessions, real-time)
- **Real-time:** WebSocket for live updates

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd doordash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432 (with seed data)
- Redis on port 6379

### 2. Start Backend

```bash
cd backend
npm install
npm run dev
```

The API server starts on http://localhost:3000

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend starts on http://localhost:5173

### 4. Access the Application

Open http://localhost:5173 in your browser.

## Demo Accounts

The database is seeded with demo accounts:

| Role | Email | Password |
|------|-------|----------|
| Customer | customer@example.com | password123 |
| Restaurant Owner | restaurant@example.com | password123 |
| Driver | driver@example.com | password123 |
| Admin | admin@example.com | password123 |

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Restaurants
- `GET /api/restaurants` - List restaurants (with filters)
- `GET /api/restaurants/:id` - Get restaurant with menu
- `GET /api/restaurants/meta/cuisines` - Get cuisine types

### Orders
- `POST /api/orders` - Place order
- `GET /api/orders` - Get customer's orders
- `GET /api/orders/:id` - Get order details
- `PATCH /api/orders/:id/status` - Update order status

### Drivers
- `POST /api/drivers/location` - Update driver location
- `POST /api/drivers/status` - Toggle online/offline
- `GET /api/drivers/orders` - Get driver's orders
- `POST /api/drivers/orders/:id/pickup` - Confirm pickup
- `POST /api/drivers/orders/:id/deliver` - Confirm delivery

## WebSocket Events

Connect to `ws://localhost:3000/ws`

### Subscribe to Channels
```javascript
// Subscribe to order updates
ws.send(JSON.stringify({ type: 'subscribe', channel: 'order:123' }))

// Subscribe to customer orders
ws.send(JSON.stringify({ type: 'subscribe', channel: 'customer:1:orders' }))

// Subscribe to restaurant orders
ws.send(JSON.stringify({ type: 'subscribe', channel: 'restaurant:1:orders' }))
```

### Events Received
- `new_order` - New order placed (for restaurants)
- `order_status_update` - Order status changed
- `driver_location` - Driver location update
- `order_assigned` - Order assigned to driver

## Order Flow

```
PLACED -> CONFIRMED -> PREPARING -> READY_FOR_PICKUP -> PICKED_UP -> DELIVERED
  |           |           |              |                |
  +---------->+---------->+<-- Restaurant updates these --+
                                         |
                                         +-- Driver updates these --+
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Key Technical Challenges

1. **Three-Sided Marketplace**: Balancing customers, restaurants, and drivers
2. **Delivery Matching**: Optimal order-to-driver assignment using scoring
3. **Real-Time Tracking**: Location updates with WebSocket and Redis geo
4. **ETA Accuracy**: Multi-factor calculation with traffic adjustments
5. **Order State Machine**: Managing complex status transitions

## Project Structure

```
doordash/
├── backend/
│   ├── src/
│   │   ├── routes/          # API route handlers
│   │   ├── services/        # Business logic
│   │   ├── middleware/      # Auth middleware
│   │   ├── utils/           # Geo calculations, helpers
│   │   ├── db.js            # PostgreSQL connection
│   │   ├── redis.js         # Redis connection
│   │   ├── websocket.js     # WebSocket server
│   │   └── index.js         # App entry point
│   └── db/
│       └── init.sql         # Database schema and seeds
├── frontend/
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── routes/          # Tanstack Router routes
│   │   ├── stores/          # Zustand stores
│   │   ├── services/        # API client
│   │   ├── hooks/           # Custom hooks
│   │   └── types/           # TypeScript types
│   └── ...
├── docker-compose.yml       # PostgreSQL + Redis
└── README.md                # This file
```

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [How DoorDash Optimizes Delivery Logistics](https://doordash.engineering/2024/03/05/how-doordash-optimizes-delivery-logistics/) - Real-time dispatch and routing optimization
- [DoorDash's Evolving Dispatch Architecture](https://doordash.engineering/2021/06/29/doordashs-evolving-dispatch-architecture/) - Building a scalable logistics platform
- [Next-Generation Optimization for Dasher Dispatch](https://doordash.engineering/2020/02/28/next-generation-optimization-for-dasher-dispatch-at-doordash/) - ML-based driver assignment
- [Building Faster Indexing with Apache Kafka and Elasticsearch](https://doordash.engineering/2021/07/14/building-faster-indexing-with-apache-kafka-and-elasticsearch/) - Real-time search infrastructure
- [How We Reduced Hotspot Issues on Our Cassandra Cluster](https://doordash.engineering/2021/03/02/how-we-reduced-hotspot-issues-on-our-cassandra-cluster/) - Scaling time-series data
- [Managing Supply and Demand Balance Through Machine Learning](https://doordash.engineering/2021/04/14/managing-supply-and-demand-balance-through-machine-learning/) - Dynamic pricing and demand forecasting
- [How DoorDash is Scaling its Data Platform](https://doordash.engineering/2020/04/27/how-doordash-is-scaling-its-data-platform/) - Data infrastructure at scale
- [Building DoorDash's Self-Serve Analytics Platform](https://doordash.engineering/2020/05/27/building-doordashs-self-serve-analytics-platform/) - Real-time analytics for operations
