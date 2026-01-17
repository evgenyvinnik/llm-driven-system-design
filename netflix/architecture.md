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

## Authentication, Authorization, and Rate Limiting

### Authentication Strategy

**Session-Based Authentication (Local Development):**

For this learning project, we use session-based auth stored in Redis for simplicity and statefulness visibility.

```javascript
// Session configuration
const sessionConfig = {
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax'
  }
}

// Session structure
interface UserSession {
  accountId: string
  email: string
  activeProfileId: string | null
  loginAt: Date
  lastActivity: Date
}
```

**Production Alternative (JWT + Refresh Tokens):**

In production Netflix, stateless JWTs enable global scale:

```typescript
// Access token (short-lived, 15 minutes)
interface AccessToken {
  sub: string         // account_id
  profile_id: string  // active profile
  exp: number         // expiration
  iat: number         // issued at
  device_id: string   // client device fingerprint
}

// Refresh token (long-lived, 30 days, stored in DB)
interface RefreshToken {
  token_id: string
  account_id: string
  device_id: string
  expires_at: Date
  revoked: boolean
}
```

### Authorization and RBAC

**Role Definitions:**

| Role | Description | Permissions |
|------|-------------|-------------|
| `viewer` | Standard subscriber | Browse, watch, manage own profiles, rate content |
| `kids_viewer` | Kids profile | Browse/watch kids content only, no ratings |
| `account_owner` | Primary account holder | All viewer permissions + billing, add/remove profiles |
| `admin` | Netflix staff | Content management, experiments, analytics |
| `content_admin` | Content team | Upload videos, edit metadata, manage catalog |
| `experiment_admin` | Data science | Create/manage A/B tests, view experiment results |

**Permission Enforcement:**

```javascript
// Middleware for route protection
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const userRole = req.session?.role || 'anonymous'

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'Forbidden',
        required: allowedRoles,
        current: userRole
      })
    }
    next()
  }
}

// Maturity-based content filtering
function filterByMaturityLevel(content, profile) {
  const maturityMap = {
    'G': 1, 'PG': 2, 'PG-13': 3, 'R': 4, 'NC-17': 5, 'TV-MA': 5
  }

  return content.filter(item =>
    maturityMap[item.rating] <= profile.maturityLevel
  )
}

// API route examples
app.get('/api/browse', requireRole('viewer', 'kids_viewer'))
app.post('/api/admin/videos', requireRole('admin', 'content_admin'))
app.post('/api/admin/experiments', requireRole('admin', 'experiment_admin'))
app.get('/api/admin/analytics', requireRole('admin'))
```

**Profile-Level Isolation:**

```javascript
// Ensure users can only access their own profiles
async function validateProfileAccess(req, res, next) {
  const { profileId } = req.params
  const { accountId } = req.session

  const profile = await db.query(
    'SELECT account_id FROM profiles WHERE id = $1',
    [profileId]
  )

  if (!profile.rows[0] || profile.rows[0].account_id !== accountId) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  req.profile = profile.rows[0]
  next()
}
```

### Rate Limiting

**Tier-Based Limits (per endpoint category):**

| Endpoint Category | Limit | Window | Burst |
|-------------------|-------|--------|-------|
| Browse/Search | 100 | 1 minute | 20 |
| Playback Start | 30 | 1 minute | 5 |
| Profile Updates | 20 | 1 minute | 5 |
| Progress Updates | 60 | 1 minute | 10 |
| Admin APIs | 200 | 1 minute | 50 |
| Auth (login/register) | 5 | 5 minutes | 2 |

**Implementation (Redis-based sliding window):**

```javascript
const rateLimiter = {
  async checkLimit(key, limit, windowSeconds) {
    const now = Date.now()
    const windowStart = now - (windowSeconds * 1000)

    const multi = redis.multi()
    multi.zremrangebyscore(key, 0, windowStart)  // Remove old entries
    multi.zadd(key, now, `${now}:${Math.random()}`)  // Add current request
    multi.zcard(key)  // Count requests in window
    multi.expire(key, windowSeconds)  // Set TTL

    const [,, count] = await multi.exec()

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(now + windowSeconds * 1000)
    }
  }
}

// Middleware
function rateLimit(category, limit, windowSeconds) {
  return async (req, res, next) => {
    const key = `ratelimit:${category}:${req.session?.accountId || req.ip}`
    const result = await rateLimiter.checkLimit(key, limit, windowSeconds)

    res.set({
      'X-RateLimit-Limit': limit,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': result.resetAt.toISOString()
    })

    if (!result.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
      })
    }
    next()
  }
}
```

