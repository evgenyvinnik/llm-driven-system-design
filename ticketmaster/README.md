# Ticketmaster - Event Ticketing Platform

A full-stack event ticketing platform inspired by Ticketmaster, featuring seat selection, real-time availability, virtual waiting room for high-demand events, and time-limited checkout.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,160 |
| Source Files | 50 |
| .ts | 2,302 |
| .tsx | 1,439 |
| .md | 885 |
| .sql | 299 |
| .json | 131 |

## Features

- **Event Browsing**: Search and filter events by category, date, artist, and venue
- **Interactive Seat Selection**: Visual seat map with real-time availability
- **Seat Reservation with Locking**: Distributed seat locks using Redis prevent double-booking
- **Virtual Waiting Room**: Fair queue system for high-demand events
- **Time-Limited Checkout**: 10-minute hold on reserved seats with countdown timer
- **Order Management**: View purchased tickets and order history

## Architecture Highlights

- **Distributed Locking**: Redis-based seat locks ensure no overselling
- **Optimistic Locking**: Database transactions with `FOR UPDATE NOWAIT` for race condition prevention
- **Virtual Waiting Room**: FIFO queue with configurable concurrent shopper limits
- **Real-time Updates**: Short-TTL caching for seat availability during high traffic
- **Background Jobs**: Automatic cleanup of expired holds

## Tech Stack

### Backend
- Node.js + Express
- PostgreSQL (primary data store)
- Redis (session storage, distributed locks, queues)
- TypeScript

### Frontend
- React 19 + TypeScript
- Vite (build tool)
- TanStack Router (routing)
- Zustand (state management)
- Tailwind CSS (styling)

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for databases)
- npm or yarn

### Quick Start with Docker

1. **Clone and navigate to the project**
   ```bash
   cd ticketmaster
   ```

2. **Start the databases**
   ```bash
   docker-compose up -d
   ```

3. **Install backend dependencies**
   ```bash
   cd backend
   npm install
   ```

4. **Start the backend server**
   ```bash
   npm run dev
   ```
   The API server will start on http://localhost:3001

5. **In a new terminal, install frontend dependencies**
   ```bash
   cd frontend
   npm install
   ```

6. **Start the frontend**
   ```bash
   npm run dev
   ```
   The frontend will start on http://localhost:5173

### Running Without Docker (Native Services)

If you prefer to run PostgreSQL and Redis natively:

1. **Install PostgreSQL and Redis**
   - macOS: `brew install postgresql redis`
   - Ubuntu: `sudo apt install postgresql redis-server`

2. **Start the services**
   ```bash
   # macOS with Homebrew
   brew services start postgresql
   brew services start redis

   # Ubuntu
   sudo systemctl start postgresql
   sudo systemctl start redis-server
   ```

3. **Create the database**
   ```bash
   createdb ticketmaster
   psql ticketmaster -f backend/src/db/init.sql
   ```

4. **Set environment variables (optional)**
   ```bash
   export DB_HOST=localhost
   export DB_PORT=5432
   export DB_USER=your_username
   export DB_PASSWORD=your_password
   export DB_NAME=ticketmaster
   export REDIS_HOST=localhost
   export REDIS_PORT=6379
   ```

5. **Start the backend and frontend** as described above

### Running Multiple Backend Instances

For testing load balancing and distributed behavior:

