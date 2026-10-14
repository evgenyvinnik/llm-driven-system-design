# Local Delivery Service

A last-mile delivery platform for local goods and services, similar to DoorDash, Instacart, or Uber Eats. Features real-time driver tracking, order management, and driver matching.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 12,539 |
| Source Files | 85 |
| .ts | 7,509 |
| .tsx | 2,386 |
| .md | 1,966 |
| .sql | 311 |
| .json | 147 |

## Features

### Customer Features
- Browse nearby restaurants by category
- Search for merchants
- Add items to cart and place orders
- Real-time order tracking with driver location
- Rate drivers and merchants

### Driver Features
- Go online/offline
- Receive and accept/reject delivery offers
- Mark orders as picked up, in transit, delivered
- View delivery stats and ratings

### Admin Features
- Dashboard with order, driver, and merchant stats
- View all orders, drivers, and merchants
- Monitor system health

## Tech Stack

- **Frontend:** TypeScript, React 19, Vite, Tanstack Router, Zustand, Tailwind CSS
- **Backend:** Node.js, Express, WebSocket
- **Database:** PostgreSQL (relational data), Redis (geo-indexing, caching, pub/sub)

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

## Quick Start

### 1. Start Infrastructure

```bash
cd local-delivery

# Start PostgreSQL and Redis
docker-compose up -d

# Wait for services to be healthy
docker-compose ps

# Load demo accounts and sample data.
# The mounted init.sql only creates the schema; the seed users live in
# backend/db-seed/seed.sql, which must be loaded explicitly (there is no npm seed script).
PGPASSWORD=delivery_secret psql -h localhost -U delivery -d delivery -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
```

Both SQL files are re-runnable. After pulling schema changes into an existing volume, apply them with
`psql ... -v ON_ERROR_STOP=1 -f backend/src/db/init.sql` (every statement is guarded, and the new
constraints use `NOT VALID` so old rows don't block them).

### 2. Start Backend

```bash
cd backend

# Install dependencies
npm install

# Start the server (default port 3000)
npm run dev

# Unit tests (vitest, offline: shared modules are mocked)
npm test
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP + WebSocket port |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `localhost`, `5432`, `delivery`, `delivery`, `delivery_secret` | PostgreSQL |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` | Redis / Valkey |
| `LOCATION_STALE_MS` | `30000` | A driver whose last ping is older than this gets no offers |
| `LOG_LEVEL` | `info` | Pino log level |

Drivers only receive offers while they are online **and** pinging: the driver dashboard sends its
position every 10 seconds while online, so keep that tab open when testing matching.

Backend will be available at:
- API: http://localhost:3000/api/v1
- WebSocket: ws://localhost:3000/ws
- Health check: http://localhost:3000/health

### 3. Start Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Frontend will be available at http://localhost:5173

## Demo Accounts

The database is seeded with test accounts:

| Role | Email | Password |
|------|-------|----------|
| Customer | customer1@test.com | password123 |
| Customer | customer2@test.com | password123 |
| Driver | driver1@test.com | password123 |
| Driver | driver2@test.com | password123 |
| Driver | driver3@test.com | password123 |
| Admin | admin@delivery.local | password123 |

All seeded accounts share the bcrypt-hashed password `password123`. Login is verified with `bcrypt.compare` in `authService.validatePassword`, so the password must match exactly.

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Merchants
- `GET /api/v1/merchants?lat=...&lng=...` - Get nearby merchants
- `GET /api/v1/merchants/:id` - Get merchant details
- `GET /api/v1/merchants/:id/menu` - Get merchant menu
- `GET /api/v1/merchants/categories` - Get all categories
- `GET /api/v1/merchants/search?q=...` - Search merchants

### Orders (Customer)
- `POST /api/v1/orders/quote` - Price a cart (subtotal, delivery fee, tip, total) without creating it
- `POST /api/v1/orders` - Create order; send an `Idempotency-Key` header (one per checkout attempt): a retry with the same key returns the original order, a different body or user gets `422`
- `GET /api/v1/orders` - Get my orders
- `GET /api/v1/orders/:id` - Get order details (includes `version`)
- `POST /api/v1/orders/:id/cancel` - Cancel order (`409` once a driver has accepted)
- `POST /api/v1/orders/:id/tip` - Change the tip
- `POST /api/v1/orders/:id/rate/driver` - Rate driver
- `POST /api/v1/orders/:id/rate/merchant` - Rate merchant

### Driver
- `GET /api/v1/driver/profile` - Get driver profile
- `POST /api/v1/driver/go-online` - Go online
- `POST /api/v1/driver/go-offline` - Go offline
- `POST /api/v1/driver/location` - Update location
- `GET /api/v1/driver/orders` - Get active orders
- `GET /api/v1/driver/offers/pending` - Get pending offer
- `POST /api/v1/driver/offers/:id/accept` - Accept offer (`409` if the offer expired or the order was cancelled)
- `POST /api/v1/driver/offers/:id/reject` - Reject offer
- `POST /api/v1/driver/orders/:id/picked-up` - Mark picked up
- `POST /api/v1/driver/orders/:id/in-transit` - Mark in transit
- `POST /api/v1/driver/orders/:id/delivered` - Mark delivered

### Admin
- `GET /api/v1/admin/stats` - Dashboard stats
- `GET /api/v1/admin/orders` - All orders
- `GET /api/v1/admin/drivers` - All drivers
- `GET /api/v1/admin/merchants` - All merchants
- `GET /api/v1/admin/customers` - All customers

## WebSocket Events

Connect to `ws://localhost:3000/ws?token=<auth_token>`

### Client -> Server
```json
{ "type": "subscribe_order", "payload": { "order_id": "..." } }
{ "type": "unsubscribe_order" }
{ "type": "subscribe_driver_offers" }
{ "type": "update_location", "payload": { "lat": ..., "lng": ... } }
```

### Server -> Client
```json
{ "type": "order_snapshot", "payload": { "order": {...} } }
{ "type": "location_update", "payload": { "lat": ..., "lng": ..., "eta_seconds": ... } }
{ "type": "status_update", "payload": { "order_id": "...", "status": "...", "driver_id": "...", "version": 3, "timestamp": "..." } }
{ "type": "new_offer", "payload": { "offer_id": "...", "order": {...}, "expires_in": 30 } }
```

Every `subscribe_order` is answered with an `order_snapshot`, so a client that reconnects simply resubscribes. Keep whichever copy of the order has the higher `version`.

## Running Multiple Backend Instances

For testing load balancing and distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

Matching is shared through dispatch leases in PostgreSQL: if you stop the instance that is matching an
order, another instance's sweeper picks the order up within about 45 seconds (immediately on a graceful
shutdown, which releases its leases).

