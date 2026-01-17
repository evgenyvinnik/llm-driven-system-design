# Design Airbnb - Two-Sided Marketplace

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,017 |
| Source Files | 50 |
| .tsx | 3,052 |
| .js | 1,981 |
| .md | 977 |
| .ts | 618 |
| .sql | 239 |

## Overview

A simplified Airbnb-like platform demonstrating two-sided marketplace dynamics, availability calendars, search ranking, and trust & safety systems. This educational project focuses on building a property rental marketplace with complex booking workflows.

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Database:** PostgreSQL with PostGIS extension
- **Cache:** Redis
- **Containerization:** Docker Compose

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
# Start PostgreSQL (with PostGIS) and Redis
docker-compose up -d

# Verify containers are running
docker-compose ps
```

### 2. Start Backend

```bash
cd backend
npm install
npm run seed  # Seed database with sample data
npm run dev   # Start on port 3000
```

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev   # Start on port 5173
```

### 4. Access the Application

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3000/api

### Sample Login Credentials

| Role   | Email                  | Password     |
|--------|------------------------|--------------|
| Host   | host1@example.com      | password123  |
| Host   | host2@example.com      | password123  |
| Guest  | guest1@example.com     | password123  |
| Guest  | guest2@example.com     | password123  |
| Admin  | admin@example.com      | password123  |

## Key Features

### 1. Property Listings
- Host property management with photos
- Amenities and house rules
- Custom pricing per night
- Availability calendar management

### 2. Search & Discovery
- Location-based search using PostGIS
- Date availability filtering
- Price range and amenity filters
- Property type filtering

### 3. Booking System
- Availability calendar with date ranges
- Instant book vs request-to-book
- Double-booking prevention with database transactions
- Cancellation handling

### 4. Trust & Safety
- Two-sided reviews (hidden until both submit)
- Rating aggregation
- Host verification status

### 5. Messaging
- Host-guest communication
- Pre-booking inquiries
- Conversation threading

## Project Structure

```
airbnb/
├── docker-compose.yml      # PostgreSQL + Redis
├── backend/
│   ├── src/
│   │   ├── index.js        # Express server
│   │   ├── db.js           # PostgreSQL connection
│   │   ├── redis.js        # Redis connection
│   │   ├── routes/         # API endpoints
│   │   │   ├── auth.js
│   │   │   ├── listings.js
│   │   │   ├── search.js
│   │   │   ├── bookings.js
│   │   │   ├── reviews.js
│   │   │   └── messages.js
│   │   ├── services/       # Business logic
│   │   └── middleware/     # Auth middleware
│   └── migrations/
│       └── init.sql        # Database schema
├── frontend/
│   ├── src/
│   │   ├── routes/         # Tanstack Router pages
│   │   ├── components/     # React components
│   │   ├── stores/         # Zustand stores
│   │   ├── services/       # API client
│   │   └── types/          # TypeScript types
│   └── index.html
├── architecture.md
├── claude.md
└── README.md
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `POST /api/auth/become-host` - Become a host

### Listings
- `GET /api/listings` - Get all listings
- `GET /api/listings/:id` - Get listing by ID
- `POST /api/listings` - Create listing (host only)
- `PUT /api/listings/:id` - Update listing
- `GET /api/listings/:id/availability` - Get availability
- `PUT /api/listings/:id/availability` - Update availability

### Search
- `GET /api/search` - Search listings with filters
- `GET /api/search/suggest` - Location suggestions
- `GET /api/search/popular-destinations` - Popular destinations

### Bookings
- `GET /api/bookings/check-availability` - Check dates
- `POST /api/bookings` - Create booking
- `GET /api/bookings/my-trips` - Guest's bookings
- `GET /api/bookings/host-reservations` - Host's reservations
- `PUT /api/bookings/:id/respond` - Accept/decline
- `PUT /api/bookings/:id/cancel` - Cancel booking

### Reviews
- `POST /api/reviews` - Create review
- `GET /api/reviews/listing/:id` - Get listing reviews

### Messages
- `POST /api/messages/start` - Start conversation
- `GET /api/messages` - Get conversations
- `GET /api/messages/:id` - Get messages
- `POST /api/messages/:id/messages` - Send message

## Multi-Instance Testing

Run multiple backend instances for load testing:

```bash
# Terminal 1
PORT=3001 npm run dev

# Terminal 2
PORT=3002 npm run dev

# Terminal 3
PORT=3003 npm run dev
```

## Key Technical Challenges

1. **Availability Calendar**: Date ranges stored as blocks with overlap detection
2. **Search Ranking**: PostGIS for geographic queries with availability filtering
3. **Double-Booking Prevention**: Database transactions with row-level locking
4. **Two-Sided Reviews**: Visibility triggered when both parties submit
5. **Geographic Search**: GIST index on PostGIS geography column

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [Airbnb's Search Ranking Algorithm](https://medium.com/airbnb-engineering/listing-search-ranking-at-airbnb-4ab8ec5d76fb) - How Airbnb ranks search results using machine learning
- [Improving Deep Learning for Airbnb Search](https://medium.com/airbnb-engineering/improving-deep-learning-for-airbnb-search-5fb2c22ec31e) - Deep learning approaches for personalized search ranking
- [Dynamic Pricing at Airbnb](https://medium.com/airbnb-engineering/dynamic-pricing-1a82fbb21f14) - Airbnb's Smart Pricing system for hosts
- [Building a Trustworthy Marketplace](https://medium.com/airbnb-engineering/building-a-trustworthy-marketplace-60b3b0df2fc4) - Trust and safety systems at scale
- [Machine Learning-Powered Search Ranking of Airbnb Experiences](https://medium.com/airbnb-engineering/machine-learning-powered-search-ranking-of-airbnb-experiences-110b4b1a0789) - ML for experiences ranking
- [How Airbnb Avoids Double Payments](https://medium.com/airbnb-engineering/avoiding-double-payments-in-a-distributed-payments-system-2981f6b070bb) - Idempotency in payment systems
- [Chronon, Airbnb's ML Feature Platform](https://medium.com/airbnb-engineering/chronon-airbnbs-ml-feature-platform-is-now-open-source-d9c4dba859e8) - Feature engineering for ML models
- [Nebula: Airbnb's Data Marketplace](https://medium.com/airbnb-engineering/data-quality-at-airbnb-e582465f3ef7) - Data quality and governance at Airbnb
