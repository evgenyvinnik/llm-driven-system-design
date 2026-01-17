# Payment System

A transaction processing and payment platform with double-entry bookkeeping, idempotency support, and a merchant dashboard.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,389 |
| Source Files | 44 |
| .ts | 2,788 |
| .tsx | 1,552 |
| .md | 702 |
| .json | 133 |
| .sql | 131 |

## Overview

This project implements a payment processing system similar to Stripe, featuring:

- **Payment Processing** - Accept and process payments with idempotency support
- **Double-Entry Ledger** - Every transaction creates balanced ledger entries
- **Refunds** - Full and partial refunds with proper accounting
- **Fraud Detection** - Rule-based risk scoring for transactions
- **Merchant Dashboard** - View transactions, statistics, and manage payments

## Key Features

- Idempotent payment creation (retry-safe)
- Two-phase payments (authorize then capture)
- Double-entry bookkeeping for all financial operations
- Transaction status management (pending, authorized, captured, refunded, voided)
- Platform fee calculation and tracking
- Basic fraud scoring

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer (PostgreSQL + Redis)
- [x] API endpoints
- [x] Frontend dashboard
- [ ] Comprehensive testing
- [ ] Performance optimization
- [ ] Full documentation

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- Docker and Docker Compose
- npm or yarn

### Option 1: Docker Setup (Recommended)

1. **Start the infrastructure:**

```bash
cd payment-system
docker-compose up -d
```

This starts PostgreSQL and Redis with the database schema automatically initialized.

2. **Setup and run the backend:**

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

The API server will start on http://localhost:3000

3. **Setup and run the frontend:**

```bash
cd frontend
npm install
npm run dev
```

The frontend will start on http://localhost:5173

### Option 2: Native Services Setup

If you prefer to run PostgreSQL and Redis natively:

1. **Install and start PostgreSQL:**

```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16

# Create database
createdb payment_db
createuser payment_user -P  # Set password: payment_pass
psql -d payment_db -c "GRANT ALL PRIVILEGES ON DATABASE payment_db TO payment_user;"
```

2. **Install and start Redis:**

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

3. **Initialize the database schema:**

```bash
psql -U payment_user -d payment_db -f backend/src/db/init.sql
```

4. **Continue with steps 2-3 from the Docker setup above.**

## Running the Service

### Development Mode

```bash
# Terminal 1: Start infrastructure
docker-compose up -d

# Terminal 2: Start backend
cd backend && npm run dev

# Terminal 3: Start frontend
cd frontend && npm run dev
```

### Running Multiple Backend Instances

For testing load balancing or distributed scenarios:

```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

## API Endpoints

### Health Check
- `GET /health` - Server health status

### Merchants (Public)
- `POST /api/v1/merchants` - Create a new merchant account

### Merchants (Authenticated)
- `GET /api/v1/merchants/me` - Get current merchant profile
- `GET /api/v1/merchants/me/stats` - Get dashboard statistics
- `GET /api/v1/merchants/me/volume` - Get volume over time
- `PATCH /api/v1/merchants/me/webhook` - Update webhook URL
- `POST /api/v1/merchants/me/rotate-key` - Rotate API key

### Payments
- `POST /api/v1/payments` - Create a payment
- `GET /api/v1/payments` - List payments
- `GET /api/v1/payments/:id` - Get payment details
- `POST /api/v1/payments/:id/capture` - Capture authorized payment
- `POST /api/v1/payments/:id/void` - Void authorized payment
- `POST /api/v1/payments/:id/refund` - Refund captured payment
- `GET /api/v1/payments/:id/refunds` - Get refunds for payment
- `GET /api/v1/payments/:id/ledger` - Get ledger entries for payment

### Refunds
- `GET /api/v1/refunds` - List refunds
- `GET /api/v1/refunds/:id` - Get refund details

### Chargebacks
- `GET /api/v1/chargebacks` - List chargebacks
- `GET /api/v1/chargebacks/:id` - Get chargeback details

### Ledger
- `GET /api/v1/ledger/verify` - Verify ledger balance
- `GET /api/v1/ledger/summary` - Get ledger summary

## Authentication

All API endpoints (except merchant creation and health check) require API key authentication:

```bash
curl -H "Authorization: Bearer pk_your_api_key_here" \
     http://localhost:3000/api/v1/payments
