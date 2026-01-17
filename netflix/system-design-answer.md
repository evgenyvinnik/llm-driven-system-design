# Design Netflix - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for having me. Today I'll design Netflix, a video streaming platform serving hundreds of millions of subscribers globally. Netflix is fascinating from a system design perspective because:

1. It accounts for a significant portion of global internet traffic
2. Adaptive bitrate streaming must work across wildly different network conditions
3. The personalization system drives content discovery and engagement
4. A/B testing infrastructure enables data-driven product decisions

Let me clarify the requirements first."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core product:

1. **Streaming**: Watch video with adaptive quality that adjusts to bandwidth
2. **Browse**: Personalized homepage with rows of content recommendations
3. **Profiles**: Multiple viewing profiles per account with separate preferences
4. **Continue Watching**: Resume playback across devices
5. **A/B Testing**: Experiment with features and content presentation

I'll focus on the streaming infrastructure and personalization systems since those are the most technically interesting."

### Non-Functional Requirements

"Let's establish our scale:

- **Playback Start Latency**: Under 2 seconds from clicking play to video appearing
- **Availability**: 99.99% for the streaming service
- **Scale**: 200+ million subscribers, roughly 15% of global internet traffic at peak
- **Quality**: Support up to 4K HDR streaming

The sheer scale here is the defining challenge - at peak hours, Netflix is one of the largest sources of internet traffic worldwide."

---

## High-Level Design (10 minutes)

### Architecture Overview

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

### The Open Connect CDN

"Netflix built their own CDN called Open Connect. Here's why:

1. **Scale**: At 15% of internet traffic, third-party CDN costs would be enormous
2. **Control**: Custom hardware and software optimized for video delivery
3. **ISP Partnerships**: They embed servers directly in ISP data centers

Open Connect Appliances (OCAs) are servers placed inside ISPs. When you stream, traffic often doesn't leave your ISP's network at all - the content is served locally."

### Service Layer

"Three main services:

**Playback Service**: Generates streaming manifests, handles DRM, tracks playback position for resume functionality.

**Personalization Service**: Builds the personalized homepage - which rows to show, which titles in each row, in what order.

**Experimentation Service**: Manages A/B tests, allocates users to variants, tracks metrics."

---

## Deep Dive: Adaptive Bitrate Streaming (12 minutes)

### Encoding Ladder

"Each piece of content is encoded at multiple bitrates:

```
Per-title encoding ladder example:
├── 4K HDR:   15 Mbps
├── 1080p:    5.8 Mbps
├── 1080p:    4.3 Mbps
├── 720p:     3 Mbps
├── 720p:     2.35 Mbps
├── 480p:     1.05 Mbps
├── 360p:     560 kbps
└── 240p:     235 kbps
```

Netflix actually uses per-title encoding - each movie/show gets a custom encoding ladder based on its complexity. Animation compresses better than action movies, so the same visual quality needs different bitrates."

### DASH Manifest

"When playback starts, the client fetches a DASH manifest describing available quality levels:

```xml
<MPD>
  <Period>
    <AdaptationSet>
      <Representation bandwidth='15000000' width='3840' height='2160'>
        <SegmentTemplate media='4k/seg-$Number$.m4s'/>
      </Representation>
      <Representation bandwidth='5800000' width='1920' height='1080'>
        <SegmentTemplate media='1080p/seg-$Number$.m4s'/>
      </Representation>
      <!-- More quality levels -->
    </AdaptationSet>
  </Period>
</MPD>
```

Video is split into segments (typically 2-4 seconds). Each segment exists at every quality level. The client downloads segments one at a time, choosing quality for each."

### ABR Algorithm

"The client's adaptive bitrate algorithm decides which quality to fetch:

