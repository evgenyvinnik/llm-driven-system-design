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

### Phase 1: Product Catalog
- [ ] Categories and products
- [ ] Basic product pages
- [ ] PostgreSQL full-text search

### Phase 2: Inventory
- [ ] Stock tracking
- [ ] Reserved quantity model
- [ ] Availability checking

### Phase 3: Cart & Checkout
- [ ] Cart CRUD operations
- [ ] Inventory reservation
- [ ] Checkout workflow

### Phase 4: Search
- [ ] Elasticsearch indexing
- [ ] Faceted filtering
- [ ] Search relevance tuning

### Phase 5: Recommendations
- [ ] Also bought computation
- [ ] Personalized homepage
- [ ] Recently viewed

---

## Resources

- [Amazon Architecture](https://www.allthingsdistributed.com/)
- [Elasticsearch E-commerce](https://www.elastic.co/solutions/ecommerce)
- [Inventory Management Patterns](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html)