---

## Failure Handling

### Retry Strategy with Idempotency

**Idempotency Key Pattern:**

```javascript
// Client sends idempotency key in header
async function handleIdempotentRequest(req, res, next) {
  const idempotencyKey = req.headers['x-idempotency-key']

  if (!idempotencyKey) {
    return next() // Non-idempotent request
  }

  const cacheKey = `idempotency:${req.session.accountId}:${idempotencyKey}`

  // Check for cached response
  const cached = await redis.get(cacheKey)
  if (cached) {
    const { status, body } = JSON.parse(cached)
    return res.status(status).json(body)
  }

  // Store response after processing
  const originalJson = res.json.bind(res)
  res.json = async (body) => {
    await redis.setex(cacheKey, 86400, JSON.stringify({
      status: res.statusCode,
      body
    }))
    return originalJson(body)
  }

  next()
}

// Operations that need idempotency keys
// - Adding to My List
// - Creating profiles
// - Starting playback (prevents double-counting)
// - Rating content
```

**Retry with Exponential Backoff:**

```javascript
async function retryWithBackoff(operation, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']
  } = options

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const isRetryable = retryableErrors.includes(error.code) ||
                          (error.status >= 500 && error.status < 600)

      if (!isRetryable || attempt === maxRetries) {
        throw error
      }

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * 100,
        maxDelayMs
      )

      console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`)
      await sleep(delay)
    }
  }
}

// Usage
const manifest = await retryWithBackoff(
  () => fetchPlaybackManifest(videoId),
  { maxRetries: 3, baseDelayMs: 200 }
)
```

### Circuit Breaker Pattern

**Circuit Breaker for External Services:**

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.recoveryTimeout = options.recoveryTimeout || 30000
    this.monitorWindow = options.monitorWindow || 60000

    this.state = 'CLOSED'  // CLOSED, OPEN, HALF_OPEN
    this.failures = []
    this.lastFailure = null
  }

  async execute(operation) {
    // Reject immediately if circuit is open
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.recoveryTimeout) {
        this.state = 'HALF_OPEN'
      } else {
        throw new Error('Circuit breaker is OPEN')
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
      this.failures = []
    }
  }

  onFailure() {
    this.failures.push(Date.now())
    this.lastFailure = Date.now()

    // Count failures in monitoring window
    const recentFailures = this.failures.filter(
      t => Date.now() - t < this.monitorWindow
    )

    if (recentFailures.length >= this.failureThreshold) {
      this.state = 'OPEN'
      console.log('Circuit breaker OPENED')
    }
  }

  getState() {
    return {
      state: this.state,
      recentFailures: this.failures.length,
      lastFailure: this.lastFailure
    }
  }
}

// Service-specific circuit breakers
const circuitBreakers = {
  personalization: new CircuitBreaker({ failureThreshold: 5 }),
  recommendations: new CircuitBreaker({ failureThreshold: 3 }),
  experimentService: new CircuitBreaker({ failureThreshold: 10 })
}

// Fallback when circuit opens
async function getHomepageRows(profileId) {
  try {
    return await circuitBreakers.personalization.execute(
      () => personalizationService.getRows(profileId)
    )
  } catch (error) {
    // Graceful degradation: return cached or generic rows
    const cached = await redis.get(`homepage:${profileId}`)
    if (cached) return JSON.parse(cached)

    return getGenericHomepage() // Trending content for all users
  }
}
```

### Disaster Recovery (Local Development Simulation)

**Multi-Region Simulation (3 Local Instances):**

For learning purposes, simulate multi-region by running services on different ports:

```bash
# Simulate 3 "regions" locally
PORT=3001 REGION=us-east npm run dev   # Primary
PORT=3002 REGION=us-west npm run dev   # Secondary
PORT=3003 REGION=eu-west npm run dev   # Tertiary
```

**Failover Configuration:**

```javascript
// Load balancer configuration (nginx or HAProxy simulation)
const regions = [
  { name: 'us-east', url: 'http://localhost:3001', priority: 1, healthy: true },
  { name: 'us-west', url: 'http://localhost:3002', priority: 2, healthy: true },
  { name: 'eu-west', url: 'http://localhost:3003', priority: 3, healthy: true }
]

async function healthCheck() {
  for (const region of regions) {
    try {
      const response = await fetch(`${region.url}/health`, { timeout: 2000 })
      region.healthy = response.ok
    } catch {
      region.healthy = false
    }
  }
}

function getActiveRegion() {
  return regions
    .filter(r => r.healthy)
    .sort((a, b) => a.priority - b.priority)[0]
}
```