## Project Structure

```
local-delivery/
├── docker-compose.yml          # PostgreSQL + Redis
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── db-seed/
│   │   └── seed.sql            # Demo accounts and menus (re-runnable)
│   └── src/
│       ├── index.ts            # Entry point
│       ├── routes/             # API routes
│       │   ├── auth.ts
│       │   ├── merchants.ts
│       │   ├── orders.ts
│       │   ├── driver.ts
│       │   └── admin.ts
│       ├── db/init.sql         # Schema (re-runnable)
│       ├── services/           # Business logic
│       │   ├── authService.ts
│       │   ├── driverService.ts
│       │   ├── merchantService.ts
│       │   ├── ratingService.ts
│       │   └── order/          # pricing, create, stateMachine, cancel,
│       │                       # assignment, dispatch, matching, delivery, tracking
│       ├── shared/             # idempotency, errors, schemas, circuit breaker, metrics, logger
│       ├── middleware/
│       │   └── auth.ts
│       ├── websocket/
│       │   ├── handler.ts
│       │   └── channelRegistry.ts
│       ├── types/
│       │   └── index.ts
│       └── utils/
│           ├── db.ts           # PostgreSQL connection
│           ├── redis.ts        # Redis connection + geo ops
│           └── geo.ts          # Geospatial utilities
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── index.css
        ├── routes/             # Tanstack Router routes
        ├── components/         # React components
        ├── stores/             # Zustand stores
        ├── services/           # API and WebSocket clients
        └── types/              # TypeScript definitions
```

## Key Design Decisions

### Real-time Location Tracking
- Driver locations are stored in Redis with GEOADD and searched with GEOSEARCH; a `drivers:last_seen` sorted set filters out drivers who stopped pinging
- Location updates are published via Redis Pub/Sub; PostgreSQL gets one sample per driver per 10 seconds
- Each API process holds one Redis subscriber and fans messages out to its WebSocket clients

### Driver Matching
- Scoring algorithm considers: distance, rating, acceptance rate, current load
- Offers are sent sequentially with 30-second timeout
- Accepting is one transaction (offer, order, driver); partial unique indexes allow one live offer per order and per driver
- After 5 offers, or 5 minutes without a driver nearby, the order is cancelled

### Data Storage
- PostgreSQL for persistent data (users, orders, merchants)
- Redis for real-time data (driver locations, active orders, sessions)

## Architecture

See [architecture.md](./architecture.md) for detailed system design.
See [system-design-answer-fullstack.md](./system-design-answer-fullstack.md) for interview-style design discussion.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

## References & Inspiration

- [DoorDash System Design](https://blog.bytebytego.com/p/designing-doordash) - ByteByteGo breakdown of food delivery architecture
- [Uber's Real-Time Marketplace](https://www.uber.com/blog/uber-marketplace-real-time-data-platform/) - Real-time matching at scale
- [Redis Geospatial Indexes](https://redis.io/docs/data-types/geospatial/) - Efficient driver location tracking
- [Last-Mile Delivery Optimization](https://www.mckinsey.com/industries/travel-logistics-and-infrastructure/our-insights/how-customer-demands-are-reshaping-last-mile-delivery) - McKinsey insights on delivery logistics
- [Route Optimization Algorithms](https://developers.google.com/optimization/routing) - Google OR-Tools for vehicle routing
- [Building Real-Time Location Tracking](https://www.pubnub.com/blog/build-a-real-time-location-tracking-app/) - PubNub patterns for live tracking
- [Instacart's Dispatch System](https://tech.instacart.com/space-time-and-groceries-a315925acf3a) - Shopper assignment optimization
- [Surge Pricing Algorithms](https://www.uber.com/blog/demand-pricing/) - Dynamic pricing based on demand
- [WebSocket at Scale for Real-Time Updates](https://engineering.grab.com/how-we-built-grabchat-android) - Grab's real-time messaging architecture

## Future Enhancements

- [ ] Add map visualization for tracking
- [ ] Implement surge pricing
- [ ] Add multi-stop route optimization
- [ ] Payment integration (Stripe)
- [ ] Push notifications
- [ ] Demand prediction for driver positioning
- [ ] Performance testing and optimization
