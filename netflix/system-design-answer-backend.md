# Design Netflix - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design Netflix, a video streaming platform serving hundreds of millions of subscribers globally. The backend challenge focuses on adaptive bitrate streaming, CDN architecture, viewing history at scale, and A/B testing infrastructure.

## Requirements Clarification

### Functional Requirements
- **Streaming API**: Generate DASH manifests with quality tiers
- **Progress Tracking**: Store viewing position for resume across devices
- **Personalization API**: Generate personalized homepage rows
- **A/B Testing**: Allocate users to experiments consistently

### Non-Functional Requirements
- **Latency**: < 2 seconds to start playback
- **Availability**: 99.99% for streaming service
- **Scale**: 200M subscribers, 15% of global internet traffic
- **Throughput**: Handle millions of progress updates per second

### Scale Estimates
- **Peak Concurrent Viewers**: 50 million
- **Progress Updates**: 50M viewers x 1 update/10s = 5M writes/second
- **Daily Playback Starts**: 500 million
- **Video Catalog**: 15,000+ titles

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
│                    API Gateway (Kong/Zuul)                      │
│              Rate Limiting │ Auth │ Routing                     │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Playback Svc  │    │Personalization│    │ Experiment Svc│
│               │    │    Service    │    │               │
│ - Manifest    │    │ - Homepage    │    │ - Allocation  │
│ - DRM         │    │ - Ranking     │    │ - A/B tests   │
│ - Progress    │    │ - Rows        │    │ - Metrics     │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├──────────────┬──────────────────┬───────────────────────────────┤
│  PostgreSQL  │    Cassandra     │         Redis + Kafka         │
│  - Catalog   │  - View History  │    - Sessions, Cache          │
│  - Accounts  │  - Progress      │    - Events                   │
└──────────────┴──────────────────┴───────────────────────────────┘
```

## Deep Dives

### 1. Playback Service Architecture

**DASH Manifest Generation:**

```typescript
interface PlaybackManifest {
  videoId: string;
  title: string;
  duration: number;
  resumePosition: number;
  qualities: QualityTier[];
  subtitles: SubtitleTrack[];
  audioTracks: AudioTrack[];
}

interface QualityTier {
  id: string;
  resolution: string;     // "3840x2160", "1920x1080"
  bandwidth: number;      // bits per second
  codec: string;          // "avc1.640028", "hev1.1.6.L150.90"
  segmentDuration: number; // seconds per segment
  baseUrl: string;        // CDN URL template
}

async function generateManifest(
  videoId: string,
  profileId: string,
  deviceCapabilities: DeviceCapabilities
): Promise<PlaybackManifest> {
  // 1. Get video metadata
  const video = await db.query(`
    SELECT v.*, e.episode_number, s.season_number
    FROM videos v
    LEFT JOIN episodes e ON v.id = e.video_id
    LEFT JOIN seasons s ON e.season_id = s.id
    WHERE v.id = $1
  `, [videoId]);

  // 2. Get available encodings filtered by device
  const encodings = await db.query(`
    SELECT * FROM video_encodings
    WHERE video_id = $1
    AND codec = ANY($2)
    AND max_resolution <= $3
    ORDER BY bandwidth DESC
  `, [videoId, deviceCapabilities.supportedCodecs, deviceCapabilities.maxResolution]);

  // 3. Get resume position from Cassandra
  const progress = await cassandra.execute(`
    SELECT position_seconds FROM viewing_progress
    WHERE profile_id = ? AND content_id = ?
  `, [profileId, videoId]);

  // 4. Generate CDN URLs with signed tokens
  const qualities = encodings.rows.map(enc => ({
    id: enc.id,
    resolution: enc.resolution,
    bandwidth: enc.bandwidth,
    codec: enc.codec,
    segmentDuration: 4,
    baseUrl: generateSignedCdnUrl(videoId, enc.id, profileId),
  }));

  // 5. Get subtitles and audio tracks
  const [subtitles, audioTracks] = await Promise.all([
    getSubtitleTracks(videoId),
    getAudioTracks(videoId),
  ]);

  return {
    videoId,
    title: video.rows[0].title,
    duration: video.rows[0].duration_seconds,
    resumePosition: progress.rows[0]?.position_seconds || 0,
    qualities,
    subtitles,
    audioTracks,
  };
}
```

**CDN URL Signing:**

```typescript
function generateSignedCdnUrl(
  videoId: string,
  encodingId: string,
  profileId: string
): string {
  const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  const payload = {
    v: videoId,
    e: encodingId,
    p: profileId,
    exp: expiry,
  };

  const token = jwt.sign(payload, CDN_SECRET, { algorithm: 'HS256' });

  // Template URL - client replaces $Number$ with segment index
  return `https://cdn.netflix.example/v/${videoId}/${encodingId}/seg-$Number$.m4s?token=${token}`;
}
```

### 2. Viewing Progress at Scale

**Cassandra Schema for High-Write Throughput:**

```cql
-- Keyspace with replication
CREATE KEYSPACE netflix_viewing WITH REPLICATION = {
  'class': 'NetworkTopologyStrategy',
  'us-east': 3,
  'us-west': 3,
  'eu-west': 3
};

