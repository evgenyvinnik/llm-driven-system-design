# Design LinkedIn - Development with Claude

## Project Context

Building a professional social network to understand graph-based recommendations, multi-factor matching algorithms, and feed ranking.

**Key Learning Goals:**
- Design efficient connection degree calculations
- Build recommendation engines (PYMK, job matching)
- Implement multi-signal feed ranking
- Handle professional data modeling

---

## Key Challenges to Explore

### 1. Connection Degrees at Scale

**Challenge**: With billions of connections, how to efficiently find 2nd-degree network?

**Approaches:**
1. **Real-time graph traversal**: Too slow for large networks
2. **Precomputed cache**: Store 2nd-degree connections, refresh nightly
3. **Hybrid**: Real-time for small networks, cached for large

### 2. PYMK Algorithm

**Challenge**: Recommend people to connect with based on multiple signals

**Signal Weights:**
- Mutual connections: 10 points each
- Same current company: 8 points
- Same past company: 5 points
- Same school: 5 points
- Shared skills: 2 points each
- Same location: 2 points

### 3. Feed Ranking

**Challenge**: Balance recency, relevance, and engagement

**Ranking Signals:**
- Post age (decay over time)
- Author relationship (1st vs 2nd degree)
- Engagement rate (likes, comments)
- Content type (article vs post vs job)
- User interests (inferred from activity)

---

## Development Phases

### Phase 1: Profile & Connections - COMPLETED
- [x] User profiles with experience, education, and skills
- [x] Connection requests and acceptance
- [x] First-degree connection listing
- [x] Profile editing with Elasticsearch indexing

### Phase 2: Graph Queries - IN PROGRESS
- [x] 2nd-degree connections (via SQL queries)
- [x] Mutual connections calculation
- [x] Connection degree finder (1st, 2nd, 3rd)
- [ ] Connection path finder (optimization opportunity)

### Phase 3: Recommendations - COMPLETED
- [x] PYMK algorithm with multi-factor scoring
- [x] Job-candidate matching with skill, experience, location scoring
- [x] Skill endorsements

### Phase 4: Feed & Content - COMPLETED
- [x] Post creation with author information
- [x] Feed generation from connections
- [x] Ranking algorithm (engagement + recency + relationship)
- [x] Comments and likes

---

## Resources

- [LinkedIn's Graph Processing](https://engineering.linkedin.com/blog/topic/graph-processing)
- [Economic Graph](https://economicgraph.linkedin.com/)
- [People You May Know Paper](https://dl.acm.org/doi/10.1145/1772690.1772698)
