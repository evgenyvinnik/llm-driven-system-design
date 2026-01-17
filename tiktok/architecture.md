# Design TikTok - Architecture

## System Overview

TikTok is a short-video platform where the recommendation algorithm is the core product. Unlike social feeds based on follows, TikTok's FYP surfaces content from anyone based on predicted engagement.

**Learning Goals:**
- Build recommendation systems from scratch
- Handle video processing pipelines
- Design for infinite scroll UX
- Balance exploration vs exploitation

---

## Requirements

### Functional Requirements

1. **Upload**: Create short videos with effects
2. **FYP**: Personalized video recommendations
3. **Discovery**: Hashtags, sounds, search
4. **Engage**: Like, comment, share, follow
5. **Analytics**: Creator metrics and insights

### Non-Functional Requirements

- **Latency**: < 100ms for video start
- **Availability**: 99.99% for video playback
- **Scale**: 1B users, 1M videos/day
- **Freshness**: New videos in recommendations within hours

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mobile Client Layer                         │
│            React Native / Native iOS/Android                    │
│         - Video player - Infinite scroll - Upload               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        CDN Layer                                │
│              Video delivery, thumbnails, assets                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Video Service │    │  Rec Service  │    │ User Service  │
│               │    │               │    │               │
│ - Upload      │    │ - FYP         │    │ - Profiles    │
│ - Transcode   │    │ - Ranking     │    │ - Follows     │
│ - Storage     │    │ - Cold start  │    │ - Activity    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├───────────────┬───────────────┬───────────────┬─────────────────┤
│  PostgreSQL   │    Valkey     │    S3/Blob    │  Feature Store  │
│  - Metadata   │ - User state  │  - Videos     │ - Embeddings    │
│  - Engagement │ - Counters    │  - Thumbnails │ - User vectors  │
└───────────────┴───────────────┴───────────────┴─────────────────┘
```

---

## Core Components

### 1. Recommendation Engine

**Two-Phase Approach:**

**Phase 1: Candidate Generation**
```javascript
async function generateCandidates(userId, count = 1000) {
  const candidates = []

  // Source 1: Videos from followed creators
  candidates.push(...await getFollowedCreatorVideos(userId, 200))

  // Source 2: Videos with liked hashtags
  candidates.push(...await getHashtagVideos(userId, 300))

  // Source 3: Videos with liked sounds
  candidates.push(...await getSoundVideos(userId, 200))

  // Source 4: Trending videos (exploration)
  candidates.push(...await getTrendingVideos(300))

  // Deduplicate and remove already watched
  return filterWatched(userId, dedupe(candidates))
}
```

**Phase 2: Ranking**
```javascript
function rankVideos(userId, candidates) {
  const userVector = getUserEmbedding(userId)

  return candidates
    .map(video => ({
      video,
      score: predictEngagement(userVector, video)
    }))
    .sort((a, b) => b.score - a.score)
}

function predictEngagement(userVector, video) {
  const videoVector = getVideoEmbedding(video.id)

  // Cosine similarity as base
  let score = cosineSimilarity(userVector, videoVector)

  // Boost factors
  score *= videoQualityScore(video)
  score *= creatorScore(video.creatorId)
  score *= freshnessScore(video.createdAt)

  return score
}
```

### 2. Video Processing Pipeline

```
Upload → Validate → Transcode → Generate Thumbnails → CDN Distribution
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Video Processing Queue                       │
│                         (Kafka)                                 │
└─────────────────────────────────────────────────────────────────┘
   │
   ├─── Transcoder Worker 1 ──▶ 1080p, 720p, 480p, 360p
   ├─── Transcoder Worker 2 ──▶ (parallel processing)
   └─── Transcoder Worker N

Output:
  - Multiple resolutions for adaptive bitrate
  - Thumbnail at multiple timestamps
  - Audio extraction for sound matching
  - Content fingerprint for dedup
```

### 3. Cold Start Strategy

**New User (no history):**
```javascript
async function coldStartFeed(userId, demographics) {
  // Use demographic-based popular videos
  const popular = await getPopularByDemographic(demographics)

  // Add variety with exploration
  const diverse = await getDiverseContent()

  // 70% demographic popular, 30% exploration
  return shuffle([
    ...popular.slice(0, 7),
    ...diverse.slice(0, 3)
  ])
}
```

**New Video (no engagement):**
```javascript
async function boostNewVideo(videoId) {
  // Give new videos initial exposure
  const targetAudience = predictAudience(videoId) // Based on content

  // Add to candidate pools of target users
  for (const userId of targetAudience.sample(1000)) {
    await addToExplorationPool(userId, videoId)
  }

  // Track early engagement signals
  // Promote or demote based on watch-through rate
}
```

---

## Database Schema

```sql
-- Videos
CREATE TABLE videos (
  id BIGSERIAL PRIMARY KEY,
  creator_id INTEGER REFERENCES users(id),
  url VARCHAR(500),
  duration_seconds INTEGER,
  description TEXT,
  hashtags TEXT[],
  sound_id INTEGER REFERENCES sounds(id),
  view_count BIGINT DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'processing',
  created_at TIMESTAMP DEFAULT NOW()
);

-- User Watch History (for recommendations)
CREATE TABLE watch_history (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  video_id BIGINT REFERENCES videos(id),
  watch_duration_ms INTEGER,
  completion_rate FLOAT,
  liked BOOLEAN DEFAULT FALSE,
  shared BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_watch_history_user ON watch_history(user_id, created_at DESC);

-- Video Embeddings (for similarity)
CREATE TABLE video_embeddings (
  video_id BIGINT PRIMARY KEY REFERENCES videos(id),
  embedding VECTOR(128) -- pgvector extension
);

-- User Embeddings (learned preferences)
CREATE TABLE user_embeddings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  embedding VECTOR(128),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Watch Time as Primary Metric

**Decision**: Optimize for completion rate, not just views

**Rationale**:
- Views can be gamed
- Watch time indicates genuine interest
- Aligns with user satisfaction

### 2. Two-Phase Recommendation

**Decision**: Candidate generation (fast, broad) + Ranking (slow, precise)

**Rationale**:
- Can't score every video for every user
- Candidates filter to ~1000, then rank
- Ranking model can be sophisticated

### 3. Content-Based + Collaborative Filtering

**Decision**: Hybrid recommendation approach

**Rationale**:
- Content-based: Works for new videos
- Collaborative: Captures subtle preferences
- Combined: Best of both worlds

---

## Scalability Considerations

### Video Storage

- Object storage (S3/GCS) for videos
- CDN edge caching for popular videos
- Adaptive bitrate streaming (HLS/DASH)

### Recommendation Serving

- Precompute recommendations batch
- Cache top-N for each user
- Real-time updates for engagement signals

### View Counting

- Aggregate in Valkey (INCR)
- Flush to database periodically
- Eventually consistent counts

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Rec metric | Watch time | Views | Quality signal |
| Rec approach | Two-phase | Single model | Scalability |
| Video storage | Object + CDN | Database | Cost, performance |
| Embeddings | pgvector | Dedicated vector DB | Simplicity |
