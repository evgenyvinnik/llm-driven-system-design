# Design Etsy - Development with Claude

## Project Context

Building a multi-seller marketplace to understand varied product search, personalization, and multi-seller order handling.

**Key Learning Goals:**
- Design multi-seller cart and checkout
- Build search for non-standardized products
- Implement personalization with sparse signals
- Handle unique/one-of-a-kind inventory

---

## Key Challenges

### 1. One-of-a-Kind Items
- Quantity usually 1
- No "similar products" backup
- Stock issues = lost sale
- **Solution**: 15-minute cart reservations for unique items

### 2. Multi-Seller Shipping
- Different origin locations
- Combined shipping optimization
- Separate tracking per seller
- **Solution**: Orders split by seller with independent fulfillment

### 3. Seller Quality
- Wide quality variance
- Response time tracking
- Dispute handling
- **Solution**: Shop ratings, reviews, and sales count for trust signals

### 4. Search Relevance
- Handmade products described inconsistently
- Varied terminology (handmade, handcrafted, artisan)
- **Solution**: Elasticsearch with synonym filters and fuzzy matching

---

## Development Phases

### Phase 1: Shops & Products - COMPLETED
- [x] Shop creation and management
- [x] Product listings with categories
- [x] Elasticsearch-powered search with synonyms
- [x] Category browsing

### Phase 2: Buyer Experience - IN PROGRESS
- [x] Multi-seller cart (grouped by shop)
- [x] Checkout workflow (creates orders per seller)
- [x] Order tracking
- [x] Favorites system
- [x] Reviews (linked to purchases)

### Phase 3: Personalization - PARTIAL
- [x] Favorites (products and shops)
- [x] View history tracking
- [x] Similar products (Elasticsearch more_like_this)
- [ ] Personalized homepage recommendations
- [ ] "Because you viewed" suggestions

---

## Implementation Notes

### Backend Architecture
- Express.js with session-based auth (Redis store)
- PostgreSQL for relational data
- Elasticsearch for product search with custom analyzer
- Multi-seller cart with shop grouping

### Frontend Architecture
- React 19 with TanStack Router
- Zustand for state management (auth, cart)
- Tailwind CSS for styling
- Responsive design

### Search Implementation
The Elasticsearch configuration includes:
- Custom `etsy_analyzer` with synonym filter
- Synonyms for handmade terminology
- Fuzzy matching for typos
- Function score boosting by shop rating and sales

### Order Flow
1. Cart items grouped by shop
2. Checkout validates inventory
3. Creates one order per shop (transaction)
4. Decrements product quantities
5. Updates shop sales count
6. Clears cart

---

## Resources

- [Etsy Engineering](https://www.etsy.com/codeascraft)
- [Search Relevance Tuning](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-match-query.html)
- [Elasticsearch Synonyms](https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-synonym-tokenfilter.html)

---

## Repair Log (2026-07-12)

The project was unable to run from a fresh clone; three defects were found and fixed during the repo-wide implementation audit:

1. **Missing database schema**: commit 439fde56 removed `src/db/migrate.js` (schema + triggers) assuming migrations were "handled elsewhere" — they were not. Restored the schema as `backend/src/db/init.sql` (recovered from git history), added `backend/src/db/migrate.ts` and an `npm run db:migrate` script, and mounted init.sql into `docker-entrypoint-initdb.d` so a fresh `docker-compose up` self-initializes.
2. **Backend crash on boot**: `src/shared/logger.ts` used CommonJS `require('pino-http')` in an ESM package (`"type": "module"`), throwing `ReferenceError: require is not defined` at import time. Replaced with the named ESM import `{ pinoHttp }` (pino-http v11+).
3. **README drift**: README instructed `npm run migrate`, which did not exist. Now documents `npm run db:migrate`.

Verified end-to-end after the fixes: docker-compose up → migrate → seed → backend boots (health 200) → products/categories APIs return seeded data → login succeeds → frontend serves on 5173.
