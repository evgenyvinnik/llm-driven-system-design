# Uber - Ride Hailing Platform

A full-stack ride-hailing platform implementation featuring real-time driver matching, location tracking, surge pricing, and separate rider/driver interfaces.

## Features

### Rider App
- Request rides with pickup/dropoff locations
- View fare estimates for different vehicle types
- Real-time driver tracking
- Surge pricing display
- Ride history

### Driver App
- Go online/offline toggle
- Real-time location updates
- Accept/decline ride requests with countdown
- Trip management (arrived, start, complete)
- Earnings dashboard

### Core Features
- **Real-time matching**: Redis geo commands for driver location indexing
- **Surge pricing**: Dynamic pricing based on supply/demand ratio
- **WebSocket updates**: Real-time communication between riders and drivers
- **Session-based auth**: Simple authentication with Redis session storage

## Tech Stack

- **Frontend**: TypeScript, Vite, React 19, TanStack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, WebSocket (ws)
- **Database**: PostgreSQL (transactional data)
- **Cache/Geo**: Redis (location indexing, sessions, real-time state)

## Architecture

```
                    ┌─────────────────┐
                    │   Frontend      │
                    │  (Rider/Driver) │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │   API Gateway   │
                    │   + WebSocket   │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │ Auth Service │   │ Ride Service │   │ Pricing Svc  │
  └──────────────┘   │ + Matching   │   │ + Surge      │
                     └──────────────┘   └──────────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
              ┌─────┴─────┐     ┌─────┴─────┐
              │PostgreSQL │     │   Redis   │
              │ (Users,   │     │ (Geo,     │
              │  Rides)   │     │  Sessions)│
              └───────────┘     └───────────┘
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or pnpm

### Option 1: Using Docker (Recommended)

1. **Start infrastructure services**:
   ```bash
   cd uber
   docker-compose up -d
   ```

2. **Install backend dependencies**:
   ```bash
   cd backend
   npm install
   ```

3. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env if needed (defaults work for Docker setup)
   ```

4. **Start the backend**:
   ```bash
   npm run dev
   ```
   The API server will run on http://localhost:3000

5. **Install frontend dependencies** (new terminal):
   ```bash
   cd frontend
   npm install
   ```

6. **Start the frontend**:
   ```bash
   npm run dev
   ```
   The frontend will run on http://localhost:5173

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

1. **Install and start PostgreSQL**:
   ```bash
   # macOS with Homebrew
   brew install postgresql@16
   brew services start postgresql@16

   # Create database
   createdb uber_db
   psql uber_db -c "CREATE USER uber WITH PASSWORD 'uber_dev_password';"
   psql uber_db -c "GRANT ALL PRIVILEGES ON DATABASE uber_db TO uber;"
   ```

2. **Install and start Redis**:
   ```bash
   # macOS with Homebrew
   brew install redis
   brew services start redis
   ```

3. **Initialize database**:
   ```bash
   psql -U uber -d uber_db -f backend/src/models/init.sql
   ```

4. Follow steps 2-6 from Option 1 above.

### Running Multiple Backend Instances

To simulate a distributed environment:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Test Credentials

The database is seeded with test users:

| Role | Email | Password |
|------|-------|----------|
| Rider | rider1@test.com | password123 |
| Rider | rider2@test.com | password123 |
| Driver | driver1@test.com | password123 |
| Driver | driver2@test.com | password123 |
| Driver | driver3@test.com | password123 |

## API Endpoints

### Authentication
- `POST /api/auth/register/rider` - Register a new rider
- `POST /api/auth/register/driver` - Register a new driver
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

### Rides (Rider)
- `POST /api/rides/estimate` - Get fare estimates
- `POST /api/rides/request` - Request a ride
- `GET /api/rides/:rideId` - Get ride status
- `POST /api/rides/:rideId/cancel` - Cancel ride
- `POST /api/rides/:rideId/rate` - Rate the ride
- `GET /api/rides` - Get ride history
- `GET /api/rides/nearby/drivers` - Get nearby drivers
- `GET /api/rides/surge/info` - Get surge pricing info

### Driver
- `POST /api/driver/location` - Update location
- `POST /api/driver/online` - Go online
- `POST /api/driver/offline` - Go offline
- `GET /api/driver/status` - Get current status
- `POST /api/driver/rides/:rideId/accept` - Accept ride
- `POST /api/driver/rides/:rideId/arrived` - Notify arrival
- `POST /api/driver/rides/:rideId/start` - Start ride
- `POST /api/driver/rides/:rideId/complete` - Complete ride
- `GET /api/driver/earnings` - Get earnings

### WebSocket Events
- `auth` - Authenticate connection
- `location_update` - Send driver location
- `ride_offer` - Receive ride request (driver)
- `ride_matched` - Driver matched (rider)
- `driver_arrived` - Driver at pickup
- `ride_started` - Trip started
- `ride_completed` - Trip completed

## Project Structure

```
uber/
├── docker-compose.yml       # PostgreSQL, Redis
├── backend/
│   ├── package.json
│   ├── src/
│   │   ├── index.js         # Express + WebSocket server
│   │   ├── config/          # Configuration
│   │   ├── routes/          # API routes
│   │   ├── services/        # Business logic
│   │   │   ├── authService.js
│   │   │   ├── locationService.js
│   │   │   ├── matchingService.js
│   │   │   └── pricingService.js
│   │   ├── middleware/      # Auth middleware
│   │   ├── models/          # Database schema
│   │   └── utils/           # DB, Redis, geo helpers
│   └── .env.example
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── src/
    │   ├── main.tsx
    │   ├── routes/          # TanStack Router pages
    │   ├── stores/          # Zustand state management
    │   ├── services/        # API client, WebSocket
    │   └── types/           # TypeScript definitions
    └── index.html
```

## Key Design Decisions

1. **Redis Geo for driver locations**: O(log N) queries for finding nearby drivers using GEOADD/GEORADIUS commands

2. **Greedy matching algorithm**: Simple first-match approach prioritizing ETA and driver rating. Can be enhanced with batch matching for high-demand scenarios.

3. **Surge pricing by geohash**: Areas divided into ~5km cells, surge calculated per cell based on supply/demand ratio

4. **WebSocket for real-time updates**: Persistent connections for instant notifications rather than polling

5. **Session-based auth**: Simple approach using Redis for session storage, avoiding JWT complexity

## Future Enhancements

- [ ] Map integration (Mapbox/Google Maps)
- [ ] Actual geocoding for addresses
- [ ] Payment processing integration
- [ ] Push notifications
- [ ] Admin dashboard
- [ ] Driver route optimization
- [ ] ETA prediction using ML
- [ ] Ride pooling (UberPool)
- [ ] Scheduled rides

## Architecture Deep Dive

See [architecture.md](./architecture.md) for detailed system design documentation including:
- Scale estimation
- Data model design
- Component deep dives
- Trade-off analysis

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.