### Backup and Restore Testing

**Automated Backup Schedule:**

```sql
-- PostgreSQL backup script (run daily via cron)
-- For local development, use pg_dump

-- backup.sh
#!/bin/bash
BACKUP_DIR="/backups/postgres"
DATE=$(date +%Y%m%d_%H%M%S)

pg_dump -Fc netflix_db > "$BACKUP_DIR/netflix_$DATE.dump"

# Keep last 7 daily backups locally
find "$BACKUP_DIR" -name "*.dump" -mtime +7 -delete
```

**Restore Verification Script:**

```bash
#!/bin/bash
# restore-test.sh - Run weekly to verify backups work

# 1. Create test database
createdb netflix_restore_test

# 2. Restore from latest backup
LATEST=$(ls -t /backups/postgres/*.dump | head -1)
pg_restore -d netflix_restore_test "$LATEST"

# 3. Run verification queries
psql netflix_restore_test << EOF
  SELECT COUNT(*) as video_count FROM videos;
  SELECT COUNT(*) as profile_count FROM profiles;
  SELECT COUNT(*) as experiment_count FROM experiments;
  -- Verify referential integrity
  SELECT COUNT(*) FROM seasons s
    LEFT JOIN videos v ON s.video_id = v.id
    WHERE v.id IS NULL;
EOF

# 4. Cleanup
dropdb netflix_restore_test

echo "Backup verification complete"
```

**Cassandra Snapshot (for viewing history):**

```bash
# Take snapshot
nodetool snapshot viewing_keyspace -t daily_$(date +%Y%m%d)

# Verify snapshot exists
ls /var/lib/cassandra/data/viewing_keyspace/viewing_progress-*/snapshots/
```

---

## Data Lifecycle Policies

### Retention and TTL Policies

| Data Type | Retention Period | Storage Tier | Notes |
|-----------|------------------|--------------|-------|
| Viewing progress | 2 years | Hot (Cassandra/Redis) | Active "continue watching" data |
| Completed views | 5 years | Warm (PostgreSQL) | Used for recommendations |
| Playback events | 90 days | Hot (Kafka) | Real-time analytics |
| Playback events | 2 years | Cold (S3/MinIO) | Historical analysis |
| Experiment allocations | Duration + 30 days | Hot (Redis) | Stable bucketing |
| Experiment results | Indefinite | Cold (S3/MinIO) | Decision auditing |
| Session data | 30 days | Hot (Redis) | Auto-expires via TTL |
| Audit logs | 7 years | Cold (S3/MinIO) | Compliance |

**TTL Implementation:**

```javascript
// Redis TTLs (set at write time)
const TTL = {
  session: 30 * 24 * 60 * 60,           // 30 days
  homepage_cache: 5 * 60,                // 5 minutes
  experiment_allocation: 90 * 24 * 60 * 60, // 90 days
  rate_limit: 60,                        // 1 minute
  idempotency: 24 * 60 * 60              // 24 hours
}

await redis.setex(`session:${sessionId}`, TTL.session, sessionData)

// Cassandra TTL (viewing history cleanup)
// Automatically expire completed views after 2 years
INSERT INTO viewing_progress (profile_id, video_id, position, completed)
VALUES (?, ?, ?, true)
USING TTL 63072000; -- 2 years in seconds

// PostgreSQL cleanup job (run nightly)
DELETE FROM playback_events
WHERE created_at < NOW() - INTERVAL '90 days';
```

### Archival to Cold Storage

**Archive Pipeline:**

```javascript
// Archive old playback events to MinIO (S3-compatible)
async function archiveOldEvents() {
  const batchSize = 10000
  const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  while (true) {
    // Fetch batch of old events
    const events = await db.query(`
      SELECT * FROM playback_events
      WHERE created_at < $1
      ORDER BY created_at
      LIMIT $2
    `, [cutoffDate, batchSize])

    if (events.rows.length === 0) break

    // Write to MinIO as Parquet (or JSON for simplicity)
    const datePrefix = events.rows[0].created_at.toISOString().slice(0, 10)
    const key = `archives/playback_events/${datePrefix}/${Date.now()}.json`

    await minioClient.putObject(
      'netflix-archives',
      key,
      JSON.stringify(events.rows),
      { 'Content-Type': 'application/json' }
    )

    // Delete archived events from hot storage
    const ids = events.rows.map(e => e.id)
    await db.query(
      'DELETE FROM playback_events WHERE id = ANY($1)',
      [ids]
    )

    console.log(`Archived ${events.rows.length} events to ${key}`)
  }
}

// Schedule nightly
// cron: 0 3 * * * node scripts/archive-events.js
```

