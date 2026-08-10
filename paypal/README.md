# PayPal - P2P Payment Platform

A peer-to-peer payment platform with double-entry bookkeeping, idempotent payment processing, optimistic locking for wallet balances, and money request workflows.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,178 |
| Source Files | 69 |
| .ts | 1,881 |
| .tsx | 1,467 |
| .md | 1,384 |
| .json | 160 |
| .sql | 141 |


## Features

- **Wallet Management** -- Deposit, withdraw, and view balance
- **P2P Transfers** -- Send money to other users with double-entry ledger
- **Money Requests** -- Request money from users, pay or decline incoming requests
- **Payment Methods** -- Link and manage bank accounts and cards
- **Transaction History** -- Full activity feed with type filtering
- **Idempotent Payments** -- Safe retries with client-generated idempotency keys

## Architecture

- **Frontend:** React 19 + TypeScript + Vite + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL 16 (users, wallets, transactions, ledger, requests)
- **Cache/Sessions:** Valkey (Redis-compatible)
- **Monitoring:** Prometheus metrics + Pino structured logging

## Prerequisites

- Node.js >= 20.0.0
- Docker Desktop (recommended) or native PostgreSQL + Valkey/Redis

## Quick Start

### Option A: Docker Compose (Recommended)

```bash
# Start PostgreSQL and Valkey
docker-compose up -d

# Install backend dependencies and run migrations
cd backend
npm install
npm run db:migrate

# Start backend
npm run dev

# In another terminal, install and start frontend
cd frontend
npm install
npm run dev
```

### Option B: Native Installation (No Docker)

**PostgreSQL:**
```bash
brew install postgresql@16
brew services start postgresql@16
createdb paypal
psql paypal -c "CREATE USER paypal WITH PASSWORD 'paypal123';"
psql paypal -c "GRANT ALL PRIVILEGES ON DATABASE paypal TO paypal;"
psql paypal -c "GRANT ALL ON SCHEMA public TO paypal;"
```

**Valkey/Redis:**
```bash
brew install valkey
brew services start valkey
# Verify: redis-cli ping → PONG
```

Then follow the same backend/frontend setup steps as Option A.

## Environment Variables

All have sensible defaults for local development:

```bash
DATABASE_URL=postgresql://paypal:paypal123@localhost:5432/paypal
REDIS_URL=redis://localhost:6379
PORT=3001
SESSION_SECRET=paypal-dev-secret-change-in-production
CORS_ORIGIN=http://localhost:5173
```

## Available Scripts

### Backend
```bash
npm run dev          # Start with hot reload (port 3001)
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
npm run db:migrate   # Run database migrations
npm run build        # TypeScript compilation
npm run test         # Run tests
npm run lint         # ESLint
npm run format       # Prettier
```

### Frontend
```bash
npm run dev          # Start Vite dev server (port 5173)
npm run build        # Production build
npm run type-check   # TypeScript type checking
npm run lint         # ESLint
npm run format       # Prettier
```

## Default Development Credentials

| Service | Username | Password | Database |
|---------|----------|----------|----------|
| PostgreSQL | paypal | paypal123 | paypal |
| Valkey/Redis | - | - | (no auth) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Register (creates wallet) |
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Logout |
| GET | /api/auth/me | Current user |
| GET | /api/wallet | Get balance |
| POST | /api/wallet/deposit | Deposit funds |
| POST | /api/wallet/withdraw | Withdraw funds |
| POST | /api/transfers | Send money (P2P) |
| GET | /api/transfers | Transaction history |
| POST | /api/requests | Request money |
| GET | /api/requests | List requests |
| POST | /api/requests/:id/pay | Pay request |
| POST | /api/requests/:id/decline | Decline request |
| GET | /api/payment-methods | List methods |
| POST | /api/payment-methods | Add method |
| DELETE | /api/payment-methods/:id | Remove method |
| GET | /api/users/search?q= | Search users |

## Testing the Payment Flow

1. Register two users (e.g., alice and bob)
2. Log in as alice
3. Deposit some money into alice's wallet
4. Send money to bob
5. Log in as bob to verify receipt
6. Bob requests money from alice
7. Log in as alice and pay the request

## Key Design Patterns

- **Double-Entry Bookkeeping**: Every transfer creates debit + credit ledger entries
- **Optimistic Locking**: Wallet version column prevents concurrent modification
- **Idempotency Keys**: Stored atomically with the payment transaction
- **Deadlock Prevention**: Wallet locks acquired in consistent user_id order
