# Design Airbnb - Development with Claude

## Project Context

Building a two-sided marketplace to understand availability calendars, geographic search, and trust systems.

**Key Learning Goals:**
- Design efficient availability calendar storage
- Build geographic search with PostGIS
- Handle concurrent booking attempts
- Implement two-sided review systems

---

## Implementation Summary

### What Was Built

**Backend (Node.js + Express)**
- Session-based authentication with Redis caching
- Listings API with photo uploads and availability management
- Geographic search using PostGIS ST_DWithin queries
- Booking system with transaction-based double-booking prevention
- Two-sided reviews with automatic visibility on both submissions
- Real-time messaging between hosts and guests

**Frontend (React + TypeScript)**
- Home page with featured listings
- Search page with filters (price, amenities, property type)
- Listing detail page with booking widget
- Calendar component for date selection
- Host dashboard for managing listings and reservations
- Guest trips page
- Messaging interface

**Database (PostgreSQL + PostGIS)**
- Users, listings, bookings, reviews, messages tables
- Availability blocks stored as date ranges (not day-by-day)
- GIST spatial index on listings.location
- Triggers for automatic review visibility and rating updates

---

## Key Challenges to Explore

### 1. Calendar Complexity

**Challenge**: Hosts have complex availability patterns

**Patterns to Handle:**
- Blocked dates (not available)
- Custom pricing (weekends, holidays)
- Minimum stay requirements
- Gap nights (fill short gaps)

**Solution Implemented:**
- Date ranges stored as `availability_blocks` table
- Overlap detection using PostgreSQL OVERLAPS operator
- Split/merge logic when updating ranges

### 2. Search Ranking

**Factors:**
- Location relevance (distance to search center)
- Price (within budget)
- Quality (ratings, reviews)
- Availability (matching dates)
- Host responsiveness

**Solution Implemented:**
- PostGIS for geographic queries with ST_DWithin
- Combined filtering: geo + availability + amenities
- Sorting by relevance, price, rating, or distance

### 3. Instant Book vs Request

**Trade-off:**
- Instant: Better conversion, less host control
- Request: Host screening, slower booking

**Solution Implemented:**
- `instant_book` flag on listings
- Instant book creates confirmed booking immediately
- Request flow creates pending booking awaiting host response

### 4. Double-Booking Prevention

**Solution Implemented:**
- Database transaction with FOR UPDATE row lock
- Availability check within transaction
- Availability block inserted atomically with booking

---

## Development Phases

### Phase 1: Listings - COMPLETED
- [x] Property CRUD
- [x] Photo upload
- [x] Basic availability

### Phase 2: Search - IN PROGRESS
- [x] PostGIS setup
- [x] Radius search
- [x] Availability filtering
- [ ] Full-text search on descriptions
- [ ] Search result caching

### Phase 3: Booking - COMPLETED
- [x] Booking workflow
- [x] Double-booking prevention
- [x] Cancellation handling
- [ ] Payment integration (simulated)

### Phase 4: Trust - COMPLETED
- [x] Two-sided reviews
- [x] Rating aggregation
- [ ] Verification badges (UI only)

---

## Design Decisions

### 1. Date Ranges vs Day-by-Day

**Chose: Date Ranges**

Rationale:
- 10M listings x 365 days = 3.65B rows for day-by-day
- Date ranges: ~200M rows (18x reduction)
- PostgreSQL OVERLAPS operator handles range queries efficiently

### 2. PostGIS vs Elasticsearch for Geo

**Chose: PostGIS**

Rationale:
- Keeps all data in single database
- No sync complexity
- PostGIS GIST index very efficient for radius queries
- Would add Elasticsearch if needed full-text search

### 3. Session-based Auth vs JWT

**Chose: Session-based with Redis**

Rationale:
- Simpler for learning project
- Easy session invalidation
- Redis provides fast lookups
- PostgreSQL backup for persistence

---

## Future Improvements

1. **Elasticsearch integration** for full-text search
2. **Dynamic pricing** based on demand
3. **Real-time notifications** with WebSockets
4. **Image optimization** and CDN
5. **Admin dashboard** for moderation
6. **Load testing** with multiple instances

---

## Resources

- [Airbnb Engineering Blog](https://medium.com/airbnb-engineering)
- [PostGIS Documentation](https://postgis.net/documentation/)
- [Two-Sided Marketplace Design](https://a16z.com/2015/01/22/marketplace-strategies-for-finding-liquidity/)