```bash
# Terminal 1 - Instance on port 3001
npm run dev:server1

# Terminal 2 - Instance on port 3002
npm run dev:server2

# Terminal 3 - Instance on port 3003
npm run dev:server3
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login and create session
- `POST /api/v1/auth/logout` - Logout and invalidate session
- `GET /api/v1/auth/me` - Get current user

### Events
- `GET /api/v1/events` - List events (supports filtering)
- `GET /api/v1/events/:id` - Get event details

### Venues
- `GET /api/v1/venues` - List all venues
- `GET /api/v1/venues/:id` - Get venue details
- `GET /api/v1/venues/:id/sections` - Get venue sections

### Seats
- `GET /api/v1/seats/:eventId/availability` - Get seat availability by section
- `GET /api/v1/seats/:eventId/sections/:section` - Get individual seats in section
- `POST /api/v1/seats/:eventId/reserve` - Reserve seats (creates 10-min hold)
- `POST /api/v1/seats/:eventId/release` - Release held seats
- `GET /api/v1/seats/reservation` - Get current reservation

### Waiting Room
- `POST /api/v1/queue/:eventId/join` - Join waiting room queue
- `GET /api/v1/queue/:eventId/status` - Get queue position
- `POST /api/v1/queue/:eventId/leave` - Leave queue
- `GET /api/v1/queue/:eventId/stats` - Get queue statistics

### Checkout
- `POST /api/v1/checkout` - Complete purchase
- `GET /api/v1/checkout/orders` - List user orders
- `GET /api/v1/checkout/orders/:id` - Get order details
- `POST /api/v1/checkout/orders/:id/cancel` - Cancel order

## Sample Data

The database is seeded with:
- 4 venues (Madison Square Garden, The O2 Arena, Staples Center, Red Rocks)
- 6 sample events across different categories
- Venue sections with VIP, Premium, Standard, and Economy pricing tiers
- Admin user: `admin@ticketmaster.local` (for testing admin features)

## Environment Variables

### Backend
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `ticketmaster` | PostgreSQL user |
| `DB_PASSWORD` | `ticketmaster_secret` | PostgreSQL password |
| `DB_NAME` | `ticketmaster` | PostgreSQL database |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |

### Frontend
| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `/api` | API base URL (proxied in dev) |

## Testing the Flow

1. **Browse Events**: Visit http://localhost:5173 to see available events
2. **Register/Login**: Create an account or sign in
3. **Select Event**: Click on an "On Sale" event
4. **High-Demand Event**: For events with "High Demand" badge, enter the waiting room
5. **Select Seats**: Choose a section, then click on available seats
6. **Reserve**: Click "Reserve Seats" to create a 10-minute hold
7. **Checkout**: Complete the purchase before the timer expires
8. **View Tickets**: Go to "My Orders" to see purchased tickets

## Development

```bash
# Backend
cd backend
npm run dev          # Start with hot reload
npm run build        # Build TypeScript
npm run lint         # Run ESLint
npm run type-check   # TypeScript type checking

# Frontend
cd frontend
npm run dev          # Start Vite dev server
npm run build        # Build for production
npm run lint         # Run ESLint
npm run type-check   # TypeScript type checking
```

## Architecture Documentation

See [architecture.md](./architecture.md) for detailed system design documentation.

See [system-design-answer.md](./system-design-answer.md) for interview-style system design walkthrough.

## Key Design Decisions

1. **Redis for Seat Locks**: Sub-millisecond distributed locking with automatic expiry
2. **PostgreSQL FOR UPDATE NOWAIT**: Prevents database-level race conditions
3. **10-Minute Hold Duration**: Balances user checkout time with seat turnover
4. **Virtual Waiting Room**: Protects backend from traffic spikes, ensures fairness
5. **Session-Based Auth**: Simple cookie + Redis sessions (no JWT complexity for learning)

## Future Enhancements

- [ ] Admin dashboard for event management
- [ ] Payment integration (Stripe)
- [ ] Email confirmation with tickets
- [ ] Mobile ticket with QR codes
- [ ] Secondary market (resale)
- [ ] Bot detection and CAPTCHA
- [ ] WebSocket for real-time seat updates

## References & Inspiration

- [Ticketmaster Tech Blog](https://tech.ticketmaster.com/) - Official Ticketmaster engineering blog
- [How We Built Our Virtual Waiting Room](https://tech.ticketmaster.com/2022/01/24/how-we-built-our-virtual-waiting-room/) - Queue systems for high-demand events
- [Redis Distributed Locks (Redlock)](https://redis.io/docs/manual/patterns/distributed-locks/) - Distributed locking patterns
- [Handling High Traffic Ticket Sales](https://www.infoq.com/presentations/ticketmaster-scalability/) - Scalability lessons from Ticketmaster
- [PostgreSQL FOR UPDATE NOWAIT](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) - Optimistic locking in PostgreSQL
- [Queue-Fair: Virtual Waiting Room](https://queue-fair.com/virtual-waiting-room-explained) - Virtual waiting room concepts
- [Building Fair Queuing Systems](https://aws.amazon.com/blogs/architecture/managing-flash-traffic-with-amazon-sqs/) - AWS queue-based traffic management
- [Preventing Ticket Scalping with CAPTCHA](https://www.cloudflare.com/learning/bots/what-is-a-captcha/) - Bot detection and prevention strategies
