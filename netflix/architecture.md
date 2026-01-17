# Design Netflix - Architecture

## System Overview

Netflix is a video streaming platform with personalized content discovery. Core challenges involve video encoding, adaptive streaming, and large-scale personalization.

**Learning Goals:**
- Build adaptive bitrate streaming
- Design personalization systems
- Implement A/B testing infrastructure
- Handle global content delivery

---

## Requirements

### Functional Requirements

1. **Stream**: Watch video with adaptive quality
2. **Browse**: Personalized homepage and search
3. **Profiles**: Multiple viewing profiles
4. **Resume**: Continue watching across devices
5. **Experiment**: A/B test features and content

### Non-Functional Requirements

- **Latency**: < 2 seconds to start playback
- **Availability**: 99.99% for streaming
- **Scale**: 200M subscribers, 15% of internet traffic
- **Quality**: Up to 4K HDR streaming

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│    Smart TV │ Mobile │ Web │ Gaming Console │ Set-top Box       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Open Connect CDN                             │
│         (Netflix's custom CDN, ISP-embedded appliances)         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Playback Service│    │Personalization│    │Experiment Svc │
│               │    │               │    │               │
│ - Manifest    │    │ - Homepage    │    │ - A/B tests   │
│ - Resume      │    │ - Rows        │    │ - Allocation  │
│ - DRM         │    │ - Ranking     │    │ - Analysis    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │         Cassandra + Kafka                     │
│   - Catalog     │         - Viewing history                     │
│   - Accounts    │         - Events                              │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Adaptive Bitrate Streaming

**Encoding Ladder:**
```
Each video encoded at multiple bitrates:
├── 4K HDR:   15 Mbps
├── 1080p:    5.8 Mbps
├── 1080p:    4.3 Mbps
├── 720p:     3 Mbps
├── 720p:     2.35 Mbps
├── 480p:     1.05 Mbps
├── 360p:     560 kbps
└── 240p:     235 kbps
```

**DASH Manifest:**
```xml
<MPD>
  <Period>
    <AdaptationSet>
      <Representation bandwidth="15000000" width="3840" height="2160">
        <SegmentTemplate media="4k/seg-$Number$.m4s"/>
      </Representation>
      <Representation bandwidth="5800000" width="1920" height="1080">
        <SegmentTemplate media="1080p/seg-$Number$.m4s"/>
      </Representation>
      <!-- More quality levels -->
    </AdaptationSet>
  </Period>
</MPD>
```

**Client ABR Logic:**
```javascript
class ABRController {
  selectQuality(bandwidthEstimate, bufferLevel) {
    // Find highest quality we can sustain
    const qualities = this.manifest.representations

    for (const quality of qualities.sortByBandwidth('desc')) {
      // Need bandwidth headroom (80% rule)
      if (quality.bandwidth < bandwidthEstimate * 0.8) {
        // Also check buffer level for safety
        if (bufferLevel > 10 || quality.bandwidth < bandwidthEstimate * 0.5) {
          return quality
        }
      }
    }

    // Fallback to lowest quality
    return qualities[qualities.length - 1]
  }

  estimateBandwidth(downloadTime, segmentSize) {
    const instantBandwidth = (segmentSize * 8) / downloadTime
    // Exponential moving average
    this.bandwidthEstimate = 0.7 * this.bandwidthEstimate + 0.3 * instantBandwidth
    return this.bandwidthEstimate
  }
}
```

### 2. Personalization

**Homepage Row Generation:**
```javascript
async function generateHomepage(profileId) {
  const profile = await getProfile(profileId)
  const viewingHistory = await getViewingHistory(profileId)

  const rows = []

  // Continue Watching (always first)
  const continueWatching = await getContinueWatching(profileId)
  if (continueWatching.length > 0) {
    rows.push({ title: 'Continue Watching', items: continueWatching })
  }

  // Trending Now
  rows.push({
    title: 'Trending Now',
    items: await getTrending(profile.country)
  })

  // Personalized rows based on viewing history
  const genres = extractTopGenres(viewingHistory)
  for (const genre of genres.slice(0, 3)) {
    rows.push({
      title: `${genre} Movies`,
      items: await getTopByGenre(genre, profileId)
    })
  }

  // "Because you watched X"
  const recentlyWatched = viewingHistory.slice(0, 3)
  for (const item of recentlyWatched) {
    const similar = await getSimilar(item.videoId)
    rows.push({
      title: `Because you watched ${item.title}`,
      items: similar
    })
  }

  // Apply A/B test treatments
  return applyExperiments(profileId, rows)
}
```

**Ranking Within Rows:**
```javascript
function rankItems(items, profileId) {
  const userVector = getUserEmbedding(profileId)

  return items
    .map(item => ({
      ...item,
      score: cosineSimilarity(userVector, item.embedding) *
             item.popularityScore *
             item.recencyBoost
    }))
    .sort((a, b) => b.score - a.score)
}
```

### 3. A/B Testing Framework

**Experiment Configuration:**
```typescript
interface Experiment {
  id: string
  name: string
  description: string
  variants: Variant[]
  allocation: number // Percentage of traffic
  targetGroups: TargetGroup[] // Country, device, etc.
  metrics: Metric[] // What to measure
  startDate: Date
  endDate: Date
}

interface Variant {
  id: string
  name: string
  weight: number // Within experiment
  config: Record<string, any>
}
```

**Allocation Algorithm:**
```javascript
function allocateToExperiment(userId, experimentId) {
  // Consistent hashing for stable allocation
  const hash = murmurhash3(`${userId}:${experimentId}`)
  const bucket = hash % 100

  const experiment = getExperiment(experimentId)

  // Check if user is in experiment population
  if (bucket >= experiment.allocation) {
    return null // Control (not in experiment)
  }

  // Determine variant
  let accumulated = 0
  for (const variant of experiment.variants) {
    accumulated += variant.weight
    if (bucket < (experiment.allocation * accumulated / 100)) {
      return variant.id
    }
  }

  return experiment.variants[0].id
}

// Usage in code
function getArtwork(videoId, profileId) {
  const variant = allocateToExperiment(profileId, 'artwork_test_123')

  if (variant === 'treatment_a') {
    return getPersonalizedArtwork(videoId, profileId)
  } else {
    return getDefaultArtwork(videoId)
  }
}
```

### 4. Continue Watching

**Tracking Progress:**
```javascript
async function updateProgress(profileId, videoId, position, duration) {
  await cassandra.execute(`
    INSERT INTO viewing_progress (profile_id, video_id, position, duration, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `, [profileId, videoId, position, duration, Date.now()])

  // If near end, mark as completed
  if (position / duration > 0.95) {
    await markCompleted(profileId, videoId)
  }
}

async function getContinueWatching(profileId) {
  const progress = await cassandra.execute(`
    SELECT video_id, position, duration, updated_at
    FROM viewing_progress
    WHERE profile_id = ?
    AND completed = false
    ORDER BY updated_at DESC
    LIMIT 20
  `, [profileId])

  return progress.rows
    .filter(p => p.position / p.duration > 0.05) // Started watching
    .map(p => ({
      videoId: p.video_id,
      resumePosition: p.position,
      percentComplete: Math.round(p.position / p.duration * 100)
    }))
}
```

---

## Database Schema

```sql
-- Videos (movies and series)
CREATE TABLE videos (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  type VARCHAR(20), -- 'movie', 'series'
  release_year INTEGER,
  duration_minutes INTEGER, -- For movies
  rating VARCHAR(10), -- 'TV-MA', 'PG-13', etc.
  genres TEXT[],
  description TEXT,
  poster_url VARCHAR(500),
  backdrop_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Seasons (for series)
CREATE TABLE seasons (
  id UUID PRIMARY KEY,
  video_id UUID REFERENCES videos(id),
  season_number INTEGER,
  title VARCHAR(200),
  episode_count INTEGER
);

-- Episodes
CREATE TABLE episodes (
  id UUID PRIMARY KEY,
  season_id UUID REFERENCES seasons(id),
  episode_number INTEGER,
  title VARCHAR(200),
  duration_minutes INTEGER,
  description TEXT
);

-- Profiles (per account)
CREATE TABLE profiles (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES accounts(id),
  name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  is_kids BOOLEAN DEFAULT FALSE,
  maturity_level INTEGER DEFAULT 4,
  language VARCHAR(10) DEFAULT 'en',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Experiments
CREATE TABLE experiments (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  allocation_percent INTEGER,
  variants JSONB,
  target_groups JSONB,
  metrics TEXT[],
  status VARCHAR(20) DEFAULT 'draft',
  start_date TIMESTAMP,
  end_date TIMESTAMP
);
```

---

## Key Design Decisions

### 1. Open Connect (Custom CDN)

**Decision**: Build custom CDN with ISP-embedded appliances

**Rationale**:
- Lower latency (content at ISP edge)
- Cost savings (no third-party CDN fees)
- Better quality control

### 2. Cassandra for Viewing History

**Decision**: Use Cassandra for time-series viewing data

**Rationale**:
- High write throughput
- Time-series friendly
- Scales horizontally

### 3. Per-Title Encoding

**Decision**: Custom encoding ladder per title

**Rationale**:
- Animation needs different bitrates than action
- Dark scenes compress differently
- Optimizes storage and quality

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| CDN | Custom (Open Connect) | Third-party | Cost, control |
| Streaming | DASH | HLS | Flexibility |
| History storage | Cassandra | PostgreSQL | Write scale |
| Experiments | In-house | Third-party | Scale, control |
