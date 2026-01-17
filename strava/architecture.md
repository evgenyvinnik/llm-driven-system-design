# Strava - Fitness Tracking - Architecture Design

## System Overview

A fitness tracking and social platform for athletes that records GPS-based activities, enables social features among athletes, and provides segment-based leaderboards.

## Requirements

### Functional Requirements

- **Activity Recording** - Record GPS-based activities (running, cycling, hiking) with metrics
- **Route Visualization** - Display activities on maps with route polylines
- **Segment Matching** - Detect when activities traverse predefined route segments
- **Leaderboards** - Rank athletes on segments by time
- **Social Features** - Follow athletes, activity feed, kudos, comments
- **Statistics** - Track personal stats and achievements

### Non-Functional Requirements

- **Reliability** - Never lose uploaded activity data
- **Latency** - Activity upload and processing under 30 seconds
- **Scalability** - Handle multiple concurrent users (learning project scale)
- **Accuracy** - Segment matching must be precise for fair competition

### Out of Scope

- Training plans and coaching features
- Paid subscription tiers
- Partner device integrations (Garmin, Wahoo, etc.)
- Real-time live tracking during activities

## Capacity Estimation

### Learning Project Scale

- 100-1000 registered users
- 10-100 activities per day
- 1000-10000 GPS points per activity
- 10-100 segments

### Storage Estimates

- GPS point: ~50 bytes (lat, lng, altitude, time, speed, heart_rate)
- Average activity: 1000 points x 50 bytes = 50 KB
- Daily GPS storage: ~5 MB

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   React     │  │  TanStack   │  │  Zustand    │  │  Leaflet    │    │
│  │   + Vite    │  │   Router    │  │   Store     │  │   Maps      │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Backend API                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Express   │  │   Auth      │  │  Activity   │  │  Segment    │    │
│  │   Server    │  │   Routes    │  │   Routes    │  │   Routes    │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│  │   GPX       │  │  Segment    │  │ Achievement │                      │
│  │  Parser     │  │  Matcher    │  │  Service    │                      │
│  └─────────────┘  └─────────────┘  └─────────────┘                      │
└─────────────────────┬─────────────────────────┬─────────────────────────┘
                      │                         │
                      ▼                         ▼
           ┌─────────────────┐       ┌─────────────────┐
           │   PostgreSQL    │       │     Redis       │
           │   + PostGIS     │       │                 │
           │                 │       │ - Sessions      │
           │ - Users         │       │ - Leaderboards  │
           │ - Activities    │       │ - Feed Cache    │
           │ - GPS Points    │       │ - User Cache    │
           │ - Segments      │       │                 │
           │ - Efforts       │       │                 │
           └─────────────────┘       └─────────────────┘
