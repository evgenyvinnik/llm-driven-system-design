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

### Phase 1: Profile & Connections
- [ ] User profiles with experience
- [ ] Connection requests and acceptance
- [ ] First-degree connection listing

### Phase 2: Graph Queries
- [ ] 2nd-degree connections
- [ ] Mutual connections
- [ ] Connection path finder

### Phase 3: Recommendations
- [ ] PYMK algorithm
- [ ] Job-candidate matching
- [ ] Skill endorsements

### Phase 4: Feed & Content
- [ ] Post creation
- [ ] Feed generation
- [ ] Ranking algorithm

---

## Resources

- [LinkedIn's Graph Processing](https://engineering.linkedin.com/blog/topic/graph-processing)
- [Economic Graph](https://economicgraph.linkedin.com/)
- [People You May Know Paper](https://dl.acm.org/doi/10.1145/1772690.1772698)