**Storage Tiering:**

```
Hot Storage (Immediate Access)
├── Redis: Sessions, caches, rate limits
├── PostgreSQL: Active catalog, profiles, experiments
└── Cassandra: Recent viewing history (< 90 days)

Warm Storage (Minutes to Access)
├── PostgreSQL Archive Tables: Completed experiments, old profiles
└── Cassandra: Historical viewing data (90 days - 2 years)

Cold Storage (Hours to Access - MinIO/S3)
├── Playback event archives (Parquet/JSON)
├── Experiment result datasets
├── Audit logs
└── Database backups
```

### Backfill and Replay Procedures

**Kafka Event Replay:**

```javascript
// Replay events from a specific offset for reprocessing
async function replayEvents(topic, fromOffset, handler) {
  const consumer = kafka.consumer({ groupId: 'replay-consumer' })
  await consumer.connect()

  await consumer.subscribe({
    topic,
    fromBeginning: false
  })

  // Seek to specific offset
  consumer.on('consumer.connect', async () => {
    const partitions = await admin.fetchTopicOffsets(topic)
    for (const partition of partitions) {
      consumer.seek({
        topic,
        partition: partition.partition,
        offset: fromOffset
      })
    }
  })

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      await handler(JSON.parse(message.value.toString()))
    }
  })
}

// Example: Replay viewing events to rebuild recommendations
await replayEvents('viewing-events', '1704067200000', async (event) => {
  await recommendationService.processViewingEvent(event)
})
```

**Database Backfill from Archives:**

```javascript
// Restore archived data for analysis
async function backfillFromArchive(dateRange) {
  const { startDate, endDate } = dateRange

  // List archived files in date range
  const objects = await minioClient.listObjects(
    'netflix-archives',
    `archives/playback_events/`,
    true
  )

  for await (const obj of objects) {
    const fileDate = obj.name.split('/')[2] // Extract date from path
    if (fileDate >= startDate && fileDate <= endDate) {
      // Download and insert into analysis table
      const data = await minioClient.getObject('netflix-archives', obj.name)
      const events = JSON.parse(await streamToString(data))

      await db.query(`
        INSERT INTO playback_events_analysis
        SELECT * FROM json_populate_recordset(null::playback_events, $1)
        ON CONFLICT (id) DO NOTHING
      `, [JSON.stringify(events)])

      console.log(`Backfilled ${events.length} events from ${obj.name}`)
    }
  }
}

// Usage: Backfill Q4 2024 data for year-end analysis
await backfillFromArchive({
  startDate: '2024-10-01',
  endDate: '2024-12-31'
})
```

**Viewing History Rebuild:**

