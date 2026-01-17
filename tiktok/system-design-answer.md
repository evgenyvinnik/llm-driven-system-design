# System Design Interview: TikTok - Short Video Platform

## Opening Statement

"Today I'll design a short-video platform like TikTok, where the recommendation algorithm is the core product. Unlike traditional social feeds based on follows, TikTok's 'For You Page' surfaces content from anyone based on predicted engagement. The key technical challenges are building an effective recommendation system, handling video processing at scale, and solving the cold start problem for both new users and new content."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Upload**: Create and publish short videos (15-60 seconds) with effects
2. **For You Page (FYP)**: Personalized video recommendations as infinite scroll
3. **Discovery**: Explore hashtags, sounds, and search
4. **Engagement**: Like, comment, share, follow creators
5. **Analytics**: Creator metrics and video performance insights

### Non-Functional Requirements

- **Latency**: < 100ms for video playback start
- **Availability**: 99.99% for video delivery
- **Scale**: 1 billion users, 1 million videos uploaded per day
- **Freshness**: New videos should appear in recommendations within hours

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Daily Active Users | 500M |
| Videos Uploaded/Day | 1M |
| Average Video Size | 20MB (after transcoding) |
| Daily Storage Growth | 20TB |
| Read:Write Ratio | 1000:1 |

---

## Step 2: High-Level Architecture (8 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mobile Client Layer                         │
│            React Native / Native iOS/Android                    │
│         Video player - Infinite scroll - Upload                 │
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

### Why This Architecture?

**CDN is Critical**: With 500M DAU watching videos, CDN caching is essential. Videos are immutable after upload, perfect for aggressive caching. Popular videos will have 99%+ cache hit rates.

**Separation of Rec Service**: The recommendation engine is the core product differentiator. It needs its own service with specialized infrastructure (feature stores, embedding databases).

**Feature Store**: Pre-computed user and video embeddings enable fast real-time ranking. Computing embeddings on-demand would be too slow for infinite scroll.

---

## Step 3: Recommendation Engine Deep Dive (12 minutes)

This is the heart of TikTok. Let me explain the two-phase approach.

### Phase 1: Candidate Generation

The goal is to quickly narrow from millions of videos to ~1000 candidates.

```javascript
async function generateCandidates(userId, count = 1000) {
  const candidates = []

  // Source 1: Videos from followed creators (200)
  candidates.push(...await getFollowedCreatorVideos(userId, 200))

  // Source 2: Videos with hashtags user has engaged with (300)
  candidates.push(...await getHashtagVideos(userId, 300))

  // Source 3: Videos using sounds user has liked (200)
  candidates.push(...await getSoundVideos(userId, 200))

  // Source 4: Trending videos for exploration (300)
  candidates.push(...await getTrendingVideos(300))

  // Deduplicate and filter already-watched
  return filterWatched(userId, dedupe(candidates))
}
```

**Why Multiple Sources?**

- **Followed creators**: Strong signal, user explicitly chose to see them
- **Hashtags/Sounds**: Captures interest in topics and trends
- **Trending**: Ensures exploration and surfaces viral content
- **Mixing sources**: Prevents filter bubbles and keeps feed fresh

### Phase 2: Ranking

Now we score each candidate and rank them.

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

  // Cosine similarity as base score
  let score = cosineSimilarity(userVector, videoVector)

  // Multiply by quality and freshness signals
  score *= videoQualityScore(video)      // Based on past engagement rates
  score *= creatorScore(video.creatorId)  // Creator's track record
  score *= freshnessScore(video.createdAt) // Decay for older videos

  return score
}
```

**Key Ranking Signals:**

| Signal | Weight | Rationale |
|--------|--------|-----------|
| Watch completion rate | High | Strong indicator of quality |
| Like ratio | Medium | Explicit positive signal |
| Comment rate | Medium | Shows engagement depth |
| Share rate | High | Strongest endorsement |
| Creator history | Medium | Reliable creators produce quality |
| Freshness | Medium | Prefer recent content |

### Embeddings: The Secret Sauce

**User Embeddings** (128-dimensional vectors):
- Updated every time user watches, likes, or skips
- Weighted average of engaged video embeddings
- Decay factor for older interactions

**Video Embeddings**:
- Computed from content: visual features, audio, text
- Also influenced by engagement patterns
- Similar videos cluster together in vector space

```sql
-- Using pgvector for embeddings
CREATE TABLE video_embeddings (
  video_id BIGINT PRIMARY KEY REFERENCES videos(id),
  embedding VECTOR(128)
);

