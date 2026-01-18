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
