# Price Tracking Service

## Overview

An e-commerce price monitoring and alert system that helps users track product prices across multiple online retailers, receive alerts when prices drop, and view historical price trends.

## Key Features

- **Product Tracking** - Add products from various e-commerce sites (Amazon, eBay, Walmart, etc.)
- **Price Scraping** - Automated price extraction with support for multiple site formats
- **Historical Tracking** - View price history with interactive charts
- **Price Alerts** - Get notified when prices drop below your target
- **Admin Dashboard** - Monitor system health and scraping statistics

## Tech Stack

- **Frontend:** React 19 + TypeScript + Vite + TanStack Router + Zustand + Tailwind CSS + Recharts
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL with TimescaleDB extension (time-series data)
- **Cache:** Redis
- **Scraping:** Cheerio (HTML parsing) + Puppeteer (JavaScript rendering, optional)

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer (PostgreSQL + TimescaleDB + Redis)
- [x] API endpoints (Auth, Products, Alerts, Admin)
- [x] Frontend UI with price charts
- [x] Scraper worker with proxy support
- [ ] Testing
- [ ] Performance optimization
- [ ] Browser extension

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Installation

1. **Clone the repository:**
```bash
git clone <repository-url>
cd price-tracking
```

2. **Start infrastructure services (PostgreSQL + Redis):**
```bash
docker-compose up -d
```

3. **Setup Backend:**
```bash
cd backend
cp .env.example .env
npm install
```

4. **Setup Frontend:**
```bash
cd frontend
npm install
```

### Running the Service

#### Option 1: Development Mode (Recommended)

**Terminal 1 - Start backend API server:**
```bash
cd backend
npm run dev
```

**Terminal 2 - Start scraper worker:**
```bash
cd backend
npm run dev:scraper
```

**Terminal 3 - Start frontend:**
```bash
cd frontend
npm run dev
```

The application will be available at:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000
- API Health Check: http://localhost:3000/health

#### Option 2: Multi-Instance Backend (for load testing)

```bash
# Terminal 1
cd backend && npm run dev:server1   # Port 3001

# Terminal 2
cd backend && npm run dev:server2   # Port 3002

# Terminal 3
cd backend && npm run dev:server3   # Port 3003
```

### Environment Variables

Backend (`.env`):
```bash
DATABASE_URL=postgresql://pricetracker:pricetracker123@localhost:5432/pricetracker
REDIS_URL=redis://localhost:6379
PORT=3000
NODE_ENV=development
SESSION_SECRET=your-super-secret-session-key
SCRAPE_INTERVAL_MINUTES=30
MAX_CONCURRENT_SCRAPES=5

# Optional proxy settings for scraping
PROXY_HOST=
PROXY_PORT=
PROXY_USERNAME=
PROXY_PASSWORD=
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Products
- `GET /api/v1/products` - Get user's tracked products
- `POST /api/v1/products` - Add product to track
- `GET /api/v1/products/:id` - Get product details
- `PATCH /api/v1/products/:id` - Update tracking settings
- `DELETE /api/v1/products/:id` - Stop tracking product
- `GET /api/v1/products/:id/history` - Get price history
- `GET /api/v1/products/:id/daily` - Get daily price summary

### Alerts
- `GET /api/v1/alerts` - Get user's alerts
- `GET /api/v1/alerts/count` - Get unread alert count
- `PATCH /api/v1/alerts/:id/read` - Mark alert as read
- `POST /api/v1/alerts/read-all` - Mark all alerts as read

### Admin (requires admin role)
- `GET /api/v1/admin/stats` - Dashboard statistics
- `GET /api/v1/admin/products` - All products
- `GET /api/v1/admin/scrape-queue` - Products pending scrape
- `GET /api/v1/admin/scraper-configs` - Scraper configurations

## Database Schema

The system uses PostgreSQL with TimescaleDB for efficient time-series storage:

- **users** - User accounts and settings
- **products** - Product metadata and current prices
- **user_products** - User-product tracking relationships
- **price_history** - TimescaleDB hypertable for price data
- **alerts** - Price drop notifications
- **scraper_configs** - Domain-specific scraping configurations
- **sessions** - User session tokens

## Scraper Architecture

The scraper worker:
1. Runs on a configurable schedule (default: every 30 minutes)
2. Prioritizes products based on watcher count
3. Supports CSS selectors and JSON-LD extraction
4. Respects rate limits per domain
5. Supports proxy rotation for avoiding blocks
6. Triggers alerts when prices change

## Testing

```bash
# Backend tests
cd backend
npm run lint
npm run type-check

# Frontend tests
cd frontend
npm run lint
npm run type-check
```

## Architecture

See [architecture.md](./architecture.md) for high-level design.
See [system-design-answer.md](./system-design-answer.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Future Enhancements

- [ ] Browser extension for quick product adding
- [ ] Email notifications
- [ ] Push notifications
- [ ] ML-based price predictions
- [ ] Price comparison across retailers
- [ ] Mobile app
- [ ] Coupon/deal aggregation
