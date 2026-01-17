# Design Shopify - Multi-Tenant E-Commerce

## Overview

A simplified Shopify-like platform demonstrating multi-tenant e-commerce, checkout flows, payment processing, and merchant customization. This educational project focuses on building a platform where merchants can create their own online stores.

## Features

### Store Admin
- **Dashboard**: Analytics overview with revenue, orders, products, customers
- **Products**: Full CRUD with variants, inventory tracking
- **Orders**: Order listing, fulfillment status management
- **Customers**: Customer listing with order history
- **Settings**: Store configuration, branding

### Customer Storefront
- **Product Catalog**: Browse all active products
- **Product Details**: Variant selection, inventory display
- **Shopping Cart**: Add/remove items, quantity updates
- **Checkout**: Complete order with shipping info
- **Order Confirmation**: Success page after checkout

### Multi-Tenant Architecture
- PostgreSQL Row-Level Security (RLS) for tenant isolation
- Subdomain-based store resolution
- Session-based authentication with Redis

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Node.js 18+ and npm

### 1. Start Infrastructure

```bash
cd shopify
docker-compose up -d
```

This starts:
- **PostgreSQL** on port 5432 (with RLS enabled)
- **Redis** on port 6379

### 2. Start Backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on http://localhost:3001

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

## Demo Credentials

### Platform Access
- **Email**: `merchant@example.com`
- **Password**: `merchant123`

### Demo Store
- **Subdomain**: `demo`
- Pre-loaded with sample products

## API Endpoints

### Authentication
```
POST /api/auth/login      - Login
POST /api/auth/register   - Register
POST /api/auth/logout     - Logout
GET  /api/auth/me         - Current user
```

### Store Admin (Authenticated)
```
GET    /api/stores                         - List user's stores
POST   /api/stores                         - Create store
GET    /api/stores/:storeId                - Get store
PUT    /api/stores/:storeId                - Update store
GET    /api/stores/:storeId/analytics      - Store analytics

GET    /api/stores/:storeId/products       - List products
POST   /api/stores/:storeId/products       - Create product
GET    /api/stores/:storeId/products/:id   - Get product
PUT    /api/stores/:storeId/products/:id   - Update product
DELETE /api/stores/:storeId/products/:id   - Delete product

GET    /api/stores/:storeId/orders         - List orders
GET    /api/stores/:storeId/orders/:id     - Get order
PUT    /api/stores/:storeId/orders/:id     - Update order status

GET    /api/stores/:storeId/customers      - List customers
GET    /api/stores/:storeId/customers/:id  - Get customer
```

### Storefront (Public)
```
GET  /api/storefront/:subdomain              - Get store info
GET  /api/storefront/:subdomain/products     - List products
GET  /api/storefront/:subdomain/products/:h  - Get product by handle
GET  /api/storefront/:subdomain/collections  - List collections
GET  /api/storefront/:subdomain/cart         - Get cart
POST /api/storefront/:subdomain/cart/add     - Add to cart
PUT  /api/storefront/:subdomain/cart/update  - Update cart
POST /api/storefront/:subdomain/checkout     - Process checkout
```

## Project Structure

```
shopify/
├── docker-compose.yml        # PostgreSQL + Redis
├── backend/
│   ├── package.json
│   ├── scripts/
│   │   └── init.sql          # Database schema with RLS
│   └── src/
│       ├── index.js          # Express server
│       ├── config/           # Configuration
│       ├── middleware/       # Auth middleware
│       ├── routes/           # API routes
│       └── services/         # DB and Redis clients
└── frontend/
    ├── package.json
    ├── index.html
    └── src/
        ├── main.tsx          # App entry
        ├── routes/           # TanStack Router routes
        ├── stores/           # Zustand stores
        ├── services/         # API client
        └── types/            # TypeScript types
```

## Key Technical Features

### Row-Level Security (RLS)
Every tenant table has RLS enabled with policies that automatically filter queries:

```sql
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_isolation_products ON products
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);
```

### Multi-Tenant Query Pattern
```javascript
async function queryWithTenant(storeId, query, params) {
  const client = await pool.connect();
  await client.query(`SET app.current_store_id = '${storeId}'`);
  return client.query(query, params);
}
```

### Session-Based Auth
```javascript
// Redis stores session data
await redis.set(`session:${sessionId}`, JSON.stringify({ user }));

// Cookie sent to client
res.cookie('session', sessionId, { httpOnly: true, sameSite: 'lax' });
```

## Development

### Running Multiple Backend Instances
```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

### Database Reset
```bash
docker-compose down -v
docker-compose up -d
```

### Viewing Database
```bash
docker exec -it shopify-postgres psql -U shopify -d shopify
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Key Design Decisions

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Multi-tenancy | Shared DB + RLS | Schema per tenant | Operational simplicity |
| Session Storage | Redis | JWT | Simpler revocation |
| State Management | Zustand | Redux | Less boilerplate |
| Routing | TanStack Router | React Router | Type-safe routing |

## What's Not Included

For simplicity, this learning project omits:
- Real payment processing (Stripe integration mocked)
- Custom domain SSL provisioning
- Email notifications
- File upload/image hosting
- Full theme customization
- Real-time inventory sync

See [architecture.md](./architecture.md) for how these would be implemented in production.