```javascript
class ABRController {
  selectQuality(bandwidthEstimate, bufferLevel) {
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

Key principles:
- Leave headroom (80% rule) to absorb fluctuations
- Consider buffer level - if buffer is full, we can risk higher quality
- Smooth bandwidth estimates to avoid oscillation"

### Why Not Third-Party CDN?

"At Netflix's scale, building Open Connect saves money and improves quality:
- No per-GB CDN costs for the majority of traffic
- Content is often served from within the viewer's ISP
- Custom optimizations for video workloads
- Direct relationships with ISPs for better peering"

---

## Deep Dive: Personalization (10 minutes)

### Homepage Structure

"The Netflix homepage is rows of content. Each user sees different rows with different titles in different orders.

```javascript
async function generateHomepage(profileId) {
  const profile = await getProfile(profileId)
  const viewingHistory = await getViewingHistory(profileId)

  const rows = []

  // Continue Watching - always first if non-empty
  const continueWatching = await getContinueWatching(profileId)
  if (continueWatching.length > 0) {
    rows.push({ title: 'Continue Watching', items: continueWatching })
  }

  // Trending in user's country
  rows.push({
    title: 'Trending Now',
    items: await getTrending(profile.country)
  })

  // Genre rows based on viewing history
  const genres = extractTopGenres(viewingHistory)
  for (const genre of genres.slice(0, 3)) {
    rows.push({
      title: `${genre} Movies`,
      items: await getTopByGenre(genre, profileId)
    })
  }

  // 'Because you watched' rows
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
```"

### Ranking Within Rows

"Within each row, titles are ordered by predicted relevance:

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

We combine:
- User-item similarity (based on embeddings)
- Overall popularity (social proof)
- Recency (new releases get a boost)
- Various business rules (promotions, etc.)"

### Continue Watching

"Tracking watch progress for seamless resume:

```javascript
async function updateProgress(profileId, videoId, position, duration) {
  await cassandra.execute(`
    INSERT INTO viewing_progress
    (profile_id, video_id, position, duration, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `, [profileId, videoId, position, duration, Date.now()])

  // If near end (95%), mark as completed
  if (position / duration > 0.95) {
    await markCompleted(profileId, videoId)
  }
}
```

We use Cassandra for viewing history because:
- High write throughput (every few seconds per active viewer)
- Time-series access patterns
- Horizontal scaling"

---

## Deep Dive: A/B Testing (8 minutes)

### Why So Much Testing?

"Netflix runs hundreds of A/B tests simultaneously. Everything from UI layout to artwork to recommendation algorithms is tested. This requires sophisticated infrastructure."

### Experiment Configuration

```typescript
interface Experiment {
  id: string
  name: string
  description: string
  variants: Variant[]
  allocation: number  // Percentage of traffic
  targetGroups: TargetGroup[]  // Country, device, etc.
  metrics: Metric[]  // What to measure
  startDate: Date
  endDate: Date
}

interface Variant {
  id: string
  name: string
  weight: number  // Within the experiment
  config: Record<string, any>  // Feature flags, parameters
}
```

### Allocation Algorithm

"Users are consistently allocated to experiment variants:

```javascript
function allocateToExperiment(userId, experimentId) {
  // Consistent hash ensures stable allocation
  const hash = murmurhash3(`${userId}:${experimentId}`)
  const bucket = hash % 100

  const experiment = getExperiment(experimentId)

  // Check if user is in experiment population
  if (bucket >= experiment.allocation) {
    return null  // Control - not in experiment
  }

  // Determine which variant
  let accumulated = 0
  for (const variant of experiment.variants) {
    accumulated += variant.weight
    if (bucket < (experiment.allocation * accumulated / 100)) {
      return variant.id
    }
  }

  return experiment.variants[0].id
}
```

The consistent hash ensures:
- Same user always gets same variant (no flickering)
- Adding/removing experiments doesn't change other allocations
- Even distribution across variants"

### Using Experiments in Code

```javascript
function getArtwork(videoId, profileId) {
  const variant = allocateToExperiment(profileId, 'artwork_test_123')

  if (variant === 'personalized_artwork') {
    return getPersonalizedArtwork(videoId, profileId)
  } else {
    return getDefaultArtwork(videoId)
  }
}
```

This enables testing whether personalized artwork (showing your favorite actor's face) increases engagement."

---

## Database Schema (2 minutes)

"Core tables:

```sql
CREATE TABLE videos (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  type VARCHAR(20),  -- 'movie', 'series'
  release_year INTEGER,
  duration_minutes INTEGER,
  rating VARCHAR(10),  -- 'TV-MA', 'PG-13'
  genres TEXT[],
  description TEXT,
  poster_url VARCHAR(500)
);

CREATE TABLE profiles (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES accounts(id),
  name VARCHAR(100) NOT NULL,
  is_kids BOOLEAN DEFAULT FALSE,
  maturity_level INTEGER DEFAULT 4,
  language VARCHAR(10) DEFAULT 'en'
);

CREATE TABLE experiments (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  allocation_percent INTEGER,
  variants JSONB,
  target_groups JSONB,
  metrics TEXT[],
  status VARCHAR(20) DEFAULT 'draft',
  start_date TIMESTAMP,
  end_date TIMESTAMP
);
```"

---

## Trade-offs and Alternatives (2 minutes)

"Key decisions:

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| CDN | Custom (Open Connect) | Third-party CDN | Cost at scale, control, ISP integration |
| Streaming Protocol | DASH | HLS | More flexibility, industry standard |
| Viewing History | Cassandra | PostgreSQL | Write throughput, time-series patterns |
| Experimentation | In-house platform | Third-party | Scale, integration, custom needs |

If I had more time, I'd discuss:
- Video encoding pipeline (how content gets prepared)
- DRM and content protection
- Global failover and regional resilience
- Recommendation model training infrastructure"

---

## Summary

"To summarize, I've designed Netflix with:

1. **Open Connect CDN** with ISP-embedded appliances for global scale
2. **Adaptive bitrate streaming** with per-title encoding ladders
3. **DASH manifests** enabling quality switching per segment
4. **Personalized homepage** with ranked rows and titles
5. **Cassandra-backed viewing history** for resume and recommendations
6. **Sophisticated A/B testing** infrastructure for continuous experimentation

The design prioritizes viewing experience - fast startup, smooth playback, relevant content discovery - while handling massive global scale.

What would you like me to elaborate on?"
