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

### 2. Multi-Seller Shipping
- Different origin locations
- Combined shipping optimization
- Separate tracking per seller

### 3. Seller Quality
- Wide quality variance
- Response time tracking
- Dispute handling

---

## Development Phases

### Phase 1: Shops & Products
- [ ] Shop creation
- [ ] Product listings
- [ ] Basic search

### Phase 2: Buyer Experience
- [ ] Multi-seller cart
- [ ] Checkout workflow
- [ ] Order tracking

### Phase 3: Personalization
- [ ] Favorites
- [ ] View history
- [ ] Recommendations

---

## Resources

- [Etsy Engineering](https://www.etsy.com/codeascraft)
- [Search Relevance Tuning](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-match-query.html)
