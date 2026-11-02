# PayPal - P2P Payment Platform

A peer-to-peer payment platform with double-entry bookkeeping, idempotent payment processing, optimistic locking for wallet balances, and money request workflows.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,040 |
| Source Files | 84 |
| .ts | 3,117 |
| .tsx | 1,828 |
| .md | 1,517 |
| .sql | 237 |
| .json | 163 |


## Features

- **Wallet Management** -- Add money from or withdraw to a linked bank/card, view balance
- **P2P Transfers** -- Send money to other users with double-entry ledger
- **Money Requests** -- Request money from users, pay or decline incoming requests
- **Payment Methods** -- Link and manage bank accounts and cards
- **Transaction History** -- Full activity feed with type filtering
- **Idempotent Payments** -- Per-user `Idempotency-Key` on transfers, deposits and withdrawals; retries replay, never re-charge
- **Ledger Reconciliation** -- Admin page proving every transaction nets to zero and customer balances equal platform cash

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

# Install backend dependencies, run migrations, load demo data
cd backend
npm install
npm run db:migrate
docker exec -i paypal-postgres psql -U paypal -d paypal < db-seed/seed.sql

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

Then follow the same backend/frontend setup steps as Option A, loading the seed with
`psql postgresql://paypal:paypal123@localhost:5432/paypal -f backend/db-seed/seed.sql`.

## Environment Variables

All have sensible defaults for local development:

```bash
DATABASE_URL=postgresql://paypal:paypal123@localhost:5432/paypal
REDIS_URL=redis://localhost:6379
PORT=3001
SESSION_SECRET=paypal-dev-secret-change-in-production
CORS_ORIGIN=http://localhost:5173
RATE_LIMIT_API_PER_15MIN=1000     # all /api calls, per IP
RATE_LIMIT_AUTH_PER_15MIN=50      # login/register, per IP
RATE_LIMIT_MONEY_PER_MIN=30       # transfers, request payments, deposits, withdrawals, per user
```

The schema (`backend/src/db/init.sql`) upgrades older volumes in place, but the demo data
assumes a fresh database: `docker-compose down -v` before re-seeding if in doubt.

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

Seeded app users (password `password123`): `alice`, `bob`, `carol`, and `admin` (sees the Admin
reconciliation page).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Register (creates wallet) |
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Logout |
| GET | /api/auth/me | Current user |
| GET | /api/wallet | Get balance |
| POST | /api/wallet/deposit | Deposit from a linked payment method (`Idempotency-Key` optional) |
| POST | /api/wallet/withdraw | Withdraw to a linked payment method (`Idempotency-Key` optional) |
| POST | /api/transfers | Send money (P2P, `Idempotency-Key` optional) |
| GET | /api/transfers | Transaction history |
| POST | /api/requests | Request money |
| GET | /api/requests | List requests |
| POST | /api/requests/:id/pay | Pay request |
| POST | /api/requests/:id/decline | Decline request (payer) |
| POST | /api/requests/:id/cancel | Cancel request (requester) |
| GET | /api/payment-methods | List methods |
| POST | /api/payment-methods | Add method |
| DELETE | /api/payment-methods/:id | Remove method |
| PUT | /api/payment-methods/:id/default | Set default method |
| GET | /api/users/search?q= | Search users (name, username, exact email) |
| GET | /api/admin/reconciliation | Ledger reconciliation (admin) |

## Testing the Payment Flow

1. Log in as alice (seeded) or register a new user
2. New users: add a bank or card under Wallet, then use **Add money** on the dashboard
3. Send money to bob
4. Log in as bob to verify receipt
5. Bob requests money from alice; alice pays it from the dashboard (or bob cancels it from the Request page)
6. Log in as admin and open **Admin** to confirm the ledger still reconciles

## Key Design Patterns

- **Double-Entry Bookkeeping**: Every movement posts a balanced debit/credit pair; deposits and withdrawals post against a platform cash account
- **Optimistic Locking**: Deposits/withdrawals use a wallet version column with bounded retries
- **Idempotency Keys**: Claimed per user as the payment transaction's first statement, replayed on retry
- **Deadlock Prevention**: Transfers lock both wallets in one ordered `SELECT ... FOR UPDATE`
- **Row-locked Requests**: Paying a request locks it, so a double click can't pay twice