```

### Idempotency

For payment creation and refunds, include an idempotency key:

```bash
curl -X POST \
     -H "Authorization: Bearer pk_your_api_key_here" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: unique_key_123" \
     -d '{"amount": 5000, "currency": "USD", "payment_method": {"type": "card", "card_brand": "visa", "last_four": "4242"}}' \
     http://localhost:3000/api/v1/payments
```

## Testing

### Create a Merchant

```bash
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{"name": "Test Store", "email": "test@example.com"}' \
     http://localhost:3000/api/v1/merchants
```

Save the returned `api_key` - you'll need it for authenticated requests.

### Create a Payment

```bash
curl -X POST \
     -H "Authorization: Bearer pk_your_api_key" \
     -H "Content-Type: application/json" \
     -d '{
       "amount": 5000,
       "currency": "USD",
       "payment_method": {
         "type": "card",
         "card_brand": "visa",
         "last_four": "4242",
         "exp_month": 12,
         "exp_year": 2025
       },
       "description": "Test order #123",
       "customer_email": "customer@example.com"
     }' \
     http://localhost:3000/api/v1/payments
```

### Test Decline

Use last_four: "0000" to simulate a declined payment.

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Project Structure

```
payment-system/
├── backend/
│   ├── src/
│   │   ├── db/           # Database connection and schema
│   │   ├── middleware/   # Express middleware (auth, logging)
│   │   ├── routes/       # API route handlers
│   │   ├── services/     # Business logic services
│   │   ├── types/        # TypeScript type definitions
│   │   └── index.ts      # Express app entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── routes/       # Tanstack Router pages
│   │   ├── services/     # API client
│   │   ├── stores/       # Zustand state management
│   │   ├── types/        # TypeScript types
│   │   └── utils/        # Helper functions
│   ├── package.json
│   └── vite.config.ts
├── docker-compose.yml    # PostgreSQL + Redis
├── architecture.md       # System design documentation
├── claude.md            # Development notes
└── README.md            # This file
```

## Future Enhancements

- Webhook delivery system
- Multi-currency support with real-time conversion
- Settlement processing
- Enhanced fraud detection with ML models
- Comprehensive test suite
- Performance monitoring with Prometheus/Grafana

## References & Inspiration

- [Saga Pattern for Microservices](https://microservices.io/patterns/data/saga.html) - Chris Richardson's guide to managing distributed transactions
- [PCI DSS Quick Reference Guide](https://www.pcisecuritystandards.org/document_library/) - Payment Card Industry Data Security Standards
- [Avoiding Double Payments in Distributed Systems](https://medium.com/airbnb-engineering/avoiding-double-payments-in-a-distributed-payments-system-2981f6b070bb) - Airbnb's battle-tested patterns
- [Building a Modern Payment System](https://www.moderntreasury.com/learn/payment-operations) - Modern Treasury's guide to payment operations
- [Eventual Consistency in Payment Systems](https://www.uber.com/blog/money-scale-strong-data/) - Uber's approach to financial data integrity
- [Implementing Event Sourcing for Financial Ledgers](https://www.eventstore.com/blog/event-sourcing-and-cqrs) - Event sourcing patterns for audit trails
- [Two-Phase Commit vs Saga](https://www.baeldung.com/cs/saga-pattern-microservices) - Comparing distributed transaction approaches
- [Designing Webhooks for Payment Systems](https://stripe.com/docs/webhooks/best-practices) - Best practices for reliable webhook delivery