```

### Core Components

1. **Activity Service** - Handles uploads, GPX parsing, metric calculation
2. **Segment Matcher** - Two-phase matching: bounding box filter + GPS point comparison
3. **Leaderboard Service** - Redis sorted sets for rankings
4. **Feed Generator** - Fan-out on write for personalized feeds
5. **Achievement Service** - Checks and awards achievements after activities

## Data Model

### PostgreSQL Schema

```sql
-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    username        VARCHAR(50) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    profile_photo   VARCHAR(512),
    weight_kg       DECIMAL(5,2),
    bio             TEXT,
    location        VARCHAR(255),
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Following relationships
CREATE TABLE follows (
    follower_id     UUID REFERENCES users(id),
    following_id    UUID REFERENCES users(id),
    created_at      TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

-- Activities
CREATE TABLE activities (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id),
    type            VARCHAR(20) NOT NULL,      -- 'run', 'ride', 'hike'
    name            VARCHAR(255),
    start_time      TIMESTAMP NOT NULL,
    elapsed_time    INTEGER NOT NULL,          -- seconds
    moving_time     INTEGER NOT NULL,
    distance        DECIMAL(12,2),             -- meters
    elevation_gain  DECIMAL(8,2),              -- meters
    avg_speed       DECIMAL(8,2),              -- m/s
    max_speed       DECIMAL(8,2),
    polyline        TEXT,                      -- Encoded polyline for display
    privacy         VARCHAR(20) DEFAULT 'public',
    kudos_count     INTEGER DEFAULT 0,
    comment_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- GPS Points (for segment matching)
CREATE TABLE gps_points (
    id              SERIAL PRIMARY KEY,
    activity_id     UUID REFERENCES activities(id),
    point_index     INTEGER NOT NULL,
    timestamp       TIMESTAMP,
    latitude        DECIMAL(10,7) NOT NULL,
    longitude       DECIMAL(10,7) NOT NULL,
    altitude        DECIMAL(8,2),
    speed           DECIMAL(8,2),
    heart_rate      INTEGER
);

-- Segments
CREATE TABLE segments (
    id              UUID PRIMARY KEY,
    creator_id      UUID REFERENCES users(id),
    name            VARCHAR(255) NOT NULL,
    activity_type   VARCHAR(20) NOT NULL,
    distance        DECIMAL(12,2) NOT NULL,
    elevation_gain  DECIMAL(8,2),
    polyline        TEXT NOT NULL,
    start_lat       DECIMAL(10,7) NOT NULL,
    start_lng       DECIMAL(10,7) NOT NULL,
    end_lat         DECIMAL(10,7) NOT NULL,
    end_lng         DECIMAL(10,7) NOT NULL,
    min_lat         DECIMAL(10,7) NOT NULL,
    min_lng         DECIMAL(10,7) NOT NULL,
    max_lat         DECIMAL(10,7) NOT NULL,
    max_lng         DECIMAL(10,7) NOT NULL,
    effort_count    INTEGER DEFAULT 0,
    athlete_count   INTEGER DEFAULT 0
);

-- Segment Efforts
CREATE TABLE segment_efforts (
    id              UUID PRIMARY KEY,
    segment_id      UUID REFERENCES segments(id),
    activity_id     UUID REFERENCES activities(id),
    user_id         UUID REFERENCES users(id),
    elapsed_time    INTEGER NOT NULL,
    moving_time     INTEGER NOT NULL,
    pr_rank         INTEGER,                   -- 1, 2, 3 for top PRs
    created_at      TIMESTAMP DEFAULT NOW()
);
```

### Redis Data Structures

```
# Leaderboards (sorted sets - lower time = better)
leaderboard:{segment_id} -> ZSET { user_id: elapsed_time }

# Personal Records
pr:{user_id}:{segment_id} -> best_elapsed_time

# Activity Feeds (sorted sets - score = timestamp)
feed:{user_id} -> ZSET { activity_id: timestamp }

# Sessions
sess:{session_id} -> JSON { userId, username, role }
```

## API Design

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/logout` - Logout (destroy session)
- `GET /api/auth/me` - Get current user

### Activities
- `GET /api/activities` - List activities (paginated)
- `GET /api/activities/:id` - Get activity details
- `GET /api/activities/:id/gps` - Get GPS points
- `POST /api/activities/upload` - Upload GPX file
- `POST /api/activities/simulate` - Create simulated activity
- `POST /api/activities/:id/kudos` - Give kudos
- `DELETE /api/activities/:id/kudos` - Remove kudos
- `POST /api/activities/:id/comments` - Add comment

### Segments
- `GET /api/segments` - List segments (with search)
- `GET /api/segments/:id` - Get segment with leaderboard
- `GET /api/segments/:id/leaderboard` - Get leaderboard
- `POST /api/segments` - Create segment from activity

### Users & Social
- `GET /api/users/:id` - Get user profile
- `POST /api/users/:id/follow` - Follow user
- `DELETE /api/users/:id/follow` - Unfollow user
- `GET /api/feed` - Get personalized feed
- `GET /api/feed/explore` - Get public activities

## Key Design Decisions

### GPS Data Storage

**Decision:** PostgreSQL with indexed tables instead of Cassandra.

**Rationale:** For this learning project, PostgreSQL handles the scale well. The `gps_points` table with a composite index on `(activity_id, point_index)` provides efficient retrieval. For production scale (millions of activities/day), we would use Cassandra or TimescaleDB.

### Segment Matching Algorithm

**Decision:** Two-phase matching:
1. Bounding box intersection (fast filter)
2. GPS point comparison (precise match)

**Implementation:**
```javascript
// Phase 1: Find candidate segments
const candidates = await db.query(`
  SELECT * FROM segments
  WHERE activity_type = $1
    AND min_lat <= $2 AND max_lat >= $3
    AND min_lng <= $4 AND max_lng >= $5
`, [activityType, activityMaxLat, activityMinLat, activityMaxLng, activityMinLng]);

// Phase 2: Match GPS points (25m threshold)
for (const segment of candidates) {
  const effort = matchGpsPoints(activityPoints, segmentPoints);
  if (effort) await saveEffort(effort);
}
```

### Leaderboard Implementation

**Decision:** Redis sorted sets with elapsed time as score.

**Advantages:**
- O(log N) insertions
- O(1) rank lookups
- Built-in range queries for top N

```javascript
// Update leaderboard
await redis.zadd(`leaderboard:${segmentId}`, elapsedTime, oderId);

// Get top 10
const leaderboard = await redis.zrange(`leaderboard:${segmentId}`, 0, 9, 'WITHSCORES');
```

### Activity Feed Strategy

**Decision:** Fan-out on write.

**Implementation:** When an activity is created, add it to all followers' feeds.

```javascript
const followers = await db.query('SELECT follower_id FROM follows WHERE following_id = $1', [userId]);
for (const follower of followers.rows) {
  await redis.zadd(`feed:${follower.follower_id}`, timestamp, activityId);
  await redis.zremrangebyrank(`feed:${follower.follower_id}`, 0, -1001); // Keep last 1000
}
```

**Trade-off:** More write work, but fast reads. Works well for typical follower counts.

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend | React 19 + Vite | Fast development, TypeScript support |
| Routing | TanStack Router | File-based routing, type-safe |
| State | Zustand | Minimal boilerplate, performant |
| Maps | Leaflet + React-Leaflet | Open source, widely used |
| Backend | Node.js + Express | Familiar, quick iteration |
| Database | PostgreSQL + PostGIS | Reliable, geospatial support |
| Cache | Redis | Sessions, leaderboards, feeds |
| Styling | Tailwind CSS | Utility-first, consistent design |

## Scalability Considerations

### Current Implementation (Learning Scale)
- Single backend instance
- PostgreSQL for all data
- Redis for sessions/leaderboards/feeds
- Local file processing

### Production Scale Improvements
1. **Horizontal scaling**: Multiple API servers behind load balancer
2. **GPS data**: Move to Cassandra or TimescaleDB
3. **Segment matching**: Background job queue (RabbitMQ/Kafka)
4. **CDN**: Cache static assets and map tiles
5. **Read replicas**: PostgreSQL read replicas for queries
6. **Caching**: Application-level caching for hot data

## Monitoring and Observability

### Recommended Stack (Future)
- **Metrics**: Prometheus + Grafana
- **Logging**: Structured JSON logs
- **Tracing**: OpenTelemetry

### Key Metrics to Track
- Activity upload latency
- Segment matching duration
- API response times
- Database query performance
- Cache hit rates

## Security Considerations

- **Authentication**: Session-based with HttpOnly cookies
- **Password Storage**: bcrypt hashing
- **CORS**: Restricted to known origins
- **Input Validation**: Sanitize all user inputs
- **SQL Injection**: Parameterized queries only
- **Rate Limiting**: Consider for production

## Data Lifecycle Policies

### Retention and TTL Policies

| Data Type | Hot Storage | Warm/Archive | Deletion | Rationale |
|-----------|-------------|--------------|----------|-----------|
| Activities | Indefinite | N/A | Manual by user | Core user data, never auto-delete |
| GPS Points | 1 year full resolution | Downsample after 1 year | Keep downsampled indefinitely | Reduce storage while preserving routes |
| Segment Efforts | 2 years | Archive to cold storage | Delete after 5 years | Historical leaderboards less relevant |
| Activity Feeds | 30 days in Redis | N/A | Auto-expire | Reconstructible from database |
| Session Data | 24 hours | N/A | Redis TTL | Security best practice |
| Leaderboards | Indefinite in Redis | Rebuild from DB if lost | N/A | Small dataset, high read frequency |

### GPS Point Downsampling Strategy

After 1 year, reduce GPS resolution to save storage while preserving route shape:

```sql
-- Downsample to every 5th point (80% reduction)
DELETE FROM gps_points
WHERE activity_id IN (
  SELECT id FROM activities
  WHERE created_at < NOW() - INTERVAL '1 year'
)
AND point_index % 5 != 0;

-- Update polyline (encoded route unaffected, stored separately)
```

### Cold Storage Archival (Local Development)

For local development, cold storage is simulated using compressed SQL dumps:

```bash
# Archive old segment efforts to compressed file
pg_dump -t segment_efforts --where="created_at < NOW() - INTERVAL '2 years'" \
  strava_db | gzip > archives/efforts_$(date +%Y%m).sql.gz

# Delete archived records from active database
DELETE FROM segment_efforts WHERE created_at < NOW() - INTERVAL '2 years';
```

### Backfill and Replay Procedures

**Scenario 1: Redis Cache Lost**
```bash
# Rebuild leaderboards from PostgreSQL
npm run rebuild:leaderboards

# Script implementation:
# SELECT segment_id, user_id, MIN(elapsed_time) as best_time
# FROM segment_efforts
# GROUP BY segment_id, user_id
# -> ZADD to Redis sorted sets
```

**Scenario 2: Activity Feed Reconstruction**
```bash
# Rebuild user feeds from follows + activities
npm run rebuild:feeds

# For each user:
#   1. Get all followed users
#   2. Get their activities from last 30 days
#   3. ZADD to feed:{user_id} with activity timestamps
```

**Scenario 3: Segment Effort Reprocessing**
```bash
# Re-run segment matching for specific activities
npm run reprocess:segments --activity-id=<uuid>
npm run reprocess:segments --date-range="2024-01-01,2024-01-31"
```

## Deployment and Operations

### Rollout Strategy (Local Multi-Instance)

For learning distributed systems locally, run multiple instances:

```bash
# Terminal 1: Backend instance A (port 3001)
PORT=3001 npm run dev

# Terminal 2: Backend instance B (port 3002)
PORT=3002 npm run dev

# Terminal 3: Simple load balancer (nginx or node-based)
npm run dev:lb  # Routes to 3001/3002 round-robin
```

**Rolling deployment simulation:**
1. Start new version on port 3003
2. Health check: `curl http://localhost:3003/health`
3. Update load balancer to include 3003
4. Remove 3001 from load balancer
5. Stop old instance on 3001
6. Repeat for 3002

### Schema Migration Runbook

**Before running migrations:**
```bash
# 1. Check current migration status
npm run db:status

# 2. Review pending migrations
ls backend/src/db/migrations/

# 3. Take database backup (local)
pg_dump strava_db > backup_$(date +%Y%m%d_%H%M%S).sql
```

**Running migrations:**
```bash
# Apply all pending migrations
npm run db:migrate

# Verify migration success
npm run db:status
```

**Migration file naming:**
```
001_create_users.sql
002_create_activities.sql
003_add_polyline_to_activities.sql
004_create_segments.sql
```

### Rollback Runbook

**Application Rollback:**
```bash
# 1. Identify last known good commit
git log --oneline -10

# 2. Checkout and rebuild
git checkout <commit-hash>
npm install && npm run build

# 3. Restart services
npm run dev
```

**Database Rollback (if migration fails):**
```bash
# Option A: Restore from backup
psql strava_db < backup_20240115_143022.sql

# Option B: Run down migration (if implemented)
npm run db:rollback

# Option C: Manual fix (document the SQL)
psql strava_db -c "DROP TABLE IF EXISTS new_table;"
psql strava_db -c "ALTER TABLE activities DROP COLUMN IF EXISTS new_column;"
```

**Redis Rollback:**
```bash
# Redis data is reconstructible from PostgreSQL
# If corruption occurs, flush and rebuild

redis-cli FLUSHDB
npm run rebuild:leaderboards
npm run rebuild:feeds
```

### Health Check Endpoints

```javascript
// GET /health - Basic liveness
{ "status": "ok", "timestamp": "2024-01-15T10:30:00Z" }

// GET /health/ready - Readiness (dependencies)
{
  "status": "ok",
  "postgres": "connected",
  "redis": "connected",
  "latency_ms": { "postgres": 2, "redis": 1 }
}
```

## Capacity and Cost Guardrails

### Monitoring Alerts (Local Development)

Even for local development, practice setting up alerts. Use console logging or a simple dashboard:

**Queue Lag Alerts (if using RabbitMQ/Kafka for background jobs):**
```javascript
// Check every 30 seconds
const QUEUE_LAG_THRESHOLD = 100; // messages

async function checkQueueHealth() {
  const pendingJobs = await queue.getJobCounts();
  if (pendingJobs.waiting > QUEUE_LAG_THRESHOLD) {
    console.warn(`[ALERT] Queue lag: ${pendingJobs.waiting} pending jobs`);
  }
}
```

**Segment Matching Duration:**
```javascript
const SEGMENT_MATCH_WARN_MS = 5000;

const start = Date.now();
await matchSegments(activity);
const duration = Date.now() - start;

if (duration > SEGMENT_MATCH_WARN_MS) {
  console.warn(`[ALERT] Slow segment matching: ${duration}ms for activity ${activity.id}`);
}
```

### Storage Growth Monitoring

Track database size weekly to catch unexpected growth:

```sql
-- Check table sizes
SELECT
  relname as table_name,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size,
  pg_size_pretty(pg_relation_size(relid)) as data_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

**Expected growth (learning project):**
| Table | Expected Size | Alert Threshold |
|-------|---------------|-----------------|
| gps_points | 50 MB/month | > 500 MB total |
| activities | 5 MB/month | > 50 MB total |
| segment_efforts | 1 MB/month | > 20 MB total |

### Cache Hit Rate Targets

Monitor Redis cache effectiveness:

```javascript
// Track cache hits/misses
const cacheStats = { hits: 0, misses: 0 };

async function getCachedFeed(userId) {
  const cached = await redis.get(`feed:${userId}`);
  if (cached) {
    cacheStats.hits++;
    return JSON.parse(cached);
  }
  cacheStats.misses++;
  // ... fetch from DB
}

// Log hit rate every 5 minutes
setInterval(() => {
  const total = cacheStats.hits + cacheStats.misses;
  const hitRate = total > 0 ? (cacheStats.hits / total * 100).toFixed(1) : 0;
  console.log(`[METRICS] Cache hit rate: ${hitRate}% (${cacheStats.hits}/${total})`);
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}, 300000);
```

**Target hit rates:**
| Cache Type | Target | Action if Below |
|------------|--------|-----------------|
| Activity feeds | > 80% | Increase TTL or pre-warm on follow |
| Leaderboards | > 95% | Check for missing ZADD on effort creation |
| User profiles | > 70% | Acceptable, profiles change frequently |

### Resource Limits (Local Development)

Prevent runaway processes from consuming system resources:

```javascript
// Limit concurrent segment matching
const CONCURRENT_MATCH_LIMIT = 3;
const matchQueue = new PQueue({ concurrency: CONCURRENT_MATCH_LIMIT });

// Limit GPS points per activity (prevent DoS via huge uploads)
const MAX_GPS_POINTS = 50000; // ~14 hours at 1 point/second

// Limit feed size to prevent Redis bloat
const MAX_FEED_SIZE = 1000;
await redis.zremrangebyrank(`feed:${userId}`, 0, -MAX_FEED_SIZE - 1);
```

### Cost Estimation (If Deployed)

For reference, rough cloud costs at learning scale:

| Resource | Specification | Monthly Cost |
|----------|---------------|--------------|
| PostgreSQL | db.t3.micro (1 vCPU, 1GB) | ~$15 |
| Redis | cache.t3.micro (0.5GB) | ~$12 |
| Compute | t3.small (2 vCPU, 2GB) | ~$15 |
| Storage | 20GB gp3 | ~$2 |
| **Total** | | **~$44/month** |

Cost guardrails for cloud deployment:
- Set billing alerts at $25, $50, $75
- Use Reserved Instances after validating usage patterns
- Enable auto-scaling with max instance limits

## Future Optimizations

1. **Real-time updates**: WebSocket for live kudos/comments
2. **Privacy zones**: Full implementation with GPS filtering
3. **Route snapping**: Improve GPS accuracy using road network
4. **Challenges**: Time-based competitive events
5. **Heat maps**: Aggregate route visualization
6. **Training load**: Fitness and fatigue tracking