CREATE TABLE user_embeddings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  embedding VECTOR(128),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Find similar videos
SELECT video_id, embedding <=> $1 as distance
FROM video_embeddings
ORDER BY distance
LIMIT 100;
```

---

## Step 4: Cold Start Problem (8 minutes)

This is one of the hardest challenges. Two scenarios:

### Cold Start: New User (No History)

```javascript
async function coldStartFeed(userId, demographics) {
  // Use demographic-based popular videos
  const popular = await getPopularByDemographic({
    age: demographics.age,
    country: demographics.country,
    language: demographics.language
  })

  // Add variety with random exploration
  const diverse = await getDiverseContent()

  // 70% demographic popular, 30% exploration
  return shuffle([
    ...popular.slice(0, 7),
    ...diverse.slice(0, 3)
  ])
}
```

**Learning Phase Strategy:**
1. Show diverse content from different categories
2. Track every signal (watch time, replays, skips, likes)
3. After 10-20 videos, user embedding starts taking shape
4. Gradually shift from demographic to personalized

### Cold Start: New Video (No Engagement Data)

```javascript
async function boostNewVideo(videoId) {
  // Predict target audience from video content
  const targetAudience = predictAudience(videoId)

  // Give initial exposure to sample of target users
  for (const userId of targetAudience.sample(1000)) {
    await addToExplorationPool(userId, videoId)
  }

  // Track early signals intensively
  // If watch-through rate > threshold, boost more
  // If watch-through rate < threshold, limit exposure
}
```

**Initial Exposure Strategy:**
- Every new video gets shown to 100-1000 users
- Measure watch-through rate in first hour
- High performers get more exposure, low performers fade
- This creates a meritocratic discovery system

---

## Step 5: Video Processing Pipeline (5 minutes)

```
Upload → Validate → Transcode → Generate Thumbnails → CDN Distribution
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Video Processing Queue (Kafka)               │
└─────────────────────────────────────────────────────────────────┘
   │
   ├─── Transcoder Worker 1 ──▶ 1080p, 720p, 480p, 360p
   ├─── Transcoder Worker 2 ──▶ (parallel processing)
   └─── Transcoder Worker N

Output:
  - Multiple resolutions for adaptive bitrate
  - Thumbnails at multiple timestamps
  - Audio extraction for sound matching
  - Content fingerprint for deduplication
```

**Transcoding Strategy:**
- **Multiple resolutions**: 1080p, 720p, 480p, 360p for adaptive streaming
- **Fast processing**: Target < 2 minutes from upload to live
- **HLS format**: Industry standard for adaptive streaming

---

## Step 6: Database Schema (3 minutes)

```sql
-- Videos table
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

-- Watch history for recommendations
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
```

---

## Step 7: Key Design Decisions & Trade-offs (4 minutes)

### Decision 1: Watch Time as Primary Metric

**Why Not Views?**
- Views can be gamed (auto-scroll, bots)
- A 3-second view and 30-second view are very different
- Watch completion rate indicates genuine interest

**Implementation:**
```javascript
// Track watch time on client
onVideoEnd(videoId, watchTimeMs, totalDurationMs) {
  const completionRate = watchTimeMs / totalDurationMs
  trackEngagement(videoId, { completionRate, watchTimeMs })
}
```

### Decision 2: Two-Phase Recommendation

**Why Not Single Model?**
- Scoring every video against every user is O(videos * users) - impossible
- Candidate generation filters to ~1000 videos quickly
- Ranking model can then be sophisticated and slow

**Trade-off**: Some good videos might not make it into candidates

### Decision 3: pgvector vs Dedicated Vector DB

**Choice**: pgvector (PostgreSQL extension)

**Rationale**:
- Simpler operations (one database)
- Good enough for our scale
- Would switch to Pinecone/Milvus at 100M+ vectors

---

## Step 8: Scalability Considerations (2 minutes)

### Video Storage
- Object storage (S3/GCS) for actual videos
- CDN edge caching for popular videos
- Adaptive bitrate streaming (HLS/DASH)

### Recommendation Serving
- Precompute recommendations in batch (every few hours)
- Cache top-N for each user in Valkey
- Real-time updates only for engagement signals

### View Counting
- Aggregate in Valkey (INCR command)
- Flush to database periodically
- Accept eventually consistent counts (users don't notice)

---

## Closing Summary

I've designed a short-video platform with three key components:

1. **Video Pipeline**: Upload, transcode to multiple resolutions, distribute via CDN for sub-100ms playback

2. **Recommendation Engine**: Two-phase approach with candidate generation (1M to 1K videos) and ranking (1K to ordered feed). Uses embedding-based similarity with quality and freshness signals.

3. **Cold Start Solutions**: Demographic-based content for new users, initial exposure pools for new videos with rapid feedback loops

**Key trade-offs:**
- Watch time over views (quality signal vs. simpler metric)
- Two-phase vs. single model (scalability vs. potential missed candidates)
- pgvector vs. dedicated vector DB (simplicity vs. specialized performance)

**What would I add with more time?**
- Multi-armed bandit for exploration/exploitation balance
- Real-time feature updates for trending signals
- A/B testing infrastructure for ranking model experiments
