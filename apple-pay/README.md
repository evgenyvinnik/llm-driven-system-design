# Design Apple Pay - Secure Mobile Payments

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,502 |
| Source Files | 46 |
| .ts | 2,314 |
| .tsx | 1,612 |
| .md | 1,144 |
| .json | 133 |
| .sql | 120 |

## Overview

A simplified Apple Pay-like platform demonstrating secure tokenized payments, NFC transactions, and biometric authentication. This educational project focuses on building a mobile payment system with hardware security integration.

## Key Features

### 1. Card Tokenization
- Card provisioning with device-specific tokens
- Simulated Token Service Provider (TSP) integration
- Dynamic Device PAN (DPAN) generation
- Token lifecycle management (suspend, reactivate, remove)

### 2. Payment Methods
- In-app payments with biometric authentication
- Simulated NFC contactless payments
- Web checkout simulation
- Payment session management

### 3. Security
- Simulated Secure Element storage
- Biometric authentication (Face ID/Touch ID simulation)
- Device-specific tokens
- Payment cryptogram generation
- Luhn algorithm validation

### 4. Merchant Integration
- Payment session creation
- Transaction processing
- Refund handling
- Transaction history

## Tech Stack

- **Frontend:** TypeScript, Vite, React 19, Tanstack Router, Zustand, Tailwind CSS
- **Backend:** Node.js, Express, TypeScript
- **Database:** PostgreSQL
- **Cache:** Redis
- **Containerization:** Docker Compose

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Option 1: Docker Setup (Recommended)

```bash
# Clone and navigate to project
cd apple-pay

# Start infrastructure (PostgreSQL + Redis)
docker-compose up -d

# Install backend dependencies
cd backend
npm install

# Start backend server
npm run dev
# Server runs on http://localhost:3000

# In another terminal, install frontend dependencies
cd frontend
npm install

# Start frontend dev server
npm run dev
# App runs on http://localhost:5173
```

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

#### PostgreSQL Setup
```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16

# Create database and user
createdb applepay
psql -d applepay -c "CREATE USER applepay WITH PASSWORD 'applepay_secret';"
psql -d applepay -c "GRANT ALL PRIVILEGES ON DATABASE applepay TO applepay;"
psql -d applepay -c "GRANT ALL ON SCHEMA public TO applepay;"

# Initialize schema
psql -U applepay -d applepay -f backend/src/db/init.sql
```

#### Redis Setup
```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

#### Run the Application
```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

### Environment Variables (Optional)

Create `.env` files if using non-default settings:

**backend/.env**
```env
PORT=3000
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=applepay
POSTGRES_PASSWORD=applepay_secret
POSTGRES_DB=applepay
REDIS_HOST=localhost
REDIS_PORT=6379
FRONTEND_URL=http://localhost:5173
```

## Usage

### Demo Account

Pre-configured demo account:
- **Email:** demo@example.com
- **Password:** demo123

### Adding Cards

Test card numbers that work with Luhn validation:
- **Visa:** 4111111111111111
- **Mastercard:** 5555555555554444
- **Amex:** 378282246310005

### Making Payments

1. Go to the **Pay** tab
2. Select a card
3. Choose a merchant
4. Enter an amount
5. Click "Pay with Apple Pay"
6. Complete biometric simulation

### Test Scenarios

Special amounts for testing:
- **$666.66** - Insufficient funds
- **$999.99** - Card declined
- **>$10,000** - Transaction limit exceeded

## API Endpoints

### Authentication
```
POST /api/auth/login       - Login
POST /api/auth/register    - Register new user
POST /api/auth/logout      - Logout
GET  /api/auth/me          - Get current user
POST /api/auth/devices     - Register device
GET  /api/auth/devices     - List devices
```

### Cards
```
GET  /api/cards            - List user's cards
POST /api/cards            - Provision new card
GET  /api/cards/:id        - Get card details
POST /api/cards/:id/suspend    - Suspend card
POST /api/cards/:id/reactivate - Reactivate card
POST /api/cards/:id/default    - Set as default
DELETE /api/cards/:id          - Remove card
```

