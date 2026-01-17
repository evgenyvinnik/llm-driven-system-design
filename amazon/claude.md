# Design Amazon - Development with Claude

## Project Context

Building an e-commerce platform to understand inventory management, product search, and recommendation systems.

**Key Learning Goals:**
- Design inventory systems that prevent overselling
- Build full-text search with faceted filtering
- Implement collaborative filtering recommendations
- Handle complex order state machines

---

## Key Challenges to Explore

### 1. Flash Sale Problem

**Scenario**: 1000 units, 10000 concurrent buyers

**Solutions:**
1. **Distributed locks**: Serialize access (slow)
2. **Queue-based**: Process orders sequentially
3. **Reserved inventory**: Lock on cart, release on timeout

### 2. Cart Abandonment

**Problem**: Users add to cart but don't checkout

**Solution**:
- Reserve inventory for 30 minutes
- Background job releases expired reservations
- Balance UX (long hold) vs availability (short hold)

### 3. Eventual Consistency in Search

**Problem**: Product update → Search index delay

**Acceptable**: Search slightly stale
**Important**: Inventory always current on product page

---

## Development Phases

### Phase 1: Product Catalog - COMPLETED
- [x] Categories and products
- [x] Basic product pages
- [x] PostgreSQL full-text search

### Phase 2: Inventory - IN PROGRESS
- [x] Stock tracking
- [x] Reserved quantity model
- [x] Availability checking

### Phase 3: Cart & Checkout - COMPLETED
- [x] Cart CRUD operations
- [x] Inventory reservation
- [x] Checkout workflow

### Phase 4: Search - COMPLETED
- [x] Elasticsearch indexing
- [x] Faceted filtering
- [x] Search relevance tuning

### Phase 5: Recommendations - PARTIAL
- [x] Also bought computation
- [ ] Personalized homepage (basic implementation done)
- [ ] Recently viewed (not implemented)

---

## Implementation Summary

### What was built:

**Backend (Express + Node.js)**
- RESTful API with authentication (session-based)
- Products, categories, cart, orders, reviews endpoints
- Reserved inventory model preventing overselling
- Background jobs for reservation cleanup
- Elasticsearch integration for search
- Redis for sessions and recommendation caching

**Frontend (React + TypeScript + Vite)**
- Product browsing and search
- Category navigation
- Shopping cart with real-time inventory
- Checkout flow
- Order history
- Product reviews

**Infrastructure**
- PostgreSQL for primary data
- Redis for caching and sessions
- Elasticsearch for product search

---

## Resources

- [Amazon Architecture](https://www.allthingsdistributed.com/)
- [Elasticsearch E-commerce](https://www.elastic.co/solutions/ecommerce)
- [Inventory Management Patterns](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html)