-- Viewing progress (Continue Watching)
CREATE TABLE viewing_progress (
  profile_id UUID,
  content_id UUID,
  content_type TEXT,           -- 'movie' or 'episode'
  video_id UUID,
  episode_id UUID,
  position_seconds INT,
  duration_seconds INT,
  progress_percent FLOAT,
  completed BOOLEAN,
  last_watched_at TIMESTAMP,
  PRIMARY KEY (profile_id, last_watched_at, content_id)
) WITH CLUSTERING ORDER BY (last_watched_at DESC)
  AND default_time_to_live = 7776000  -- 90 days TTL
  AND gc_grace_seconds = 864000;

-- Watch history (for recommendations)
CREATE TABLE watch_history (
  profile_id UUID,
  content_id UUID,
  content_type TEXT,
  title TEXT,                  -- Denormalized for display
  genres SET<TEXT>,            -- Denormalized for recommendations
  watched_at TIMESTAMP,
  PRIMARY KEY (profile_id, watched_at, content_id)
) WITH CLUSTERING ORDER BY (watched_at DESC)
  AND default_time_to_live = 31536000;  -- 1 year TTL
```

**Progress Update Handler:**

```typescript
interface ProgressUpdate {
  profileId: string;
  contentId: string;
  contentType: 'movie' | 'episode';
  positionSeconds: number;
  durationSeconds: number;
}

