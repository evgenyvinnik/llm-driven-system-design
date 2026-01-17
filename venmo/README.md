# Design Venmo - P2P Payment Platform

A simplified Venmo-like platform demonstrating peer-to-peer payments, social feeds, and instant money transfers. This educational project focuses on building a social payment network with balance management and multi-source funding.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,562 |
| Source Files | 46 |
| .tsx | 1,969 |
| .js | 1,888 |
| .md | 1,107 |
| .ts | 450 |
| .json | 88 |

## Features

### Core Functionality
- **P2P Payments**: Send money to friends with atomic balance transfers
- **Payment Requests**: Request money from others with pay/decline flow
- **Social Feed**: View transaction activity with fan-out-on-write architecture
- **Wallet Management**: Track balance, link bank accounts, cash out

### Technical Highlights
- Atomic transfers with PostgreSQL transactions and row-level locking
- Fan-out-on-write social feed for fast reads
- Multi-source funding waterfall (Balance -> Bank -> Card)
- Session-based authentication with Redis
- Real-time balance cache invalidation

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express
- **Database**: PostgreSQL (primary data), Redis (sessions, caching)
- **Infrastructure**: Docker Compose

## Quick Start

### Prerequisites
- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd venmo
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

### 2. Setup Backend

```bash
cd backend
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

The API server runs on http://localhost:3000

### 3. Setup Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs on http://localhost:5173

### 4. Login

Demo users are created by the seed script:
- **alice** / password123 (Balance: $500)
- **bob** / password123 (Balance: $250)
- **charlie** / password123 (Balance: $100)
- **diana** / password123 (Balance: $100)
- **admin** / password123 (Admin user)

All demo users are already friends with each other and have some sample transactions.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `GET /api/auth/search?q=` - Search users

### Transfers
- `POST /api/transfers/send` - Send money
- `GET /api/transfers/:id` - Get transfer details
- `POST /api/transfers/:id/like` - Like a transfer
- `DELETE /api/transfers/:id/like` - Unlike a transfer
- `POST /api/transfers/:id/comments` - Add comment

### Requests
- `POST /api/requests` - Create payment request
- `GET /api/requests/sent` - Get sent requests
- `GET /api/requests/received` - Get received requests
- `POST /api/requests/:id/pay` - Pay a request
- `POST /api/requests/:id/decline` - Decline a request
- `POST /api/requests/:id/cancel` - Cancel a request

### Wallet
- `GET /api/wallet` - Get wallet details
- `GET /api/wallet/balance` - Get balance
- `GET /api/wallet/history` - Transaction history
- `POST /api/wallet/deposit` - Add money (demo)

### Payment Methods
- `GET /api/payment-methods` - List payment methods
- `POST /api/payment-methods/bank` - Link bank account
- `POST /api/payment-methods/card` - Add card
- `POST /api/payment-methods/:id/default` - Set default
- `DELETE /api/payment-methods/:id` - Remove method
- `POST /api/payment-methods/cashout` - Cash out

### Feed
- `GET /api/feed` - Friends feed
- `GET /api/feed/global` - Global public feed
- `GET /api/feed/user/:username` - User's transactions

### Friends
- `GET /api/friends` - List friends
- `GET /api/friends/requests` - Pending requests
- `POST /api/friends/request/:username` - Send request
- `POST /api/friends/accept/:username` - Accept request
- `POST /api/friends/decline/:username` - Decline request
- `DELETE /api/friends/:username` - Remove friend

## Project Structure

```
venmo/
├── docker-compose.yml      # PostgreSQL + Redis
├── backend/
│   ├── src/
│   │   ├── index.js        # Express server entry
│   │   ├── routes/         # API routes
│   │   │   ├── auth.js
│   │   │   ├── wallet.js
│   │   │   ├── transfers.js
│   │   │   ├── requests.js
│   │   │   ├── feed.js
│   │   │   ├── friends.js
│   │   │   └── paymentMethods.js
│   │   ├── services/       # Business logic
│   │   │   └── transfer.js # Atomic transfer service
│   │   ├── middleware/     # Auth middleware
│   │   └── db/             # Database connections
│   │       ├── pool.js     # PostgreSQL pool
│   │       ├── redis.js    # Redis client
│   │       ├── migrate.js  # Schema migrations
│   │       └── seed.js     # Demo data
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── main.tsx        # React entry
│   │   ├── routes/         # Tanstack Router pages
│   │   │   ├── __root.tsx
│   │   │   ├── index.tsx   # Feed page
│   │   │   ├── pay.tsx     # Send money
│   │   │   ├── request.tsx # Request money
│   │   │   ├── wallet.tsx  # Wallet management
│   │   │   ├── profile.tsx # User profile
│   │   │   ├── login.tsx
│   │   │   └── register.tsx
│   │   ├── components/     # Reusable UI
│   │   ├── stores/         # Zustand state
│   │   ├── services/       # API client
│   │   ├── types/          # TypeScript types
│   │   └── utils/          # Helpers
│   └── package.json
├── architecture.md         # System design docs
├── CLAUDE.md               # Development notes
└── README.md               # This file
```

## Key Design Decisions

### 1. Atomic Balance Transfers
Uses PostgreSQL transactions with `SELECT FOR UPDATE` to lock wallet rows during transfers, preventing race conditions and ensuring balance consistency.

### 2. Fan-Out-On-Write Feed
When a transaction occurs, it's pre-computed into all relevant users' feeds. This trades write amplification for fast reads.

### 3. Funding Waterfall
Automatic payment source selection: Venmo Balance -> Bank Account -> Card. Best UX without requiring user to choose each time.

### 4. Session-Based Auth
Simple Redis-backed sessions instead of JWT complexity. Appropriate for learning project scope.

## Running Multiple Backend Instances

For testing load balancing scenarios:

```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.

## License

Educational project - MIT License

## References & Inspiration

- [Building a Payment System](https://newsletter.pragmaticengineer.com/p/designing-a-payment-system) - Gergely Orosz's comprehensive guide to payment system design
- [PayPal Engineering Blog](https://medium.com/paypal-tech) - Technical insights from PayPal/Venmo engineering
- [How Venmo Built a Highly Available Real-Time Transaction System](https://www.infoq.com/presentations/venmo-real-time/) - Architecture of Venmo's real-time processing
- [Fan-out, Fan-in: Designing Social Feeds](https://www.mongodb.com/blog/post/schema-design-for-social-inboxes-in-mongodb) - Patterns for building activity feeds
- [Designing Instagram's Activity Feed](https://instagram-engineering.com/designing-instagrams-feed-b8c3eb9d95e6) - Instagram's approach to feed architecture
- [ACH Payment Processing Guide](https://www.nacha.org/rules) - Understanding bank transfer mechanics
- [The Architecture of Uber's Wallet](https://www.uber.com/blog/money-scale-strong-data/) - How Uber handles money at scale with strong data consistency
