# Design Amazon - E-Commerce Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,146 |
| Source Files | 48 |
| .js | 2,306 |
| .tsx | 2,086 |
| .md | 988 |
| .ts | 420 |
| .sql | 186 |

## Overview

A simplified Amazon-like platform demonstrating product catalog management, inventory systems, recommendation engines, and order fulfillment. This educational project focuses on building a scalable e-commerce system with complex product search and ordering workflows.

## Key Features

### 1. Product Catalog
- Hierarchical category system
- Product attributes and variants (size, color)
- Seller marketplace integration
- Product search and filtering with Elasticsearch

### 2. Inventory Management
- Real-time stock tracking
- Reserved inventory for carts (prevents overselling)
- Automatic reservation expiration
- Low stock alerts

### 3. Shopping Cart & Checkout
- Cart with inventory reservation
- Multi-step checkout flow
- Order confirmation

### 4. Order Processing
- Order status tracking
- Order history
- Order cancellation

### 5. Reviews & Ratings
- Product reviews with star ratings
- Verified purchase badges
- Helpful vote system
- Rating summaries

### 6. Recommendations
- "Customers also bought" suggestions
- Batch-computed collaborative filtering
- Redis-cached for fast retrieval

## Tech Stack

- **Frontend:** TypeScript, React 19, Vite, TanStack Router, Zustand, Tailwind CSS
- **Backend:** Node.js, Express
- **Database:** PostgreSQL
- **Cache:** Redis
- **Search:** Elasticsearch

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd amazon
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- Elasticsearch on port 9200

Wait for Elasticsearch to be ready (may take 30-60 seconds):
```bash
curl http://localhost:9200/_cluster/health
```

### 2. Setup Backend

```bash
cd backend

# Copy environment file
cp .env.example .env

# Install dependencies
npm install

# Seed the database with sample data
npm run seed

# Sync products to Elasticsearch
npm run sync-es

# Start the server
npm run dev
```

Backend runs on http://localhost:3000

### 3. Setup Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

Frontend runs on http://localhost:5173

### 4. Access the Application

- **Frontend:** http://localhost:5173
- **API:** http://localhost:3000/api
- **API Health Check:** http://localhost:3000/api/health

## Demo Accounts

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@amazon.local | admin123 |
| Seller | seller@amazon.local | admin123 |

Note: Create a new account to test as a regular user.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Products
- `GET /api/products` - List products (with pagination/filters)
- `GET /api/products/:id` - Get product details
- `GET /api/products/:id/recommendations` - Get product recommendations
- `POST /api/products` - Create product (seller/admin)
- `PUT /api/products/:id` - Update product (seller/admin)
- `PUT /api/products/:id/inventory` - Update inventory (seller/admin)

### Categories
- `GET /api/categories` - List all categories (tree structure)
- `GET /api/categories/:slug` - Get category with subcategories

### Search
- `GET /api/search?q=query` - Search products with facets
- `GET /api/search/suggestions?q=query` - Autocomplete suggestions

### Cart
- `GET /api/cart` - Get cart
- `POST /api/cart` - Add to cart
- `PUT /api/cart/:productId` - Update quantity
- `DELETE /api/cart/:productId` - Remove item
- `DELETE /api/cart` - Clear cart

### Orders
- `GET /api/orders` - List user's orders
- `GET /api/orders/:id` - Get order details
- `POST /api/orders` - Create order (checkout)
- `POST /api/orders/:id/cancel` - Cancel order

### Reviews
- `GET /api/reviews/product/:productId` - Get product reviews
- `POST /api/reviews` - Create review
- `POST /api/reviews/:id/helpful` - Mark review as helpful

### Admin
- `GET /api/admin/stats` - Dashboard statistics
- `GET /api/admin/orders` - List all orders
- `GET /api/admin/users` - List all users
- `GET /api/admin/inventory` - Inventory report
- `POST /api/admin/sync-elasticsearch` - Sync products to ES

## Project Structure

```
amazon/
├── docker-compose.yml     # Infrastructure services
├── backend/
│   ├── src/
│   │   ├── index.js       # Express app entry
│   │   ├── routes/        # API routes
│   │   ├── services/      # Database, Redis, ES services
│   │   ├── middleware/    # Auth, error handling
│   │   └── utils/         # Seed, sync scripts
│   └── db/
│       └── init.sql       # Database schema
└── frontend/
    └── src/
        ├── routes/        # Page components (TanStack Router)
        ├── components/    # Reusable UI components
        ├── stores/        # Zustand state management
        ├── services/      # API client
        └── types/         # TypeScript definitions
```

## Key Technical Challenges Demonstrated

### 1. Inventory Consistency
The reserved inventory model prevents overselling:
- When adding to cart, inventory is reserved (not decremented)
- Reservations expire after 30 minutes
- Background job releases expired reservations
- Checkout atomically decrements both quantity and reserved

### 2. Product Search
Elasticsearch provides:
- Full-text search with fuzzy matching
- Faceted filtering (categories, price ranges, ratings)
- Relevance scoring
- PostgreSQL fallback if ES unavailable

### 3. Cart Persistence
- Cart items stored in PostgreSQL (durable)
- Inventory reservations prevent overselling
- Automatic cleanup of expired reservations

### 4. Recommendations
- Collaborative filtering based on co-purchase data
- Batch computed (not real-time) for performance
- Cached in Redis for fast retrieval

## Development

### Running Multiple Backend Instances

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

### Database Reset

```bash
# Stop containers
docker-compose down -v

# Start fresh
docker-compose up -d

# Re-seed data
cd backend && npm run seed && npm run sync-es
```

## Native Installation (Without Docker)

If you prefer to run services natively:

### PostgreSQL
```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16
createdb amazon_ecommerce
psql amazon_ecommerce < backend/db/init.sql
```

### Redis
```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

### Elasticsearch
```bash
# macOS with Homebrew
brew tap elastic/tap
brew install elastic/tap/elasticsearch-full
brew services start elastic/tap/elasticsearch-full
```

Update `.env` with appropriate connection strings if using non-default ports.

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [Amazon's Dynamo Paper](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) - Foundational distributed key-value store design from Amazon
- [All Things Distributed (Werner Vogels' Blog)](https://www.allthingsdistributed.com/) - Insights from Amazon's CTO on distributed systems
- [Building Scalable E-Commerce with Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) - Event sourcing pattern for order tracking
- [Elasticsearch for E-Commerce Search](https://www.elastic.co/blog/found-elasticsearch-as-a-foundation-for-e-commerce-search) - Search implementation strategies
- [Amazon Item-to-Item Collaborative Filtering](https://www.cs.umd.edu/~samir/498/Amazon-Recommendations.pdf) - The original recommendation algorithm paper
- [Inventory Management Patterns](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html) - Optimistic locking for concurrent inventory updates
- [Designing a Shopping Cart](https://blog.bytebytego.com/p/ep70-how-to-design-a-shopping-cart) - ByteByteGo deep dive on cart design
- [Handling Flash Sales at Scale](https://engineering.grab.com/how-we-built-real-time-flash-sale-system) - Grab's approach to high-concurrency sales