```javascript
// Rebuild continue-watching from event log
async function rebuildContinueWatching(profileId) {
  // Query raw events from Cassandra
  const events = await cassandra.execute(`
    SELECT video_id, position, duration, event_time
    FROM viewing_events
    WHERE profile_id = ?
    AND event_time > ?
    ORDER BY event_time DESC
  `, [profileId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)])

  // Aggregate to get latest position per video
  const progressMap = new Map()
  for (const event of events.rows) {
    if (!progressMap.has(event.video_id)) {
      progressMap.set(event.video_id, {
        videoId: event.video_id,
        position: event.position,
        duration: event.duration,
        updatedAt: event.event_time
      })
    }
  }

  // Write to viewing_progress table
  for (const [videoId, progress] of progressMap) {
    await cassandra.execute(`
      INSERT INTO viewing_progress
      (profile_id, video_id, position, duration, updated_at, completed)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      profileId,
      videoId,
      progress.position,
      progress.duration,
      progress.updatedAt,
      progress.position / progress.duration > 0.95
    ])
  }

  console.log(`Rebuilt ${progressMap.size} continue-watching entries for profile ${profileId}`)
}
```

---

## Implementation Notes

This section explains the rationale behind key implementation decisions in the codebase, focusing on patterns that might differ from production Netflix but are appropriate for a learning project.

### Why Session-Based Auth Instead of JWT

**Decision**: Use Redis-backed sessions with httpOnly cookies instead of JWTs for this learning project.

**Rationale**:

1. **Visibility and Debugging**: Sessions stored in Redis are easily inspectable (`redis-cli KEYS "session:*"`). You can view, modify, or revoke any session instantly. With JWTs, the token is opaque to the server until decoded, and revocation requires maintaining a blocklist anyway.

2. **Simpler Mental Model**: Sessions follow a straightforward request-response pattern:
   - User logs in → Server creates session in Redis → Cookie sent to client
   - Each request → Server looks up session in Redis → User identity confirmed
   - Logout → Server deletes session from Redis

   JWTs require understanding cryptographic signatures, token refresh flows, and the stateless vs. stateful tradeoffs.

3. **Immediate Revocation**: When a user logs out or an admin needs to terminate a session, deletion is immediate and atomic. With JWTs, you either wait for expiration or maintain a revocation list (which reintroduces statefulness).

4. **Learning Value**: The session approach teaches core concepts (cookies, server-side state, TTLs) that transfer to understanding JWTs. Production Netflix uses JWTs for global scale, but the concepts learned here (identity, authorization, session lifecycle) apply directly.

**When to Use JWTs Instead**:
- Multi-region deployments where session replication latency is problematic
- Third-party API access requiring self-contained credentials
- Mobile apps that need offline token validation

```typescript
// Our session approach (simpler for learning)
const session = await redis.get(`session:${token}`);
if (!session) return res.status(401).json({ error: 'Unauthorized' });

// Production JWT approach (more complex but scales globally)
const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
// Still need Redis for revocation list...
```

### Why Circuit Breakers Prevent Cascade Failures

**Decision**: Implement circuit breakers for Cassandra, CDN, and storage operations using the Opossum library.

**Rationale**:

1. **Cascade Failure Prevention**: In microservices, one failing service can bring down the entire system. Without circuit breakers:
   - Storage service slows down → API threads wait → Thread pool exhausted → All requests fail
   - This "cascading failure" can take down healthy services that depend on the failing one

2. **Fail Fast, Recover Gracefully**: The circuit breaker pattern provides three states:
   - **CLOSED**: Normal operation, requests pass through
   - **OPEN**: Service is failing, immediately return error without trying (fail fast)
   - **HALF-OPEN**: Test recovery with limited requests before fully reopening

3. **Resource Protection**: By failing fast when a dependency is unhealthy, circuit breakers prevent:
   - Connection pool exhaustion
   - Memory pressure from queued requests
   - CPU waste on retries that will fail
   - User-facing latency from waiting on timeouts

4. **Graceful Degradation**: Combined with fallbacks, circuit breakers enable degraded but functional experiences:
   - CDN fails → Return cached content or lower quality
   - Recommendation service fails → Show generic trending content
   - Storage fails → Disable upload but continue browsing

```typescript
// Without circuit breaker: cascade failure
const manifest = await fetchFromCDN(videoId); // Times out after 30s
// Thread blocked, other requests queue up...

// With circuit breaker: fail fast, protect resources
const manifest = await cdnCircuitBreaker.fire(videoId);
// Circuit open? Returns immediately with fallback/error
// Healthy? Monitors success/failure for state transitions
```

**Metrics to Monitor**:
- `circuit_breaker_state`: Current state per service (0=closed, 1=half_open, 2=open)
- `circuit_breaker_failures_total`: Failure count (triggers opening)
- `circuit_breaker_successes_total`: Success count (triggers closing)

### Why Streaming Metrics Enable QoE Optimization

**Decision**: Implement Prometheus metrics for streaming starts, buffer events, playback errors, and bitrate distribution.

**Rationale**:

1. **Quality of Experience (QoE)**: Netflix's primary user experience metric isn't uptime—it's viewing quality. Metrics like rebuffering ratio (time spent buffering / total watch time) directly correlate with user satisfaction and churn.

2. **Adaptive Bitrate Insights**: Tracking bitrate distribution helps optimize the encoding ladder:
   - If 90% of plays are at 720p, investing in more 720p quality levels pays off
   - If 4K adoption is low, investigate whether it's device capability or bandwidth limits

3. **Problem Detection**: Streaming metrics enable rapid problem detection:
   - Spike in buffer events → CDN issue or ISP peering problem
   - Increased playback errors in specific regions → Regional infrastructure issue
   - Bitrate downgrades → Network congestion or ABR algorithm issues

4. **Business Metrics**: Streaming metrics connect technical performance to business outcomes:
   - Streaming starts → Engagement metric
   - Buffer events → Frustration indicator
   - Error rate → Service quality SLA

```typescript
// Key streaming metrics we track
streamingStarts.labels(quality, contentType).inc();  // User engagement
bufferEvents.labels(quality, contentType).inc();      // User frustration
playbackErrors.labels(errorType, contentType).inc(); // Service quality
streamingBitrate.labels(quality).observe(bitrateKbps); // Quality distribution
```

**Dashboard Queries** (Prometheus/Grafana):
```promql
# Rebuffering ratio (should be < 0.5%)
rate(streaming_buffer_events_total[5m]) / rate(streaming_starts_total[5m])

