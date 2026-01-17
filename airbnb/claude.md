# Design Airbnb - Development with Claude

## Project Context

Building a two-sided marketplace to understand availability calendars, geographic search, and trust systems.

**Key Learning Goals:**
- Design efficient availability calendar storage
- Build geographic search with PostGIS
- Handle concurrent booking attempts
- Implement two-sided review systems

---

## Key Challenges to Explore

### 1. Calendar Complexity

**Challenge**: Hosts have complex availability patterns

**Patterns to Handle:**
- Blocked dates (not available)
- Custom pricing (weekends, holidays)
- Minimum stay requirements
- Gap nights (fill short gaps)

### 2. Search Ranking

**Factors:**
- Location relevance (distance to search center)
- Price (within budget)
- Quality (ratings, reviews)
- Availability (matching dates)
- Host responsiveness

### 3. Instant Book vs Request

**Trade-off:**
- Instant: Better conversion, less host control
- Request: Host screening, slower booking

---

## Development Phases

### Phase 1: Listings
- [ ] Property CRUD
- [ ] Photo upload
- [ ] Basic availability

### Phase 2: Search
- [ ] PostGIS setup
- [ ] Radius search
- [ ] Availability filtering

### Phase 3: Booking
- [ ] Booking workflow
- [ ] Payment integration
- [ ] Cancellation handling

### Phase 4: Trust
- [ ] Two-sided reviews
- [ ] Rating aggregation
- [ ] Verification badges

---

## Resources

- [Airbnb Engineering Blog](https://medium.com/airbnb-engineering)
- [PostGIS Documentation](https://postgis.net/documentation/)
- [Two-Sided Marketplace Design](https://a16z.com/2015/01/22/marketplace-strategies-for-finding-liquidity/)
