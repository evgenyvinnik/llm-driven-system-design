# Design Stripe - Payment Processing Platform

A Stripe-like payment processing platform demonstrating payment APIs, financial ledger systems, and fraud prevention. This educational project focuses on building secure payment infrastructure with idempotency guarantees.

## Features

### Payment Processing
- Payment Intents API (create, confirm, capture, cancel)
- Customers and Payment Methods
- Refunds with ledger reconciliation
- Test card numbers for different scenarios

### Financial Operations
- Double-entry ledger system
- Processing fees (2.9% + 30c)
- Balance tracking and transactions
- Complete audit trail

### Webhooks
- Signed webhook delivery
- Exponential backoff retry
- Event logging and replay

### Security
- Idempotency keys for safe retries
- API key authentication
- Fraud risk scoring

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Database:** PostgreSQL
- **Cache/Queue:** Redis + BullMQ

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose

### Option 1: Docker Setup (Recommended)

1. **Start infrastructure services:**
   ```bash
   cd stripe
   docker-compose up -d
   ```

2. **Install backend dependencies:**
   ```bash
   cd backend
   cp .env.example .env
   npm install
   ```

3. **Seed the database with demo data:**
   ```bash
   npm run db:seed
   ```

4. **Start the backend server:**
   ```bash
   npm run dev
   ```

5. **In a new terminal, install and start the frontend:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

6. **Open your browser:**
   - Frontend Dashboard: http://localhost:5173
   - API Documentation: http://localhost:3001/docs

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

1. **PostgreSQL:**
   ```bash
   # macOS with Homebrew
   brew install postgresql@16
   brew services start postgresql@16
   createdb stripe_db
   psql -d stripe_db -f backend/src/db/init.sql
   ```

2. **Redis:**
   ```bash
   # macOS with Homebrew
   brew install redis
   brew services start redis
   ```

3. **Configure and run:**
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env if using non-default credentials
   npm install
   npm run db:seed
   npm run dev
   ```

## Demo Credentials

After seeding, use these credentials to log in:

- **API Key:** `sk_test_demo_merchant_key_12345`

Or create a new merchant account in the UI.

## Test Cards

| Card Number | Result |
|-------------|--------|
| 4242 4242 4242 4242 | Success |
| 4000 0000 0000 0002 | Card declined |
| 4000 0000 0000 9995 | Insufficient funds |
| 4000 0000 0000 0069 | Expired card |
| 4000 0000 0000 0127 | Incorrect CVC |
| 4100 0000 0000 0019 | Fraud detected |

## API Endpoints

### Payment Intents

```bash
# Create a payment intent
curl -X POST http://localhost:3001/v1/payment_intents \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345" \
  -H "Content-Type: application/json" \
  -d '{"amount": 2500, "currency": "usd"}'

# Confirm a payment intent
curl -X POST http://localhost:3001/v1/payment_intents/{id}/confirm \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345" \
  -H "Content-Type: application/json" \
  -d '{"payment_method": "{pm_id}"}'

# List payment intents
curl http://localhost:3001/v1/payment_intents \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345"
```

### Payment Methods

```bash
# Create a payment method
curl -X POST http://localhost:3001/v1/payment_methods \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "card",
    "card": {
      "number": "4242424242424242",
      "exp_month": 12,
      "exp_year": 2027,
      "cvc": "123"
    }
  }'
```

### Customers

```bash
# Create a customer
curl -X POST http://localhost:3001/v1/customers \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345" \
  -H "Content-Type: application/json" \
  -d '{"email": "customer@example.com", "name": "Test Customer"}'
```

### Refunds

```bash
# Create a refund
curl -X POST http://localhost:3001/v1/refunds \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345" \
  -H "Content-Type: application/json" \
  -d '{"payment_intent": "{pi_id}"}'
```

### Balance

```bash
# Get balance
curl http://localhost:3001/v1/balance \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345"

# Get balance summary
curl http://localhost:3001/v1/balance/summary \
  -H "Authorization: Bearer sk_test_demo_merchant_key_12345"
```

## Project Structure

```
stripe/
├── docker-compose.yml       # PostgreSQL and Redis
├── backend/
│   ├── src/
│   │   ├── index.js         # Express app entry
│   │   ├── routes/          # API routes
│   │   │   ├── paymentIntents.js
│   │   │   ├── customers.js
│   │   │   ├── paymentMethods.js
│   │   │   ├── refunds.js
│   │   │   ├── charges.js
│   │   │   ├── balance.js
│   │   │   ├── webhooks.js
│   │   │   └── merchants.js
│   │   ├── services/        # Business logic
│   │   │   ├── ledger.js    # Double-entry accounting
│   │   │   ├── fraud.js     # Risk scoring
│   │   │   ├── webhooks.js  # Webhook delivery
│   │   │   └── cardNetwork.js # Simulated card network
│   │   ├── middleware/      # Auth, idempotency
│   │   ├── db/              # Database connections
│   │   │   ├── init.sql     # Schema
│   │   │   ├── pool.js      # PostgreSQL
│   │   │   ├── redis.js     # Redis
│   │   │   └── seed.js      # Demo data
│   │   └── utils/           # Helpers
│   └── package.json
└── frontend/
    ├── src/
    │   ├── routes/          # Pages
    │   ├── components/      # UI components
    │   ├── services/        # API client
    │   ├── stores/          # Zustand state
    │   ├── types/           # TypeScript types
    │   └── utils/           # Helpers
    └── package.json
```

## Key Technical Concepts

### Idempotency

All mutating endpoints support idempotency keys:

```bash
curl -X POST http://localhost:3001/v1/payment_intents \
  -H "Idempotency-Key: unique-request-id" \
  -H "Authorization: Bearer sk_test_..." \
  -d '{"amount": 2500}'
```

Same key returns the same response, preventing duplicate charges.

### Double-Entry Ledger

Every financial transaction creates balanced ledger entries:

```
Charge $100:
  DR Funds Receivable    $100.00
  CR Merchant Payable    $ 97.10
  CR Revenue: Fees       $  2.90
```

### Webhook Signatures

Webhooks are signed for verification:

```
Stripe-Signature: t=1234567890,v1=abc123...
```

Merchants can verify using HMAC-SHA256 with their webhook secret.

## Development

### Running Multiple Instances

```bash
# Terminal 1
PORT=3001 npm run dev

# Terminal 2
PORT=3002 npm run dev

# Terminal 3
PORT=3003 npm run dev
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Server port |
| POSTGRES_HOST | localhost | PostgreSQL host |
| POSTGRES_PORT | 5432 | PostgreSQL port |
| POSTGRES_USER | stripe | PostgreSQL user |
| POSTGRES_PASSWORD | stripe_dev_password | PostgreSQL password |
| POSTGRES_DB | stripe_db | PostgreSQL database |
| REDIS_URL | redis://localhost:6379 | Redis URL |
| PROCESSING_FEE_PERCENT | 2.9 | Fee percentage |
| PROCESSING_FEE_FIXED | 30 | Fixed fee in cents |

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
