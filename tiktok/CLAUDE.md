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

### Phase 1: Video Upload & Storage (Completed)
- [x] Upload endpoint
- [x] Object storage integration (MinIO)
- [x] Basic transcoding
- [ ] CDN setup

### Phase 2: Basic Feed (In Progress)
- [x] Chronological feed
- [x] View tracking
- [x] Engagement (likes, comments)

### Phase 3: Recommendation Engine (Completed)
- [x] User embeddings (hashtag preferences)
- [x] Video embeddings (via hashtag similarity)
- [x] Candidate generation (multi-source)
- [x] Ranking model (engagement-based scoring)

### Phase 4: Cold Start (Completed)
- [x] New user handling (trending content)
- [x] New video boost (exploration rate)
- [x] Exploration strategy (20% exploration)

---

## Implementation Notes

### Backend Architecture
- **Express.js** API with session-based auth (Redis store)
- **PostgreSQL** for users, videos, comments, follows, likes
- **MinIO** for S3-compatible video storage
- **Redis** for session management and view counting

### Frontend Architecture
- **React 19** with TypeScript
- **TanStack Router** for file-based routing
- **Zustand** for state management
- **Tailwind CSS** for styling

### Recommendation Algorithm

The recommendation engine uses a two-phase approach:

1. **Candidate Generation**: Pull videos from multiple sources
   - 40% from followed creators
   - 30% from liked hashtags
   - 30% from trending pool

2. **Ranking**: Score each candidate based on:
   - Hashtag preference match
   - Engagement metrics (likes, views, comments)
   - Freshness boost for recent content
   - Source boost (followed > hashtag > trending)
   - Random exploration factor (20%)

---

## Resources

- [TikTok's Recommendation System](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [ByteDance AI Lab Publications](https://ailab.bytedance.com/publications)
- [Two-Stage Recommendation Systems](https://research.google/pubs/pub45530/)

### Phase 5: Vector Embeddings (Completed)
- [x] pgvector integration for similarity search
- [x] Video embeddings (384-dimensional vectors)
- [x] User interest embeddings (aggregated from watch history)
- [x] IVFFlat indexes for approximate nearest neighbor search
- [x] Similar videos endpoint (`GET /api/videos/:id/similar`)

---

## pgvector Integration

### Schema Changes

Added vector columns to support embedding-based recommendations:

```sql
-- Videos table
embedding vector(384)  -- Video content embedding

-- Users table  
interest_embedding vector(384)  -- User interest embedding

-- Indexes using IVFFlat for approximate nearest neighbor search
CREATE INDEX ON videos USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON users USING ivfflat (interest_embedding vector_cosine_ops) WITH (lists = 100);
```

### Embeddings Service

Located at `backend/src/services/embeddings.js`:

- `generateVideoEmbedding(videoId, description, hashtags)` - Generates and stores video embedding
- `generateUserEmbedding(userId, watchHistory)` - Aggregates watched video embeddings
- `findSimilarVideos(embedding, limit, options)` - Uses pgvector `<=>` cosine distance
- `findVideosLikeThis(videoId, limit)` - Finds videos similar to a given video
- `getEmbeddingBasedRecommendations(userId, limit)` - Personalized recommendations

### Updated Recommendation Algorithm

Candidate generation now includes embedding-based source:
- 30% from followed creators
- 20% from liked hashtags
- **20% from embedding similarity** (NEW)
- 30% from trending pool

Ranking includes embedding similarity boost:
- Followed: +5 score
- Embedding match: +4 score + (similarity * 3)
- Hashtag match: +2 score

### Note on Production

The current implementation uses random embeddings for simulation. In production:
- Use sentence-transformers (e.g., `all-MiniLM-L6-v2`) for text embeddings
- Use CLIP or similar for video frame embeddings
- Consider audio embeddings for music/sound features
- Run embedding generation as background job
