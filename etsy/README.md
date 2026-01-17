# Design Etsy - Seller Marketplace

## Overview

A simplified Etsy-like platform demonstrating seller marketplace dynamics, search relevance, personalization, and handmade/vintage product discovery. This educational project focuses on building a multi-seller e-commerce platform with emphasis on unique product discovery.

## Key Features

### 1. Seller Shops
- Shop setup and branding
- Product listings
- Inventory management
- Order fulfillment

### 2. Product Discovery
- Category browsing
- Full-text search with Elasticsearch
- Synonym-enhanced search for handmade items
- Trending and popular items

### 3. Personalization
- Favorite shops and items
- View history tracking
- Similar product recommendations

### 4. Buyer Experience
- Shopping cart (multi-seller)
- Checkout with orders split by seller
- Order tracking per seller
- Reviews and favorites

## Tech Stack

- **Frontend**: TypeScript, Vite, React 19, TanStack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **Cache/Sessions**: Redis
- **Search**: Elasticsearch

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
# Start PostgreSQL, Redis, and Elasticsearch
docker-compose up -d

# Wait for services to be healthy (especially Elasticsearch)
docker-compose ps
```

### 2. Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Run database migrations
npm run migrate

# Seed with sample data
npm run seed

# Start the backend server
npm run dev
```

The backend runs on http://localhost:3000

### 3. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Start the frontend dev server
npm run dev
```

The frontend runs on http://localhost:5173

## Test Accounts

After running the seed script, these accounts are available:

| Email | Password | Role |
|-------|----------|------|
| buyer@example.com | password123 | Buyer |
| alice@example.com | password123 | Seller (Alice's Handmade Jewelry) |
| bob@example.com | password123 | Seller (Bob's Woodwork Studio) |
| carol@example.com | password123 | Seller (Carol's Vintage Finds) |
| admin@example.com | admin123 | Admin |

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Shops
- `GET /api/shops` - List shops
- `GET /api/shops/:id` - Get shop by ID
- `GET /api/shops/slug/:slug` - Get shop by slug
- `POST /api/shops` - Create shop (auth required)
- `PUT /api/shops/:id` - Update shop (owner only)
- `GET /api/shops/:id/products` - Get shop products
- `GET /api/shops/:id/orders` - Get shop orders (owner only)
- `GET /api/shops/:id/stats` - Get shop stats (owner only)

### Products
- `GET /api/products` - List products
- `GET /api/products/search` - Search products (Elasticsearch)
- `GET /api/products/trending` - Get trending products
- `GET /api/products/:id` - Get product details
- `POST /api/products` - Create product (shop owner)
- `PUT /api/products/:id` - Update product (shop owner)
- `DELETE /api/products/:id` - Delete product (shop owner)

### Cart
- `GET /api/cart` - Get cart (grouped by shop)
- `POST /api/cart/items` - Add to cart
- `PUT /api/cart/items/:id` - Update quantity
- `DELETE /api/cart/items/:id` - Remove item
- `DELETE /api/cart` - Clear cart

### Orders
- `GET /api/orders` - Get user's orders
- `GET /api/orders/:id` - Get order details
- `POST /api/orders/checkout` - Create order(s)
- `PUT /api/orders/:id/status` - Update status (seller)

### Favorites
- `GET /api/favorites` - Get favorites
- `POST /api/favorites` - Add favorite
- `DELETE /api/favorites/:type/:id` - Remove favorite
- `GET /api/favorites/check/:type/:id` - Check if favorited

### Reviews
- `GET /api/reviews/product/:id` - Get product reviews
- `GET /api/reviews/shop/:id` - Get shop reviews
- `POST /api/reviews` - Create review (must have purchased)
- `PUT /api/reviews/:id` - Update review
- `DELETE /api/reviews/:id` - Delete review

### Categories
- `GET /api/categories` - List categories
- `GET /api/categories/:id/products` - Get products in category

## Project Structure

```
etsy/
├── docker-compose.yml      # PostgreSQL, Redis, Elasticsearch
├── backend/
│   ├── src/
│   │   ├── db/            # Database connection and migrations
│   │   ├── routes/        # Express route handlers
│   │   ├── services/      # Redis, Elasticsearch clients
│   │   ├── middleware/    # Auth middleware
│   │   ├── config.js      # Environment config
│   │   └── index.js       # Express app entry
│   └── uploads/           # Product images
├── frontend/
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── routes/        # TanStack Router pages
│   │   ├── stores/        # Zustand stores
│   │   ├── services/      # API client
│   │   └── types/         # TypeScript types
│   └── index.html
├── architecture.md        # System design documentation
├── claude.md              # Development notes
└── README.md              # This file
```

## Running Multiple Backend Instances

For testing load balancing and distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Key Technical Challenges Addressed

### 1. Multi-Seller Cart
Cart items are grouped by shop, and checkout creates separate orders per seller with independent fulfillment tracking.

### 2. Search Relevance
Elasticsearch with synonym filters handles varied terminology (handmade, handcrafted, artisan) and fuzzy matching for typos.

### 3. One-of-a-Kind Inventory
Products often have quantity=1. Short cart reservations (15 min) prevent overselling unique items.

### 4. Sparse Signal Personalization
Recommendations based on favorites and view history, with trending products for cold-start users.

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
