# Coinbase - Crypto Exchange

A cryptocurrency exchange platform with real-time price feeds, order matching engine, candlestick charts, and portfolio management. Built to explore 24/7 market operations, DECIMAL precision accounting, and order book data structures.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,216 |
| Source Files | 79 |
| .ts | 3,506 |
| .md | 1,657 |
| .tsx | 1,431 |
| .sql | 251 |
| .json | 151 |


## Screenshots

_Run the application to see the dark-themed exchange UI with live price charts, order book depth visualization, and trading interface._

## Features

- **Market Overview** - Real-time prices for 12+ trading pairs with 24h change, volume, and sparklines
- **Trading Interface** - Candlestick charts (TradingView lightweight-charts), order book depth, market/limit orders
- **Order Matching Engine** - In-memory order book with price-time priority matching
- **Price Simulation** - Geometric Brownian Motion for realistic price movement
- **Portfolio Management** - Holdings summary with allocation breakdown
- **Wallet System** - Per-currency wallets with balance/reserved tracking
- **Real-time Updates** - WebSocket price streaming every 2 seconds
- **Order History** - View and cancel open orders

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, TanStack Router, Zustand, Tailwind CSS, lightweight-charts |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 (DECIMAL(28,18) precision) |
| Cache | Valkey/Redis (sessions, idempotency) |
| Messaging | Kafka (price events, trade events) |
| Real-time | WebSocket (ws library) |

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- Docker Desktop

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure
docker-compose up -d

# Wait for services to be healthy
docker-compose ps

# Run database migrations
cd backend
npm install
npm run db:migrate

# Seed demo data
PGPASSWORD=coinbase123 psql -h localhost -U coinbase -d coinbase -f db-seed/seed.sql

# Start backend (Terminal 1)
npm run dev

# Start price broadcaster worker (Terminal 2)
npm run dev:worker:price

# Start frontend (Terminal 3)
cd ../frontend
npm install
npm run dev
```

### Option B: Native Installation

```bash
# PostgreSQL
brew install postgresql@16
brew services start postgresql@16
createuser -s coinbase
createdb -O coinbase coinbase
psql -U coinbase -d coinbase -c "ALTER USER coinbase PASSWORD 'coinbase123'"

# Valkey (Redis-compatible)
brew install valkey
brew services start valkey

# Kafka (requires Java)
brew install kafka
brew services start zookeeper
brew services start kafka
```

### Demo Accounts

| Username | Password | Starting Balance |
|----------|----------|-----------------|
| alice | password123 | $100,000 + 1.5 BTC + 10 ETH + 100 SOL + more |
| bob | password123 | $100,000 + 0.5 BTC + 5 ETH + 50 SOL + more |

## Architecture

See [architecture.md](./architecture.md) for the full system design document.

## Available Scripts

### Backend

```bash
npm run dev              # Start API server on port 3001
npm run dev:server1      # Port 3001
npm run dev:server2      # Port 3002
npm run dev:server3      # Port 3003
npm run dev:worker:price # Price broadcaster (every 2s)
npm run dev:worker:portfolio # Portfolio snapshots (every 60s)
npm run test             # Run tests
npm run db:migrate       # Run database migrations
```

### Frontend

```bash
npm run dev              # Start dev server on port 5173
npm run build            # Production build
npm run lint             # ESLint
```

## Environment Variables

```bash
# Backend
DATABASE_URL=postgresql://coinbase:coinbase123@localhost:5432/coinbase
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9092
SESSION_SECRET=coinbase-dev-secret-key
PORT=3001

# Frontend
# Configured via Vite proxy (vite.config.ts)
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/v1/auth/register | No | Register new user |
| POST | /api/v1/auth/login | No | Login |
| POST | /api/v1/auth/logout | Yes | Logout |
| GET | /api/v1/auth/me | Yes | Get current user |
| GET | /api/v1/markets/pairs | No | All trading pairs with prices |
| GET | /api/v1/markets/currencies | No | All currencies |
| GET | /api/v1/markets/:symbol/price | No | Current price for pair |
| GET | /api/v1/markets/:symbol/orderbook | No | Order book depth |
| GET | /api/v1/markets/:symbol/candles | No | Candlestick data |
| POST | /api/v1/orders | Yes | Place order |
| DELETE | /api/v1/orders/:id | Yes | Cancel order |
| GET | /api/v1/orders | Yes | User's orders |
| GET | /api/v1/portfolio | Yes | Portfolio summary |
| GET | /api/v1/wallets | Yes | Wallet balances |
| POST | /api/v1/wallets/deposit | Yes | Simulate deposit |
| GET | /api/v1/transactions | Yes | Transaction history |

## WebSocket

Connect to `ws://localhost:3001/ws` (or via Vite proxy at `ws://localhost:5173/ws`).

```json
// Subscribe to price updates
{"type": "subscribe", "channels": ["ticker:BTC-USD"]}

// Receive price updates every 2 seconds
{"type": "prices", "data": {"BTC-USD": {"price": 65123.45, ...}}}
```

## Cleanup

```bash
docker-compose down      # Stop services
docker-compose down -v   # Stop and remove volumes
```
