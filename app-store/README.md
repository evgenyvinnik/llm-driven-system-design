# Design App Store - Application Marketplace

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,691 |
| Source Files | 54 |
| .ts | 3,369 |
| .tsx | 1,859 |
| .md | 1,154 |
| .json | 137 |
| .yml | 87 |

## Overview

A simplified App Store-like platform demonstrating app discovery, secure purchases, review systems, and ranking algorithms. This educational project focuses on building a digital marketplace with content moderation and personalized recommendations.

## Key Features

### 1. App Discovery
- Full-text search with Elasticsearch
- Category browsing and filtering
- Top charts (Free, Paid, New)
- Similar app recommendations

### 2. Ratings & Reviews
- Star ratings (1-5)
- Written reviews with titles
- Review integrity scoring (fake review detection)
- Developer responses to reviews
- Helpful/Not helpful voting

### 3. Developer Dashboard
- App submission and management
- App metadata editing
- Screenshot and icon uploads
- Analytics (downloads, ratings, revenue)
- Review management with response capability

### 4. User Management
- Registration and authentication
- Session-based auth with Redis
- Role-based access (user, developer, admin)

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL (primary data store)
- **Cache:** Redis (sessions, caching)
- **Search:** Elasticsearch (full-text search, app indexing)
- **Storage:** MinIO (app packages, screenshots, icons)

## Project Structure

```
app-store/
├── docker-compose.yml     # Infrastructure services
├── backend/
│   ├── src/
│   │   ├── config/        # Database, Redis, ES, MinIO clients
│   │   ├── controllers/   # Route handlers
│   │   ├── middleware/    # Auth, error handling
│   │   ├── routes/        # API routes
│   │   ├── services/      # Business logic
│   │   ├── types/         # TypeScript definitions
│   │   ├── scripts/       # Migration and seed scripts
│   │   └── index.ts       # Express app entry
│   └── package.json
└── frontend/
    ├── src/
    │   ├── components/    # Reusable UI components
    │   ├── routes/        # Tanstack Router pages
    │   ├── stores/        # Zustand state stores
    │   ├── services/      # API client
    │   └── types/         # TypeScript definitions
    └── package.json
```

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure Services

```bash
cd app-store
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- Elasticsearch on port 9200
- MinIO on ports 9000 (API) and 9001 (Console)

### 2. Set Up Backend

```bash
cd backend

# Copy environment file
cp .env.example .env

# Install dependencies
npm install

# Run database migrations
npm run migrate

# Seed sample data
npm run seed

# Start development server
npm run dev
```

The API will be available at `http://localhost:3000/api/v1`

### 3. Set Up Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

The frontend will be available at `http://localhost:5173`

### Demo Accounts

After running the seed script, these accounts are available:

| Email | Password | Role |
|-------|----------|------|
| admin@appstore.dev | admin123 | Admin |
| developer@appstore.dev | developer123 | Developer |
| user@appstore.dev | user123 | User |

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user
- `POST /api/v1/auth/become-developer` - Upgrade to developer

### Catalog
- `GET /api/v1/categories` - List categories
- `GET /api/v1/apps` - List apps with filtering
- `GET /api/v1/apps/top` - Get top charts
- `GET /api/v1/apps/search` - Search apps
- `GET /api/v1/apps/:id` - Get app details
- `POST /api/v1/apps/:id/download` - Record download

### Reviews
- `GET /api/v1/apps/:appId/reviews` - Get app reviews
- `GET /api/v1/apps/:appId/ratings` - Get rating summary
- `POST /api/v1/apps/:appId/reviews` - Create review
- `PUT /api/v1/reviews/:id` - Update review
- `DELETE /api/v1/reviews/:id` - Delete review
- `POST /api/v1/reviews/:id/vote` - Vote on review

### Developer
- `GET /api/v1/developer/apps` - List developer's apps
- `POST /api/v1/developer/apps` - Create new app
- `PUT /api/v1/developer/apps/:id` - Update app
- `POST /api/v1/developer/apps/:id/publish` - Publish app
- `GET /api/v1/developer/apps/:id/analytics` - Get app analytics

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

## Key Design Decisions

### 1. Bayesian Rating Average
Apps with few reviews use Bayesian averaging to prevent gaming with early 5-star reviews.

### 2. Review Integrity Scoring
ML-inspired scoring considers:
- Review velocity (too many reviews too fast = suspicious)
- Content quality (generic phrases, length, specificity)
- Account age
- Verified purchase status
- Coordination detection (review bombing)

### 3. Multi-Signal Ranking
Top charts combine:
- Download velocity (30%)
- Rating quality (25%)
- Engagement metrics (20%)
- Revenue (15%)
- Freshness (10%)

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) - Apple's official guidelines for app submission and approval
- [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi) - Apple's API for managing apps, in-app purchases, and analytics
- [StoreKit Documentation](https://developer.apple.com/documentation/storekit) - In-app purchases and subscriptions implementation
- [Google Play Console Help](https://support.google.com/googleplay/android-developer/) - Comparison platform for app distribution patterns
- [Detecting Fake Reviews with Machine Learning](https://arxiv.org/abs/2106.09757) - Research paper on review integrity and fraud detection
- [App Store Optimization Guide](https://developer.apple.com/app-store/search/) - Apple's guidance on app discoverability and search ranking
- [Rating and Review Guidelines](https://developer.apple.com/app-store/ratings-and-reviews/) - Best practices for encouraging authentic reviews
