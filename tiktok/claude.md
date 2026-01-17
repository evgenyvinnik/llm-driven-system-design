# Design TikTok - Development with Claude

## Project Context

Building a short-video recommendation platform to understand content-based and collaborative filtering, cold start solutions, and engagement optimization.

**Key Learning Goals:**
- Build recommendation systems with limited user data
- Handle cold start for users and content
- Design video processing pipelines
- Optimize for watch time over clicks

---

## Key Challenges to Explore

### 1. The Cold Start Problem

**Two Types:**
1. **New User**: No watch history, can't predict preferences
2. **New Video**: No engagement data, can't assess quality

**Solutions:**
- New user: Start with popular/trending, diversify based on demographics
- New video: Give initial exposure, measure early signals (watch-through rate)

### 2. Exploration vs Exploitation

**Trade-off:**
- Exploitation: Show what we predict user will like (safe, high engagement)
- Exploration: Show unknown content (risky, but discovers new interests)

**Approach: Multi-Armed Bandit**
```javascript
const EXPLORE_RATE = 0.1 // 10% exploration

function selectVideo(candidates) {
  if (Math.random() < EXPLORE_RATE) {
    return randomSelect(candidates)
  }
  return topRanked(candidates)
}
```

### 3. Feature Engineering for Videos

**Content Features:**
- Duration, hashtags, sounds, effects
- Visual features (extracted by ML)
- Audio features (music genre, tempo)
- Text features (description, captions)

**Engagement Features:**
- Average watch-through rate
- Like/share ratio
- Comment sentiment
- Creator history

---

## Development Phases

### Phase 1: Video Upload & Storage
- [ ] Upload endpoint
- [ ] Object storage integration
- [ ] Basic transcoding
- [ ] CDN setup

### Phase 2: Basic Feed
- [ ] Chronological feed
- [ ] View tracking
- [ ] Engagement (likes, comments)

### Phase 3: Recommendation Engine
- [ ] User embeddings
- [ ] Video embeddings
- [ ] Candidate generation
- [ ] Ranking model

### Phase 4: Cold Start
- [ ] New user handling
- [ ] New video boost
- [ ] Exploration strategy

---

## Resources

- [TikTok's Recommendation System](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [ByteDance AI Lab Publications](https://ailab.bytedance.com/publications)
- [Two-Stage Recommendation Systems](https://research.google/pubs/pub45530/)
