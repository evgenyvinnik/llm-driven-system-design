# Design Reddit - Development with Claude

## Project Context

This document tracks the development of a Reddit-like content platform focusing on voting systems, nested comments, and ranking algorithms.

**Key Learning Goals:**
- Implement voting systems that handle high concurrency
- Design efficient nested comment storage (materialized path)
- Build and compare ranking algorithms (hot, controversial, top)
- Handle community isolation with subreddits

---

## Key Challenges to Explore

### 1. Vote Aggregation at Scale

**Challenge**: How do we count millions of votes without database locks?

**Approaches Considered**:

| Approach | Pros | Cons |
|----------|------|------|
| Direct UPDATE | Simple | Row locks under contention |
| Vote table + async | No contention | Delayed counts |
| Redis INCR | Real-time, fast | Memory cost, durability |

**Decision**: Vote table with async aggregation
- Insert votes to table (no contention)
- Background worker aggregates every 5-30 seconds
- Cache current counts in Valkey

**Learning Outcome**: Understanding eventual consistency trade-offs

### 2. Nested Comment Trees

**Challenge**: How to efficiently store and query arbitrarily deep comment trees?

**Options Compared**:

| Method | Query Complexity | Insert Complexity | Move Complexity |
|--------|------------------|-------------------|-----------------|
| Adjacency List | O(n) recursive | O(1) | O(1) |
| Materialized Path | O(log n) | O(1) | O(subtree) |
| Nested Sets | O(log n) | O(n) | O(n) |
| Closure Table | O(1) | O(depth) | O(subtree) |

**Decision**: Materialized Path
- Path string like "1.5.23.102" encodes ancestry
- Single LIKE query fetches subtree: `WHERE path LIKE '1.5.%'`
- Good balance of read/write performance

### 3. Ranking Algorithms

**Challenge**: How do different ranking algorithms create different user experiences?

**Algorithms to Implement**:

1. **Hot**: Balances recency with popularity
   - Reddit formula: `sign(score) * log10(|score|) + seconds/45000`
   - Older posts need exponentially more votes to compete

2. **Top**: Pure score within time window
   - Simple but favors early posts (more exposure time)

3. **Controversial**: High engagement, balanced votes
   - `magnitude * (min(ups, downs) / max(ups, downs))`
   - Surfaces divisive content

4. **Rising**: Rapid recent acceleration
   - Compare votes in last hour vs previous hour
   - Finds emerging content early

5. **Best** (Wilson score): Statistical confidence
   - Accounts for sample size
   - Prevents 1 upvote / 0 downvotes = 100% from ranking first

---

## Development Phases

### Phase 1: Core Data Model
- [x] Users, subreddits, posts schema
- [x] Comment tree with materialized path
- [x] Vote table design
- [x] Basic CRUD operations

### Phase 2: Voting System (In Progress)
- [x] Vote submission endpoint
- [x] Duplicate vote handling (change/remove)
- [x] Background aggregation worker
- [x] Karma calculation

### Phase 3: Ranking Algorithms
- [x] Implement hot, top, new, controversial
- [x] Precomputation strategy
- [ ] Valkey sorted sets for fast retrieval
- [ ] Compare algorithm behaviors

### Phase 4: Comment Threading
- [x] Materialized path implementation
- [x] Subtree fetching and pagination
- [x] Comment sorting (best, top, new)
- [ ] "Load more" for deep threads

### Phase 5: Subreddit Features
- [x] Community creation and settings
- [x] Subscription management
- [ ] Home feed (aggregated subscriptions)
- [ ] Basic moderation tools

---

## Design Decisions Log

### Decision 1: Materialized Path for Comments
**Context**: Need to store and query nested comments efficiently
**Options**: Adjacency list, materialized path, nested sets, closure table
**Decision**: Materialized path with LIKE queries
**Rationale**: Good read performance, simple implementation, rare moves

### Decision 2: Async Vote Aggregation
**Context**: Prevent database contention on popular posts
**Options**: Direct update, async aggregation, Redis counters
**Decision**: Insert to vote table, background worker aggregates
**Rationale**: Eliminates locks, enables vote auditing, acceptable delay

### Decision 3: PostgreSQL over Document Store
**Context**: Choose primary database
**Options**: PostgreSQL, MongoDB, Cassandra
**Decision**: PostgreSQL
**Rationale**: Relational model fits (users → posts → comments), ACID for votes

---

## Questions to Explore

1. **How does Reddit handle vote brigading?**
   - Rate limiting per user per subreddit
   - Account age/karma requirements
   - Fuzzing displayed scores

2. **Why does Reddit hide vote counts temporarily?**
   - Prevents bandwagon voting
   - Encourages independent judgment

3. **How would this scale to 1M concurrent users?**
   - Shard by subreddit
   - Read replicas for feeds
   - CDN for static content
   - Kafka for cross-service events

---

## Resources

- [Reddit's Comment System](https://old.reddit.com/r/programming/comments/1a4a6i/how_reddit_ranking_algorithms_work/)
- [Materialized Path Trees](https://www.postgresql.org/docs/current/ltree.html)
- [Wilson Score Interval](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html)
- [Reddit Ranking Algorithms](https://medium.com/hacking-and-gonzo/how-reddit-ranking-algorithms-work-ef111e33d0d9)
