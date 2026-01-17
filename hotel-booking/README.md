# Hotel Booking - Hotel Reservation and Management System

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,800 |
| Source Files | 55 |
| .tsx | 3,156 |
| .js | 2,464 |
| .md | 1,002 |
| .ts | 838 |
| .sql | 140 |

## Overview

A hotel reservation and management system with inventory management, dynamic pricing, and booking capabilities. This project implements a fully functional hotel booking platform similar to Booking.com or Expedia.

## Key Features

- **Hotel and Room Inventory Management** - Hotels can list properties with multiple room types, amenities, and photos
- **Search and Filtering** - Search hotels by location, dates, guests with filters for price, stars, and amenities
- **Booking System with Double-Booking Prevention** - Pessimistic locking ensures no overbooking
- **Availability Calendar** - Visual calendar showing room availability and pricing by date
- **Dynamic Pricing** - Set custom prices for specific dates (seasonal, events, etc.)
- **Reviews and Ratings** - Guests can review hotels after their stay
- **Hotel Admin Dashboard** - Property owners can manage hotels, rooms, and view bookings

## Technology Stack

### Backend
- **Runtime**: Node.js + Express
- **Database**: PostgreSQL (relational data, bookings, users)
- **Cache**: Redis (sessions, availability caching)
- **Search**: Elasticsearch (hotel search with geo and filters)

### Frontend
- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite
- **Routing**: TanStack Router
- **State Management**: Zustand
- **Styling**: Tailwind CSS

## Implementation Status

- [x] Initial architecture design
- [x] Database schema and migrations
- [x] Backend API endpoints
- [x] Hotel and room management
- [x] Search with Elasticsearch
- [x] Booking system with concurrency control
- [x] Frontend UI
- [x] Hotel admin dashboard
- [ ] Comprehensive testing
- [ ] Performance optimization

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Quick Start with Docker

1. **Start Infrastructure Services**
```bash
cd hotel-booking
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- Elasticsearch on port 9200

2. **Set Up Backend**
```bash
cd backend
cp .env.example .env
npm install
```

3. **Seed Sample Data**
```bash
npm run seed
```

This creates test accounts and sample hotels:
- **User**: user@hotel-booking.com / user123
- **Hotel Admin**: hotel@hotel-booking.com / hoteladmin123
- **Admin**: admin@hotel-booking.com / admin123

4. **Start Backend Server**
```bash
npm run dev
```
Backend runs on http://localhost:3001

5. **Set Up and Start Frontend**
```bash
cd ../frontend
npm install
npm run dev
```
Frontend runs on http://localhost:5173

### Running Multiple Backend Instances

For testing distributed scenarios:
```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

### Native Services (Without Docker)

If you prefer running services natively:

**PostgreSQL**
```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16
createdb hotel_booking
psql hotel_booking < backend/scripts/init.sql
```