# Error rate by content type
rate(streaming_playback_errors_total[5m]) / rate(streaming_starts_total[5m])

# Quality distribution
histogram_quantile(0.5, rate(streaming_bitrate_kbps_bucket[5m]))
```

### Why Watch History Retention Balances Personalization vs. Privacy

**Decision**: Implement data lifecycle policies with 90-day viewing progress retention and 2-year watch history retention.

**Rationale**:

1. **Personalization Value Decay**: Older viewing data provides diminishing returns for recommendations:
   - Last 30 days: Strong signal for current interests
   - 30-90 days: Useful for understanding viewing patterns
   - 90+ days: Genre preferences, but specific titles less relevant
   - 2+ years: Minimal recommendation value

2. **Privacy by Design**: Data minimization is a core privacy principle (GDPR Article 5):
   - Collect only what's needed
   - Retain only as long as necessary
   - Provide deletion mechanisms (Right to Erasure)

3. **Storage Cost Management**: Viewing events accumulate rapidly:
   - 200M subscribers × 2 hours/day × 1 event/minute = 24B events/day
   - Without retention policies, storage costs grow unboundedly

4. **Tiered Storage Strategy**: Different data needs different access patterns:
   - **Hot (Redis/Cassandra)**: Active viewing progress for Continue Watching
   - **Warm (PostgreSQL)**: Recent watch history for recommendations
   - **Cold (S3/MinIO)**: Archived history for auditing and analytics

```typescript
// Retention configuration
const RETENTION_CONFIG = {
  completedProgressRetentionDays: 90,   // "Continue Watching" cleanup
  watchHistoryRetentionDays: 730,       // 2 years for recommendations
  archiveBeforeDelete: true,            // Audit trail
};

// Archive pipeline: Hot → Cold
await archiveWatchHistory(cutoffDate, batchSize);

// GDPR deletion support
await deleteProfileData(profileId);
```

**Compliance Considerations**:
- GDPR: Right to erasure (Article 17), data minimization (Article 5)
- CCPA: Right to delete personal information
- Retention schedule documentation for audits

### Rate Limiting Strategy

**Decision**: Implement Redis-based sliding window rate limiting with tiered limits by endpoint category.

**Rationale**:

1. **Protection Against Abuse**: Rate limits prevent:
   - Credential stuffing attacks on login endpoints
   - Scraping of video catalog data
   - Resource exhaustion from runaway clients

2. **Fair Usage**: Per-user limits ensure no single user degrades service for others.

3. **Sliding Window Algorithm**: Provides smoother limiting than fixed windows:
   - Fixed window: 100 requests allowed, user sends 100 at minute boundary, then 100 more at next minute = 200 in 2 seconds
   - Sliding window: Tracks requests over a rolling window, preventing burst abuse

**Tier Configuration**:
| Endpoint Category | Limit | Window | Rationale |
|-------------------|-------|--------|-----------|
| Browse/Search | 100/min | 60s | Normal browsing patterns |
| Playback Start | 30/min | 60s | Streaming is expensive |
| Auth (login) | 5/5min | 300s | Prevent credential stuffing |
| Admin APIs | 200/min | 60s | Tools need higher limits |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| CDN | Custom (Open Connect) | Third-party | Cost, control |
| Streaming | DASH | HLS | Flexibility |
| History storage | Cassandra | PostgreSQL | Write scale |
| Experiments | In-house | Third-party | Scale, control |
| Auth (local dev) | Session + Redis | JWT | Simpler debugging |
| Rate limiting | Sliding window | Token bucket | Smoother limiting |
| Backups | pg_dump + snapshots | Logical replication | Simpler for learning |
| Archives | MinIO (S3-compat) | Glacier | Local development friendly |
