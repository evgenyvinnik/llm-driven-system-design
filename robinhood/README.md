# Robinhood - Stock Trading Platform

A full-stack stock trading platform with real-time quotes, portfolio tracking, order execution simulation, watchlists, and price alerts.

## Features

- Real-time stock quotes with WebSocket streaming
- Portfolio tracking with P&L calculations
- Buy/sell order placement (market and limit orders)
- Order execution simulation
- Watchlists with live price updates
- Price alerts (above/below target price)
- Session-based authentication

## Tech Stack

### Backend
- Node.js + Express
- WebSocket (ws library)
- PostgreSQL (data persistence)
- Redis (quote caching, pub/sub, sessions)
- TypeScript

### Frontend
- React 19
- Vite
- Tanstack Router
- Zustand (state management)
- Tailwind CSS
- TypeScript

## Prerequisites

- Node.js 18+ (or 20+)
- Docker and Docker Compose
- npm or yarn

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
cd robinhood
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

The database is automatically initialized with the schema and demo data.

### 2. Start Backend

```bash
cd backend
npm install
npm run dev
```

The backend starts on http://localhost:3001

### 3. Start Frontend

In a new terminal:

```bash
cd frontend
npm install
npm run dev
```

The frontend starts on http://localhost:5173

### 4. Open the Application

Navigate to http://localhost:5173 in your browser.

**Demo Credentials:**
- Email: demo@example.com
- Password: password

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

## Project Structure

```
robinhood/
├── docker-compose.yml           # PostgreSQL + Redis
├── backend/
│   ├── src/
│   │   ├── index.ts             # Express server entry point
│   │   ├── config.ts            # Configuration
│   │   ├── database.ts          # PostgreSQL connection
│   │   ├── redis.ts             # Redis connection
│   │   ├── websocket.ts         # WebSocket handler
│   │   ├── routes/              # API routes
│   │   │   ├── auth.ts          # Login/register/logout
│   │   │   ├── quotes.ts        # Stock quotes
│   │   │   ├── orders.ts        # Order placement
│   │   │   ├── portfolio.ts     # Portfolio data
│   │   │   └── watchlists.ts    # Watchlists & alerts
│   │   ├── services/            # Business logic
│   │   │   ├── quoteService.ts  # Mock quote generation
│   │   │   ├── orderService.ts  # Order execution
│   │   │   ├── portfolioService.ts
│   │   │   └── watchlistService.ts
│   │   ├── middleware/
│   │   │   └── auth.ts          # Authentication middleware
│   │   └── types/
│   │       └── index.ts         # TypeScript types
│   └── scripts/
│       └── init.sql             # Database schema
│
└── frontend/
    ├── src/
    │   ├── main.tsx             # React entry point
    │   ├── router.ts            # Tanstack Router config
    │   ├── routes/              # Page components
    │   │   ├── __root.tsx       # Root layout
    │   │   ├── index.tsx        # Portfolio (home)
    │   │   ├── login.tsx        # Login page
    │   │   ├── register.tsx     # Registration page
    │   │   ├── stocks.tsx       # Stock list
    │   │   ├── stock.$symbol.tsx # Stock detail page
    │   │   ├── orders.tsx       # Order history
    │   │   └── watchlist.tsx    # Watchlist management
    │   ├── components/          # Reusable components
    │   │   ├── Header.tsx
    │   │   ├── Portfolio.tsx
    │   │   ├── QuoteDisplay.tsx
    │   │   ├── TradeForm.tsx
    │   │   └── Watchlist.tsx
    │   ├── stores/              # Zustand stores
    │   │   ├── authStore.ts
    │   │   ├── quoteStore.ts
    │   │   └── portfolioStore.ts
    │   ├── services/            # API clients
    │   │   ├── api.ts
    │   │   └── websocket.ts
    │   └── types/
    │       └── index.ts
    └── index.html
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/register` - Register
- `POST /api/auth/logout` - Logout

### Quotes
- `GET /api/quotes` - Get all quotes
- `GET /api/quotes/:symbol` - Get single quote
- `GET /api/quotes/stocks` - List all available stocks
- `GET /api/quotes/:symbol/details` - Get stock details

### Portfolio
- `GET /api/portfolio` - Get portfolio summary
- `GET /api/portfolio/positions` - Get all positions
- `GET /api/portfolio/account` - Get account info

### Orders
- `GET /api/orders` - List orders
- `POST /api/orders` - Place order
- `DELETE /api/orders/:id` - Cancel order

### Watchlists
- `GET /api/watchlists` - List watchlists
- `POST /api/watchlists` - Create watchlist
- `POST /api/watchlists/:id/items` - Add stock to watchlist
- `DELETE /api/watchlists/:id/items/:symbol` - Remove stock

### Alerts
- `GET /api/watchlists/alerts` - List alerts
- `POST /api/watchlists/alerts` - Create alert
- `DELETE /api/watchlists/alerts/:id` - Delete alert

## WebSocket

Connect to `ws://localhost:3001/ws?token=YOUR_TOKEN` for real-time updates.

**Messages:**
```json
// Subscribe to symbols
{ "type": "subscribe", "symbols": ["AAPL", "GOOGL"] }

// Unsubscribe
{ "type": "unsubscribe", "symbols": ["AAPL"] }

// Subscribe to all
{ "type": "subscribe_all" }

// Incoming quote updates
{ "type": "quotes", "data": [...] }
```

## Stock Simulation

The platform includes 20 simulated stocks with realistic price movements:

| Symbol | Company |
|--------|---------|
| AAPL | Apple Inc. |
| GOOGL | Alphabet Inc. |
| MSFT | Microsoft Corporation |
| AMZN | Amazon.com Inc. |
| TSLA | Tesla Inc. |
| META | Meta Platforms Inc. |
| NVDA | NVIDIA Corporation |
| JPM | JPMorgan Chase & Co. |
| V | Visa Inc. |
| JNJ | Johnson & Johnson |
| ... | ... |

Prices update every second with configurable volatility.

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
  - [x] Real-time quote simulation
  - [x] WebSocket streaming
  - [x] Order placement and execution
  - [x] Portfolio tracking
  - [x] Watchlists
  - [x] Price alerts
- [x] Database/Storage layer
- [x] API endpoints
- [x] Frontend views
- [ ] Testing
- [ ] Performance optimization
- [ ] Documentation

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## License

MIT