**Redis**
```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

**Elasticsearch**
```bash
# macOS with Homebrew
brew tap elastic/tap
brew install elastic/tap/elasticsearch-full
elasticsearch
```

Update `.env` with your connection strings.

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Hotels
- `GET /api/v1/hotels/search` - Search hotels
- `GET /api/v1/hotels/:hotelId` - Get hotel details
- `POST /api/v1/hotels` - Create hotel (hotel admin)
- `PUT /api/v1/hotels/:hotelId` - Update hotel (owner)
- `DELETE /api/v1/hotels/:hotelId` - Delete hotel (owner)
- `GET /api/v1/hotels/admin/my-hotels` - Get owned hotels

### Room Types
- `GET /api/v1/hotels/:hotelId/rooms` - Get room types
- `POST /api/v1/hotels/:hotelId/rooms` - Create room type
- `PUT /api/v1/hotels/rooms/:roomTypeId` - Update room type
- `DELETE /api/v1/hotels/rooms/:roomTypeId` - Delete room type
- `POST /api/v1/hotels/rooms/:roomTypeId/pricing` - Set price override
- `GET /api/v1/hotels/rooms/:roomTypeId/pricing` - Get prices

### Bookings
- `GET /api/v1/bookings/availability` - Check availability
- `GET /api/v1/bookings/availability/calendar` - Get availability calendar
- `POST /api/v1/bookings` - Create booking
- `POST /api/v1/bookings/:bookingId/confirm` - Confirm booking
- `POST /api/v1/bookings/:bookingId/cancel` - Cancel booking
- `GET /api/v1/bookings/:bookingId` - Get booking
- `GET /api/v1/bookings` - Get my bookings
- `GET /api/v1/bookings/hotel/:hotelId` - Get hotel bookings (admin)

### Reviews
- `GET /api/v1/hotels/:hotelId/reviews` - Get hotel reviews
- `GET /api/v1/hotels/:hotelId/reviews/stats` - Get review stats
- `POST /api/v1/bookings/:bookingId/review` - Submit review

## Project Structure

```
hotel-booking/
├── docker-compose.yml      # Infrastructure services
├── backend/
│   ├── src/
│   │   ├── config/         # Configuration
│   │   ├── middleware/     # Auth middleware
│   │   ├── models/         # Database connections
│   │   ├── routes/         # API routes
│   │   ├── services/       # Business logic
│   │   └── index.js        # Express app
│   └── scripts/
│       ├── init.sql        # Database schema
│       └── seed.js         # Sample data
└── frontend/
    ├── src/
    │   ├── components/     # Reusable UI components
    │   ├── routes/         # TanStack Router pages
    │   ├── services/       # API client
    │   ├── stores/         # Zustand state
    │   ├── types/          # TypeScript types
    │   └── utils/          # Helper functions
    └── index.html
```

## Key Design Decisions

### Double-Booking Prevention
Uses PostgreSQL's `SELECT ... FOR UPDATE` for pessimistic locking. When a user creates a booking:
1. Lock the room inventory row
2. Check current availability across all dates
3. Create the booking if rooms are available
4. Release lock on commit

### Reservation Hold
Bookings start in "reserved" status with a 15-minute hold. A background job expires stale reservations, releasing inventory for other users.

### Search Architecture
1. Elasticsearch for fast hotel matching (location, amenities, capacity)
2. Real-time availability check against PostgreSQL
3. Dynamic pricing calculation per date range

### Caching Strategy
- Session data in Redis (fast auth validation)
- Availability calendar cached in Redis (5-minute TTL)
- Cache invalidation on booking create/cancel

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.
See [system-design-answer.md](./system-design-answer.md) for the complete design interview answer.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

## Future Enhancements

- [ ] Payment gateway integration (Stripe)
- [ ] Email notifications for bookings
- [ ] Photo upload for hotels and rooms
- [ ] Advanced search (map view, nearby attractions)
- [ ] Loyalty program
- [ ] Multi-language support
- [ ] Mobile app with React Native

## References & Inspiration

- [How Booking.com Handles Millions of Bookings](https://blog.booking.com/how-booking-handles-millions-of-bookings.html) - High-availability booking systems
- [Expedia Group Technology Blog](https://medium.com/expedia-group-tech) - Travel industry engineering insights
- [Preventing Double Bookings with Database Transactions](https://www.postgresql.org/docs/current/explicit-locking.html) - PostgreSQL locking mechanisms
- [Building Inventory Management Systems](https://engineering.atspotify.com/2023/03/managing-inventory-at-scale/) - Inventory systems at scale
- [Distributed Locking with Redis](https://redis.io/docs/manual/patterns/distributed-locks/) - Redis distributed lock patterns
- [How Hotels.com Redesigned Their Checkout](https://medium.com/hotels-com-technology/how-hotels-com-redesigned-their-checkout-a3e18c7dd57b) - Checkout flow optimization
- [Building Real-Time Availability Systems](https://www.infoq.com/articles/real-time-hotel-availability/) - Real-time inventory challenges
- [Overbooking Strategies in Hospitality](https://www.sciencedirect.com/science/article/abs/pii/S0261517706001889) - Revenue management and overbooking research
