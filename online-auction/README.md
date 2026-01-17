# Online Auction System

## Overview

A real-time bidding and auction platform for online sales with auto-bidding, snipe protection, and live updates via WebSocket.

## Key Features

- **Item Listing**: Create auctions with images, descriptions, starting prices, and reserve prices
- **Real-time Bidding**: Place bids with instant updates via WebSocket
- **Auto-bidding (Proxy Bids)**: Set a maximum bid and let the system bid automatically on your behalf
- **Snipe Protection**: Auctions extend when bids are placed in the final minutes
- **Auction Timer**: Countdown timers with automatic auction closing
- **Winner Notification**: Automated notifications for winners, sellers, and outbid users
- **Watchlist**: Track auctions you're interested in
- **Admin Dashboard**: Manage users, auctions, and view system statistics

## Tech Stack

- **Frontend**: TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend**: Node.js + Express + WebSocket (ws)
- **Database**: PostgreSQL
- **Cache/Sessions/Locks**: Redis
- **Real-time**: WebSocket with Redis Pub/Sub

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (for PostgreSQL and Redis)
- npm or yarn

### Installation

1. Clone the repository and navigate to the project:

```bash
cd online-auction
```

2. Install backend dependencies:

```bash
cd backend
npm install
```

3. Install frontend dependencies:

```bash
cd ../frontend
npm install
```

### Running with Docker (Recommended)

1. Start the database and cache services:

```bash
docker-compose up -d
```

This will start:
- PostgreSQL on port 5432
- Redis on port 6379

The database will be automatically initialized with the schema from `backend/db/init.sql`.

2. Start the backend server:

```bash
cd backend
npm run dev
```

The API server will run on http://localhost:3001

3. Start the frontend development server:

```bash
cd frontend
npm run dev
```

The frontend will run on http://localhost:5173

### Running with Native Services

If you prefer to run PostgreSQL and Redis natively:

1. **PostgreSQL Setup**:

```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16

# Create database and user
psql postgres
CREATE USER auction WITH PASSWORD 'auction123';
CREATE DATABASE auction_db OWNER auction;
\q

# Initialize schema
psql -U auction -d auction_db -f backend/db/init.sql
```

2. **Redis Setup**:

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

3. Start the backend and frontend as described above.

### Environment Variables

The backend uses these defaults (can be overridden with environment variables):

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=auction_db
DB_USER=auction
DB_PASSWORD=auction123

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Server
PORT=3001
FRONTEND_URL=http://localhost:5173
```

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
cd backend
npm run dev:server1  # Port 3001

# Terminal 2
cd backend
npm run dev:server2  # Port 3002

# Terminal 3
cd backend
npm run dev:server3  # Port 3003
```

## Demo Credentials

The database is initialized with an admin user:

- **Email**: admin@auction.com
- **Password**: admin123

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Auctions
- `GET /api/auctions` - List auctions (with filters)
- `GET /api/auctions/:id` - Get auction details with bid history
- `POST /api/auctions` - Create auction (multipart form with image)
- `PUT /api/auctions/:id` - Update auction
- `DELETE /api/auctions/:id` - Cancel auction
- `POST /api/auctions/:id/watch` - Add to watchlist
- `DELETE /api/auctions/:id/watch` - Remove from watchlist
- `GET /api/auctions/user/watchlist` - Get user's watchlist
- `GET /api/auctions/user/selling` - Get user's selling auctions
- `GET /api/auctions/user/bids` - Get user's bid history

### Bidding
- `POST /api/bids/:auctionId` - Place a bid
- `POST /api/bids/:auctionId/auto` - Set auto-bid
- `DELETE /api/bids/:auctionId/auto` - Cancel auto-bid
- `GET /api/bids/:auctionId` - Get bid history

### Notifications
- `GET /api/notifications` - Get user's notifications
- `PUT /api/notifications/:id/read` - Mark as read
- `PUT /api/notifications/read-all` - Mark all as read

### Admin
- `GET /api/admin/stats` - Dashboard statistics
- `GET /api/admin/users` - List users
- `PUT /api/admin/users/:id/role` - Update user role
- `POST /api/admin/auctions/:id/close` - Force close auction

## WebSocket Events

Connect to `ws://localhost:3001/ws?token=<session_token>`

### Client Messages
- `{ type: "subscribe", auction_id: "..." }` - Subscribe to auction updates
- `{ type: "unsubscribe", auction_id: "..." }` - Unsubscribe
- `{ type: "ping" }` - Keep-alive

### Server Messages
- `{ type: "connected", authenticated: boolean }` - Connection established
- `{ type: "subscribed", auction_id: "..." }` - Subscription confirmed
- `{ type: "new_bid", auction_id, current_price, bidder_id, ... }` - New bid placed
- `{ type: "auction_ended", auction_id, winner_id, final_price }` - Auction ended

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
  - [x] User authentication
  - [x] Auction CRUD
  - [x] Bidding system
  - [x] Auto-bidding (proxy bids)
  - [x] Auction scheduler
  - [x] Snipe protection
- [x] Database/Storage layer
- [x] API endpoints
- [x] Real-time WebSocket updates
- [x] Frontend implementation
- [x] Admin dashboard
- [ ] Testing
- [ ] Performance optimization

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Future Enhancements

- Payment integration
- Email notifications
- Image CDN integration
- Buy It Now feature
- Seller ratings
- Search with Elasticsearch
- Rate limiting
- Comprehensive test suite