async function updateProgress(update: ProgressUpdate): Promise<void> {
  const progressPercent = update.positionSeconds / update.durationSeconds;
  const completed = progressPercent > 0.95;

  // 1. Update viewing progress in Cassandra
  await cassandra.execute(`
    INSERT INTO viewing_progress (
      profile_id, content_id, content_type,
      position_seconds, duration_seconds, progress_percent,
      completed, last_watched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    update.profileId,
    update.contentId,
    update.contentType,
    update.positionSeconds,
    update.durationSeconds,
    progressPercent,
    completed,
    new Date(),
  ]);

  // 2. Invalidate cached Continue Watching
  await redis.del(`continue_watching:${update.profileId}`);

  // 3. Emit event for analytics
  await kafka.send({
    topic: 'viewing-events',
    messages: [{
      key: update.profileId,
      value: JSON.stringify({
        type: 'progress_update',
        ...update,
        timestamp: Date.now(),
      }),
    }],
  });

  // 4. If completed, record in watch history
  if (completed) {
    await recordWatchHistory(update);
    await updateGenrePreferences(update.profileId, update.contentId);
  }
}

// Batch progress updates to reduce write load
class ProgressBatcher {
  private buffer: Map<string, ProgressUpdate> = new Map();
  private flushInterval: NodeJS.Timer;

  constructor(flushIntervalMs: number = 5000) {
    this.flushInterval = setInterval(() => this.flush(), flushIntervalMs);
  }

  add(update: ProgressUpdate): void {
    // Key by profile+content, only keep latest
    const key = `${update.profileId}:${update.contentId}`;
    this.buffer.set(key, update);
  }

  private async flush(): Promise<void> {
    if (this.buffer.size === 0) return;

    const updates = Array.from(this.buffer.values());
    this.buffer.clear();

    // Batch insert to Cassandra
    const batch = updates.map(u => ({
      query: `INSERT INTO viewing_progress (...) VALUES (?, ?, ...)`,
      params: [u.profileId, u.contentId, ...],
    }));

    await cassandra.batch(batch);
  }
}
```

### 3. Continue Watching API

**Efficient Query Pattern:**

```typescript
async function getContinueWatching(
  profileId: string,
  limit: number = 20
): Promise<ContinueWatchingItem[]> {
  // 1. Check cache first
  const cached = await redis.get(`continue_watching:${profileId}`);
  if (cached) {
    return JSON.parse(cached);
  }

  // 2. Query Cassandra for recent progress
  const progress = await cassandra.execute(`
    SELECT content_id, content_type, position_seconds, duration_seconds,
           progress_percent, last_watched_at
    FROM viewing_progress
    WHERE profile_id = ?
    AND completed = false
    ORDER BY last_watched_at DESC
    LIMIT ?
  `, [profileId, limit * 2]); // Over-fetch for filtering

  // 3. Filter: started watching (>5%) but not completed
  const filtered = progress.rows.filter(p =>
    p.progress_percent > 0.05 && p.progress_percent < 0.95
  );

  // 4. Enrich with metadata from PostgreSQL
  const contentIds = filtered.map(p => p.content_id);
  const metadata = await db.query(`
    SELECT v.id, v.title, v.poster_url, v.backdrop_url, v.type,
           e.episode_number, s.season_number, s.title as season_title
    FROM videos v
    LEFT JOIN episodes e ON v.id = e.video_id
    LEFT JOIN seasons s ON e.season_id = s.id
    WHERE v.id = ANY($1)
  `, [contentIds]);

  const metadataMap = new Map(metadata.rows.map(m => [m.id, m]));

  // 5. Build response
  const items: ContinueWatchingItem[] = filtered.slice(0, limit).map(p => {
    const meta = metadataMap.get(p.content_id);
    return {
      contentId: p.content_id,
      title: meta.title,
      episodeInfo: meta.episode_number
        ? `S${meta.season_number}:E${meta.episode_number}`
        : null,
      posterUrl: meta.poster_url,
      progressPercent: Math.round(p.progress_percent * 100),
      resumePosition: p.position_seconds,
      lastWatchedAt: p.last_watched_at,
    };
  });

  // 6. Cache for 5 minutes
  await redis.setex(
    `continue_watching:${profileId}`,
    300,
    JSON.stringify(items)
  );

  return items;
}
```

### 4. A/B Testing Framework

**Experiment Configuration:**

```typescript
interface Experiment {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'running' | 'paused' | 'completed';
  allocation: number;         // Percentage of traffic (0-100)
  variants: Variant[];
  targetGroups: TargetGroup[];
  metrics: string[];
  startDate: Date;
  endDate: Date;
}

interface Variant {
  id: string;
  name: string;
  weight: number;             // Weight within experiment
  config: Record<string, any>;
}

interface TargetGroup {
  type: 'country' | 'device' | 'plan' | 'tenure';
  values: string[];
  include: boolean;
}
```

**Consistent Allocation with MurmurHash:**

```typescript
import murmurhash from 'murmurhash';

function allocateToExperiment(
  userId: string,
  experiment: Experiment
): string | null {
  // 1. Consistent hash for stable allocation
  const hash = murmurhash.v3(`${userId}:${experiment.id}`);
  const bucket = hash % 10000; // 0.01% granularity

  // 2. Check if user is in experiment population
  const allocationThreshold = experiment.allocation * 100;
  if (bucket >= allocationThreshold) {
    return null; // Not in experiment (control)
  }

  // 3. Allocate to variant based on weights
  const variantBucket = murmurhash.v3(`${userId}:${experiment.id}:variant`) % 10000;
  let cumulativeWeight = 0;

  for (const variant of experiment.variants) {
    cumulativeWeight += variant.weight * 100;
    if (variantBucket < cumulativeWeight) {
      return variant.id;
    }
  }

  // Fallback to first variant
  return experiment.variants[0].id;
}

// Get all experiment allocations for a user
async function getUserExperiments(
  userId: string,
  context: UserContext
): Promise<Map<string, string>> {
  const allocations = new Map<string, string>();

  // Get running experiments
  const experiments = await db.query(`
    SELECT * FROM experiments
    WHERE status = 'running'
    AND start_date <= NOW()
    AND (end_date IS NULL OR end_date >= NOW())
  `);

  for (const exp of experiments.rows) {
    // Check targeting rules
    if (!matchesTargeting(exp.target_groups, context)) {
      continue;
    }

    const variantId = allocateToExperiment(userId, exp);
    if (variantId) {
      allocations.set(exp.id, variantId);
    }
  }

  // Cache allocations (stable for experiment duration)
  await redis.setex(
    `experiments:${userId}`,
    3600,
    JSON.stringify(Object.fromEntries(allocations))
  );

  return allocations;
}
```

**Using Experiments in Application Code:**

```typescript
// Feature flag check
async function getArtworkForVideo(
  videoId: string,
  profileId: string
): Promise<string> {
  const experiments = await getUserExperiments(profileId, context);
  const artworkVariant = experiments.get('artwork_personalization_v2');

  if (artworkVariant === 'personalized') {
    return getPersonalizedArtwork(videoId, profileId);
  } else if (artworkVariant === 'genre_based') {
    return getGenreBasedArtwork(videoId, profileId);
  } else {
    return getDefaultArtwork(videoId);
  }
}

// Row ordering experiment
async function generateHomepageRows(
  profileId: string
): Promise<HomepageRow[]> {
  const experiments = await getUserExperiments(profileId, context);
  const rowOrderVariant = experiments.get('homepage_row_order_v3');

  const rows = await fetchAllRows(profileId);

  switch (rowOrderVariant) {
    case 'continue_first':
      return prioritizeContinueWatching(rows);
    case 'trending_first':
      return prioritizeTrending(rows);
    case 'personalized':
      return personalizeRowOrder(rows, profileId);
    default:
      return rows; // Control: default ordering
  }
}
```

### 5. Rate Limiting Strategy

**Tiered Rate Limits:**

```typescript
const RATE_LIMITS = {
  browse: { limit: 100, windowSeconds: 60 },     // Normal browsing
  playbackStart: { limit: 30, windowSeconds: 60 }, // Streaming is expensive
  progressUpdate: { limit: 60, windowSeconds: 60 }, // Frequent updates
  search: { limit: 50, windowSeconds: 60 },      // Prevent scraping
  auth: { limit: 5, windowSeconds: 300 },        // Credential stuffing protection
};

async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  // Sliding window using Redis sorted set
  const multi = redis.multi();
  multi.zremrangebyscore(key, 0, windowStart);   // Remove old entries
  multi.zadd(key, now, `${now}:${Math.random()}`); // Add current request
  multi.zcard(key);                               // Count requests
  multi.expire(key, windowSeconds);               // Set TTL

  const [,, count] = await multi.exec();

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(now + windowSeconds * 1000),
  };
}

// Middleware
function rateLimit(category: keyof typeof RATE_LIMITS) {
  const config = RATE_LIMITS[category];

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `ratelimit:${category}:${req.session?.accountId || req.ip}`;
    const result = await checkRateLimit(key, config.limit, config.windowSeconds);

    res.set({
      'X-RateLimit-Limit': config.limit,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': result.resetAt.toISOString(),
    });

    if (!result.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
      });
    }

    next();
  };
}
```

### 6. Circuit Breaker for External Services

**Implementation with Fallback:**

```typescript
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failures: number[] = [];
  private lastFailure: number = 0;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions = {}
  ) {}

  async execute<T>(
    operation: () => Promise<T>,
    fallback?: () => T | Promise<T>
  ): Promise<T> {
    // Check circuit state
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > (this.options.recoveryTimeout || 30000)) {
        this.state = 'HALF_OPEN';
      } else {
        if (fallback) return fallback();
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      if (fallback) return fallback();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failures = [];
    }
  }

  private onFailure(): void {
    this.failures.push(Date.now());
    this.lastFailure = Date.now();

    const recentFailures = this.failures.filter(
      t => Date.now() - t < (this.options.monitorWindow || 60000)
    );

    if (recentFailures.length >= (this.options.failureThreshold || 5)) {
      this.state = 'OPEN';
      console.log(`Circuit breaker ${this.name} OPENED`);
    }
  }
}

// Service-specific circuit breakers
const circuitBreakers = {
  personalization: new CircuitBreaker('personalization', { failureThreshold: 5 }),
  recommendations: new CircuitBreaker('recommendations', { failureThreshold: 3 }),
  cdn: new CircuitBreaker('cdn', { failureThreshold: 10 }),
};

// Usage with graceful degradation
async function getHomepageRows(profileId: string): Promise<HomepageRow[]> {
  return circuitBreakers.personalization.execute(
    () => personalizationService.getRows(profileId),
    async () => {
      // Fallback: Return cached or generic rows
      const cached = await redis.get(`homepage:${profileId}`);
      if (cached) return JSON.parse(cached);
      return getGenericHomepage(); // Trending for all users
    }
  );
}
```

### 7. Observability

**Key Metrics:**

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

const metrics = {
  streamingStarts: new Counter({
    name: 'streaming_starts_total',
    help: 'Total streaming playback starts',
    labelNames: ['quality', 'content_type', 'device'],
  }),

  playbackErrors: new Counter({
    name: 'streaming_playback_errors_total',
    help: 'Total playback errors',
    labelNames: ['error_type', 'content_type'],
  }),

  manifestLatency: new Histogram({
    name: 'manifest_generation_seconds',
    help: 'Time to generate playback manifest',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
  }),

  progressWriteLatency: new Histogram({
    name: 'progress_write_seconds',
    help: 'Time to write viewing progress',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5],
  }),

  experimentAllocations: new Counter({
    name: 'experiment_allocations_total',
    help: 'Experiment allocations',
    labelNames: ['experiment_id', 'variant_id'],
  }),

  circuitBreakerState: new Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half_open, 2=open)',
    labelNames: ['service'],
  }),
};
```

**Structured Logging:**

```typescript
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  service: string;
  requestId: string;
  profileId?: string;
  event: string;
  metadata: Record<string, unknown>;
}