### Payments
```
POST /api/payments/biometric/initiate  - Start biometric auth
POST /api/payments/biometric/verify    - Verify biometric
POST /api/payments/biometric/simulate  - Simulate success (demo)
POST /api/payments/pay                 - Process payment
GET  /api/payments/transactions        - List transactions
GET  /api/payments/transactions/:id    - Get transaction
```

### Merchants
```
GET  /api/merchants                    - List merchants
GET  /api/merchants/:id                - Get merchant
POST /api/merchants/:id/sessions       - Create payment session
POST /api/merchants/:id/process        - Process payment
POST /api/merchants/:id/refund         - Refund transaction
GET  /api/merchants/:id/transactions   - Merchant transactions
```

## Project Structure

```
apple-pay/
├── docker-compose.yml      # PostgreSQL + Redis
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts        # Express server
│       ├── db/
│       │   ├── index.ts    # PostgreSQL connection
│       │   ├── redis.ts    # Redis connection
│       │   └── init.sql    # Schema
│       ├── middleware/
│       │   └── auth.ts     # Auth middleware
│       ├── routes/
│       │   ├── auth.ts     # Auth routes
│       │   ├── cards.ts    # Card routes
│       │   ├── payments.ts # Payment routes
│       │   └── merchants.ts # Merchant routes
│       ├── services/
│       │   ├── auth.ts         # Auth service
│       │   ├── tokenization.ts # Card tokenization
│       │   ├── payment.ts      # Payment processing
│       │   └── biometric.ts    # Biometric auth
│       ├── types/
│       │   └── index.ts    # TypeScript types
│       └── utils/
│           └── crypto.ts   # Crypto utilities
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx        # App entry
        ├── index.css       # Global styles
        ├── components/     # UI components
        ├── routes/         # Page routes
        ├── stores/         # Zustand stores
        ├── services/       # API client
        └── types/          # TypeScript types
```

## Key Technical Challenges

1. **Tokenization**: Secure token generation simulating network TSP integration
2. **Security**: Simulated hardware-backed key storage in Secure Element
3. **Biometric**: Face ID/Touch ID authentication flow simulation
4. **Cryptograms**: Dynamic per-transaction cryptogram generation
5. **Privacy**: Merchant never sees real card number (only token)

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.

## Running Multiple Backend Instances

For load balancing testing:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Troubleshooting

### Docker Issues
```bash
# Reset containers and volumes
docker-compose down -v
docker-compose up -d
```

### Database Connection Issues
```bash
# Check if PostgreSQL is running
docker-compose ps
# or
brew services list | grep postgresql
```

### Redis Connection Issues
```bash
# Check if Redis is responding
redis-cli ping
```

## Implementation Status

- [x] Initial architecture design
- [x] Card tokenization
- [x] In-app payments with biometric
- [x] Transaction processing
- [x] Merchant integration demo
- [x] Frontend implementation
- [ ] NFC payment simulation
- [ ] Admin dashboard
- [ ] Fraud detection simulation

## References & Inspiration

- [Apple Pay Security and Privacy Overview](https://support.apple.com/en-us/HT203027) - Apple's documentation on Apple Pay security architecture
- [Apple Pay Developer Documentation](https://developer.apple.com/documentation/passkit/apple_pay) - PassKit integration for Apple Pay
- [EMV Payment Tokenization Specification](https://www.emvco.com/emv-technologies/payment-tokenisation/) - Industry standard for payment token generation
- [Secure Element Overview](https://developer.apple.com/documentation/security/certificate_key_and_trust_services) - Hardware-backed key storage on Apple devices
- [NFC Payment Standards (ISO 14443)](https://www.iso.org/standard/70121.html) - Contactless payment communication protocols
- [PCI DSS Compliance Guide](https://www.pcisecuritystandards.org/) - Payment Card Industry Data Security Standard
- [Google Pay Architecture](https://developers.google.com/pay/api/web/overview) - Comparison mobile payment platform design
