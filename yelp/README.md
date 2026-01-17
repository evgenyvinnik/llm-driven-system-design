# Yelp Clone - Local Business Review Platform

A local business review and discovery platform inspired by Yelp, built with modern web technologies.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,094 |
| Source Files | 48 |
| .tsx | 3,183 |
| .js | 2,258 |
| .md | 896 |
| .ts | 296 |
| .sql | 271 |

## Features

- **Business Search**: Full-text search with geo-spatial filtering using Elasticsearch
- **Business Listings**: Detailed business profiles with photos, hours, and contact info
- **Reviews & Ratings**: User reviews with star ratings and voting (helpful/funny/cool)
- **User Authentication**: Session-based auth with role-based access control
- **Business Owner Dashboard**: Claim businesses, respond to reviews, update information
- **Admin Panel**: User management, business verification, review moderation

## Tech Stack

### Backend
- **Runtime**: Node.js with Express
- **Database**: PostgreSQL with PostGIS for geo-spatial queries
- **Search**: Elasticsearch for full-text and geo search
- **Cache**: Redis for session management and caching

### Frontend
- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite
- **Routing**: TanStack Router
- **State Management**: Zustand
- **Styling**: Tailwind CSS

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Option 1: Docker Setup (Recommended)

1. **Start infrastructure services**
   ```bash
   docker-compose up -d
   ```

   This starts:
   - PostgreSQL with PostGIS on port 5432
   - Redis on port 6379
   - Elasticsearch on port 9200

2. **Wait for services to be healthy**
   ```bash
   docker-compose ps
   ```
   All services should show as "healthy".

3. **Install and start the backend**
   ```bash
   cd backend
   npm install
   npm run dev
   ```

4. **Sync Elasticsearch index** (in a new terminal)
   ```bash
   cd backend
   npm run sync-elasticsearch
   ```

5. **Install and start the frontend** (in a new terminal)
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

6. **Access the application**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3000
   - Health check: http://localhost:3000/health

### Option 2: Native Services Setup

If you prefer to run services natively:

#### PostgreSQL with PostGIS

```bash
# macOS with Homebrew
brew install postgresql@16 postgis

# Start PostgreSQL
brew services start postgresql@16

# Create database
createdb yelp_db
psql yelp_db -c "CREATE USER yelp WITH PASSWORD 'yelp_password';"
psql yelp_db -c "GRANT ALL PRIVILEGES ON DATABASE yelp_db TO yelp;"
psql yelp_db -c "CREATE EXTENSION postgis;"
psql yelp_db -c "CREATE EXTENSION \"uuid-ossp\";"

# Run init script
psql yelp_db -f backend/db/init.sql
```

#### Redis

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

#### Elasticsearch

```bash
# macOS with Homebrew
brew tap elastic/tap
brew install elastic/tap/elasticsearch-full
brew services start elasticsearch-full
```

### Environment Configuration

The backend uses a `.env` file for configuration. The default values work with Docker:

```bash
cd backend
cp .env.example .env
# Edit .env if using custom ports or credentials
```

### Running Multiple Server Instances

For testing distributed scenarios:

```bash
# Terminal 1
cd backend && npm run dev:server1  # Port 3001

# Terminal 2
cd backend && npm run dev:server2  # Port 3002

# Terminal 3
cd backend && npm run dev:server3  # Port 3003
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Businesses
- `GET /api/businesses` - List businesses
- `GET /api/businesses/nearby` - Get nearby businesses
- `GET /api/businesses/:idOrSlug` - Get business details
- `POST /api/businesses` - Create business (auth required)
- `PATCH /api/businesses/:id` - Update business (owner only)
- `POST /api/businesses/:id/claim` - Claim business
- `GET /api/businesses/:id/reviews` - Get business reviews

### Reviews
- `POST /api/reviews` - Create review (auth required)
- `GET /api/reviews/:id` - Get review
- `PATCH /api/reviews/:id` - Update review (author only)
- `DELETE /api/reviews/:id` - Delete review (author/admin)
- `POST /api/reviews/:id/vote` - Vote on review
- `POST /api/reviews/:id/respond` - Respond to review (business owner)

### Search
- `GET /api/search` - Search businesses
- `GET /api/search/autocomplete` - Autocomplete suggestions

### Categories
- `GET /api/categories` - List all categories
- `GET /api/categories/:slug` - Get category details
- `GET /api/categories/:slug/businesses` - Get businesses in category

### Admin (admin only)
- `GET /api/admin/stats` - Dashboard statistics
- `GET /api/admin/users` - List users
- `PATCH /api/admin/users/:id/role` - Update user role
- `GET /api/admin/businesses` - List businesses
- `PATCH /api/admin/businesses/:id/verify` - Verify business
- `GET /api/admin/reviews` - List reviews
- `DELETE /api/admin/reviews/:id` - Delete review

## Sample Data

The database is seeded with:
- Sample categories (Restaurants, Coffee, Bars, etc.)
- Sample businesses in New York and San Francisco
- Business hours and photos

To add more sample data, edit `backend/db/init.sql`.

## Development

### Backend Development

```bash
cd backend
npm run dev        # Start with hot reload
npm run lint       # Run ESLint
```

### Frontend Development

```bash
cd frontend
npm run dev        # Start dev server
npm run build      # Build for production
npm run lint       # Run ESLint
npm run type-check # TypeScript check
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

## License

This is a learning project for system design practice.

## References & Inspiration

- [Yelp's Real-Time Data Pipeline](https://engineeringblog.yelp.com/2016/11/salute-our-new-yelp-data-pipeline.html) - How Yelp processes billions of events
- [How Yelp Runs Millions of Tests Every Day](https://engineeringblog.yelp.com/2017/04/how-yelp-runs-millions-of-tests-every-day.html) - Testing infrastructure at scale
- [Scaling Yelp's Ad Platform](https://engineeringblog.yelp.com/2023/04/scaling-yelps-ad-platform.html) - High-throughput advertising system
- [Yelp's Photo Search Engine](https://engineeringblog.yelp.com/2019/09/yelp-photo-search-engine.html) - Visual search for local businesses
- [Fighting Review Fraud at Yelp](https://engineeringblog.yelp.com/2018/07/fighting-review-fraud-at-yelp.html) - ML-based spam and fraud detection
- [Elasticsearch Cluster Management at Yelp](https://engineeringblog.yelp.com/2017/10/nrtsearch-yelps-fast-lucene-based-search-engine.html) - NRTSearch: Yelp's fast search engine
- [Building Local Search with Elasticsearch](https://engineeringblog.yelp.com/2015/03/scaling-elasticsearch-to-hundreds-of-millions-of-reviews.html) - Scaling Elasticsearch for local search
- [Yelp's Review Ranking Algorithm](https://www.yelp.com/developers/documentation/v3/business_reviews) - How reviews are sorted and ranked