function log(entry: Omit<LogEntry, 'timestamp'>): void {
  console.log(JSON.stringify({
    ...entry,
    timestamp: new Date().toISOString(),
  }));
}

// Usage
log({
  level: 'info',
  service: 'playback',
  requestId: req.id,
  profileId: req.session.profileId,
  event: 'manifest_generated',
  metadata: {
    videoId,
    qualityCount: manifest.qualities.length,
    latencyMs: Date.now() - startTime,
  },
});
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| CDN | Custom (Open Connect) | Third-party CDN | Cost at scale, ISP integration, control |
| Progress Storage | Cassandra | PostgreSQL | High write throughput, time-series access |
| Session Storage | Redis | Database | Low latency, easy revocation |
| Streaming Protocol | DASH | HLS | More flexibility, industry standard |
| Experiment Allocation | MurmurHash | Random | Consistent allocation across requests |
| Rate Limiting | Sliding window | Token bucket | Smoother limiting, prevents burst abuse |

## Future Enhancements

1. **Per-Title Encoding**: Custom encoding ladders based on content complexity
2. **Predictive Prefetch**: Pre-fetch likely next content during credits
3. **Multi-Region Active-Active**: Cassandra cross-region replication
4. **ML-Based ABR**: Neural network for bandwidth prediction
5. **Real-Time Experiment Analysis**: Streaming metrics with Flink/Spark
6. **Content-Based Embeddings**: Video fingerprinting for similar titles
7. **Chaos Engineering**: Automated failure injection testing
8. **Edge Computing**: Personalization at CDN edge nodes
